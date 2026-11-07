import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, lchmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUNDLE_ID, install, listenerOwned, loadedAgentPid, parseConfig, provision, requirement, verifyApp, type HostConfig } from "./host-install.ts";
import { DEPLOYMENT_PLACEHOLDER, parseDeployment, runningDeployment } from "./deployment.ts";

const native = process.platform === "darwin" && !!process.env.HUE_SIGNER;
test("deployment metadata is bounded and legacy source runs do not claim a signed installation", async () => {
  assert.deepEqual(parseDeployment({ schemaVersion: 1, deploymentId: "a".repeat(64), privateField: "not public" }), { schemaVersion: 1, deploymentId: "a".repeat(64) });
  for (const value of [null, {}, { schemaVersion: 1, deploymentId: "private invalid value" }]) assert.throws(() => parseDeployment(value));
  assert.equal(await runningDeployment(), undefined);
  assert.throws(() => requirement("identifier-only"));
  assert.throws(() => parseConfig({} as HostConfig));
});
test("a matching version claim cannot substitute for ownership of the port and launch agent", () => {
  const destination = "/Applications/Hue Control.app";
  const definition = `arguments = ${destination}/Contents/MacOS/HueControl\n\tpid = 123\n`;
  assert.equal(loadedAgentPid(definition, destination), 123);
  assert.equal(listenerOwned(definition, destination, "123\n123\n"), true);
  assert.equal(listenerOwned(definition, destination, "999\n"), false);
  assert.equal(listenerOwned(definition, destination, "123\n999\n"), false);
  assert.equal(listenerOwned(definition.replace("\tpid = 123\n", ""), destination, "123"), false);
  assert.throws(() => listenerOwned("pid = 123", destination, "123"));
  assert.throws(() => loadedAgentPid(definition.replace("123", "999999999999999999999"), destination));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hue-signing-test-"));
  const destination = join(root, "installed", "Hue Control.app");
  await mkdir(join(root, "installed"));
  const config: HostConfig = { stateDir: join(root, "identity-state"), destination,
    signer: process.env.HUE_SIGNER!, openssl: process.env.HUE_OPENSSL ?? "/usr/bin/openssl", ownerUid: process.getuid!() };
  const app = async (name: string, binary: string) => {
    const folder = join(root, name, "Hue Control.app");
    await mkdir(join(folder, "Contents/MacOS"), { recursive: true });
    await mkdir(join(folder, "Contents/Resources"));
    await cp(binary, join(folder, "Contents/MacOS/HueControl"));
    await cp("/usr/bin/true", join(folder, "Contents/Resources/native.node"));
    await writeFile(join(folder, "Contents/Resources/payload.txt"), name);
    await symlink("payload.txt", join(folder, "Contents/Resources/payload-alias"));
    await writeFile(join(folder, "Contents/Resources/hue-control.mjs"), `const deploymentId = "${DEPLOYMENT_PLACEHOLDER}";`);
    await writeFile(join(folder, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string><key>CFBundleExecutable</key><string>HueControl</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>`);
    return folder;
  };
  const metadata = async () => parseDeployment(JSON.parse(await readFile(join(destination, "Contents/Resources/host-deployment.json"), "utf8")));
  return { root, config, app, metadata, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("different executable and resource bytes retain one authenticated identity; wrong identities fail", { skip: !native, timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    const signer = await provision(f.config);
    assert.equal((await provision(f.config)).fingerprint, signer.fingerprint, "normal deployment cannot regenerate a signer");
    const a = await f.app("artifact-a", process.execPath), b = await f.app("artifact-b", "/usr/bin/true");
    await assert.rejects(verifyApp(a, signer), "known bad: ad-hoc/unsigned code cannot satisfy the certificate-bound requirement");
    const first = await install(f.config, a), drA = await verifyApp(f.config.destination, signer);
    const second = await install(f.config, b), drB = await verifyApp(f.config.destination, signer);
    assert.notEqual(first.deploymentId, second.deploymentId);
    assert.equal(drA, drB, "changing the executable and resources must not change privacy identity");
    const backup = join(f.root, "installed/.Hue Control.previous.app");
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${drA}`, f.config.destination]);
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${drB}`, backup]);
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", "-R", `=certificate leaf = H\"${signer.fingerprint}\"`, join(f.config.destination, "Contents/Resources/native.node")]);
    assert.deepEqual(await install(f.config, b), second);
    const other = { ...f.config, stateDir: join(f.root, "other-identity") };
    await assert.rejects(verifyApp(f.config.destination, await provision(other)), "known bad: same app identifier, wrong signing key");
    const c = await f.app("artifact-c", "/usr/bin/true");
    await assert.rejects(install({ ...f.config, signer: "/usr/bin/false" }, c));
    assert.deepEqual(await f.metadata(), second, "sign failure preserves the installed generation");
    const unsafe = await f.app("external-reference", "/usr/bin/true");
    const unrelated = join(f.root, "unrelated-file");await writeFile(unrelated,"preserve this");
    const unrelatedMode = (await lstat(unrelated)).mode;
    await symlink(unrelated,join(unsafe,"Contents/Resources/outside"));
    await assert.rejects(install(f.config,unsafe),/EXTERNAL_BUNDLE_SYMLINK/);
    assert.equal(await readFile(unrelated,"utf8"),"preserve this");
    assert.equal((await lstat(unrelated)).mode, unrelatedMode, "link normalization must not chmod the external target");
    await writeFile(join(f.config.destination, "Contents/Resources/payload.txt"), "native user edit");
    await assert.rejects(install(f.config, c), "unverified native edits must not be overwritten");
    assert.equal(await readFile(join(f.config.destination, "Contents/Resources/payload.txt"), "utf8"), "native user edit");
  } finally { await f.cleanup(); }
});

