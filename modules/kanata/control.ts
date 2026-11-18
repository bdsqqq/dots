import { spawnSync } from 'node:child_process';
import { existsSync, openSync, closeSync, fstatSync, readSync, statSync, accessSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export type Config = {
  label: string;
  plist: string;
  virtualhidLabel: string;
  virtualhidPlist: string;
  virtualhidDaemon: string;
  binary: string;
  config: string;
  log: string;
  arguments: string[];
};
type CommandResult = { status: number; stdout: string; stderr: string };
export type Dependencies = {
  run(command: string, args: string[], privileged?: boolean): CommandResult;
  exists(path: string): boolean;
  executable(path: string): boolean;
  readLog(path: string): RunLog;
  sessionId(): string;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};
export type RunLog = { start: string | null; backend: string | null; input: string | null; tail: string };
export type Service = { loaded: boolean; pid: number | null; running: boolean; detail: string };
export type Action = 'start' | 'stop' | 'restart' | 'toggle' | 'status' | 'doctor';
export type Finding = { code: 'missing' | 'invalid-config' | 'driver-approval' | 'not-running' | 'backend-unavailable' | 'permission-denial-reported'; detail: string };
export type Diagnosis = { healthy: boolean; state: Service; virtualhid: Service; findings: Finding[]; log: string };
export type Outcome =
  | { status: 'observed' | 'started' | 'stopped'; state: Service }
  | { status: 'planned'; action: 'start' | 'stop' | 'restart'; state: Service }
  | { status: 'diagnosed'; report: Diagnosis; state: Service };

export class OperationError extends Error {
  readonly code: 'unavailable' | 'denied' | 'conflict' | 'timeout' | 'invalid-input' | 'command-failed';
  constructor(code: OperationError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'OperationError';
  }
}
const aliases: Record<string, Action> = {
  start: 'start', on: 'start', enable: 'start',
  stop: 'stop', off: 'stop', disable: 'stop',
  restart: 'restart', toggle: 'toggle', status: 'status', doctor: 'doctor',
};
export const usage = 'toggle-kanata [start|stop|restart|toggle|status|doctor] [-v] [-n]';

export function parseArgs(args: string[]) {
  let action: Action = 'toggle';
  let supplied = false;
  let verbose = false;
  let dryRun = false;
  let help = false;
  for (const arg of args) {
    if (arg === '-v' || arg === '--verbose') verbose = true;
    else if (arg === '-n' || arg === '--dry-run') dryRun = true;
    else if (arg === '-h' || arg === '--help') help = true;
    else if (Object.hasOwn(aliases, arg) && !supplied) {
      action = aliases[arg];
      supplied = true;
    } else throw new Error(`unexpected argument: ${arg}\n${usage}`);
  }
  return { action, verbose, dryRun, help };
}

export function createController(config: Config, deps: Dependencies) {
  function checked(command: string, args: string[], privileged = false) {
    const result = deps.run(command, args, privileged);
    if (result.status !== 0) {
      const code = /permission|password|not permitted/i.test(result.stderr) ? 'denied' : 'command-failed';
      throw new OperationError(code, `${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`);
    }
    return result.stdout;
  }

  function inspect(label = config.label, inspectProcesses = true): Service {
    const result = deps.run('/bin/launchctl', ['print', `system/${label}`]);
    if (result.status !== 0) {
      if (/Could not find service/.test(result.stderr)) {
        return { loaded: false, pid: null, running: false, detail: 'not loaded' };
      }
      throw new Error(`cannot inspect system/${label}: ${result.stderr || result.stdout}`);
    }
    const pidMatch = result.stdout.match(/^\s*pid = (\d+)$/m);
    const launchPid = pidMatch ? Number(pidMatch[1]) : null;
    const state = result.stdout.match(/^\s*state = (.+)$/m)?.[1] ?? 'unknown';
    const exit = result.stdout.match(/^\s*last exit code = (.+)$/m)?.[1];
    // Existing plists run a shell which can remain Kanata's parent. Only count
    // the configured binary inside this job's process tree, never global pgrep.
    let pid = launchPid;
    let running = state === 'running' && launchPid !== null;
    if (label === config.label && inspectProcesses) {
      const table = launchPid === null ? '' : checked('/bin/ps', ['-axo', 'pid=,ppid=,comm=']);
      const processes = table.split('\n').flatMap(line => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
        return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : [];
      });
      const owned = new Set(launchPid === null ? [] : [launchPid]);
      for (let size = -1; size !== owned.size;) {
        size = owned.size;
        for (const process of processes) if (owned.has(process.parent)) owned.add(process.pid);
      }
      pid = processes.find(process => owned.has(process.pid) && process.command === config.binary)?.pid ?? null;
      running = pid !== null;
    }
    return { loaded: true, pid, running, detail: `${state}${exit ? `; last exit ${exit}` : ''}` };
  }

  function launch(args: string[]) { checked('/bin/launchctl', args, true); }

  function backendReady(state: Service) {
    if (!state.running || state.pid === null) return false;
    const started = Date.parse(checked('/bin/ps', ['-p', String(state.pid), '-o', 'lstart=']).trim());
    const log = deps.readLog(config.log);
    const stamp = log.start?.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+(?:Z|[+-]\d{2}:\d{2})/);
    const runStart = stamp ? Date.parse(stamp[0]) : NaN;
    // Legacy time-only logs cannot prove which day's process wrote a record.
    if (!Number.isFinite(started) || !Number.isFinite(runStart) || runStart < started || runStart - started > 5000) return false;
    return /virtual_hid_keyboard_ready true|cleared stale virtual HID keyboard state|output backend and console session ready/.test(log.backend ?? '')
      && /keyboard grabbed, entering event processing loop/.test(log.input ?? '');
  }

  async function waitForStart(signal?: AbortSignal) {
    const deadline = deps.now() + 20_000;
    let stablePid: number | null = null;
    let since = deps.now();
    while (deps.now() < deadline) {
      signal?.throwIfAborted();
      const state = inspect();
      if (!state.running || state.pid !== stablePid) {
        stablePid = state.running ? state.pid : null;
        since = deps.now();
      }
      // Survive Kanata's device-open phase, not just launchd's spawn.
      if (stablePid !== null && deps.now() - since >= 3_000 && backendReady(state)) return state;
      await deps.sleep(250, signal);
    }
    throw new OperationError('timeout', `kanata did not become ready within 20s (${inspect().detail}).\n${diagnostics()}`);
  }

  function diagnostics() {
    const log = deps.readLog(config.log).tail;
    const permission = /Input Monitoring permission is denied|accessibility.*(denied|permission)/i.test(log)
      ? `\nrecent log reports a macOS permission denial. If startup is still failing, approve ${config.binary} in System Settings → Privacy & Security → Input Monitoring (and Accessibility if requested), then restart. Re-add the exact binary if an old approval is stale.`
      : '';
    return `recent ${config.log}:\n${log.split('\n').slice(-25).join('\n')}${permission}`;
  }

  async function stop() {
    if (inspect(config.label, false).loaded) launch(['bootout', `system/${config.label}`]);
    const deadline = deps.now() + 10_000;
    while (inspect(config.label, false).loaded) {
      if (deps.now() >= deadline) throw new OperationError('timeout', 'kanata job is still loaded after bootout');
      await deps.sleep(250);
    }
    // VirtualHID may have other clients; stopping Kanata does not own its lifetime.
  }

  function prepareDependencies() {
    for (const path of [config.binary, config.config, config.plist, config.virtualhidDaemon, config.virtualhidPlist]) {
      if (!deps.exists(path)) throw new OperationError('unavailable', `missing prerequisite: ${path}`);
    }
    for (const path of [config.binary, config.virtualhidDaemon]) {
      if (!deps.executable(path)) throw new OperationError('unavailable', `not an executable regular file: ${path}`);
    }
    checked(config.binary, ['--check', '--cfg', config.config]);
    launch(['enable', `system/${config.virtualhidLabel}`]);
    if (!inspect(config.virtualhidLabel).loaded) launch(['bootstrap', 'system', config.virtualhidPlist]);
    launch(['kickstart', `system/${config.virtualhidLabel}`]);

  }

  async function start() {
    if (!inspect().running) {
      prepareDependencies();
      launch(['enable', `system/${config.label}`]);
      if (!inspect(config.label, false).loaded) launch(['bootstrap', 'system', config.plist]);
      launch(['kickstart', `system/${config.label}`]);
    }
    return await waitForStart();
  }

  async function testSession(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (inspect(config.label, false).loaded) throw new OperationError('conflict', 'kanata is already loaded; stop it before running kanata-test');
    prepareDependencies();
    const label = `${config.label}.test.${deps.sessionId()}`;
    const log = `/var/log/${label}.log`;
    const session = createController({ ...config, label, log }, deps);
    try {
      // A unique transient job makes even an interrupted submit unambiguously
      // ours to reconcile. PID 1's bootstrap namespace keeps it in system/.
      launch(['bsexec', '1', '/bin/launchctl', 'submit', '-l', label, '-o', log, '-e', log, '--', config.binary, ...config.arguments]);
      await session.waitForStart(signal);
      await deps.sleep(60_000, signal);
      return { status: 'stopped' as const };
    } finally {
      await session.invoke('stop');
    }
  }

  async function invoke(action: Action, dryRun = false): Promise<Outcome> {
    if (!['start', 'stop', 'restart', 'toggle', 'status', 'doctor'].includes(action) || typeof dryRun !== 'boolean') {
      throw new OperationError('invalid-input', 'invalid kanata operation');
    }
    const state = inspect(config.label, !['stop', 'restart', 'toggle'].includes(action));
    if (action === 'status') return { status: 'observed', state };
    if (action === 'doctor') {
      const hid = inspect(config.virtualhidLabel);
      const validation = deps.exists(config.binary)
        ? deps.run(config.binary, ['--check', '--cfg', config.config])
        : null;
      const findings: Finding[] = [config.binary, config.config, config.plist, config.virtualhidDaemon, config.virtualhidPlist]
        .filter(path => !deps.exists(path)).map(path => ({ code: 'missing', detail: `missing prerequisite: ${path}` }));
      if (validation && validation.status !== 0) findings.push({ code: 'invalid-config', detail: validation.stderr || validation.stdout });
      if (!state.running || !hid.running) findings.push({ code: 'not-running', detail: 'kanata or VirtualHID is not running' });
      if (state.running && !backendReady(state)) findings.push({ code: 'backend-unavailable', detail: 'no dated current-run VirtualHID readiness signal; kanata may be recovering. Time-only logs require installing and restarting the updated binary.' });
      const extensions = checked('/usr/bin/systemextensionsctl', ['list']);
      if (!/^\s*\*\s+\*\s+G43BCU2T37\s+org\.pqrs\.Karabiner-DriverKit-VirtualHIDDevice\s/m.test(extensions)) {
        findings.push({ code: 'driver-approval', detail: 'VirtualHID driver is not active. Run sudo /Applications/.Karabiner-VirtualHIDDevice-Manager.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Manager activate, then approve Driver Extensions in System Settings; a restart may be required.' });
      }
      const log = deps.readLog(config.log).tail;
      if (!state.running && /Input Monitoring permission is denied/i.test(log)) {
        findings.push({ code: 'permission-denial-reported', detail: `recent log reports Input Monitoring denial; approve ${config.binary} in Privacy & Security → Input Monitoring, then restart kanata` });
      }
      return { status: 'diagnosed', state, report: { healthy: findings.length === 0, state, virtualhid: hid, findings, log } };
    }
    const desired = action === 'toggle' ? (state.loaded ? 'stop' : 'start') : action;
    if (dryRun) return { status: 'planned', action: desired, state };
    if (desired === 'stop') {
      await stop();
      return { status: 'stopped', state: inspect(config.label, false) };
    }
    if (desired === 'restart') await stop();
    return { status: 'started', state: await start() };
  }
  return { inspect, invoke, testSession, waitForStart };
}

