import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromUpstream, parseRelease, prepare, withVerifiedArchive } from "./release.ts";
import type { Release, Run } from "./release.ts";

const archive = "verified archive";
const sha256 = createHash("sha256").update(archive).digest("hex");
function record(version = "0.0.200-gbbb"): Release {
  const commit = "b".repeat(40);
  return {
    schemaVersion: 1, product: "rex", channel: "snapshot", version, commit,
    artifacts: {
      x64: { url: `https://blob.superlogical.com/download/rex/snapshot/${commit}/rex-linux-amd64.tar.gz`, sha256 },
      arm64: { url: `https://blob.superlogical.com/download/rex/snapshot/${commit}/rex-linux-arm64.tar.gz`, sha256 },
    },
  };
}
function upstream(release = record()) {
  return { ...release, artifacts: Object.entries(release.artifacts).map(([arch, artifact]) => ({
    filename: `rex-linux-${arch === "x64" ? "amd64" : "arm64"}.tar.gz`, downloadUrl: artifact.url, sha256: artifact.sha256,
  })) };
}
function temporary(t: { after: (callback: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), "rex-release-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function verifier({ badChecksum = false, wrongCommit = false, wrongVersion = false, symlink = false } = {}) {
  let probes = 0;
  const run: Run = (command, args) => {
    if (command === "curl") {
      writeFileSync(args[args.indexOf("--output") + 1], badChecksum ? "tampered archive" : archive);
    } else if (command === "tar") {
      const target = join(args[args.indexOf("--directory") + 1], "rex");
      if (symlink) symlinkSync("/nonexistent", target);
      else writeFileSync(target, "binary");
    } else {
      probes++;
      if (args[0] === "version") return `rex ${wrongVersion ? "0.0.200-other" : record().version}\ncommit: ${wrongCommit ? "a".repeat(40) : record().commit}\n`;
    }
    return "";
  };
  return { run, probes: () => probes };
}

test("release schema accepts only the two canonical linux artifact URLs", () => {
  assert.deepEqual(parseRelease(record()), record());
  const foreign = record(); foreign.artifacts.x64.url = "https://example.com/rex.tar.gz";
  assert.throws(() => parseRelease(foreign), /artifact/);
  assert.throws(() => parseRelease({ ...record(), schemaVersion: 2 }), /schema/);
  assert.throws(() => parseRelease({ ...record(), artifacts: { x64: record().artifacts.x64 } }), /architectures/);
  assert.throws(() => parseRelease({ ...record(), version: "x\nmalformed" }), /metadata/);
});

test("upstream conversion freezes both hashes without trusting arbitrary download fields", () => {
  assert.deepEqual(fromUpstream(upstream()), record());
  const duplicate = upstream(); duplicate.artifacts.push(duplicate.artifacts[0]);
  assert.throws(() => fromUpstream(duplicate), /duplicate/);
  assert.throws(() => fromUpstream({ ...upstream(), artifacts: [] }), /missing/);
});

test("prepare advances only its explicit release file and leaves equal/older pins untouched", t => {
  const root = temporary(t), file = join(root, "release.json"), unrelated = join(root, "settings.json");
  writeFileSync(file, JSON.stringify(record("0.0.100-gaaa")));
  writeFileSync(unrelated, "unpublished settings");
  assert.equal(prepare(file, () => JSON.stringify(upstream())), true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), record());
  assert.equal(prepare(file, () => JSON.stringify(upstream())), false);
  assert.equal(prepare(file, () => JSON.stringify(upstream(record("0.0.100-gaaa")))), false);
  assert.equal(readFileSync(unrelated, "utf8"), "unpublished settings");
});

test("republishing a pinned version with a different hash fails without rewriting it", t => {
  const file = join(temporary(t), "release.json"), original = JSON.stringify(record());
  writeFileSync(file, original);
  const changed = upstream(); changed.artifacts[0].sha256 = "0".repeat(64);
  assert.throws(() => prepare(file, () => JSON.stringify(changed)), /already pinned/);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("verified archive reaches the consumer only after checksum and exact build checks", () => {
  const f = verifier();
  assert.equal(withVerifiedArchive(record(), "x64", binary => readFileSync(binary, "utf8"), f.run), "binary");
  assert.equal(f.probes(), 2);
});

test("corrupt archives never execute or reach the consumer", () => {
  const f = verifier({ badChecksum: true });
  assert.throws(() => withVerifiedArchive(record(), "x64", () => assert.fail("published corrupt archive"), f.run), /checksum mismatch/);
  assert.equal(f.probes(), 0);
});

test("same numeric version with wrong build suffix/commit cannot be published", () => {
  for (const options of [{ wrongVersion: true }, { wrongCommit: true }]) {
    const f = verifier(options);
    assert.throws(() => withVerifiedArchive(record(), "x64", () => assert.fail("published wrong build"), f.run), /version\/commit mismatch/);
  }
});

test("archive symlinks are rejected before execution", () => {
  const f = verifier({ symlink: true });
  assert.throws(() => withVerifiedArchive(record(), "x64", () => assert.fail("published symlink"), f.run), /regular binary/);
  assert.equal(f.probes(), 0);
});

test("cli rejects mismatched runtime validation before fetching anything", t => {
  const file = join(temporary(t), "release.json");
  writeFileSync(file, JSON.stringify(record()));
  const wrongArch = process.arch === "x64" ? "arm64" : "x64";
  const result = spawnSync(process.execPath, [new URL("./release.ts", import.meta.url).pathname, "verify", file, wrongArch], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native linux runner/);
});
