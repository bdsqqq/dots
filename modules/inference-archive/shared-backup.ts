import { spawn } from 'node:child_process';
import { appendFile, chmod, lstat, mkdir, open, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceNames = ['journal', 'origins', 'receipts'] as const;
export interface BackupConfig {
  archiveRoot: string;
  passwordFile: string;
  sshKeyPath: string;
  knownHostsPath: string;
  stateDirectory: string;
  resticPath: string;
  sshPath: string;
  repository: { id: string; uri: string; guid: string; sshTarget: string; sshPort: number };
  timeoutMs?: number;
}
export class BackupError extends Error {
  readonly code: 'invalid-config' | 'source-unavailable' | 'credential-unavailable' | 'repository-mismatch' | 'process-failed' | 'process-timeout' | 'state-unavailable';
  constructor(code: BackupError['code']) {
    super(code); // Native process errors/output may contain raw data or credentials.
    this.code = code;
  }
}

function absolute(path: string): boolean {
  return typeof path === 'string' && isAbsolute(path) && resolve(path) === path && path !== '/' && !path.startsWith('/nix/store/');
}
export function validateConfig(c: BackupConfig): void {
  if (!c || ![c.archiveRoot, c.passwordFile, c.sshKeyPath, c.knownHostsPath, c.stateDirectory].every(absolute)
    || ![c.resticPath, c.sshPath].every(p => typeof p === 'string' && isAbsolute(p) && !/[\r\n\0]/.test(p))
    || !c.repository || !/^[a-zA-Z0-9-]+$/.test(c.repository.id) || !/^[0-9a-f]{64}$/.test(c.repository.guid)
    || !/^[a-zA-Z0-9_-]+@[a-zA-Z0-9.-]+$/.test(c.repository.sshTarget)
    || !Number.isInteger(c.repository.sshPort) || c.repository.sshPort < 1 || c.repository.sshPort > 65535
    || !c.repository.uri.startsWith(`sftp:${c.repository.sshTarget}:/`)
    || (c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 2 * 60 * 60 * 1000))) throw new BackupError('invalid-config');
  for (const path of [c.passwordFile, c.sshKeyPath, c.knownHostsPath, c.stateDirectory]) {
    if (sourceNames.some(name => path === join(c.archiveRoot, name) || path.startsWith(join(c.archiveRoot, name) + '/'))) throw new BackupError('invalid-config');
  }
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export function buildCommand(c: BackupConfig, operation: 'identity' | 'backup'): string[] {
  validateConfig(c);
  const ssh = [c.sshPath, '-F', '/dev/null', '-p', String(c.repository.sshPort),
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${c.knownHostsPath}`,
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'UpdateHostKeys=no', '-o', 'ConnectionAttempts=1',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=1',
    '-i', c.sshKeyPath, c.repository.sshTarget, '-s', 'sftp'].map(quote).join(' ');
  const common = ['--repo', c.repository.uri, '--password-file', c.passwordFile,
    '--cache-dir', join(c.stateDirectory, 'cache'), '--retry-lock', '0s',
    '--option=sftp.args=', '--option', `sftp.command=${ssh}`];
  if (operation === 'identity') return [...common, 'cat', 'config'];
  if (operation !== 'backup') throw new BackupError('invalid-config');
  // Do not widen to archiveRoot: grants/config/account material are not source journals.
  return [...common, 'backup', '--json', '--host', 'htz-lab-inference-archive', '--tag', 'inference-archive',
    '--tag', 'shared-raw', '--', ...sourceNames.map(name => join(c.archiveRoot, name))];
}

/** Drain but never relay stderr; bounded stdout is consumed only for identity/summary metadata. */
export async function runProcess(executable: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let output = Buffer.alloc(0), timedOut = false, killTimer: NodeJS.Timeout | undefined;
    const child = spawn(executable, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(['HOME', 'PATH', 'LANG', 'TMPDIR'].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : [])) });
    child.stdout.on('data', (chunk: Buffer) => { output = Buffer.concat([output, chunk]).subarray(-256 * 1024); });
    child.stderr.on('data', () => {});
    const kill = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch {} };
    const timer = setTimeout(() => {
      timedOut = true; kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 5000);
    }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(new BackupError('process-failed')); });
    child.on('close', code => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      if (timedOut) reject(new BackupError('process-timeout'));
      else if (code !== 0) reject(new BackupError('process-failed'));
      else resolvePromise(output.toString('utf8'));
    });
  });
}

async function prepare(c: BackupConfig): Promise<void> {
  for (const name of sourceNames) {
    try { if (!(await lstat(join(c.archiveRoot, name))).isDirectory()) throw new Error(); }
    catch { throw new BackupError('source-unavailable'); }
  }
  try { if (!(await lstat(c.archiveRoot)).isDirectory()) throw new Error(); }
  catch { throw new BackupError('source-unavailable'); }
  for (const path of [c.passwordFile, c.sshKeyPath, c.knownHostsPath]) {
    try {
      const info = await lstat(path);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error();
    } catch { throw new BackupError('credential-unavailable'); }
  }
}
async function history(c: BackupConfig, result: Record<string, unknown>): Promise<void> {
  try {
    const path = join(c.stateDirectory, 'history.jsonl');
    await appendFile(path, JSON.stringify(result) + '\n', { mode: 0o600 });
    await chmod(path, 0o600);
    const file = await open(path, 'r');
    try { await file.sync(); } finally { await file.close(); }
  } catch { throw new BackupError('state-unavailable'); }
}

export async function backup(c: BackupConfig): Promise<{ snapshotId: string }> {
  validateConfig(c);
  const startedAt = new Date().toISOString();
  try {
    await mkdir(c.stateDirectory, { recursive: true, mode: 0o700 });
    if (!(await lstat(c.stateDirectory)).isDirectory()) throw new Error();
    await chmod(c.stateDirectory, 0o700);
  } catch { throw new BackupError('state-unavailable'); }
  try {
    await prepare(c);
    const raw = await runProcess(c.resticPath, buildCommand(c, 'identity'), 30_000);
    let identity: unknown;
    try { identity = JSON.parse(raw); } catch { throw new BackupError('repository-mismatch'); }
    if ((identity as { id?: string })?.id !== c.repository.guid) throw new BackupError('repository-mismatch');
    const output = await runProcess(c.resticPath, buildCommand(c, 'backup'), c.timeoutMs ?? 2 * 60 * 60 * 1000);
    let snapshotId: string | undefined;
    for (const line of output.split('\n')) {
      try {
        const result = JSON.parse(line) as { message_type?: string; snapshot_id?: string };
        if (result.message_type === 'summary' && /^[0-9a-f]{64}$/.test(result.snapshot_id ?? '')) snapshotId = result.snapshot_id;
      } catch {}
    }
    if (!snapshotId) throw new BackupError('process-failed');
    await history(c, { startedAt, finishedAt: new Date().toISOString(), status: 'success', repository: c.repository.id, snapshotId });
    return { snapshotId };
  } catch (e) {
    const error = e instanceof BackupError ? e : new BackupError('process-failed');
    await history(c, { startedAt, finishedAt: new Date().toISOString(), status: 'failed', repository: c.repository.id, code: error.code });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    if (process.argv.length !== 3) throw new BackupError('invalid-config');
    const config = JSON.parse(await readFile(process.argv[2], 'utf8')) as BackupConfig;
    await backup(config);
    process.stdout.write('inference-shared-backup: success\n');
  } catch (e) {
    process.stderr.write(`inference-shared-backup: ${e instanceof BackupError ? e.code : 'invalid-config'}\n`);
    process.exitCode = 1;
  }
}
