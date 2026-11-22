import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readRunLog, parseRunLog } from './control.ts';
import { fileURLToPath } from 'node:url';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));

test('native lifecycle wrapper lets its child finish through SIGINT before reconciliation', () => {
  const result = spawnSync('/bin/bash', [join(moduleDir, 'native-command.sh'), '/bin/bash', '-c', 'kill -INT "$$"; printf finished'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'finished');
});

test('native read-only launchd lookup survives foreground cancellation signals', { skip: process.platform !== 'darwin' }, () => {
  for (const signal of ['INT', 'TERM']) {
    const result = spawnSync('/bin/bash', [join(moduleDir, 'native-command.sh'), '/bin/bash', '-c', `kill -${signal} "$$"; exec /bin/launchctl print system/com.bdsqqq.nonexistent-kanata-fixture`], { encoding: 'utf8' });
    assert.equal(result.signal, null);
    assert.match(result.stderr, /Could not find service/);
  }
});

test('run log reader finds the current startup behind megabytes of heartbeats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanata-log-'));
  try {
    const text = '00:00:00.0000 [INFO] kanata v1.12 starting\nvirtual_hid_keyboard_ready true\nkeyboard grabbed, entering event processing loop\n'
      + '02:00:00.0000 [INFO] kanata v1.12 starting\ncleared stale virtual HID keyboard state\nkeyboard grabbed, entering event processing loop\n'
      + 'virtual_hid_keyboard_ready true\n'.repeat(40_000)
      + 'output backend unavailable — releasing input devices\nInput devices released\n';
    const path = join(dir, 'run.log');
    writeFileSync(path, text);
    const actual = readRunLog(path);
    assert.deepEqual(actual, parseRunLog(text));
    assert.match(actual.start ?? '', /^02:00:00/);
    assert.match(actual.backend ?? '', /unavailable/);
    assert.match(actual.input ?? '', /released/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('evaluated activation command stages runnable signed files only into a temporary prefix', { skip: process.platform !== 'darwin' }, () => {
  const evaluated = spawnSync('nix', ['eval', '--raw', '--no-write-lock-file', '.#darwinConfigurations.mbp-m2.config.system.activationScripts.extraActivation.text'], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  assert.equal(evaluated.status, 0, evaluated.stderr);
  // Expand the trusted Nix-generated argument list for inspection, not execution.
  const expanded = spawnSync('/bin/bash', ['-c', `printf '%s\\0' ${evaluated.stdout}`], { encoding: 'utf8' });
  assert.equal(expanded.status, 0, expanded.stderr);
  const args = expanded.stdout.split('\0').filter(Boolean);
  assert.equal(args.length, 4);
  assert.ok(args[2].endsWith('/modules/kanata/install.ts'));
  const binding = JSON.parse(args[3]);
  assert.equal(binding.stage[0], join(dirname(args[2]), 'activate.sh'));
  // Host wiring targets its canonical checkout; isolated verification exercises
  // this checkout's helper, never a different worktree's executable source.
  const stage = ['/bin/bash', join(moduleDir, 'activate.sh'), ...binding.stage.slice(1)];
  assert.equal(stage[7], '/usr/local/bin/kanata');
  assert.equal(stage[8], '/usr/local/lib/kanata');
  // eval names the fetched installer without downloading it, and a bare store
  // path can't be fetched; realise the derivation that produces it.
  const toplevel = spawnSync('nix', ['eval', '--raw', '--no-write-lock-file', '.#darwinConfigurations.mbp-m2.config.system.build.toplevel.drvPath'], { cwd: root, encoding: 'utf8', timeout: 300_000 });
  assert.equal(toplevel.status, 0, toplevel.stderr);
  const producer = spawnSync('nix-store', ['-qR', toplevel.stdout], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .stdout.split('\n').find((drv) => drv.endsWith(`${binding.package.slice('/nix/store/'.length + 33)}.drv`));
  assert.ok(producer, `no derivation produces ${binding.package}`);
  const fetched = spawnSync('nix-store', ['--realise', producer], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(fetched.status, 0, fetched.stderr);
  const signature = spawnSync('/usr/sbin/pkgutil', ['--check-signature', binding.package], { encoding: 'utf8' });
  assert.equal(signature.status, 0, signature.stderr);
  assert.match(signature.stdout, /Developer ID Installer: Fumihiko Takayama \(G43BCU2T37\)/);
  const payload = spawnSync('/usr/sbin/pkgutil', ['--payload-files', binding.package], { encoding: 'utf8' });
  assert.equal(payload.status, 0, payload.stderr);
  assert.match(payload.stdout, /Karabiner-VirtualHIDDevice-Manager.app\/Contents\/MacOS/);
  assert.match(payload.stdout, /Karabiner-VirtualHIDDevice-Daemon.app\/Contents\/MacOS/);
  assert.ok(!payload.stdout.includes('LaunchDaemons'), 'the pinned installer must not create a second daemon owner');
  const dir = mkdtempSync(join(tmpdir(), 'kanata staging-'));
  try {
    stage[7] = join(dir, 'bin', 'kanata');
    stage[8] = join(dir, 'lib', 'kanata');
    const run = () => spawnSync(stage[0], stage.slice(1), { encoding: 'utf8', timeout: 30_000 });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    const installed = stage[7];
    assert.equal(statSync(installed).mode & 0o777, 0o755);
    const version = spawnSync(installed, ['--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /kanata/);
    const validation = spawnSync(installed, ['--check', '--cfg', join(root, 'assets', 'kanata.kbd')], { encoding: 'utf8' });
    assert.equal(validation.status, 0, validation.stderr);
    assert.match((validation.stdout + validation.stderr).replace(/\x1b\[[0-9;]*m/g, ''), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}:\d{2}/m, 'the installed artifact must emit dated, offset-qualified records');
    for (const path of [installed, join(stage[8], 'libiconv.2.dylib'), join(stage[8], 'libcharset.1.dylib')]) {
      const verification = spawnSync('/usr/bin/codesign', ['--verify', '--strict', path], { encoding: 'utf8' });
      assert.equal(verification.status, 0, verification.stderr);
      const linkage = spawnSync('/usr/bin/otool', ['-L', path], { encoding: 'utf8' });
      assert.equal(linkage.status, 0, linkage.stderr);
      assert.ok(!linkage.stdout.includes('/nix/store/'), linkage.stdout);
    }
    const before = statSync(installed).mtimeMs;
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(installed).mtimeMs, before, 'identical activation must not replace the installed binary');
    const sourceBinary = stage[2];
    stage[2] = join(dir, 'missing-source');
    result = run();
    assert.notEqual(result.status, 0);
    assert.equal(statSync(installed).mtimeMs, before, 'failed staging must leave the installed binary intact');
    assert.ok(!readdirSync(dir).some(name => name.startsWith('.kanata-stage.')));
    stage[2] = sourceBinary;
    stage[7] = join(dir, 'blocked', 'bin', 'kanata');
    stage[8] = join(dir, 'blocked', 'lib', 'kanata');
    mkdirSync(stage[7], { recursive: true });
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to replace directory target/);
    assert.equal(readdirSync(stage[7]).length, 0, 'must not move a binary inside the directory target');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
