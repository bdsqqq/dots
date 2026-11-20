import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventLogger, type ServiceEvent } from "../service-events/events.ts";
import { main, parse, UsageError } from "./cli.ts";
import { loadApps, nativeDeps } from "./pins.ts";

const catalog = loadApps();

test("parse dispatches each operation with exactly its inputs", () => {
  assert.deepEqual(parse(["record", "--repo", "/r", "rex"], catalog), { op: "record", repo: "/r", apps: [catalog.rex] });
  assert.deepEqual(parse(["install", "--repo", "/r"], catalog).apps, Object.values(catalog), "no app means all");
  const p = parse(["publish", "--remote", "git@x:y.git", "--host", "mbp-m2", "--cache-dir", "/c", "--notify", "helium"], catalog);
  assert.deepEqual(p, { op: "publish", remote: "git@x:y.git", host: "mbp-m2", cacheDir: "/c", notify: true, apps: [catalog.helium] });
});

test("invalid invocations fail before any work, naming the problem", () => {
  for (const [argv, expected] of [
    [["frobnicate"], /usage/],
    [["record"], /needs --repo/],
    [["record", "--repo"], /--repo needs a value/],
    [["record", "--repo", "/r", "nope"], /unknown app nope/],
    [["record", "--repo", "/r", "--remote", "x"], /does not take --remote/],
    [["publish", "--remote", "x"], /needs --host/],
    [["install", "--repo", "/r", "--force"], /unknown flag --force/],
  ] as const) assert.throws(() => parse([...argv], catalog), (e: unknown) => e instanceof UsageError && expected.test(e.message));
});

test("main emits one context-rich event per app and maps failure to a nonzero exit", async t => {
  const root = mkdtempSync(join(tmpdir(), "app-pins-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // rex: a bundle with a foreign identity (fails). helium: not installed (absent, succeeds).
  const impostor = join(root, "Rex.app/Contents");
  mkdirSync(impostor, { recursive: true });
  writeFileSync(join(impostor, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.impostor</string><key>CFBundleShortVersionString</key><string>9</string>
<key>CFBundleVersion</key><string>9</string></dict></plist>`);
  const local = { rex: { ...catalog.rex, bundle: join(root, "Rex.app") }, helium: { ...catalog.helium, bundle: join(root, "Helium.app") } };
  const events: ServiceEvent[] = [];
  const log = createEventLogger("app-pins", { sink: e => events.push(e) });
  const status = await main(["record", "--repo", root, "rex", "helium"], nativeDeps, log, local);
  assert.equal(status, 1);
  assert.deepEqual(events.map(e => [e.operation, e.context.action, e.outcome, e.context.reasonCode]),
    [["app.record", "rex", "failed", "bundle_identity_mismatch"], ["app.record", "helium", "succeeded", "absent"]]);
  assert.ok(!JSON.stringify(events).includes("impostor"), "no exception text in events");
});

test("usage errors exit 2 without emitting events", async () => {
  const events: ServiceEvent[] = [];
  assert.equal(await main(["record"], undefined, createEventLogger("app-pins", { sink: e => events.push(e) })), 2);
  assert.equal(events.length, 0);
});
