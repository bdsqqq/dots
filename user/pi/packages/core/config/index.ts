/**
 * shared config reader for pi extensions.
 *
 * reads per-extension configuration from pi's settings.json files,
 * keyed by extension namespace (e.g. `"@bds_pi/librarian"`).
 *
 * merge order: defaults → global (setGlobalSettingsPath() |
 * PI_BDS_CONFIG_PATH | ~/.pi/agent/bds-pi.json) → project-local
 * (.pi/settings.json). project-local is opt-in via `allowProjectConfig`
 * to prevent malicious repo overrides.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let _globalSettingsPath: string | null = null;

export function setGlobalSettingsPath(p: string): void {
  _globalSettingsPath = p;
}

const _cache = new Map<string, unknown>();

export function clearConfigCache(): void {
  _cache.clear();
}

export function resolveGlobalSettingsPath(): string {
  return (
    _globalSettingsPath ??
    process.env.PI_BDS_CONFIG_PATH ??
    path.join(os.homedir(), ".pi", "agent", "bds-pi.json")
  );
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (_cache.has(filePath)) {
    return _cache.get(filePath) as Record<string, unknown> | null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    _cache.set(filePath, parsed);
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[@bds_pi/config] failed to read ${filePath}:`, err);
    }
    _cache.set(filePath, null);
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: Record<string, unknown>): T {
  const result = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(override)) {
    const baseVal = result[key];
    const overVal = override[key];
    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      result[key] = deepMerge(baseVal, overVal);
    } else {
      result[key] = overVal;
    }
  }
  return result as T;
}

export interface GetExtensionConfigOpts {
  cwd?: string;
  allowProjectConfig?: boolean;
}

export interface ExtensionConfigSchema<T extends Record<string, unknown>> {
  /**
   * validates merged config before it is returned.
   * `getEnabledExtensionConfig()` strips the reserved `enabled` flag first.
   * return false to fall back to defaults.
   */
  validate?: (value: Record<string, unknown>) => value is T;
  /** normalize a validated config before it is returned. */
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

type RawExtensionConfig = Record<string, unknown> & {
  enabled?: unknown;
};

function stripEnabledFlag(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const { enabled: _enabled, ...rest } = value as RawExtensionConfig;
  return rest;
}

function applyExtensionSchema<T extends Record<string, unknown>>(
  namespace: string,
  candidate: Record<string, unknown>,
  defaults: T,
  schema?: ExtensionConfigSchema<T>,
): T {
  if (schema?.validate && !schema.validate(candidate)) {
    console.error(
      `[@bds_pi/config] invalid config for ${namespace}; falling back to defaults.`,
    );
    return schema.normalize ? schema.normalize(defaults) : defaults;
  }

  const config = candidate as T;
  return schema?.normalize ? schema.normalize(config) : config;
}

export function getExtensionConfig<T extends Record<string, unknown>>(
  namespace: string,
  defaults: T,
  opts?: GetExtensionConfigOpts,
): T {
  let merged = { ...defaults };

  const globalPath = resolveGlobalSettingsPath();
  const globalSettings = readJsonFile(globalPath);
  if (globalSettings && isPlainObject(globalSettings[namespace])) {
    merged = deepMerge(
      merged,
      globalSettings[namespace] as Record<string, unknown>,
    );
  }

  if (opts?.allowProjectConfig && opts.cwd) {
    const projectPath = path.join(opts.cwd, ".pi", "settings.json");
    const projectSettings = readJsonFile(projectPath);
    if (projectSettings && isPlainObject(projectSettings[namespace])) {
      merged = deepMerge(
        merged,
        projectSettings[namespace] as Record<string, unknown>,
      );
    }
  }

  return merged;
}

export function getExtensionConfigWithSchema<T extends Record<string, unknown>>(
  namespace: string,
  defaults: T,
  opts?: GetExtensionConfigWithSchemaOpts<T>,
): T {
  const merged = getExtensionConfig(namespace, defaults, opts);
  return applyExtensionSchema(namespace, merged, defaults, opts?.schema);
}

export function getEnabledExtensionConfig<T extends Record<string, unknown>>(
  namespace: string,
  defaults: T,
  opts?: GetExtensionConfigWithSchemaOpts<T>,
): EnabledExtensionConfig<T> {
  const merged = getExtensionConfig(
    namespace,
    defaults,
    opts,
  ) as RawExtensionConfig;
  const enabled = typeof merged.enabled === "boolean" ? merged.enabled : true;
  const config = applyExtensionSchema(
    namespace,
    stripEnabledFlag(merged),
    defaults,
    opts?.schema,
  );

  return { enabled, config };
}