test("the real packaged payload signs and verifies without touching its immutable source", { skip: !native || !process.env.HUE_APP_PAYLOAD, timeout: 120_000 }, async () => {
  const f = await fixture();
  const previousUmask = process.umask(0o077);
  async function publicRuntime(): Promise<void> {
    const resources = join(f.config.destination, "Contents/Resources");
    assert.equal((await lstat(join(resources,"node_modules/webbluetooth"))).mode & 0o777, 0o777, "root's umask must not make readlink private to root on macos");
    assert.equal((await stat(join(resources,"host-deployment.json"))).mode & 0o777, 0o644);
    const code = "process.stdout.write(typeof require('node:module').createRequire(process.argv[1])('webbluetooth').Bluetooth)";
    assert.equal(execFileSync(join(f.config.destination,"Contents/MacOS/HueControl"), ["-e", code, join(resources,"hue-control.mjs")], {encoding:"utf8"}), "function", "signed javascript and native dependencies load without acquiring the adapter");
  }
  try {
    const signed = await provision(f.config);
    await install(f.config, process.env.HUE_APP_PAYLOAD!);
    await verifyApp(f.config.destination, signed);
    await publicRuntime();
    const dependencyLink = join(f.config.destination,"Contents/Resources/node_modules/webbluetooth");
    await lchmod(dependencyLink,0o700);
    await verifyApp(f.config.destination,signed);
    await assert.rejects(publicRuntime(), "known bad: valid signature cannot excuse a root-private dependency symlink");
    await lchmod(dependencyLink,0o777);
    const sourceVersion = execFileSync(join(process.env.HUE_APP_PAYLOAD!, "Contents/MacOS/HueControl"), ["--version"], { encoding: "utf8" });
    assert.equal(execFileSync(join(f.config.destination, "Contents/MacOS/HueControl"), ["--version"], { encoding: "utf8" }), sourceVersion, "the signed Node executable must pass native runtime validation without invoking BLE");
    await assert.rejects(verifyApp(process.env.HUE_APP_PAYLOAD!, signed), "source payload remains ad-hoc, not silently re-signed in the store");
    if (process.env.HUE_UPGRADE_PAYLOAD) {
      const before = await verifyApp(f.config.destination, signed);
      const next = process.env.HUE_UPGRADE_PAYLOAD;
      await install(f.config, next);
      const after = await verifyApp(f.config.destination, signed);
      await publicRuntime();
      assert.equal(before, after);
      const nextVersion = execFileSync(join(f.config.destination, "Contents/MacOS/HueControl"), ["--version"], { encoding: "utf8" });
      assert.notEqual(nextVersion, sourceVersion, "the upgrade fixture must genuinely change Node versions");
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${before}`, f.config.destination]);
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${after}`, join(f.root,"installed/.Hue Control.previous.app")]);
    }
  } finally { process.umask(previousUmask); await f.cleanup(); }
});

test("interrupted replacement restores only our authenticated backup before attempting another install", { skip: !native, timeout: 30_000 }, async () => {
  const f=await fixture();
  try {
    await provision(f.config);
    const a=await f.app("recover-a","/usr/bin/true"), b=await f.app("recover-b","/usr/bin/true");
    const original=await install(f.config,a);
    await rename(f.config.destination,join(f.root,"installed/.Hue Control.previous.app"));
    await assert.rejects(install({...f.config,signer:"/usr/bin/false"},b));
    assert.deepEqual(await f.metadata(),original);
    await chmod(f.config.stateDir,0o755);
    await assert.rejects(provision(f.config),/INSECURE_SIGNING_STATE/);
    assert.equal((await stat(f.config.stateDir)).mode & 0o777,0o755,"do not silently repair permissions on existing state");
  }finally{await f.cleanup();}
});

test("missing private material fails closed rather than rotating permission identity", { skip: !native, timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const signer = await provision(f.config);
    await rm(join(f.config.stateDir, "identity/key.pem"));
    await assert.rejects(provision(f.config));
    const value = JSON.parse(await readFile(join(f.config.stateDir, "identity/identity.json"), "utf8"));
    assert.equal(value.fingerprint, signer.fingerprint);
  } finally { await f.cleanup(); }
});
