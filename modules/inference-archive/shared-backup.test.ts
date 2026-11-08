import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { backup, BackupError, buildCommand, runProcess, validateConfig } from './shared-backup.ts';
import type { BackupConfig } from './shared-backup.ts';

const guid = 'a'.repeat(64), snapshotId = 'b'.repeat(64);
async function fixture(): Promise<BackupConfig> {
  const root = await mkdtemp(join(tmpdir(), 'shared-backup-'));
  const archiveRoot = join(root, 'archive');
  await mkdir(archiveRoot);
  for (const name of ['journal', 'origins', 'receipts']) await mkdir(join(archiveRoot, name));
  for (const name of ['password', 'key', 'known_hosts']) await writeFile(join(root, name), 'private fixture', { mode: 0o600 });
  const executable = join(root, 'restic');
  await writeFile(executable, `#!/bin/sh\ncase " $* " in\n*' cat config '*) printf '%s\\n' '{"id":"${guid}"}' ;;\n*) printf '%s\\n' '{"message_type":"summary","snapshot_id":"${snapshotId}"}' ;;\nesac\n`, { mode: 0o700 });
  return { archiveRoot, passwordFile: join(root, 'password'), sshKeyPath: join(root, 'key'), knownHostsPath: join(root, 'known_hosts'),
    stateDirectory: join(root, 'state'), resticPath: executable, sshPath: '/usr/bin/ssh',
    repository: { id: 'ssd-01-hetzner', uri: 'sftp:owner@storage.example:/home/restic/ssd-01', guid, sshTarget: 'owner@storage.example', sshPort: 23 } };
}

test('allowlist is exactly journal, origins, receipts; credentials/config never selected', async () => {
  const c = await fixture(), args = buildCommand(c, 'backup');
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['journal', 'origins', 'receipts'].map(name => join(c.archiveRoot, name)));
  assert.equal(args.includes(c.archiveRoot), false);
  assert.equal(args.includes('--option=sftp.args='), true);
  assert.match(args[args.indexOf('--option') + 1], /IdentityAgent=none/);
  assert.match(args[args.indexOf('--option') + 1], /StrictHostKeyChecking=yes/);
  assert.equal(args.some(x => ['prune', 'forget', 'init', 'unlock'].includes(x)), false);
  assert.throws(() => buildCommand(c, 'prune' as 'backup'), BackupError);
  for (const path of [join(c.archiveRoot, 'journal', 'password'), '/nix/store/secret', '/']) {
    assert.throws(() => validateConfig({ ...c, passwordFile: path }), BackupError);
  }
});

test('successful backup verifies repository identity and appends history without replacing it', async () => {
  const c = await fixture();
  await backup(c); await backup(c);
  const history = (await readFile(join(c.stateDirectory, 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(history.length, 2);
  assert.equal(history[0].snapshotId, snapshotId);
  assert.equal(history[1].status, 'success');
});

test('repository mismatch fails closed and never invokes backup', async () => {
  const c = await fixture();
  c.repository.guid = 'c'.repeat(64);
  await assert.rejects(backup(c), { code: 'repository-mismatch' });
  assert.match(await readFile(join(c.stateDirectory, 'history.jsonl'), 'utf8'), /repository-mismatch/);
});

test('symlinked source and readable credentials are rejected', async () => {
  const c = await fixture();
  await chmod(c.passwordFile, 0o644);
  await assert.rejects(backup(c), { code: 'credential-unavailable' });
  await chmod(c.passwordFile, 0o600);
  const other = await fixture();
  const root = join(c.archiveRoot, 'linked');
  await mkdir(root);
  await symlink(join(other.archiveRoot, 'journal'), join(root, 'journal'));
  c.archiveRoot = root;
  await assert.rejects(backup(c), { code: 'source-unavailable' });
});

test('process failures never retain raw stderr/stdout; timeout is bounded', async () => {
  const c = await fixture();
  await writeFile(c.resticPath, '#!/bin/sh\nprintf "SECRET payload" >&2\nprintf "SECRET payload"\nexit 1\n', { mode: 0o700 });
  await assert.rejects(runProcess(c.resticPath, [], 1000), (e: Error) => {
    assert.equal(e.message, 'process-failed');
    assert.equal(JSON.stringify(e).includes('SECRET'), false);
    assert.equal('cause' in e, false);
    return true;
  });
  await writeFile(c.resticPath, '#!/bin/sh\nsleep 10\n', { mode: 0o700 });
  await assert.rejects(runProcess(c.resticPath, [], 100), { code: 'process-timeout' });
});

test('partial snapshots (restic exit 3) are failures, not successful history', async () => {
  const c = await fixture();
  await writeFile(c.resticPath, `#!/bin/sh\ncase " $* " in\n*' cat config '*) printf '%s\\n' '{"id":"${guid}"}' ;;\n*) echo 'sensitive file diagnostic' >&2; exit 3 ;;\nesac\n`, { mode: 0o700 });
  await assert.rejects(backup(c), { code: 'process-failed' });
  const history = await readFile(join(c.stateDirectory, 'history.jsonl'), 'utf8');
  assert.equal(history.includes('sensitive'), false);
  assert.equal(JSON.parse(history).status, 'failed');
});
