import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const upstreamReleaseUrl = "https://blob.superlogical.com/api/releases/rex/snapshot";
export const publishedReleaseUrl = "https://raw.githubusercontent.com/bdsqqq/dots/main/modules/rex/release.json";
export type Architecture = "x64" | "arm64";
export type Run = (command: string, args: string[]) => string;
export type Release = {
  schemaVersion: 1;
  product: "rex";
  channel: "snapshot";
  version: string;
  commit: string;
  artifacts: Record<Architecture, { url: string; sha256: string }>;
};
export const runCommand: Run = (command, args) => execFileSync(command, args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 120_000,
});
export const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const curl = ["--fail", "--silent", "--show-error", "--location", "--proto", "=https",
  "--proto-redir", "=https", "--connect-timeout", "15", "--max-time", "120"];
const names: Record<Architecture, string> = { x64: "amd64", arm64: "arm64" };
const semanticVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

export function reportedVersion(text: string): string {
  const match = text.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?\b/);
  if (!match) throw new Error("rex did not report a recognizable version");
  return match[0];
}
export function version(text: string): number[] {
  return reportedVersion(text).split(/[-+]/)[0].split(".").map(Number);
}
export function newer(candidate: string, installed: string): boolean {
  const a = version(candidate), b = version(installed);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid rex release object");
  return value as Record<string, unknown>;
}
function identity(value: unknown) {
  const data = object(value);
  if (data.product !== "rex" || data.channel !== "snapshot" ||
      typeof data.version !== "string" || !semanticVersion.test(data.version) ||
      typeof data.commit !== "string" || !/^[a-f0-9]{40}$/.test(data.commit)) {
    throw new Error("unexpected rex release metadata");
  }
  return { version: data.version, commit: data.commit };
}
function url(commit: string, arch: Architecture) {
  return `https://blob.superlogical.com/download/rex/snapshot/${commit}/rex-linux-${names[arch]}.tar.gz`;
}

/** the git record is an allowlist, not an arbitrary download instruction. */
export function parseRelease(value: unknown): Release {
  const data = object(value), release = identity(data), artifacts = object(data.artifacts);
  if (data.schemaVersion !== 1 || Object.keys(artifacts).sort().join(",") !== "arm64,x64") {
    throw new Error("unsupported rex release schema/architectures");
  }
  const checked = {} as Release["artifacts"];
  for (const arch of ["x64", "arm64"] as const) {
    const artifact = object(artifacts[arch]);
    if (artifact.url !== url(release.commit, arch) || typeof artifact.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`invalid rex ${arch} artifact`);
    checked[arch] = { url: artifact.url, sha256: artifact.sha256 };
  }
  return { schemaVersion: 1, product: "rex", channel: "snapshot", ...release, artifacts: checked };
}
export function fromUpstream(value: unknown): Release {
  const data = object(value), release = identity(data);
  if (!Array.isArray(data.artifacts)) throw new Error("missing rex upstream artifacts");
  const artifacts = {} as Release["artifacts"];
  for (const arch of ["x64", "arm64"] as const) {
    const matches = data.artifacts.filter(entry => object(entry).filename === `rex-linux-${names[arch]}.tar.gz`);
    if (matches.length !== 1) throw new Error(`missing or duplicate rex ${arch} archive`);
    const artifact = object(matches[0]);
    artifacts[arch] = { url: artifact.downloadUrl as string, sha256: artifact.sha256 as string };
  }
  return parseRelease({ schemaVersion: 1, product: "rex", channel: "snapshot", ...release, artifacts });
}
export function fetchRelease(source: string, run: Run = runCommand): Release {
  return parseRelease(JSON.parse(run("curl", [...curl, "--header", "Cache-Control: no-cache", source])));
}

/** publication freezes one candidate; validators must never refetch a moving channel. */
export function prepare(path: string, run: Run = runCommand): boolean {
  const previous = parseRelease(JSON.parse(readFileSync(path, "utf8")));
  const candidate = fromUpstream(JSON.parse(run("curl", [...curl, upstreamReleaseUrl])));
  if (candidate.version === previous.version && JSON.stringify(candidate) !== JSON.stringify(previous)) {
    throw new Error("upstream changed an already pinned rex version");
  }
  if (!newer(candidate.version, previous.version)) return false;
  const temporary = `${path}.candidate-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(candidate, null, 2)}\n`);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

/** checksum and exact build identity must pass before a consumer can publish/install. */
export function withVerifiedArchive<T>(release: Release, arch: Architecture, consume: (binary: string) => T,
  run: Run = runCommand): T {
  const artifact = parseRelease(release).artifacts[arch];
  const directory = mkdtempSync(join(tmpdir(), "rex-release-"));
  try {
    const archive = join(directory, "release.tar.gz"), binary = join(directory, "rex");
    run("curl", [...curl, "--output", archive, artifact.url]);
    if (digest(archive) !== artifact.sha256) throw new Error("rex archive checksum mismatch");
    run("tar", ["--extract", "--gzip", "--file", archive, "--directory", directory, "--no-same-owner", "rex"]);
    if (!lstatSync(binary).isFile()) throw new Error("rex archive member is not a regular binary");
    chmodSync(binary, 0o755);
    run(binary, ["--help"]);
    const report = run(binary, ["version"]);
    if (reportedVersion(report) !== release.version ||
        report.match(/^commit:\s*([a-f0-9]{40})\s*$/m)?.[1] !== release.commit) {
      throw new Error("rex archive version/commit mismatch");
    }
    return consume(binary);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, path, arch] = process.argv.slice(2);
  if (!path) throw new Error("usage: release.ts prepare FILE | verify FILE x64|arm64");
  if (command === "prepare") console.log(prepare(path) ? "rex candidate advanced" : "rex pin unchanged");
  else if (command === "verify") {
    if (process.platform !== "linux" || arch !== process.arch || (arch !== "x64" && arch !== "arm64")) {
      throw new Error("rex validation requires a native linux runner matching the artifact architecture");
    }
    const release = parseRelease(JSON.parse(readFileSync(path, "utf8")));
    withVerifiedArchive(release, arch, () => console.log(`verified ${release.version} ${release.commit} ${arch}`));
  } else throw new Error(`unsupported rex release command: ${command}`);
}
