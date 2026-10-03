#!/usr/bin/env node
/** Offline consumer checks, not a sandbox. CI must run candidate code in a disposable VM. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
export const repository = resolve(dirname(script), "../..");
const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
const put = (path: string, value: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
const within = (root: string, path: string) => {
  const suffix = relative(resolve(root), resolve(path));
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};

export function docs(paths: string[], root = repository) {
  assert.ok(paths.length, "docs requires at least one Markdown path");
  const physicalRoot = realpathSync(root);
  let links = 0;
  const unchecked: string[] = [];
  for (const input of paths) {
    const path = resolve(root, input);
    assert.ok(within(root, path), `Markdown source escapes candidate: ${input}`);
    assert.ok(/\.md$/i.test(path), `not Markdown: ${input}`);
    assert.ok(
      within(physicalRoot, realpathSync(path)),
      `Markdown source symlink escapes candidate: ${input}`,
    );
    const text = readFileSync(path, "utf8");
    assert.ok(!text.includes("\0"), `NUL byte in ${input}`);
    // Captured research is evidence, not a declared runtime resource.
    if (/(?:^|\/)(?:archive|sources|research-sources)\//.test(input)) {
      unchecked.push(`archival document: ${input}`);
      continue;
    }
    let fence: string | undefined;
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const marker = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (
          marker[1][0] === fence[0] &&
          marker[1].length >= fence.length &&
          raw.slice(marker[0].length).trim() === ""
        )
          fence = undefined;
        continue;
      }
      if (fence) continue;
      const line = raw.replace(/`+[^`]*`+/g, "");
      const destinations = [
        ...line.matchAll(
          /!?\[[^\]]*\]\(\s*(<[^>]+>|(?:\\.|[^()\s]|\([^()]*\))+)(?:\s+["'][^"']*["'])?\s*\)/g,
        ),
        ...line.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/g),
        ...line.matchAll(/(?:href|src)=["']([^"']+)["']/g),
      ];
      for (const match of destinations) {
        const target = match[1].replace(/^<|>$/g, "").replace(/\\([() ])/g, "$1");
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#|\/)/i.test(target)) continue;
        const file = decodeURIComponent(target.split(/[?#]/, 1)[0]);
        if (!file) continue;
        const destination = resolve(dirname(path), file);
        assert.ok(
          within(root, destination),
          `${input}:${index + 1}: relative link escapes candidate: ${target}`,
        );
        if (existsSync(destination))
          assert.ok(
            within(physicalRoot, realpathSync(destination)),
            `${input}:${index + 1}: link symlink escapes candidate: ${target}`,
          );
        if (/(?:^|\/)(?:archive|sources|research-sources)\//.test(file)) {
          unchecked.push(`archival link: ${input}:${index + 1} -> ${target}`);
          continue;
        }
        assert.ok(
          existsSync(destination),
          `${input}:${index + 1}: broken relative file: ${target}`,
        );
        links++;
      }
    }
    assert.equal(fence, undefined, `${input}: unclosed Markdown fence`);
  }
  return {
    status: "passed",
    documents: paths.length,
    localLinks: links,
    unchecked,
    limitations: [
      "heading anchors, external/network URLs and rendered Markdown are unchecked",
      "standard inline/reference destinations and HTML href/src only; not a full Markdown parser",
      "archival research sources are not runtime dependencies",
    ],
  };
}

export function extensionEntries(root: string) {
  const directory = join(root, "modules/pi/packages/extensions");
  return readdirSync(directory)
    .filter(
      (name) =>
        !["e2e", "test-utils"].includes(name) &&
        statSync(join(directory, name)).isDirectory() &&
        existsSync(join(directory, name, "index.ts")),
    )
    .sort((a, b) => a.localeCompare(b));
}

function sourceExtensionDirectories(root: string) {
  const directory = join(root, "modules/pi/packages/extensions");
  return readdirSync(directory)
    .filter((name) => {
      if (["e2e", "test-utils"].includes(name) || !statSync(join(directory, name)).isDirectory())
        return false;
      if (
        existsSync(join(directory, name, "index.ts")) ||
        existsSync(join(directory, name, "index.js"))
      )
        return true;
      const packagePath = join(directory, name, "package.json");
      return existsSync(packagePath) && json(packagePath).pi?.extensions !== undefined;
    })
    .sort((a, b) => a.localeCompare(b));
}

export function validateManifest(root: string) {
  const pi = join(root, "modules/pi");
  const manifest = json(join(pi, "package.json"));
  const names = extensionEntries(root);
  assert.deepEqual(
    manifest.pi?.extensions,
    names.map((name) => `./dist/extensions/${name}.js`),
    "pi.extensions drifted from eligible source directories",
  );
  for (const entry of manifest.pi.extensions) {
    assert.ok(statSync(join(pi, entry)).isFile(), `missing built extension: ${entry}`);
  }
  // Check the package's actual exports, including declaration artifacts and wildcard expansions.
  assert.ok(object(manifest.exports), "missing package exports");
  function targets(value: any): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(targets);
    assert.ok(object(value), "invalid exports target");
    return Object.values(value).flatMap(targets);
  }
  for (const [key, value] of Object.entries(manifest.exports)) {
    for (const target of targets(value)) {
      assert.ok(target.startsWith("./") && !target.includes(".."), `unsafe export: ${target}`);
      if (target.includes("*")) {
        const directory = dirname(join(pi, target));
        const basename = target.slice(target.lastIndexOf("/") + 1);
        const [prefix, suffix] = basename.split("*");
        assert.equal(basename.split("*").length, 2, `unsupported wildcard: ${target}`);
        const files = readdirSync(directory).filter(
          (file) => file.startsWith(prefix) && file.endsWith(suffix),
        );
        assert.ok(files.length, `empty export: ${key} -> ${target}`);
        if (key === "./extensions/*")
          for (const name of names)
            assert.ok(
              existsSync(join(directory, `${prefix}${name}${suffix}`)),
              `missing export for ${name}: ${target}`,
            );
      } else assert.ok(statSync(join(pi, target)).isFile(), `missing export: ${target}`);
    }
  }
  return { status: "passed", extensions: names.length, exports: Object.keys(manifest.exports) };
}

export function manifest(root = repository) {
  const result = validateManifest(root);
  const diff = spawnSync("git", ["diff", "--exit-code", "--", "modules/pi/package.json"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(
    diff.status,
    0,
    `build changed committed candidate manifest\n${diff.error ?? ""}${diff.stdout}${diff.stderr}`,
  );
  return result;
}

/** Fail closed where the real consumers silently fall back on malformed files. */
export function validateConfigs(root: string) {
  const pi = join(root, "modules/pi");
  const settings = json(join(pi, "settings.json"));
  assert.ok(object(settings), "settings.json must be an object");
  for (const key of ["skills", "themes", "prompts", "extensions", "defaultTools", "enabledModels"])
    if (key in settings) assert.ok(strings(settings[key]), `settings.${key} must be string[]`);
  for (const key of [
    "defaultProvider",
    "defaultModel",
    "defaultThinkingLevel",
    "theme",
    "transport",
    "steeringMode",
    "followUpMode",
    "tuiMode",
  ])
    if (key in settings)
      assert.equal(typeof settings[key], "string", `settings.${key} must be string`);
  for (const key of ["compaction", "retry", "terminal", "images", "codemode"])
    if (key in settings) assert.ok(object(settings[key]), `settings.${key} must be object`);
  for (const key of [
    "hideThinkingBlock",
    "collapseChangelog",
    "enableSkillCommands",
    "showHardwareCursor",
    "showCacheMissNotices",
  ])
    if (key in settings)
      assert.equal(typeof settings[key], "boolean", `settings.${key} must be boolean`);
  for (const key of ["compaction", "retry"])
    if (settings[key]?.enabled !== undefined)
      assert.equal(
        typeof settings[key].enabled,
        "boolean",
        `settings.${key}.enabled must be boolean`,
      );
  for (const [key, choices] of Object.entries({
    defaultThinkingLevel: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    transport: ["auto", "sse", "websocket", "websocket-cached"],
    steeringMode: ["all", "one-at-a-time"],
    followUpMode: ["all", "one-at-a-time"],
    tuiMode: ["regular", "fullscreen"],
  }))
    if (key in settings) assert.ok(choices.includes(settings[key]), `invalid settings.${key}`);
  if ("quietStartup" in settings)
    assert.ok(
      typeof settings.quietStartup === "boolean" || settings.quietStartup === "header",
      "invalid settings.quietStartup",
    );
  const policy = json(join(pi, "tool-policy.json"));
  assert.ok(Array.isArray(policy), "tool-policy.json must be an array");
  for (const rule of policy) {
    assert.ok(
      object(rule) && typeof rule.tool === "string" && ["allow", "reject"].includes(rule.action),
      "invalid tool-policy rule",
    );
    if (rule.message !== undefined)
      assert.equal(typeof rule.message, "string", "invalid policy message");
    if (rule.matches !== undefined) {
      assert.ok(object(rule.matches), "invalid policy matches");
      for (const [key, value] of Object.entries(rule.matches))
        assert.ok(
          ["cmd", "cwd", "path", "within"].includes(key) &&
            (typeof value === "string" || strings(value)),
          `invalid policy pattern: ${key}`,
        );
    }
  }
  const keybindings = json(join(pi, "keybindings.json"));
  assert.ok(object(keybindings), "keybindings.json must be object");
  for (const [key, value] of Object.entries(keybindings)) {
    assert.ok(typeof value === "string" || strings(value), `invalid keybinding: ${key}`);
    for (const binding of typeof value === "string" ? [value] : value) {
      assert.ok(
        /^(?:(?:ctrl|shift|alt|super)\+)*(?:[a-z0-9]|f(?:[1-9]|1[0-2])|escape|esc|enter|return|tab|space|backspace|delete|insert|clear|home|end|pageUp|pageDown|up|down|left|right|[`=\[\]\\;',./!@#$%^&*()_+|~{}:<>?-])$/.test(
          binding,
        ),
        `invalid key syntax: ${key} -> ${binding}`,
      );
    }
  }
  const models = json(join(pi, "models.json"));
  assert.ok(object(models) && object(models.providers), "models.providers must be object");
  const base = json(join(root, "modules/agents/bds-pi.json"));
  assert.ok(object(base), "bds-pi.json must be object");
  for (const [key, value] of Object.entries(base))
    if (key.startsWith("@bds_pi/")) assert.ok(object(value), `invalid namespace config: ${key}`);
  return { settings, policy, keybindings, models, base };
}

export function probeEnvironment(home: string): Record<string, string> {
  return {
    HOME: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
    PI_CODING_AGENT_SESSION_DIR: join(home, "sessions"),
    PI_BDS_CONFIG_PATH: join(home, ".pi/agent/bds-pi.json"),
    PI_BDS_CONFIG_OVERRIDES_PATH: join(home, ".pi/agent/bds-pi.local.json"),
    PI_MEMORY_ROOT: join(home, "memory"),
    PI_MEMORY_DATA_DIR: join(home, "memory-data"),
    PI_MEMORY_STATE_DIR: join(home, "memory-state"),
    PI_AGENT_MEMORY_PROMPT_WORKER: "0",
    PI_MEMORY_SKILLS_ROOT: join(home, ".config/agents/skills"),
    BDS_PI_LOG_DIR: join(home, "logs"),
    PI_OFFLINE: "1",
    PATH: join(home, "bin"),
    CI: "true",
    NO_COLOR: "1",
    LANG: "C.UTF-8",
  };
}

export function pi(root = repository) {
  validateConfigs(root);
  const temporary = mkdtempSync(join(tmpdir(), "ci-pi-probe-"));
  try {
    const run = spawnSync(process.execPath, [script, "_pi-child", root, temporary], {
      cwd: temporary,
      env: {
        ...probeEnvironment(temporary),
        NODE_PATH: join(root, "modules/pi/node_modules/.pnpm/node_modules"),
      },
      encoding: "utf8",
      timeout: 20_000,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(
      run.status,
      0,
      `Pi consumer probe failed (20s bound)\n${run.error ?? ""}\n${run.stderr}\n${run.stdout}`,
    );
    return JSON.parse(run.stdout);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

type VersionProcess = (
  binary: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    encoding: "utf8";
    timeout: number;
    killSignal: "SIGKILL";
    maxBuffer: number;
  },
) => {
  status: number | null;
  signal?: string | null;
  error?: Error;
  stdout: string;
  stderr: string;
};

/** Validate candidate links, not whichever commands happen to be on the host's PATH. */
function toolBinary(workspace: string, packageName: string, command: string) {
  const packageRoot = join(workspace, "node_modules", packageName);
  const metadata = json(join(packageRoot, "package.json"));
  assert.equal(metadata.name, packageName, `wrong installed package for ${command}`);
  assert.ok(
    typeof metadata.version === "string" &&
      /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(metadata.version),
    `invalid installed version for ${command}`,
  );
  const entry = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.[command];
  assert.ok(typeof entry === "string" && !isAbsolute(entry), `missing declared bin: ${command}`);
  const target = realpathSync(resolve(packageRoot, entry));
  assert.ok(statSync(target).isFile(), `missing binary: ${command}`);
  const binary = join(workspace, "node_modules/.bin", command);
  accessSync(binary, constants.X_OK);
  if (realpathSync(binary) !== target) {
    // pnpm can install either symlinks or generated shell shims. Every supported
    // shim exec branch must reference the declared package entry, not stock pi.
    const source = readFileSync(binary, "utf8");
    const branches = source.split(/\r?\n/).filter((line) => /^\s*exec\s/.test(line));
    assert.ok(branches.length, `unrecognized bin shim: ${command}`);
    for (const branch of branches) {
      const match = branch.match(/"\$basedir(?:_win)?\/(\.\.\/[^"]+)"/);
      assert.ok(match, `unrecognized bin shim exec: ${command}`);
      assert.equal(
        realpathSync(resolve(dirname(binary), match[1])),
        target,
        `wrong bin shim target: ${command}`,
      );
    }
    const marker = source.match(/^# cmd-shim-target=(.+)$/m);
    if (marker) assert.equal(realpathSync(marker[1]), target, `wrong bin shim marker: ${command}`);
  }
  return { binary, target, packageRoot, metadata };
}

export function tools(root = repository, runVersion: VersionProcess = spawnSync) {
  const workspace = join(root, "modules/node-pnpm");
  const wrapper = toolBinary(workspace, "@bdsqqq/pi-cli", "pi");
  assert.equal(
    realpathSync(wrapper.packageRoot),
    realpathSync(join(workspace, "pi-cli")),
    "global pi is not the candidate workspace wrapper",
  );
  assert.equal(
    wrapper.target,
    realpathSync(join(workspace, "pi-cli/bin/pi")),
    "wrong global pi wrapper entry",
  );
  const wrapperSource = readFileSync(wrapper.target, "utf8");
  for (const line of [
    'package_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)',
    'tools_root=$(CDPATH= cd -- "$package_root/.." && pwd -P)',
    'pi_workspace=$(CDPATH= cd -- "$tools_root/../pi" && pwd -P)',
    'export NODE_PATH="$pi_workspace/node_modules/.pnpm/node_modules"',
    'export PI_BIN="$pi_workspace/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"',
    'exec "$PI_BIN" "$@"',
  ])
    assert.ok(
      wrapperSource.split(/\r?\n/).includes(line),
      "pi wrapper no longer selects sibling workspace unbundled patched SDK",
    );
  const sdkManifest = join(
    root,
    "modules/pi/node_modules/@earendil-works/pi-coding-agent/package.json",
  );
  const sdk = json(sdkManifest);
  assert.equal(sdk.name, "@earendil-works/pi-coding-agent", "wrong Pi SDK authority");
  assert.equal(sdk.bin?.pi, "dist/cli.js", "Pi SDK bin must be the unbundled entry");
  const sdkEntry = realpathSync(join(dirname(sdkManifest), sdk.bin.pi));
  accessSync(sdkEntry, constants.X_OK);
  assert.ok(
    typeof sdk.version === "string" &&
      /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(sdk.version),
    "invalid Pi SDK version",
  );
  const candidates = [
    { ...wrapper, command: "pi", version: sdk.version, authority: sdkManifest },
    ...[
      ["@openai/codex", "codex"],
      ["t3", "t3"],
    ].map(([name, command]) => {
      const tool = toolBinary(workspace, name, command);
      return {
        ...tool,
        command,
        version: tool.metadata.version,
        authority: join(tool.packageRoot, "package.json"),
      };
    }),
  ];
  const results = [];
  for (const candidate of candidates) {
    const home = mkdtempSync(join(tmpdir(), `ci-tools-${candidate.command}-`));
    try {
      const env = {
        ...probeEnvironment(home),
        // Shell shims need dirname/sed/uname; only this Node and system utilities
        // are exposed, never the user's PATH or personal npm/credential config.
        PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
        CODEX_HOME: join(home, ".codex"),
        T3CODE_STATE_DIR: join(home, ".t3"),
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
        T3CODE_TELEMETRY_ENABLED: "false",
        DO_NOT_TRACK: "1",
        OTEL_SDK_DISABLED: "true",
      };
      const run = runVersion(candidate.binary, ["--version"], {
        cwd: home,
        env,
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      });
      assert.ok(
        !run.error && !run.signal && run.status === 0,
        `${candidate.command} --version failed or timed out\n${run.error ?? run.signal ?? ""}\n${run.stderr}`,
      );
      const reported = run.stdout.trim();
      const versions = [
        ...reported.matchAll(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?=$|\s)/g),
      ].map((match) => match[1]);
      assert.deepEqual(
        versions,
        [candidate.version],
        `${candidate.command} CLI version disagrees with installed package: ${reported}`,
      );
      results.push({
        command: candidate.command,
        package: candidate.metadata.name,
        packageVersion: candidate.metadata.version,
        versionAuthority: candidate.authority,
        expectedVersion: candidate.version,
        cliVersion: reported,
        binary: candidate.binary,
        ...(candidate.command === "pi" ? { sdkEntry, wrapperVersion: reported } : {}),
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  return {
    status: "passed",
    tools: results,
    limitations: [
      "only global Pi/Codex/T3 --version paths; not every global npm tool",
      "no authentication, model requests, server startup or live-service verification",
      "fresh HOME and allowlisted environment are not a sandbox; CI requires a disposable VM",
    ],
  };
}

async function piChild(root: string, home: string) {
  assert.equal(process.env.HOME, home, "child requires its fresh temporary environment");
  assert.equal(
    process.env.NODE_PATH,
    join(root, "modules/pi/node_modules/.pnpm/node_modules"),
    "child requires only candidate Pi peer graph",
  );
  for (const [key, value] of Object.entries(probeEnvironment(home)))
    assert.equal(process.env[key], value, `child environment mismatch: ${key}`);
  assert.deepEqual(readdirSync(home), [], "child requires an empty temporary home");
  const candidate = validateConfigs(root);
  const piRoot = join(root, "modules/pi");
  const agent = join(home, ".pi/agent");
  mkdirSync(agent, { recursive: true });
  for (const file of ["settings.json", "models.json", "keybindings.json", "tool-policy.json"])
    cpSync(join(piRoot, file), join(agent, file));
  cpSync(join(root, "modules/agents/bds-pi.json"), join(agent, "bds-pi.json"));
  const guidance = readFileSync(join(root, "config/global-agents.md"), "utf8");
  put(join(agent, "AGENTS.md"), guidance);
  cpSync(join(root, "modules/agents/skills"), join(home, ".config/agents/skills"), {
    recursive: true,
  });
  // modules/agents/default.nix also exposes the same collection through the
  // Agent Skills location; SDK discovery there differs from explicit Pi paths.
  mkdirSync(join(home, ".agents"), { recursive: true });
  symlinkSync(join(home, ".config/agents/skills"), join(home, ".agents/skills"), "dir");
  cpSync(join(root, "modules/agents/agents"), join(agent, "agents"), { recursive: true });
  const names = sourceExtensionDirectories(root);
  const expectedExtensions: string[] = [];
  mkdirSync(join(agent, "extensions"), { recursive: true });
  for (const name of new Set([...names, "editor"])) {
    const directory = join(piRoot, "packages/extensions", name);
    symlinkSync(directory, join(agent, "extensions", name), "dir");
    if (!names.includes(name)) continue; // The resource-only editor directory in bounded fixtures.
    const packagePath = join(directory, "package.json");
    const pkg = existsSync(packagePath) ? json(packagePath) : undefined;
    const entries =
      pkg?.pi && "extensions" in pkg.pi
        ? pkg.pi.extensions
        : [existsSync(join(directory, "index.ts")) ? "./index.ts" : "./index.js"];
    // The SDK silently falls back to index.ts for malformed/missing declarations.
    // Validate declarations separately, then let real directory discovery select them.
    assert.ok(strings(entries) && entries.length > 0, `invalid package pi.extensions: ${name}`);
    for (const entry of entries) {
      const file = resolve(directory, entry);
      assert.ok(
        within(directory, file) && /\.(ts|js)$/.test(file),
        `invalid package extension entry: ${name}: ${entry}`,
      );
      assert.ok(
        existsSync(file) && statSync(file).isFile(),
        `missing declared extension entry: ${name}: ${entry}`,
      );
      assert.ok(
        within(realpathSync(directory), realpathSync(file)),
        `extension entry escapes package: ${name}: ${entry}`,
      );
      expectedExtensions.push(realpathSync(file));
    }
  }
  // Do not resolve newly introduced absolute or escaping resource settings against a real home.
  for (const key of ["skills", "themes", "prompts", "extensions"]) {
    for (const entry of candidate.settings[key] ?? []) {
      if (entry.startsWith("builtin:") || entry.startsWith("-builtin:")) continue;
      const value = entry.replace(/^[!+-]/, "");
      const destination = value.startsWith("~/")
        ? join(home, value.slice(2))
        : resolve(agent, value);
      const suffix = relative(home, destination);
      assert.ok(
        suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix),
        `resource escapes temporary home: ${key}: ${entry}`,
      );
    }
  }
  assert.ok(
    !candidate.settings.packages?.length,
    "offline probe cannot install candidate package declarations",
  );
  // Immutable base remains byte-for-byte candidate. Only runtime paths live in mutable overrides.
  const overrides: Record<string, any> = {};
  for (const [namespace, config] of Object.entries(candidate.base)) {
    if (!object(config)) continue;
    overrides[namespace] = {};
    for (const [key, value] of Object.entries(config)) {
      if (/Dirs$/.test(key) && strings(value))
        overrides[namespace][key] = value.map((_, i) =>
          join(home, "runtime", namespace.replace(/\W/g, "_"), key, String(i)),
        );
      else if (/(?:Dir|Path|Root)$/.test(key) && typeof value === "string" && value)
        overrides[namespace][key] = join(home, "runtime", namespace.replace(/\W/g, "_"), key);
      else if (/(?:File)$/.test(key) && typeof value === "string" && value)
        assert.ok(
          !value.startsWith("/") && !value.includes(".."),
          `non-portable prompt resource: ${namespace}.${key}`,
        );
    }
  }
  put(join(agent, "bds-pi.local.json"), JSON.stringify(overrides));
  // Network/process boundaries fail even if a consumer catches the thrown error.
  const attempts: string[] = [];
  const deny =
    (name: string) =>
    (..._args: any[]) => {
      attempts.push(name);
      throw new Error(`offline boundary: ${name}`);
    };
  const require = createRequire(join(piRoot, "package.json"));
  const fsBoundary = require("node:fs");
  const originalExists = fsBoundary.existsSync;
  fsBoundary.existsSync = (path: any) => {
    // SDK context discovery normally walks to /. Hide only ancestor guidance
    // outside this fresh home; candidate extension/resource filesystem reads stay real.
    if (
      typeof path === "string" &&
      /(?:^|\/)(?:AGENTS(?:\.override)?\.(?:md|MD)|CLAUDE\.(?:md|MD))$/.test(path) &&
      !within(home, path)
    )
      return false;
    return originalExists(path);
  };
  for (const [module, names] of [
    [
      "node:child_process",
      ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
    ],
    ["node:http", ["request", "get"]],
    ["node:https", ["request", "get"]],
    ["node:net", ["connect", "createConnection"]],
    ["node:tls", ["connect"]],
  ] as [string, string[]][]) {
    const boundary = require(module);
    for (const name of names) boundary[name] = deny(`${module}.${name}`);
  }
  globalThis.fetch = deny("fetch") as typeof fetch;
  globalThis.WebSocket = deny("WebSocket") as any;
  require("node:net").Socket.prototype.connect = deny("net.Socket.connect");
  require("node:dgram").Socket.prototype.send = deny("dgram.Socket.send");
  syncBuiltinESMExports();
  const { createJiti } = require("jiti");
  const jiti = createJiti(join(piRoot, "package.json"), { moduleCache: false });
  const sdkName = "@earendil-works/pi-coding-agent";
  const sdkManifest = (require.resolve.paths(sdkName) ?? [])
    .map((path: string) => join(path, sdkName, "package.json"))
    .find(existsSync);
  assert.ok(sdkManifest, "Pi SDK unavailable; install the modules/pi workspace first");
  const sdkEntry = resolve(dirname(sdkManifest), json(sdkManifest).exports["."].import);
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const config = await jiti.import(join(piRoot, "packages/core/config/index.ts"));
  const policy = await jiti.import(join(piRoot, "packages/core/tool-policy/index.ts"));
  const spawn = await jiti.import(join(piRoot, "packages/core/pi-spawn/index.ts"));
  assert.deepEqual(
    policy.loadToolPolicy(),
    candidate.policy,
    "real policy consumer lost candidate rules",
  );
  assert.equal(
    policy.evaluateToolPolicy("Bash", { cmd: "git add -A" }, policy.loadToolPolicy()).action,
    "reject",
  );
  assert.equal(
    policy.evaluateToolPolicy("Bash", { cmd: "git status" }, policy.loadToolPolicy()).action,
    "allow",
  );
  for (const [namespace, expected] of Object.entries(candidate.base)) {
    const actual = config.getExtensionConfig(namespace, {});
    assert.deepEqual(
      actual,
      { ...expected, ...overrides[namespace] },
      `config consumer lost ${namespace}`,
    );
  }
  const baseBytes = readFileSync(join(agent, "bds-pi.json"), "utf8");
  config.updateGlobalExtensionConfig("@bds_pi/ci-probe", { enabled: false });
  config.clearConfigCache();
  assert.equal(
    config.getExtensionConfig("@bds_pi/ci-probe", {}).enabled,
    false,
    "mutable config reload failed",
  );
  assert.equal(
    readFileSync(join(agent, "bds-pi.json"), "utf8"),
    baseBytes,
    "mutable write altered immutable base",
  );
  const requiredPrompts = ["agent.amp.finder.md", "agent.amp.librarian.md", "agent.amp.oracle.md"];
  for (const name of requiredPrompts)
    assert.ok(spawn.readAgentPrompt(name).trim(), `missing required agent prompt: ${name}`);
  for (const [namespace, value] of Object.entries(candidate.base)) {
    if (!object(value)) continue;
    for (const [key, filename] of Object.entries(value))
      if (
        /File$/.test(key) &&
        typeof filename === "string" &&
        filename &&
        !value[key.replace(/File$/, "String")]
      )
        assert.ok(
          spawn.readAgentPrompt(filename).trim(),
          `missing configured prompt: ${namespace}.${key}: ${filename}`,
        );
  }
  const keys = await import(pathToFileURL(join(dirname(sdkEntry), "core/keybindings.js")).href);
  const keybindings = keys.KeybindingsManager.create(agent);
  keybindings.reload();
  for (const [key, value] of Object.entries(candidate.keybindings)) {
    assert.ok(key in keys.KEYBINDINGS, `unknown keybinding: ${key}`);
    assert.deepEqual(
      keybindings.getEffectiveConfig()[key],
      typeof value === "string" ? [value] : value,
      `keybinding consumer lost ${key}`,
    );
  }
  const models = await sdk.ModelRuntime.create({
    authPath: join(agent, "auth.json"),
    modelsPath: join(agent, "models.json"),
    modelsStorePath: join(agent, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  assert.equal(models.getError(), undefined, `models consumer: ${models.getError()}`);
  const settings = sdk.SettingsManager.create(home, agent, { projectTrusted: false });
  assert.deepEqual(settings.drainErrors(), [], "settings load failed");
  for (const [key, value] of Object.entries(candidate.settings))
    assert.deepEqual(settings.getGlobalSettings()[key], value, `settings consumer lost ${key}`);
  const requiredSkills: string[] = [];
  function skillEntries(directory: string) {
    const entries = readdirSync(directory, { withFileTypes: true });
    // realpath does not normalize spelling on every case-folding filesystem.
    // Start from the physical directory entry, then compare actual identities.
    const physicalSkill = entries.find((entry) => entry.name.toLowerCase() === "skill.md");
    if (physicalSkill) {
      requiredSkills.push(realpathSync(join(directory, physicalSkill.name)));
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
        skillEntries(join(directory, entry.name));
  }
  skillEntries(join(home, ".config/agents/skills"));
  const loader = new sdk.DefaultResourceLoader({
    cwd: home,
    agentDir: agent,
    settingsManager: settings,
    additionalPromptTemplatePaths: [join(agent, "agents")],
  });
  async function reload() {
    await loader.reload();
    assert.deepEqual(settings.drainErrors(), [], "settings reload failed");
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, [], "source extension registrations failed");
    assert.deepEqual(
      loaded.extensions.map((extension: any) => realpathSync(extension.resolvedPath)).sort(),
      [...new Set(expectedExtensions)].sort(),
      "directory discovery lost manifest-selected source registrations",
    );
    assert.deepEqual(
      loader.getAgentsFiles().agentsFiles,
      [{ path: join(agent, "AGENTS.md"), content: guidance }],
      "SDK did not load exact candidate global guidance, or read unrelated ancestor context",
    );
    for (const resources of [loader.getSkills(), loader.getPrompts(), loader.getThemes()])
      assert.equal(
        resources.diagnostics.filter((d: any) => d.type === "error").length,
        0,
        JSON.stringify(resources.diagnostics),
      );
    assert.ok(loader.getSkills().skills.length, "missing candidate skills");
    for (const file of requiredSkills)
      assert.ok(
        loader.getSkills().skills.some((skill: any) => realpathSync(skill.filePath) === file),
        `missing required candidate skill: ${file}`,
      );
    for (const name of requiredPrompts)
      assert.ok(
        loader.getPrompts().prompts.some((p: any) => p.name === name.replace(/\.md$/, "")),
        `missing loaded prompt ${name}`,
      );
    for (const name of (candidate.settings.theme ?? "system").split("/"))
      if (!["system", "dark", "light"].includes(name))
        assert.ok(
          loader.getThemes().themes.some((theme: any) => theme.name === name),
          `missing selected candidate theme: ${name}`,
        );
  }
  await reload();
  // Change only the temporary file to prove reload rereads disk, rather than merely returning cache.
  put(
    join(agent, "settings.json"),
    JSON.stringify({ ...candidate.settings, quietStartup: !candidate.settings.quietStartup }),
  );
  await reload();
  assert.equal(
    settings.getQuietStartup(),
    !candidate.settings.quietStartup,
    "settings reload did not observe disk change",
  );
  assert.deepEqual(attempts, [], "unexpected network/process access during registration");
  if (existsSync(join(agent, "auth.json")))
    assert.deepEqual(
      json(join(agent, "auth.json")),
      {},
      "unexpected credentials in fresh SDK auth storage",
    );
  return {
    status: "passed",
    sourceExtensions: loader.getExtensions().extensions.length,
    extensionDirectories: names.length,
    globalGuidanceBytes: Buffer.byteLength(guidance),
    skills: loader.getSkills().skills.length,
    prompts: loader.getPrompts().prompts.length,
    themes: loader.getThemes().themes.length,
    diagnostics: [loader.getSkills(), loader.getPrompts(), loader.getThemes()].flatMap(
      (resource) => resource.diagnostics,
    ),
    evidence: [
      "real SettingsManager disk reload",
      "real DefaultResourceLoader global directory/manifest discovery and resource reload",
      "candidate themes, skills, agent prompts and exact global guidance bytes",
      "real repository tool-policy and immutable-base/mutable-override consumers",
    ],
    limitations: [
      "no model requests, session lifecycle events, tool execution, personal data or live services",
      "settings shape checks cover consumed candidate fields, not every SDK option",
      "network/process denial is a test boundary, not a security sandbox; CI requires a disposable VM",
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    const argv = process.argv.slice(2);
    let root = repository;
    const rootPrefix = argv[0] === "--root";
    if (rootPrefix) {
      assert.ok(argv[1] && !argv[1].startsWith("--"), "--root requires CANDIDATE_ROOT");
      root = resolve(argv[1]);
      argv.splice(0, 2);
    }
    const [command, ...args] = argv;
    let result;
    if (command === "docs") result = docs(args, root);
    else if (command === "manifest" && !args.length) result = manifest(root);
    else if (command === "pi" && !args.length) result = pi(root);
    else if (command === "tools" && !args.length) result = tools(root);
    else if (command === "_pi-child" && !rootPrefix && args.length === 2)
      result = await piChild(resolve(args[0]), resolve(args[1]));
    else
      throw new Error(
        "usage: node scripts/ci/probes.ts [--root CANDIDATE_ROOT] docs PATH... | manifest | pi | tools",
      );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
