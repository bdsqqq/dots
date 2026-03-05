/**
 * shared config reader for pi extensions.
 *
 * reads per-extension configuration from pi's settings.json files,
 * keyed by extension namespace (e.g. `"@bds_pi/librarian"`).
 *
 * merge order: defaults → global (~/.pi/agent/settings.json) → project-local (.pi/settings.json).
 * project-local is opt-in via `allowProjectConfig` to prevent malicious repo overrides.
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

function resolveGlobalSettingsPath(): string {
  return _globalSettingsPath ?? path.join(os.homedir(), ".pi", "agent", "settings.json");
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

export function getExtensionConfig<T extends Record<string, unknown>>(
  namespace: string,
  defaults: T,
  opts?: GetExtensionConfigOpts,
): T {
  let merged = { ...defaults };

  const globalPath = resolveGlobalSettingsPath();
  const globalSettings = readJsonFile(globalPath);
  if (globalSettings && isPlainObject(globalSettings[namespace])) {
    merged = deepMerge(merged, globalSettings[namespace] as Record<string, unknown>);
  }

  if (opts?.allowProjectConfig && opts.cwd) {
    const projectPath = path.join(opts.cwd, ".pi", "settings.json");
    const projectSettings = readJsonFile(projectPath);
    if (projectSettings && isPlainObject(projectSettings[namespace])) {
      merged = deepMerge(merged, projectSettings[namespace] as Record<string, unknown>);
    }
  }

  return merged;
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, test } = import.meta.vitest;
  const tmpdir = os.tmpdir();

  function writeTmpJson(dir: string, filename: string, data: unknown): string {
    const filePath = path.join(dir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  afterEach(() => {
    clearConfigCache();
    _globalSettingsPath = null;
  });

  describe("getExtensionConfig", () => {
    test("returns defaults when no settings file exists", () => {
      setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
      const result = getExtensionConfig("@bds_pi/test", { foo: "bar", n: 1 });
      expect(result).toEqual({ foo: "bar", n: 1 });
    });

    test("reads namespaced config from global settings", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/test": { foo: "overridden" },
      });
      setGlobalSettingsPath(settingsPath);

      const result = getExtensionConfig("@bds_pi/test", { foo: "default", extra: true });
      expect(result).toEqual({ foo: "overridden", extra: true });
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
      fs.writeFileSync(settingsPath, JSON.stringify({ "@bds_pi/test": { v: 999 } }));
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
      fs.writeFileSync(settingsPath, JSON.stringify({ "@bds_pi/test": { v: 999 } }));
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

      const projectDir = fs.mkdtempSync(path.join(tmpdir, "pi-config-project-"));
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

      const projectDir = fs.mkdtempSync(path.join(tmpdir, "pi-config-project-"));
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
}
