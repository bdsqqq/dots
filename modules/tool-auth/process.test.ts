import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { capture, privateFile } from "./process.ts";

test("linked native entrypoints cannot silently skip their readiness guard", () => {
  const root = mkdtempSync(join(tmpdir(), "auth-main-"));
  try {
    const entry = join(root, "entry.ts");
    writeFileSync(entry, `import { isMain } from ${JSON.stringify(new URL("./process.ts", import.meta.url).href)};\nif (isMain(import.meta.url)) process.exitCode = 13;\n`);
    symlinkSync(entry, join(root, "alias.ts"));
    for (const path of [entry, join(root, "alias.ts")]) {
      assert.equal(spawnSync(process.execPath, [path], { timeout: 5000 }).status, 13);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every unconfigured integration fails closed through real and linked entrypoints", () => {
  const root = mkdtempSync(join(tmpdir(), "auth-entrypoints-"));
  try {
    for (const [index, name] of [
      "../gog/auth.ts", "../goplaces/auth.ts", "../wacli/ready.ts",
      "../xurl/ready.ts", "../openhue/ready.ts", "../remindctl/ready.ts",
    ].entries()) {
      const entry = fileURLToPath(new URL(name, import.meta.url));
      const alias = join(root, `alias-${index}.ts`);
      symlinkSync(entry, alias);
      for (const path of [entry, alias]) {
        const result = spawnSync(process.execPath, [path], {
          env: { ...process.env, TOOL_AUTH_GOG_ENABLED: "0", TOOL_AUTH_PLACES_ENABLED: "0" },
          encoding: "utf8", timeout: 5000,
        });
        assert.equal(result.status, 1, `${name}: ${result.stderr}`);
        assert.equal(result.stdout, "");
        assert.ok(result.stderr.trim(), name);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("process capture is bounded and never leaks failing command output", () => {
  const command = (body: string) => ({ executable: process.execPath, args: ["-e", body] });
  assert.equal(capture(command('process.stdout.write("fixture response")')), "fixture response");
  for (const body of [
    'process.stdout.write("fixture-secret"); process.stderr.write("fixture-secret"); process.exit(1)',
    'throw new Error("fixture-secret")',
    'process.stdout.write("fixture-secret"); setInterval(() => {}, 1000)',
    'process.stdout.write("fixture-secret".repeat(200000))',
  ]) {
    assert.throws(() => capture(command(body), 100), error =>
      error instanceof Error && error.message === "authentication check failed or timed out; use the tool's private setup flow");
  }
  assert.throws(() => capture({ executable: "/not/an/auth/executable", args: [] }), /authentication check failed/);
});

test("runtime secret checks accept private SOPS-style links, reject unsafe fixtures", () => {
  const root = mkdtempSync(join(tmpdir(), "tool-auth-"));
  try {
    const secret = join(root, "secret");
    const link = join(root, "runtime-link");
    writeFileSync(secret, "fixture-secret\n", { mode: 0o400 });
    symlinkSync(secret, link);
    assert.equal(privateFile(secret), "fixture-secret\n");
    assert.equal(privateFile(link), "fixture-secret\n");
    chmodSync(secret, 0o644);
    assert.throws(() => privateFile(link), /not a private file/);
    chmodSync(secret, 0o600);
    writeFileSync(secret, " \n");
    assert.throws(() => privateFile(secret), /empty/);
    writeFileSync(secret, "a".repeat(1024 * 1024 + 1));
    assert.throws(() => privateFile(secret), /not a private file/);
    mkdirSync(join(root, "directory"), { mode: 0o700 });
    for (const path of [join(root, "missing"), join(root, "directory"), "/nix/store/fixture-secret", "relative-secret"]) {
      assert.throws(() => privateFile(path));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