/** read a top-level (non-namespaced) key from the global settings file. */
export function getGlobalConfig<T>(key: string): T | undefined {
  const globalPath = resolveGlobalSettingsPath();
  const settings = readJsonFile(globalPath);
  if (!settings || !(key in settings)) return undefined;
  return settings[key] as T;
}

/** directory containing the global settings file (e.g. ~/.pi/agent/). */
export function resolveConfigDir(): string {
  return path.dirname(resolveGlobalSettingsPath());
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, test, vi } = import.meta.vitest;
  const tmpdir = os.tmpdir();

  function writeTmpJson(dir: string, filename: string, data: unknown): string {
    const filePath = path.join(dir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  const originalPiBdsConfigPath = process.env.PI_BDS_CONFIG_PATH;

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    _globalSettingsPath = null;
    if (originalPiBdsConfigPath === undefined) {
      delete process.env.PI_BDS_CONFIG_PATH;
    } else {
      process.env.PI_BDS_CONFIG_PATH = originalPiBdsConfigPath;
    }
  });

  describe("getExtensionConfig", () => {
    test("returns defaults when no settings file exists", () => {
      setGlobalSettingsPath(
        path.join(tmpdir, `nonexistent-${Date.now()}.json`),
      );
      const result = getExtensionConfig("@bds_pi/test", { foo: "bar", n: 1 });
      expect(result).toEqual({ foo: "bar", n: 1 });
    });

    test("reads namespaced config from global settings", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/test": { foo: "overridden" },
      });
      setGlobalSettingsPath(settingsPath);

      const result = getExtensionConfig("@bds_pi/test", {
        foo: "default",
        extra: true,
      });
      expect(result).toEqual({ foo: "overridden", extra: true });
    });

    test("prefers the in-process override over PI_BDS_CONFIG_PATH", () => {
      const envDir = fs.mkdtempSync(path.join(tmpdir, "pi-config-env-"));
      const envSettingsPath = writeTmpJson(envDir, "env-settings.json", {
        "@bds_pi/test": { foo: "from-env" },
      });
      const manualDir = fs.mkdtempSync(path.join(tmpdir, "pi-config-manual-"));
      const manualSettingsPath = writeTmpJson(
        manualDir,
        "manual-settings.json",
        {
          "@bds_pi/test": { foo: "from-setter" },
        },
      );
      process.env.PI_BDS_CONFIG_PATH = envSettingsPath;
      setGlobalSettingsPath(manualSettingsPath);

      const result = getExtensionConfig("@bds_pi/test", { foo: "default" });
      expect(result).toEqual({ foo: "from-setter" });
    });

    test("deep merges nested objects", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/test": { nested: { b: 2, c: 3 } },
      });
      setGlobalSettingsPath(settingsPath);

      const result = getExtensionConfig("@bds_pi/test", {
        nested: { a: 1, b: 0 },
      });
      expect(result).toEqual({ nested: { a: 1, b: 2, c: 3 } });
    });

    test("arrays replace rather than merge", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/test": { items: [3, 4] },
      });
      setGlobalSettingsPath(settingsPath);

      const result = getExtensionConfig("@bds_pi/test", { items: [1, 2] });
      expect(result).toEqual({ items: [3, 4] });
    });

    test("caches reads — second call does not re-read file", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/test": { v: 1 },
      });
      setGlobalSettingsPath(settingsPath);

      getExtensionConfig("@bds_pi/test", { v: 0 });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ "@bds_pi/test": { v: 999 } }),
      );
      const result = getExtensionConfig("@bds_pi/test", { v: 0 });
      expect(result).toEqual({ v: 1 });
    });

    test("clearConfigCache resets cached reads", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/test": { v: 1 },
      });
      setGlobalSettingsPath(settingsPath);

      getExtensionConfig("@bds_pi/test", { v: 0 });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ "@bds_pi/test": { v: 999 } }),
      );
      clearConfigCache();
      const result = getExtensionConfig("@bds_pi/test", { v: 0 });
      expect(result).toEqual({ v: 999 });
    });

    test("handles malformed JSON gracefully", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = path.join(dir, "settings.json");
      fs.writeFileSync(settingsPath, "NOT VALID JSON {{{");
      setGlobalSettingsPath(settingsPath);

      const result = getExtensionConfig("@bds_pi/test", { ok: true });
      expect(result).toEqual({ ok: true });
    });

    test("returns defaults when namespace key is missing", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/other": { x: 1 },
      });
      setGlobalSettingsPath(settingsPath);

      const result = getExtensionConfig("@bds_pi/test", { y: 2 });
      expect(result).toEqual({ y: 2 });
    });

    test("project-local config merges on top of global", () => {
      const globalDir = fs.mkdtempSync(path.join(tmpdir, "pi-config-global-"));
      const globalPath = writeTmpJson(globalDir, "settings.json", {
        "@bds_pi/test": { a: "global", b: "global" },
      });
      setGlobalSettingsPath(globalPath);

      const projectDir = fs.mkdtempSync(
        path.join(tmpdir, "pi-config-project-"),
      );
      writeTmpJson(projectDir, ".pi/settings.json", {
        "@bds_pi/test": { b: "project", c: "project" },
      });

      const result = getExtensionConfig(
        "@bds_pi/test",
        { a: "default", b: "default", c: "default" },
        { cwd: projectDir, allowProjectConfig: true },
      );
      expect(result).toEqual({ a: "global", b: "project", c: "project" });
    });

    test("project-local config is ignored when allowProjectConfig is false", () => {
      const globalDir = fs.mkdtempSync(path.join(tmpdir, "pi-config-global-"));
      const globalPath = writeTmpJson(globalDir, "settings.json", {
        "@bds_pi/test": { a: "global" },
      });
      setGlobalSettingsPath(globalPath);

      const projectDir = fs.mkdtempSync(
        path.join(tmpdir, "pi-config-project-"),
      );
      writeTmpJson(projectDir, ".pi/settings.json", {
        "@bds_pi/test": { a: "project" },
      });

      const result = getExtensionConfig(
        "@bds_pi/test",
        { a: "default" },
        { cwd: projectDir },
      );
      expect(result).toEqual({ a: "global" });
    });
  });

  describe("getExtensionConfigWithSchema", () => {
    test("applies validation and normalization to merged config", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/test": { foo: "overridden", count: 2 },
      });
      setGlobalSettingsPath(settingsPath);

      const result = getExtensionConfigWithSchema(
        "@bds_pi/test",
        { foo: "default", count: 0 },
        {
          schema: {
            validate: (
              value,
            ): value is {
              foo: string;
              count: number;
            } =>
              typeof value.foo === "string" && typeof value.count === "number",
            normalize: (value) => ({
              ...value,
              foo: value.foo.trim().toUpperCase(),
            }),
          },
        },
      );

      expect(result).toEqual({ foo: "OVERRIDDEN", count: 2 });
    });

    test("falls back to defaults when validation fails", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/test": { foo: 123 },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const result = getExtensionConfigWithSchema(
        "@bds_pi/test",
        { foo: "default" },
        {
          schema: {
            validate: (value): value is { foo: string } =>
              typeof value.foo === "string",
          },
        },
      );

      expect(result).toEqual({ foo: "default" });
      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/test; falling back to defaults.",
      );
    });
  });

  describe("getEnabledExtensionConfig", () => {
    test("defaults enabled to true and strips the reserved flag from config", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/test": { foo: "overridden" },
      });
      setGlobalSettingsPath(settingsPath);

      const result = getEnabledExtensionConfig("@bds_pi/test", {
        foo: "default",
      });

      expect(result).toEqual({ enabled: true, config: { foo: "overridden" } });
    });

    test("returns explicit enabled flag and validates remaining config", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/test": { enabled: false, foo: " override ", count: 2 },
      });
      setGlobalSettingsPath(settingsPath);

      const result = getEnabledExtensionConfig(
        "@bds_pi/test",
        { foo: "default", count: 0 },
        {
          schema: {
            validate: (
              value,
            ): value is {
              foo: string;
              count: number;
            } =>
              typeof value.foo === "string" && typeof value.count === "number",
            normalize: (value) => ({ ...value, foo: value.foo.trim() }),
          },
        },
      );

      expect(result).toEqual({
        enabled: false,
        config: { foo: "override", count: 2 },
      });
    });

    test("ignores non-boolean enabled values", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/test": { enabled: "nope", foo: "overridden" },
      });
      setGlobalSettingsPath(settingsPath);

      const result = getEnabledExtensionConfig("@bds_pi/test", {
        foo: "default",
      });

      expect(result).toEqual({ enabled: true, config: { foo: "overridden" } });
    });
  });

  describe("getGlobalConfig", () => {
    test("returns undefined when no settings file exists", () => {
      setGlobalSettingsPath(
        path.join(tmpdir, `nonexistent-${Date.now()}.json`),
      );
      expect(getGlobalConfig("missing")).toBeUndefined();
    });

    test("reads top-level key from global settings", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        promptVariables: { foo: { literal: "bar" } },
      });
      setGlobalSettingsPath(settingsPath);
      expect(getGlobalConfig("promptVariables")).toEqual({
        foo: { literal: "bar" },
      });
    });

    test("returns undefined for missing key", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", { other: 1 });
      setGlobalSettingsPath(settingsPath);
      expect(getGlobalConfig("promptVariables")).toBeUndefined();
    });
  });

  describe("resolveConfigDir", () => {
    test("returns dirname of global settings path", () => {
      setGlobalSettingsPath("/fake/dir/settings.json");
      expect(resolveConfigDir()).toBe("/fake/dir");
    });
  });
}
