import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

export type Platform = "aarch64-darwin" | "x86_64-linux";
export type Phase = "local" | "evaluation" | "artifact" | "host" | "runtime";
export type CommandSpec = {
  program: "node" | "pnpm" | "nix" | "nix-instantiate";
  args: string[];
  cwd?: string;
  timeoutSeconds: number;
  env?: Record<string, string>;
};
export type CheckSpec = {
  id: string;
  platform: Platform;
  phase: Phase;
  commands: CommandSpec[];
  reasons: string[];
};
export type Change = {
  status: "A" | "M" | "D" | "R" | "C" | "T";
  path: string;
  previousPath?: string;
};
export type Plan = {
  schemaVersion: 1;
  base: string;
  head: string;
  policyDigest: string;
  checks: CheckSpec[];
  blockers: string[];
  autoMergeEligible: boolean;
  changes: Change[];
};

export const platformForHost: Record<string, Platform> = {
  "mbp-m2": "aarch64-darwin",
  "mbp-m5": "aarch64-darwin",
  "mmn-m4": "aarch64-darwin",
  "lgo-z2e": "x86_64-linux",
  "htz-relay": "x86_64-linux",
  "htz-xfs-lab": "x86_64-linux",
  "gru-relay": "x86_64-linux",
};
export const hostTargets = Object.fromEntries(
  Object.entries(platformForHost).map(([host, platform]) => [
    host,
    platform === "aarch64-darwin"
      ? `darwinConfigurations.${host}.system`
      : `nixosConfigurations.${host}.config.system.build.toplevel`,
  ]),
) as Record<string, string>;
export const homeTargets = Object.fromEntries(
  Object.entries(platformForHost).map(([host, platform]) => [
    host,
    `${platform === "aarch64-darwin" ? "darwinConfigurations" : "nixosConfigurations"}.${host}.config.home-manager.users.bdsqqq.home.activationPackage`,
  ]),
) as Record<string, string>;
const platforms: Platform[] = ["aarch64-darwin", "x86_64-linux"];
const hosts = Object.keys(platformForHost).sort();
const shaPattern = /^[0-9a-f]{40}$/;
export function validateSha(value: string): void {
  if (!shaPattern.test(value)) throw new Error(`expected full lowercase commit SHA: ${value}`);
}
export function validPath(path: string): boolean {
  return (
    !!path &&
    !path.startsWith("-") &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !posix.isAbsolute(path) &&
    path.split("/").every((part) => !!part && part !== "." && part !== "..")
  );
}
function read(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
}
function filesIn(root: string, prefix = ""): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if ([".git", ".worktrees", "node_modules", "result", "dist"].includes(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...filesIn(root, path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const cmd = (
  program: CommandSpec["program"],
  args: string[],
  cwd?: string,
  timeoutSeconds = program === "nix" ? 1800 : 300,
  env?: Record<string, string>,
): CommandSpec => ({
  program,
  args,
  ...(cwd ? { cwd } : {}),
  timeoutSeconds,
  ...(env ? { env } : {}),
});
const node = (args: string[], cwd?: string) => cmd("node", args, cwd);
const pnpm = (args: string[], env?: Record<string, string>) =>
  cmd("pnpm", args, "modules/pi", 600, env);
const build = (target: string) =>
  cmd("nix", ["build", "--no-link", "--no-write-lock-file", `.#${target}`]);
const evaluate = (target: string) =>
  cmd("nix", ["eval", "--raw", "--no-write-lock-file", `.#${target}.drvPath`]);

type Graph = Map<string, Set<string>>;
// These are existing flake outputs, not host modules. Keep the mapping explicit:
// discovering a path in perSystem does not establish a host consumer.
const standalonePackages: {
  name: string;
  root: string;
  platforms: Platform[];
}[] = [
  { name: "tailnet-artifact-generator", root: "scripts/generate-tailnet-artifacts.py", platforms },
  {
    name: "photo-semantic-benchmark",
    root: "modules/photo-intelligence/benchmark/default.nix",
    platforms,
  },
  { name: "household-intake-smb-audit", root: "modules/household-intake/package.nix", platforms },
  {
    name: "kindle-tailscale-autostart",
    root: "modules/kindle-tailscale-autostart/default.nix",
    platforms: ["x86_64-linux"],
  },
];
const registeredChecks: Record<string, Platform[]> = {
  "household-intake-smb-audit": platforms,
  "credential-ownership": platforms,
  "credential-host-closures": platforms,
  "darwin-transcription": ["aarch64-darwin"],
  "wikiman-logging": ["aarch64-darwin"],
  "tailnet-artifacts": platforms,
  "tailnet-registry": platforms,
};
const checkRoots = [
  "modules/household-intake",
  "scripts/check-credential-ownership.py",
  "modules/darwin-transcription/darwin_transcription.py",
  "modules/darwin-transcription/test_darwin_transcription.py",
  "modules/wikiman/logging-check.nix",
  "modules/tailnet-registry/tailnet-registry.ts",
  "modules/tailnet-registry/tailnet-registry.test.ts",
  "scripts/generate-tailnet-artifacts.py",
];
function declaredOutputs(text: string): { packages: Set<string>; checks: Set<string> } {
  const result = { packages: new Set<string>(), checks: new Set<string>() };
  for (const match of text.matchAll(/\b(packages|checks)\.(?:"([^"]+)"|([\w-]+))\s*=/g))
    result[match[1] as "packages" | "checks"].add(match[2] ?? match[3]);
  return result;
}
function factoryRoots(host: string): string[] {
  const common = [
    "modules/tailnet/catalog.nix",
    "overlays/unstable.nix",
    "modules/zmx/default.nix",
  ];
  if (platformForHost[host] === "aarch64-darwin")
    return [
      ...common,
      "modules/o11y/default.nix",
      "overlays/axiom-cli.nix",
      "overlays/libplist-darwin.nix",
    ];
  return [
    ...common,
    ...(host === "htz-xfs-lab" ? [] : ["modules/o11y/default.nix"]),
    ...(host === "lgo-z2e" ? ["overlays/quickshell.nix"] : []),
  ];
}
function flakeRegions(text: string): { host: string; standalone: string; ambiguous: boolean } {
  const start = /\bperSystem\s*=/.exec(text)?.index;
  if (start === undefined) return { host: text, standalone: "", ambiguous: false };
  const boundary = /\n\s*flake\s*=/.exec(text.slice(start));
  if (!boundary) return { host: "", standalone: text, ambiguous: true };
  const end = start + boundary.index;
  return {
    host: text.slice(0, start) + text.slice(end),
    standalone: text.slice(start, end),
    ambiguous: false,
  };
}
const packagingPattern =
  /\b(?:mkDerivation|derivation|runCommand\w*|write[A-Z]\w*|symlinkJoin|buildEnv|build[A-Z]\w*|callPackage|overrideAttrs|fetch\w*|installPhase|buildPhase)\b|patches\s*=|home[.]activation|builtins[.]path/;
function idsOfStandaloneCheck(path: string): string[] {
  if (path === "modules/wikiman/logging-check.nix") return ["wikiman-logging"];
  if (/^modules\/household-intake\/(?:package\.nix|smb-audit(?:\.test)?\.mjs)$/.test(path))
    return ["household-intake-smb-audit"];
  if (
    /^modules\/darwin-transcription\/(?:darwin_transcription|test_darwin_transcription)\.py$/.test(
      path,
    )
  )
    return ["darwin-transcription"];
  if (/^modules\/tailnet-registry\/tailnet-registry(?:\.test)?\.ts$/.test(path))
    return ["tailnet-registry"];
  if (path === "scripts/generate-tailnet-artifacts.py") return ["tailnet-artifacts"];
  if (path === "scripts/check-credential-ownership.py") return ["credential-ownership"];
  return [];
}
/**
 * This is deliberately not a Nix evaluator. Literal relative paths produce
 * conservative edges; directory sources include all committed descendants.
 * Dynamic import forms cannot establish consumption and are blocked separately.
 */
function graphFor(files: string[], source: (path: string) => string | null): Graph {
  const graph: Graph = new Map();
  const known = new Set(files);
  for (const file of files.filter((path) => path.endsWith(".nix"))) {
    const edges = new Set<string>();
    const text = source(file) ?? "";
    for (const match of text.matchAll(/(?:^|[\s({=;\[])(\.{1,2}\/[a-zA-Z0-9_./+-]*)/gm)) {
      const path = posix.normalize(posix.join(posix.dirname(file), match[1]));
      if (path === ".") continue; // ./. is a flake root, not every host importing every host.
      if (known.has(path)) edges.add(path);
      if (known.has(`${path}/default.nix`)) edges.add(`${path}/default.nix`);
      else for (const child of files) if (child.startsWith(`${path}/`)) edges.add(child);
    }
    graph.set(file, edges);
  }
  return graph;
}
function closure(graph: Graph, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const child of graph.get(path) ?? []) visit(child);
  };
  roots.forEach(visit);
  return seen;
}

export function createPlan(options: {
  root: string;
  base: string;
  head: string;
  changes: Change[];
  policyRoot?: string;
  readBase?: (file: string) => string | null;
}): Plan {
  const { root, base, head } = options;
  const policyRoot = options.policyRoot ?? root;
  validateSha(base);
  validateSha(head);
  let candidateFiles: string[];
  let baseFiles: string[];
  if (options.readBase) {
    candidateFiles = filesIn(root);
    baseFiles = [
      ...new Set([
        ...candidateFiles,
        ...options.changes.flatMap((c) => [c.path, ...(c.previousPath ? [c.previousPath] : [])]),
      ]),
    ];
  } else {
    candidateFiles = git(root, ["ls-tree", "-r", "--name-only", "-z", head])
      .split("\0")
      .filter(Boolean);
    baseFiles = git(root, ["ls-tree", "-r", "--name-only", "-z", base]).split("\0").filter(Boolean);
  }
  const old =
    options.readBase ??
    ((path: string) => {
      try {
        return git(root, ["show", `${base}:${path}`]);
      } catch {
        return null;
      }
    });
  const current = (path: string) => read(root, path);
  const changes = options.changes
    .map((c) => ({ ...c }))
    .sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.status.localeCompare(b.status) ||
        (a.previousPath ?? "").localeCompare(b.previousPath ?? ""),
    );
  const blockers = new Set<string>();
  const checks = new Map<string, CheckSpec>();
  let eligible = true;
  const add = (
    id: string,
    platform: Platform,
    phase: Phase,
    commands: CommandSpec[],
    reason: string,
  ) => {
    const key = `${platform}:${id}`;
    const existing = checks.get(key);
    if (existing) existing.reasons = [...new Set([...existing.reasons, reason])].sort();
    else checks.set(key, { id, platform, phase, commands, reasons: [reason] });
  };
  const both = (id: string, phase: Phase, commands: CommandSpec[], reason: string) =>
    platforms.forEach((platform) => add(id, platform, phase, commands, reason));
  const nixCheck = (name: string, reason: string) =>
    (registeredChecks[name] ?? platforms).forEach((platform) =>
      add(
        `nix-check:${name}`,
        platform,
        "artifact",
        [evaluate(`checks.${platform}.${name}`), build(`checks.${platform}.${name}`)],
        reason,
      ),
    );
  const graphs = [graphFor(candidateFiles, current), graphFor(baseFiles, old)];
  const versions = [
    { files: candidateFiles, source: current, graph: graphs[0] },
    { files: baseFiles, source: old, graph: graphs[1] },
  ];
  const outputDeclarations = versions.map(({ source }) =>
    declaredOutputs(flakeRegions(source("flake.nix") ?? "").standalone),
  );
  const hostGraphs = versions.map(({ files, source }) =>
    graphFor(files, (path) =>
      path === "flake.nix" ? flakeRegions(source(path) ?? "").host : source(path),
    ),
  );
  const standaloneConsumers = new Map<string, Set<string>>();
  const standalonePaths = new Set<string>();
  const certifiedStandalonePaths = new Set<string>();
  const unmappedFactoryPaths = new Set<string>();
  const knownFactoryRoots = new Set(hosts.flatMap(factoryRoots));
  for (const graph of hostGraphs) {
    const unknown = [...(graph.get("flake.nix") ?? [])].filter(
      (path) => !path.startsWith("hosts/") && !knownFactoryRoots.has(path),
    );
    for (const path of closure(graph, unknown)) unmappedFactoryPaths.add(path);
  }
  for (const { files, source, graph } of versions) {
    const regions = flakeRegions(source("flake.nix") ?? "");
    const outputGraph = graphFor(["flake.nix", ...files.filter((p) => p !== "flake.nix")], (path) =>
      path === "flake.nix" ? regions.standalone : source(path),
    );
    for (const path of closure(graph, [...(outputGraph.get("flake.nix") ?? [])]))
      standalonePaths.add(path);
    for (const checkRoot of checkRoots) {
      const roots = files.filter((path) => path === checkRoot || path.startsWith(`${checkRoot}/`));
      for (const path of closure(graph, roots)) certifiedStandalonePaths.add(path);
    }
    for (const output of standalonePackages) {
      if (
        !new RegExp(`\\bpackages\\.${output.name}\\s*=`).test(regions.standalone) ||
        !outputGraph.get("flake.nix")?.has(output.root)
      )
        continue;
      const consumed = standaloneConsumers.get(output.name) ?? new Set<string>();
      for (const path of closure(graph, [output.root])) consumed.add(path);
      standaloneConsumers.set(output.name, consumed);
    }
  }
  const consumers = new Map<string, Set<string>>();
  for (const host of hosts) {
    const consumed = new Set<string>();
    for (const graph of hostGraphs) {
      // Known factories have platform-specific roots. A new relative helper
      // needs a policy mapping; flattening Darwin/Linux factories manufactures
      // consumers just as flattening perSystem would.
      const shared = factoryRoots(host).filter((path) => graph.get("flake.nix")?.has(path));
      for (const path of closure(graph, [`hosts/${host}/default.nix`, ...shared]))
        consumed.add(path);
    }
    consumers.set(host, consumed);
  }
  const affected = (path: string) => hosts.filter((host) => consumers.get(host)!.has(path));
  const evalHosts = (selected: string[], reason: string) =>
    selected.forEach((host) =>
      add(
        `evaluate:${host}`,
        platformForHost[host],
        "evaluation",
        [evaluate(hostTargets[host])],
        reason,
      ),
    );
  const hostBuilds = (selected: string[], reason: string) =>
    selected.forEach((host) =>
      add(`host:${host}`, platformForHost[host], "host", [build(hostTargets[host])], reason),
    );
  const homeBuilds = (selected: string[], reason: string) =>
    selected.forEach((host) =>
      add(
        `home:${host}`,
        platformForHost[host],
        "artifact",
        [evaluate(homeTargets[host]), build(homeTargets[host])],
        reason,
      ),
    );
  const packageChecks = (output: (typeof standalonePackages)[number], reason: string) => {
    if (!outputDeclarations[0].packages.has(output.name)) {
      blockers.add(`missing current standalone package export: ${output.name}`);
      return;
    }
    for (const platform of output.platforms) {
      const target = `packages.${platform}.${output.name}`;
      add(`evaluate-package:${output.name}`, platform, "evaluation", [evaluate(target)], reason);
      add(`package:${output.name}`, platform, "artifact", [build(target)], reason);
    }
  };
  const piChecks = (reason: string, production: boolean) => {
    // Extension packages use workspace aliases and inline tests: shared imports
    // can cross extension boundaries. A whole-suite run avoids an empty target
    // for thin wrappers and preserves coverage of reverse dependencies.
    both(
      "pi:local",
      "local",
      [
        pnpm(["exec", "tsc", "-p", "tsconfig.build.json", "--noEmit"]),
        pnpm(["exec", "vitest", "run"]),
      ],
      reason,
    );
    if (production)
      both(
        "pi:production",
        "artifact",
        [
          pnpm(["run", "build"]),
          node(["scripts/ci/probes.ts", "manifest"]),
          pnpm(["exec", "vitest", "run", "packages/core/prompt-patch"], {
            PI_TEST_BUILT_TOOLS: "1",
          }),
          node(["scripts/check-codemode.mjs"], "modules/pi"),
          node(["scripts/check-codemode.mjs", "--built"], "modules/pi"),
        ],
        reason,
      );
  };
  const agentChecks = (reason: string) =>
    both(
      "agents:local",
      "local",
      [
        pnpm(["install", "--frozen-lockfile"]),
        node([
          "--test",
          "modules/agents/check-skills.test.ts",
          "modules/agents/evaluate-skill-routing.test.ts",
        ]),
        node(["modules/agents/check-skills.ts"]),
        pnpm(["exec", "tsc", "-p", "../agents/tsconfig.json"]),
      ],
      reason,
    );
  const selfTests = (reason: string) =>
    both(
      "ci:self-tests",
      "local",
      [
        node([
          "--test",
          ...[
            ...new Set([
              "scripts/ci/policy.test.ts",
              "scripts/ci/probes.test.ts",
              ...candidateFiles.filter((path) => /^scripts\/ci\/[^/]+\.test\.ts$/.test(path)),
            ]),
          ].sort(),
        ]),
      ],
      reason,
    );
  const verifierChecks = (reason: string) => {
    selfTests(reason);
    both(
      "ci:typecheck",
      "local",
      [
        node([
          "modules/pi/node_modules/typescript/bin/tsc",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--module",
          "ESNext",
          "--moduleResolution",
          "Bundler",
          "--target",
          "ES2022",
          "--allowImportingTsExtensions",
          "--typeRoots",
          "modules/pi/node_modules/@types",
          "--types",
          "node",
          ...candidateFiles.filter((path) => /^scripts\/ci\/.*\.ts$/.test(path)).sort(),
        ]),
      ],
      reason,
    );
    both(
      "ci:workflow",
      "local",
      [
        cmd(
          "nix",
          [
            "run",
            "--no-write-lock-file",
            "--inputs-from",
            ".",
            "nixpkgs#actionlint",
            "--",
            ".github/workflows/verify.yml",
          ],
          undefined,
          300,
        ),
      ],
      reason,
    );
  };
  if (!changes.length) blockers.add("empty change set has no verification coverage");
  if (versions.some(({ source }) => flakeRegions(source("flake.nix") ?? "").ambiguous))
    blockers.add("unsupported flake layout: cannot separate host and standalone consumers");
  const paths = [
    ...new Set(changes.flatMap((c) => [c.path, ...(c.previousPath ? [c.previousPath] : [])])),
  ].sort();
  const invalid = changes.some(
    (c) =>
      !["A", "M", "D", "R", "C", "T"].includes(c.status) ||
      !validPath(c.path) ||
      (c.previousPath !== undefined && !validPath(c.previousPath)) ||
      (["R", "C"].includes(c.status) && !c.previousPath),
  );
  if (invalid) blockers.add("invalid change status or repository-relative path");
  for (const path of paths) {
    if (!validPath(path)) continue;
    let covered = false;
    const reason = `changed ${path}`;
    const text = `${current(path) ?? ""}\n${old(path) ?? ""}`;
    // Workspace/manifest config can override the fresh home's global release
    // age. A successful frozen install does not authorize weakening that policy.
    if (
      /(^|\/)(?:pnpm-workspace\.ya?ml|\.npmrc|\.pnpmrc)$/.test(path) ||
      /minimum[-_]?release[-_]?age|minimumReleaseAge|minimumReleaseAgeExclude|ignore[-_]?release[-_]?age/i.test(
        text,
      ) ||
      (/\/package\.json$/.test(path) && /"pnpm"\s*:|"packageManager"\s*:\s*"pnpm/.test(text))
    )
      eligible = false;
    const selected = path === "flake.nix" || path === "flake.lock" ? hosts : affected(path);
    const packageConsumers = standalonePackages.filter((output) =>
      standaloneConsumers.get(output.name)?.has(path),
    );
    if (
      standalonePaths.has(path) &&
      !packageConsumers.length &&
      !selected.length &&
      !idsOfStandaloneCheck(path).length
    )
      blockers.add(`unsupported standalone consumption: ${path}`);
    if (unmappedFactoryPaths.has(path) && !packageConsumers.length && !selected.length)
      blockers.add(`unsupported flake factory consumption: ${path}`);
    for (const output of packageConsumers) {
      covered = true;
      packageChecks(output, reason);
      if (
        !path.endsWith(".nix") &&
        !path.endsWith(".md") &&
        !idsOfStandaloneCheck(path).length &&
        !(output.name === "household-intake-smb-audit" && path.endsWith(".mjs"))
      )
        blockers.add(`standalone runtime input lacks bounded behavior check: ${path}`);
    }
    if (path.startsWith("modules/household-intake/") && /\.(mjs|nix)$/.test(path)) {
      covered = true;
      both(
        "household-intake:local",
        "local",
        [node(["--test", "modules/household-intake/smb-audit.test.mjs"])],
        reason,
      );
      nixCheck("household-intake-smb-audit", reason);
    }
    if (path.endsWith(".md")) {
      covered = true;
      if (current(path) !== null)
        both(`docs:${path}`, "local", [node(["scripts/ci/probes.ts", "docs", path])], reason);
      else
        both(
          "docs:deleted",
          "local",
          [
            node([
              "scripts/ci/probes.ts",
              "docs",
              ...candidateFiles.filter((p) => p.endsWith(".md")),
            ]),
          ],
          reason,
        );
    }
    if (path === "flake.lock") {
      covered = true;
      evalHosts(hosts, reason);
      hostBuilds(hosts, reason);
    }
    if (path === "flake.nix" || path === "flake.lock") {
      // Forcing systems does not force lazy perSystem output arguments. Input
      // changes must also exercise every registered independent derivation.
      for (const output of standalonePackages)
        if (outputDeclarations.some((version) => version.packages.has(output.name)))
          packageChecks(output, reason);
      for (const name of Object.keys(registeredChecks)) {
        if (!outputDeclarations.some((version) => version.checks.has(name))) continue;
        if (!outputDeclarations[0].checks.has(name))
          blockers.add(`missing current standalone check export: ${name}`);
        else nixCheck(name, reason);
      }
      for (const version of outputDeclarations) {
        for (const name of version.packages)
          if (!standalonePackages.some((output) => output.name === name))
            blockers.add(`unmapped standalone package export: ${name}`);
        for (const name of version.checks)
          if (!Object.hasOwn(registeredChecks, name))
            blockers.add(`unmapped standalone check export: ${name}`);
      }
      for (const standalonePath of standalonePaths) {
        if (
          standalonePackages.some((output) =>
            standaloneConsumers.get(output.name)?.has(standalonePath),
          ) ||
          certifiedStandalonePaths.has(standalonePath) ||
          affected(standalonePath).length
        )
          continue;
        blockers.add(`unmapped standalone flake input: ${standalonePath}`);
      }
      for (const { source } of versions)
        if (
          /\b(?:packages|checks)\s*=|\b(?:packages|checks)\s*\.\s*\$\{[^}]*\}(?:\.[\w"-]+)*\s*=/.test(
            flakeRegions(source("flake.nix") ?? "").standalone,
          )
        )
          blockers.add("unsupported dynamic/attrset standalone output declarations");
    }
    if (path.endsWith(".nix")) {
      covered = true;
      if (current(path) !== null)
        both(`parse:${path}`, "local", [cmd("nix-instantiate", ["--parse", path])], reason);
      // Deleted files are covered by evaluating their previous consumers.
      if (!selected.length && !packageConsumers.length && !idsOfStandaloneCheck(path).length)
        blockers.add(
          `${standalonePaths.has(path) ? "unsupported standalone nix consumer" : "unconsumed nix path"}: ${path}`,
        );
      evalHosts(selected, reason);
      if (
        /import\s+(?!\.{1,2}\/|inputs[.]|<)[a-zA-Z_][\w]*\s*(?:[;({]|$)/m.test(text) ||
        /(?:\.{1,2}\/)[^\s;]*\$\{/.test(text) ||
        /\bimports\s*=\s*[a-zA-Z_]/.test(text)
      ) {
        blockers.add(`unsupported dynamic nix consumption: ${path}`);
      }
      const homeOnly = [
        "modules/pi/default.nix",
        "modules/agents/default.nix",
        "modules/agents/skills.nix",
        "modules/node-pnpm/default.nix",
      ].includes(path);
      const integration =
        /\b(boot|fileSystems|disko|security|systemd|launchd|activationScripts)\b|networking[.]firewall|services[.]openssh/.test(
          text,
        );
      const packaging = packagingPattern.test(text);
      if (homeOnly && (packaging || path === "modules/node-pnpm/default.nix"))
        homeBuilds(selected, reason);
      else if (path === "flake.nix" || integration || packaging)
        hostBuilds(
          selected,
          `${reason}: ${
            path === "flake.nix"
              ? "shared flake infrastructure"
              : integration
                ? "host integration/security/service ordering"
                : "packaging has no isolated derivation mapping; assemble consumer closure"
          }`,
        );
      if (path === "modules/agents/default.nix") {
        agentChecks(reason);
        add(
          "agents:darwin-case-hook",
          "aarch64-darwin",
          "runtime",
          [node(["--test", "modules/agents/test-skill-case-repair.test.ts"])],
          reason,
        );
      }
    }
    if (
      /credential|secrets|\.sops\.yaml/.test(path) ||
      (path.endsWith(".nix") && /\bsops\b|authKeyFile/.test(text))
    ) {
      covered = true;
      nixCheck("credential-ownership", reason);
      nixCheck("credential-host-closures", reason);
      evalHosts(selected, reason);
    }
    if (path.startsWith("modules/pi/") && !path.endsWith(".nix") && !path.endsWith(".md")) {
      covered = true;
      const production =
        /^(modules\/pi\/)(packages\/core\/|patches\/|src\/|dist\/|scripts\/|package\.json$|pnpm-|tsdown|vitest|test\/|tsconfig)/.test(
          path,
        ) ||
        (/\/package\.json$/.test(path) && /"peerDependencies"/.test(text));
      const theme = /^modules\/pi\/packages\/extensions\/editor\/themes\/[^/]+\.json$/.test(path);
      const runtime =
        /\/(settings|tool-policy|keybindings|models)\.json$|\/package\.json$/.test(path) || theme;
      const dataResource = /\.(json|yaml|yml)$/.test(path);
      const evaluationConfig = [
        "modules/pi/tsconfig.json",
        "modules/pi/tsconfig.build.json",
        "modules/pi/pnpm-lock.yaml",
        "modules/pi/pnpm-workspace.yaml",
      ].includes(path);
      if (dataResource && !runtime && !evaluationConfig)
        blockers.add(`pi resource lacks consumer check: ${path}`);
      if (/\.(ts|mjs)$/.test(path) || production || runtime) piChecks(reason, production);
      else if (!runtime && !evaluationConfig)
        blockers.add(`pi resource lacks consumer check: ${path}`);
      if (/\/(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$|\/patches\//.test(path))
        both("pi:install", "local", [pnpm(["install", "--frozen-lockfile"])], reason);
      if (runtime)
        both(
          "pi:runtime",
          "runtime",
          [
            node(["scripts/ci/probes.ts", "pi"]),
            node(["scripts/check-codemode.mjs"], "modules/pi"),
          ],
          reason,
        );
      if (path.startsWith("modules/pi/packages/extensions/zmx/")) {
        const zmxHosts = affected("modules/zmx/default.nix");
        if (!zmxHosts.length) blockers.add(`missing zmx wrapper consumer: ${path}`);
        evalHosts(zmxHosts, reason);
        zmxHosts.forEach((host) => {
          const configuration = `${platformForHost[host] === "aarch64-darwin" ? "darwinConfigurations" : "nixosConfigurations"}.${host}`;
          const expression = `let f = builtins.getFlake (toString ./.); ps = f.${configuration}.config.home-manager.users.bdsqqq.home.packages; matches = builtins.filter (p: (p.name or "") == "zmx-rows") ps; in assert builtins.length matches == 1; builtins.head matches`;
          add(
            `zmx-rows:${host}`,
            platformForHost[host],
            "artifact",
            [
              cmd("nix", [
                "build",
                "--no-link",
                "--no-write-lock-file",
                "--impure",
                "--expr",
                expression,
              ]),
            ],
            reason,
          );
        });
      }
    }
    if (path.startsWith("modules/pi/") && /\/prompts\/.*\.md$/.test(path)) {
      covered = true;
      both(
        "pi:runtime",
        "runtime",
        [node(["scripts/ci/probes.ts", "pi"]), node(["scripts/check-codemode.mjs"], "modules/pi")],
        reason,
      );
    }
    const nodeToolsInput = [
      "modules/node-pnpm/package.json",
      "modules/node-pnpm/pnpm-lock.yaml",
      "modules/node-pnpm/pnpm-workspace.yaml",
      "modules/node-pnpm/config.yaml",
      "modules/node-pnpm/pi-cli/package.json",
      "modules/node-pnpm/pi-cli/bin/pi",
    ].includes(path);
    if (nodeToolsInput || path === "modules/node-pnpm/default.nix") {
      covered = true;
      // Version probes establish only these three command authorities, not
      // behavioral compatibility of every global dependency or install policy.
      eligible = false;
      const toolsReason = `${reason}: frozen global workspace; version authority covers only pi, codex, t3`;
      both(
        "node-pnpm:install",
        "local",
        [cmd("pnpm", ["install", "--frozen-lockfile"], "modules/node-pnpm", 600)],
        toolsReason,
      );
      // The global pi binary is a bridge into this separately locked workspace.
      both("pi:install", "local", [pnpm(["install", "--frozen-lockfile"])], toolsReason);
      piChecks(toolsReason, false);
      both("node-pnpm:tools", "runtime", [node(["scripts/ci/probes.ts", "tools"])], toolsReason);
      if (path === "modules/node-pnpm/config.yaml") {
        const toolsHosts = affected("modules/node-pnpm/default.nix");
        evalHosts(toolsHosts, reason);
        homeBuilds(toolsHosts, reason);
        if (!toolsHosts.length) blockers.add(`missing pnpm configuration consumer: ${path}`);
      } else if (nodeToolsInput && selected.length) {
        // t3-code/server.nix embeds package/lock bytes in restartTriggers. The
        // global install is out-of-store, but those service inputs are not.
        hostBuilds(selected, `${reason}: global tool input embedded in consuming host closure`);
      }
    }
    if (
      (path.startsWith("modules/agents/") && !path.endsWith(".nix")) ||
      path === "config/global-agents.md" ||
      /(^|\/)AGENTS\.md$/.test(path)
    ) {
      covered = true;
      agentChecks(reason);
      if (/(^|\/)AGENTS\.md$/.test(path) || path === "config/global-agents.md") eligible = false;
      if (
        /\.(py|sh|js|mjs|ts)$/.test(path) &&
        !/^modules\/agents\/(check-skills|evaluate-skill-routing|test-skill-case-repair)(\.test)?\.ts$/.test(
          path,
        )
      )
        blockers.add(`agent runtime source lacks bounded behavior check: ${path}`);
      if (path.startsWith("modules/agents/skills/")) {
        const agentHosts = affected("modules/agents/default.nix");
        evalHosts(agentHosts, reason);
        homeBuilds(agentHosts, reason);
        if (!agentHosts.length) blockers.add(`missing installed skill consumer: ${path}`);
      }
      if (
        path.startsWith("modules/agents/agents/") ||
        path === "modules/agents/bds-pi.json" ||
        path === "config/global-agents.md"
      )
        both(
          "pi:runtime",
          "runtime",
          [
            node(["scripts/ci/probes.ts", "pi"]),
            node(["scripts/check-codemode.mjs"], "modules/pi"),
          ],
          reason,
        );
    }
    const tailnet =
      /^(modules\/tailnet\/|modules\/tailnet-registry\/|generated\/|tailscale\/|cloudflare\/)|^scripts\/generate-tailnet-artifacts/.test(
        path,
      );
    for (const check of idsOfStandaloneCheck(path)) {
      covered = true;
      nixCheck(check, reason);
    }
    if (
      [
        "modules/pi/tool-policy.json",
        "modules/pi/settings.json",
        "modules/pi/models.json",
        "modules/pi/keybindings.json",
        "modules/agents/bds-pi.json",
      ].includes(path)
    )
      eligible = false;
    if (tailnet) {
      nixCheck("tailnet-artifacts", reason);
      if (path.startsWith("modules/tailnet-registry/")) {
        nixCheck("tailnet-registry", reason);
        covered = true;
      }
      if (
        path.startsWith("generated/") ||
        path.startsWith("modules/tailnet/") ||
        path === "scripts/generate-tailnet-artifacts.py"
      )
        covered = true;
    }
    if (
      path.startsWith("scripts/ci/") ||
      path.startsWith(".github/") ||
      [".gitignore", ".gitattributes"].includes(path)
    ) {
      covered = path.startsWith("scripts/ci/") || path.startsWith(".github/");
      eligible = false;
      verifierChecks(reason);
    }
    if (selected.length && !path.endsWith(".nix") && path !== "flake.lock") {
      evalHosts(selected, reason);
      const knownStore =
        path.startsWith("modules/agents/skills/") ||
        path.startsWith("modules/pi/packages/extensions/zmx/") ||
        tailnet ||
        /credential|secrets/.test(path) ||
        nodeToolsInput;
      if (!knownStore) {
        hostBuilds(selected, reason);
        if (!path.endsWith(".md"))
          blockers.add(`store/evaluation input lacks bounded local behavior check: ${path}`);
      }
    }
    if (!covered) {
      blockers.add(`unsupported path: ${path}`);
      eligible = false;
      selfTests(reason);
    }
  }
  // Hash the policy that actually planned the candidate, not its proposed
  // replacement. Workers/gate/probes are part of that same authority contract.
  const policyFiles = filesIn(policyRoot);
  const digestFiles = [
    ...new Set([
      "AGENTS.md",
      "scripts/ci/policy.ts",
      "scripts/ci/plan.ts",
      ...policyFiles.filter(
        (path) => path.endsWith("/AGENTS.md") || /^scripts\/ci\/.*\.ts$/.test(path),
      ),
    ]),
  ].sort();
  const digest = createHash("sha256");
  for (const path of digestFiles)
    digest.update(`${path}\0${read(policyRoot, path) ?? "<missing>"}\0`);
  const phaseOrder: Phase[] = ["local", "evaluation", "artifact", "host", "runtime"];
  return {
    schemaVersion: 1,
    base,
    head,
    policyDigest: digest.digest("hex"),
    checks: [...checks.values()].sort(
      (a, b) =>
        a.platform.localeCompare(b.platform) ||
        phaseOrder.indexOf(a.phase) - phaseOrder.indexOf(b.phase) ||
        a.id.localeCompare(b.id),
    ),
    blockers: [...blockers].sort(),
    autoMergeEligible: eligible && blockers.size === 0,
    changes,
  };
}
