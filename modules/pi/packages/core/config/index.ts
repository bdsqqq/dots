import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let globalSettingsPath: string | undefined;

/** explicit file injection for embedded callers and fixtures. */
export function setGlobalSettingsPath(p: string): void {
  globalSettingsPath = p;
}

/** retained for callers compiled against the old API; reads are now fresh. */
export function clearConfigCache(): void {}

export function resolveGlobalSettingsPath(): string {
  return globalSettingsPath ?? path.join(getAgentDir(), "settings.json");
}

export function resolveConfigDir(): string {
  return path.dirname(resolveGlobalSettingsPath());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
    );
    if (!isObject(value))
      throw new Error(`settings must be a json object: ${file}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function merge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    // defineProperty also treats a JSON "__proto__" key as data, not authority.
    Object.defineProperty(result, key, {
      value:
        isObject(result[key]) && isObject(value)
          ? merge(result[key], value)
          : structuredClone(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

export interface GetExtensionConfigOpts {
  cwd?: string;
  /** caller grants project settings authority; never inferred from cwd alone. */
  allowProjectConfig?: boolean;
  /** already resolved settings, e.g. a native SettingsManager snapshot. no I/O. */
  settings?: Readonly<object>;
}

export interface ExtensionConfigSchema<T extends Record<string, unknown>> {
  /** invalid configuration is diagnosed and falls back to isolated defaults. */
  validate?: (value: Record<string, unknown>) => value is T;
  normalize?: (value: T) => T;
}

export interface GetExtensionConfigWithSchemaOpts<
  T extends Record<string, unknown>,
> extends GetExtensionConfigOpts {
  schema?: ExtensionConfigSchema<T>;
}

export interface EnabledExtensionConfig<T extends Record<string, unknown>> {
  enabled: boolean;
  config: T;
}

export function getExtensionConfig<T extends Record<string, unknown>>(
  namespace: string,
  defaults: T,
  opts?: GetExtensionConfigOpts,
): T {
  const layers =
    opts?.settings !== undefined
      ? [opts.settings]
      : [
          readSettings(resolveGlobalSettingsPath()),
          ...(opts?.allowProjectConfig && opts.cwd
            ? [readSettings(path.join(opts.cwd, ".pi/settings.json"))]
            : []),
        ];
  let config = structuredClone(defaults);
  for (const settings of layers) {
    if (!isObject(settings)) throw new Error("settings must be a json object");
    const value = settings[namespace];
    if (value === undefined) continue;
    if (!isObject(value))
      throw new Error(`extension settings must be an object: ${namespace}`);
    config = merge(config, value) as T;
  }
  return config;
}

function applySchema<T extends Record<string, unknown>>(
  namespace: string,
  config: Record<string, unknown>,
  defaults: T,
  schema?: ExtensionConfigSchema<T>,
): T {
  if (schema?.validate && !schema.validate(config)) {
    console.error(
      `[@bds_pi/config] invalid config for ${namespace}; falling back to defaults.`,
    );
    const fallback = structuredClone(defaults);
    return schema.normalize ? schema.normalize(fallback) : fallback;
  }
  return schema?.normalize ? schema.normalize(config as T) : (config as T);
}

export function getExtensionConfigWithSchema<T extends Record<string, unknown>>(
  namespace: string,
  defaults: T,
  opts?: GetExtensionConfigWithSchemaOpts<T>,
): T {
  return applySchema(
    namespace,
    getExtensionConfig(namespace, defaults, opts),
    defaults,
    opts?.schema,
  );
}

export function getEnabledExtensionConfig<T extends Record<string, unknown>>(
  namespace: string,
  defaults: T,
  opts?: GetExtensionConfigWithSchemaOpts<T>,
): EnabledExtensionConfig<T> {
  const { enabled, ...config } = getExtensionConfig(namespace, defaults, opts);
  return {
    enabled: typeof enabled === "boolean" ? enabled : true,
    config: applySchema(namespace, config, defaults, opts?.schema),
  };
}

/**
 * native SettingsManager has no public arbitrary-key setter. write through the
 * live path, like its native storage, rather than renaming over an editable
 * tracked symlink. callers must serialize writes with other settings editors.
 */
function writeSettings(file: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function updateGlobalExtensionConfig(
  namespace: string,
  patch: Record<string, unknown>,
): void {
  const file = resolveGlobalSettingsPath();
  const settings = readSettings(file);
  const current = settings[namespace];
  if (current !== undefined && !isObject(current)) {
    throw new Error(`extension settings must be an object: ${namespace}`);
  }
  writeSettings(
    file,
    merge(settings, { [namespace]: merge(current ?? {}, patch) }),
  );
}

export function getGlobalConfig<T>(key: string): T | undefined {
  return readSettings(resolveGlobalSettingsPath())[key] as T | undefined;
}

/**
 * explicit one-time import, oldest legacy layer first. native settings win
 * conflicts; unknown legacy options and source files survive. never auto-run.
 */
export function migrateLegacySettings(
  legacyFiles: readonly string[],
  target: string = resolveGlobalSettingsPath(),
): void {
  let legacy: Record<string, unknown> = {};
  for (const file of legacyFiles) {
    // Unlike ordinary discovery, an explicitly requested import must exist.
    fs.accessSync(file, fs.constants.R_OK);
    legacy = merge(legacy, readSettings(file));
  }
  writeSettings(target, merge(legacy, readSettings(target)));
}

if (import.meta.vitest) {
  const { beforeEach, afterEach, expect, test, vi } = import.meta.vitest;
  const { tmpdir } = await import("node:os");
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
  let dir: string;
  const ns = "@bds_pi/test";
  const write = (file: string, data: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return file;
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), "pi-native-settings-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(dir, "agent"));
    globalSettingsPath = undefined;
  });
  afterEach(() => {
    globalSettingsPath = undefined;
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("native global/project precedence agrees with SettingsManager; project authority is opt-in", () => {
    write(resolveGlobalSettingsPath(), {
      [ns]: { nested: { a: 1, b: 2 }, enabled: true },
    });
    write(path.join(dir, ".pi/settings.json"), {
      [ns]: { nested: { b: 0 }, enabled: false, items: [] },
    });
    const defaults = { nested: { a: 0, b: 0 }, items: [1] };
    expect(getExtensionConfig(ns, defaults, { cwd: dir })).toEqual({
      ...defaults,
      nested: { a: 1, b: 2 },
      enabled: true,
    });
    const manager = SettingsManager.create(dir, path.join(dir, "agent"));
    const native = manager.getSettings();
    expect(
      getExtensionConfig(ns, {}, { cwd: dir, allowProjectConfig: true }),
    ).toEqual(getExtensionConfig(ns, {}, { settings: native }));
    expect(
      getEnabledExtensionConfig(ns, defaults, {
        cwd: dir,
        allowProjectConfig: true,
      }),
    ).toEqual({
      enabled: false,
      config: { nested: { a: 1, b: 0 }, items: [] },
    });
  });

  test("caller-owned snapshots and defaults remain isolated and cause no file read", () => {
    fs.mkdirSync(resolveGlobalSettingsPath(), { recursive: true }); // reading this would throw
    const settings = { [ns]: { nested: { text: "" }, enabled: false } };
    const defaults = { nested: { text: "default", items: [1] } };
    const config = getExtensionConfig(ns, defaults, {
      settings,
      cwd: dir,
      allowProjectConfig: true,
    });
    expect(config.nested.text).toBe("");
    config.nested.items.push(2);
    config.nested.text = "changed";
    expect(defaults.nested.items).toEqual([1]);
    expect(settings[ns].nested.text).toBe("");
    expect(getExtensionConfig(ns, defaults, { settings: {} })).toEqual(
      defaults,
    );
  });

  test("writes through a tracked-style symlink, preserves siblings, reloads manual/native edits", async () => {
    const source = write(path.join(dir, "tracked.json"), {
      theme: "dark",
      [ns]: { nested: { keep: true } },
      other: { unknown: 1 },
    });
    fs.mkdirSync(path.dirname(resolveGlobalSettingsPath()), {
      recursive: true,
    });
    fs.symlinkSync(source, resolveGlobalSettingsPath());
    updateGlobalExtensionConfig(ns, { enabled: false, items: [] });
    expect(fs.lstatSync(resolveGlobalSettingsPath()).isSymbolicLink()).toBe(
      true,
    );
    expect(readSettings(source)).toEqual({
      theme: "dark",
      [ns]: { nested: { keep: true }, enabled: false, items: [] },
      other: { unknown: 1 },
    });
    const manager = SettingsManager.create(dir, path.join(dir, "agent"), {
      projectTrusted: false,
    });
    manager.setTheme("light");
    await manager.flush();
    expect(manager.drainErrors()).toEqual([]);
    expect(getGlobalConfig("theme")).toBe("light");
    expect(getExtensionConfig(ns, {})).toEqual({
      nested: { keep: true },
      enabled: false,
      items: [],
    });
    write(source, { [ns]: { enabled: true } });
    expect(getEnabledExtensionConfig(ns, {}).enabled).toBe(true);
  });

  test("legacy import preserves unknown options, local false/empty, native conflicts and sources", () => {
    const base = write(path.join(dir, "bds-pi.json"), {
      [ns]: { enabled: true, items: [1], nested: { a: 1 } },
    });
    const local = write(path.join(dir, "bds-pi.local.json"), {
      [ns]: { enabled: false, items: [], nested: { b: 2 } },
      unknown: { future: "" },
    });
    const original = fs.readFileSync(local, "utf8");
    write(resolveGlobalSettingsPath(), {
      theme: "dark",
      [ns]: { nested: { a: 9 } },
    });
    migrateLegacySettings([base, local]);
    expect(readSettings(resolveGlobalSettingsPath())).toEqual({
      theme: "dark",
      [ns]: { enabled: false, items: [], nested: { a: 9, b: 2 } },
      unknown: { future: "" },
    });
    expect(fs.readFileSync(local, "utf8")).toBe(original);
    const imported = fs.readFileSync(resolveGlobalSettingsPath(), "utf8");
    migrateLegacySettings([base, local]);
    expect(fs.readFileSync(resolveGlobalSettingsPath(), "utf8")).toBe(imported);
  });

  test("legacy files and branded environment variables are not runtime fallbacks", () => {
    const legacy = write(path.join(dir, "bds-pi.local.json"), {
      [ns]: { enabled: false },
    });
    vi.stubEnv("PI_BDS_CONFIG_PATH", legacy);
    vi.stubEnv("PI_BDS_CONFIG_OVERRIDES_PATH", legacy);
    expect(getEnabledExtensionConfig(ns, {})).toEqual({
      enabled: true,
      config: {},
    });
  });

  test.skipIf(process.getuid?.() === 0)(
    "write permission errors propagate without reporting success",
    () => {
      const file = write(resolveGlobalSettingsPath(), {
        [ns]: { enabled: true },
      });
      fs.chmodSync(file, 0o444);
      try {
        expect(() =>
          updateGlobalExtensionConfig(ns, { enabled: false }),
        ).toThrow();
        expect(readSettings(file)).toEqual({ [ns]: { enabled: true } });
      } finally {
        fs.chmodSync(file, 0o600);
      }
    },
  );

  test("I/O and migration failures propagate; schema fallback remains compatible", () => {
    const file = resolveGlobalSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken");
    expect(() => getExtensionConfig(ns, {})).toThrow();
    expect(() => updateGlobalExtensionConfig(ns, {})).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{broken");
    write(file, { [ns]: { count: "bad" } });
    expect(
      getExtensionConfigWithSchema(
        ns,
        { count: 0 },
        {
          schema: {
            validate: (value): value is { count: number } =>
              typeof value.count === "number",
          },
        },
      ),
    ).toEqual({ count: 0 });
    const before = fs.readFileSync(file, "utf8");
    expect(() => migrateLegacySettings([path.join(dir, "absent")])).toThrow();
    const malformed = path.join(dir, "bad-import");
    fs.writeFileSync(malformed, "[");
    expect(() => migrateLegacySettings([malformed])).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect(() => getExtensionConfig(ns, {})).toThrow();
    expect(() => updateGlobalExtensionConfig(ns, {})).toThrow();
  });
}
