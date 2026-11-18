import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureInstalled, installMain, type Installation } from './install.ts';
import { systemDependencies } from './control.ts';

function fixture(initial: string | null = null, failure = '') {
  const dir = mkdtempSync(join(tmpdir(), 'kanata-install-'));
  let version = initial;
  const binding: Installation = { package: join(dir, 'driver.pkg'), version: '6.2.0', daemon: join(dir, 'daemon'), manager: join(dir, 'manager'), stage: ['/fixture/activate.sh'] };
  writeFileSync(binding.package, 'pinned fixture');
  if (initial) {
    writeFileSync(binding.daemon, 'daemon', { mode: 0o755 });
    writeFileSync(binding.manager, 'manager', { mode: 0o755 });
  }
  const calls: string[] = [];
  const deps = {
    exists: existsSync,
    executable: systemDependencies.executable,
    run(command: string, args: string[], privileged = false) {
      calls.push(`${privileged ? 'root ' : ''}${command} ${args.join(' ')}`);
      const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
      if (failure && args.includes(failure)) return { status: 1, stdout: '', stderr: 'fixture denied' };
      if (args[0] === '--pkg-info') return version ? ok(`version: ${version}\n`) : { status: 1, stdout: '', stderr: 'No receipt for package' };
      if (args[0] === '--check-signature') return ok(failure === 'signature' ? 'wrong signer' : 'Developer ID Installer: Fumihiko Takayama (G43BCU2T37)');
      if (command === '/usr/sbin/installer') {
        assert.equal(privileged, true);
        assert.deepEqual(args, ['-pkg', binding.package, '-target', '/']);
        version = binding.version;
        if (failure !== 'missing-output') {
          if (failure === 'directory-output') { mkdirSync(binding.daemon); mkdirSync(binding.manager); }
          else {
            writeFileSync(binding.daemon, 'daemon', { mode: 0o755 });
            writeFileSync(binding.manager, 'manager', { mode: 0o755 });
            chmodSync(binding.daemon, 0o755);
            chmodSync(binding.manager, 0o755);
          }
        }
        return ok();
      }
      assert.equal(command, '/bin/bash');
      assert.equal(privileged, true);
      return ok();
    },
  };
  return { dir, binding, deps, calls, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test('direct installation and CLI adapter install missing dependency, verify output, then stage kanata', () => {
  for (const adapter of [false, true]) {
    const f = fixture();
    try {
      if (adapter) {
        const output: string[] = [];
        assert.equal(installMain([JSON.stringify(f.binding)], f.deps, { log: s => output.push(s), error: s => output.push(s) }), 0);
        assert.match(output[0], /approvals are separate/);
      } else {
        assert.deepEqual(ensureInstalled(f.binding, f.deps), { status: 'installed', changed: true, approval: 'not-verified' });
      }
      assert.ok(existsSync(f.binding.daemon));
      assert.ok(existsSync(f.binding.manager));
      assert.ok(f.calls.findIndex(c => c.includes('/installer ')) < f.calls.findIndex(c => c.includes('/bin/bash ')));
    } finally { f.dispose(); }
  }
});

test('same pinned receipt and files skip native reinstallation; compatible v6 update is explicit', () => {
  for (const version of ['6.2.0', '6.0.0']) {
    const f = fixture(version);
    try {
      const result = ensureInstalled(f.binding, f.deps);
      assert.equal(result.changed, version !== '6.2.0');
      assert.equal(f.calls.some(c => c.includes('/installer ')), version !== '6.2.0');
    } finally { f.dispose(); }
  }
});

test('incompatible receipt, wrong signer, failed install, and missing output cannot announce installation', () => {
  for (const [version, failure] of [['8.8.0', ''], [null, 'signature'], [null, '-pkg'], [null, 'missing-output'], [null, 'directory-output'], [null, '/fixture/activate.sh']] as const) {
    const f = fixture(version, failure);
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      assert.equal(installMain([JSON.stringify(f.binding)], f.deps, { log: s => stdout.push(s), error: s => stderr.push(s) }), 1);
      assert.equal(stdout.length, 0);
      assert.equal(stderr.length, 1);
      if (failure !== '/fixture/activate.sh') assert.ok(!f.calls.some(c => c.includes('/bin/bash ')));
      if (version || failure === 'signature') assert.ok(!f.calls.some(c => c.includes('/installer ')));
    } finally { f.dispose(); }
  }
});

test('receipt with non-executable files requires repair instead of reporting installed', () => {
  const f = fixture('6.2.0');
  try {
    chmodSync(f.binding.daemon, 0o644);
    assert.equal(ensureInstalled(f.binding, f.deps).changed, true);
    assert.ok(f.calls.some(c => c.includes('/installer ')));
    assert.equal(f.deps.executable(f.binding.daemon), true);
  } finally { f.dispose(); }
});

test('extra user arguments fail before installation side effects', () => {
  const f = fixture();
  try {
    assert.equal(installMain([JSON.stringify(f.binding), 'unexpected'], f.deps, { log() {}, error() {} }), 1);
    assert.equal(f.calls.length, 0);
  } finally { f.dispose(); }
});