function captureRunLine(log: RunLog, raw: string) {
  const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
  if (/kanata v.* starting/.test(line)) { log.start = line; return true; }
  if (log.backend === null && /virtual_hid_keyboard_ready (?:true|false)|cleared stale virtual HID keyboard state|output backend (?:not ready|unavailable|and console session ready)/.test(line)) log.backend = line;
  if (log.input === null && /keyboard grabbed, entering event processing loop|Input devices released|console session paused|no devices grabbed/.test(line)) log.input = line;
  return false;
}

export function parseRunLog(text: string): RunLog {
  const log: RunLog = { start: null, backend: null, input: null, tail: text.split('\n').slice(-25).join('\n') };
  for (const line of text.split('\n').reverse()) if (captureRunLine(log, line)) break;
  return log;
}

export function readRunLog(path: string): RunLog {
  const log: RunLog = { start: null, backend: null, input: null, tail: '' };
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    let position = fstatSync(fd).size;
    let carry = '';
    let first = true;
    // Long-running services can have megabytes of untimestamped heartbeats.
    // Scan back to the latest startup, retaining only the latest state records.
    while (position > 0) {
      const length = Math.min(position, 64 * 1024);
      position -= length;
      const buffer = Buffer.alloc(length);
      const bytes = readSync(fd, buffer, 0, length, position);
      const text = buffer.subarray(0, bytes).toString('utf8') + carry;
      if (first) { log.tail = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-25).join('\n'); first = false; }
      const lines = text.split('\n');
      carry = lines.shift() ?? '';
      for (const line of lines.reverse()) if (captureRunLine(log, line)) return log;
    }
    if (carry) captureRunLine(log, carry);
    return log;
  } catch (error) {
    log.tail = 'cannot read log: ' + (error as Error).message;
    return log;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function commandTimeout(command: string, args: string[]) {
  if (command === '/usr/sbin/installer') return 1_500_000;
  if (command === '/bin/launchctl' && (args.includes('bootstrap') || args.includes('submit'))) return 0;
  return 15_000;
}

export const systemDependencies: Dependencies = {
  run(command, args, privileged = false) {
    const sudo = privileged && process.getuid?.() !== 0;
    const timeout = commandTimeout(command, args);
    const finishBeforeCancel = command === '/bin/launchctl' || privileged && command === '/usr/sbin/installer';
    const executable = sudo ? '/usr/bin/sudo' : command;
    const argv = sudo ? ['-n', command, ...args] : args;
    const result = spawnSync(finishBeforeCancel ? '/bin/bash' : executable,
      finishBeforeCancel ? [fileURLToPath(new URL('./native-command.sh', import.meta.url)), executable, ...argv] : argv, {
      encoding: 'utf8',
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });
    const stderr = result.error?.message || result.stderr || '';
    return { status: result.status ?? 127, stdout: result.stdout || '', stderr: stderr + (sudo && result.status !== 0 ? '\nif sudo authorization expired, run sudo -v in a terminal and retry.' : '') };
  },
  exists: existsSync,
  executable: path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } },
  readLog: readRunLog,
  sessionId: randomUUID,
  now: Date.now,
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
};

export function formatOutcome(result: Outcome): string {
  switch (result.status) {
    case 'observed': return result.state.running ? '●' : '○';
    case 'started': return `kanata running (managed PID ${result.state.pid}; stable for 3s with current-run backend readiness)`;
    case 'stopped': return 'kanata stopped';
    case 'planned': return `[dry-run] would ${result.action} managed kanata job; VirtualHID is left running on stop`;
    case 'diagnosed': return [
      `kanata process: ${result.state.running ? 'running' : 'not running'}; managed PID ${result.state.pid ?? 'none'}; job: ${result.state.detail}`,
      `VirtualHID: ${result.report.virtualhid.detail}`,
      ...result.report.findings.map(finding => `${finding.code}: ${finding.detail}`),
      `recent log:\n${result.report.log.split('\n').slice(-25).join('\n')}`,
    ].join('\n');
  }
}

export async function main(args: string[], config: Config, deps: Dependencies, output: { log(message: string): void; error(message: string): void } = console) {
  try {
    const options = parseArgs(args);
    if (options.help) { output.log(usage); return 0; }
    const result = await createController(config, deps).invoke(options.action, options.dryRun);
    output.log(formatOutcome(result));
    if (options.verbose && options.action !== 'doctor') output.log(`managed job: ${result.state.detail}; PID ${result.state.pid ?? 'none'}`);
    return result.status === 'diagnosed' && !result.report.healthy ? 1 : 0;
  } catch (error) {
    output.error((error as Error).message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // The Nix wrapper supplies this private binding; user arguments start after it.
    const config: Config = JSON.parse(process.argv[2]);
    process.exitCode = await main(process.argv.slice(3), config, systemDependencies);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
