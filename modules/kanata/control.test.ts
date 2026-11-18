import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController, main, parseArgs, commandTimeout, parseRunLog, systemDependencies, type Config, type Dependencies } from './control.ts';
import { mainLinux } from './linux-control.ts';
import { testMain, signalTestMain } from './test-mode.ts';
import { EventEmitter } from 'node:events';

const config: Config = {
  label: 'test.kanata', plist: '/test/kanata.plist',
  virtualhidLabel: 'test.hid', virtualhidPlist: '/test/hid.plist',
  virtualhidDaemon: '/test/hid', binary: '/test/kanata', config: '/test/config.kbd', log: '/test/kanata.log', arguments: ['--no-wait', '--cfg', '/test/config.kbd'],
};

function fixture(options: { loaded?: boolean; crash?: boolean; delay?: number; fail?: string; missing?: string; log?: string; backend?: boolean; stale?: boolean } = {}) {
  let time = 0;
  const loaded = new Set(options.loaded ? [config.label] : []);
  let hid = true;
  const calls: string[] = [];
  const deps: Dependencies = {
    run(command, args, privileged) {
      const call = `${command} ${args.join(' ')}`;
      calls.push(`${privileged ? 'root ' : ''}${call}`);
      const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
      const fail = (stderr: string) => ({ status: 1, stdout: '', stderr });
      if (options.fail && call.includes(options.fail)) return fail('permission denied by fixture');
      if (command === config.binary) return ok('configuration valid');
      if (command === '/usr/bin/systemextensionsctl') return ok('* * G43BCU2T37 org.pqrs.Karabiner-DriverKit-VirtualHIDDevice (1.8.0/1.8.0) [activated enabled]');
      if (command === '/bin/ps') {
        if (args[0] === '-p') return ok(new Date(0).toString());
        // Include an unrelated Kanata and a parent shell during the delay.
        return ok(`99 1 ${config.binary}\n100 1 /bin/bash\n${!options.crash && time >= (options.delay ?? 7_000) ? `101 100 ${config.binary}` : ''}`);
      }
      assert.equal(command, '/bin/launchctl');
      const [action, target, path] = args;
      const isHid = target === `system/${config.virtualhidLabel}` || path === config.virtualhidPlist;
      if (action === 'print') {
        if (isHid ? !hid : !loaded.has(target.slice('system/'.length))) return fail(`Could not find service "${target}" in domain for system`);
        return ok(isHid ? 'state = running\npid = 200\n' : `state = ${options.crash ? 'spawn scheduled' : 'running'}\npid = 100\nlast exit code = ${options.crash ? 1 : 0}\n`);
      }
      assert.equal(privileged, true);
      if (action === 'bootout') {
        assert.ok(target.startsWith(`system/${config.label}`), 'must never stop shared HID');
        loaded.delete(target.slice('system/'.length));
      } else if (action === 'bootstrap') {
        if (isHid) hid = true;
        else loaded.add(config.label);
      } else if (action === 'bsexec') {
        assert.deepEqual(args.slice(0, 5), ['bsexec', '1', '/bin/launchctl', 'submit', '-l']);
        loaded.add(args[5]);
      } else assert.ok(action === 'enable' || action === 'kickstart');
      return ok();
    },
    exists: path => path !== options.missing,
    executable: path => path !== options.missing,
    readLog: () => parseRunLog(options.log ?? `${new Date(options.stale ? -86400000 : 0).toISOString()} [INFO] kanata v1.12.0 starting\nkeyboard grabbed, entering event processing loop\n${options.backend === false ? 'output backend unavailable — releasing input devices' : 'virtual_hid_keyboard_ready true'}`),
    sessionId: () => 'fixture',
    now: () => time,
    sleep: async ms => { time += ms; },
  };
  return { deps, calls, controller: createController(config, deps), time: () => time };
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, output: { log: (s: string) => stdout.push(s), error: (s: string) => stderr.push(s) } };
}

test('default, aliases, flags and invalid combinations share one argument contract', () => {
  assert.equal(parseArgs([]).action, 'toggle');
  assert.deepEqual(parseArgs(['-v', 'enable', '-n']), { action: 'start', verbose: true, dryRun: true, help: false });
  for (const args of [['strat'], ['start', 'stop'], ['--wat'], ['constructor'], ['toString']]) {
    assert.throws(() => parseArgs(args), /unexpected argument/);
  }
});

test('direct start and CLI start both wait beyond shell delay and device-open phase', async () => {
  const direct = fixture();
  const result = await direct.controller.invoke('start');
  assert.equal(result.state.pid, 101);
  assert.equal(result.state.running, true);
  assert.equal(direct.time(), 10_000);
  const cli = fixture();
  const io = capture();
  assert.equal(await main(['on'], config, cli.deps, io.output), 0);
  assert.match(io.stdout[0], /running.*101/);
  assert.deepEqual(cli.calls, direct.calls);
  assert.equal(cli.time(), direct.time());
});

test('status ignores unrelated Kanata and startup shell; it does not mutate', async () => {
  const f = fixture({ loaded: true });
  const result = await f.controller.invoke('status');
  assert.equal(result.status, 'observed');
  assert.equal(result.state.running, false);
  assert.equal(result.state.pid, null);
  assert.ok(f.calls.every(call => !call.startsWith('root ')));
});

test('stop and default toggle unload crash-looping jobs even without a Kanata PID', async () => {
  for (const args of [['stop'], []]) {
    const f = fixture({ loaded: true, crash: true });
    const io = capture();
    assert.equal(await main(args, config, f.deps, io.output), 0);
    assert.match(io.stdout[0], /stopped/);
    assert.ok(f.calls.includes(`root /bin/launchctl bootout system/${config.label}`));
    assert.equal(f.controller.inspect().loaded, false);
    assert.ok(!f.calls.some(call => /kill|test.hid/.test(call)));
  }
});

test('bootout denial is not presented as a successful stop', async () => {
  const f = fixture({ loaded: true, crash: true, fail: 'bootout' });
  const io = capture();
  assert.equal(await main(['stop'], config, f.deps, io.output), 1);
  assert.equal(io.stdout.length, 0);
  assert.match(io.stderr[0], /permission denied/);
  assert.equal(f.controller.inspect().loaded, true);
});

test('healthy start is idempotent and does not require sudo', async () => {
  const f = fixture({ loaded: true, delay: 0 });
  await f.controller.invoke('start');
  assert.equal(f.time(), 3_000);
  assert.ok(f.calls.every(call => !call.startsWith('root ')));
});

test('loaded start kickstarts instead of repeating bootstrap', async () => {
  const f = fixture({ loaded: true, delay: 5_000 });
  await f.controller.invoke('start');
  assert.ok(f.calls.includes(`root /bin/launchctl kickstart system/${config.label}`));
  assert.ok(!f.calls.some(call => call.includes('bootstrap')));
});

test('restart stops before starting through the same operations', async () => {
  const f = fixture({ loaded: true, delay: 0 });
  await f.controller.invoke('restart');
  const stop = f.calls.indexOf(`root /bin/launchctl bootout system/${config.label}`);
  const start = f.calls.indexOf(`root /bin/launchctl bootstrap system ${config.plist}`);
  assert.ok(stop >= 0 && start > stop);
});

test('crash loops time out, surface Input Monitoring denial and never announce success', async () => {
  const f = fixture({ loaded: true, crash: true, log: 'macOS Input Monitoring permission is denied for kanata' });
  await assert.rejects(f.controller.invoke('start'), /Input Monitoring/);
  const cli = fixture({ crash: true, log: 'macOS Input Monitoring permission is denied for kanata' });
  const io = capture();
  assert.equal(await main(['start'], config, cli.deps, io.output), 1);
  assert.equal(io.stdout.length, 0);
  assert.match(io.stderr[0], /did not become ready within 20s/);
  assert.match(io.stderr[0], /approve \/test\/kanata/);
});

test('PID churn cannot satisfy the stability window', async () => {
  const f = fixture({ loaded: true, delay: 0 });
  const run = f.deps.run;
  f.deps.run = (command, args, privileged) => {
    const result = run(command, args, privileged);
    if (command === '/bin/ps') result.stdout = result.stdout.replace('101 100', `${101 + Math.floor(f.time() / 1000)} 100`);
    return result;
  };
  await assert.rejects(f.controller.invoke('start'), /did not become ready/);
});

test('bootstrap, sudo, configuration and inspection failures stay failures', async () => {
  for (const fail of ['bootstrap', 'enable', '--check', 'print']) {
    const f = fixture({ fail });
    const io = capture();
    assert.equal(await main(['start'], config, f.deps, io.output), 1);
    assert.equal(io.stdout.length, 0);
    assert.match(io.stderr[0], /permission denied by fixture/);
    if (fail === '--check') assert.ok(!f.calls.some(call => call.startsWith('root ')));
  }
});

test('missing prerequisites fail before launchd writes', async () => {
  const f = fixture({ missing: config.virtualhidDaemon });
  await assert.rejects(f.controller.invoke('start'), /missing prerequisite: \/test\/hid/);
  assert.ok(f.calls.every(call => !call.startsWith('root ')));
});

test('dry-run, doctor and invalid input cannot mutate launchd', async () => {
  for (const args of [['restart', '-n'], ['doctor'], ['strat'], ['start', 'stop']]) {
    const f = fixture({ loaded: true, crash: true });
    const io = capture();
    await main(args, config, f.deps, io.output);
    assert.ok(f.calls.every(call => !call.startsWith('root ')));
    if (args[0] === 'doctor') assert.match(io.stdout[0], /last exit 1/);
    if (args[0] === 'strat' || args.length === 2 && args[1] === 'stop') assert.equal(f.calls.length, 0);
  }
});

test('direct callers cannot bypass operation validation', async () => {
  const f = fixture();
  // @ts-expect-error runtime validation also protects untyped local callers
  await assert.rejects(f.controller.invoke('strat'), /invalid kanata operation/);
  assert.equal(f.calls.length, 0);
});

test('Linux CLI uses explicit service commands and rejects typos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanata-linux-'));
  try {
    const calls = join(dir, 'calls');
    writeFileSync(join(dir, 'pgrep'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(dir, 'systemctl'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$CALLS"\nif [[ "$*" == *is-active* ]]; then exit 1; fi\nexit "\${SERVICE_EXIT:-0}"\n`, { mode: 0o755 });
    const run = (args: string[], extra = {}) => spawnSync(process.execPath, ['--experimental-strip-types', new URL('./linux-control.ts', import.meta.url).pathname, ...args], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, ...extra },
    });
    assert.equal(run(['start']).status, 0);
    assert.equal(readFileSync(calls, 'utf8'), '--user start kanata.service\n');
    assert.equal(run(['start'], { SERVICE_EXIT: '7' }).status, 7);
    writeFileSync(calls, '');
    assert.equal(run(['strat']).status, 1);
    assert.equal(run(['start', 'stop']).status, 1);
    assert.equal(run(['restart', '-n']).status, 0);
    assert.equal(readFileSync(calls, 'utf8'), '');
    assert.equal(run([]).status, 0);
    assert.match(readFileSync(calls, 'utf8'), /--user start kanata.service/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Linux direct caller and CLI adapter share parsing and failure semantics', async () => {
  const calls: string[] = [];
  const io = capture();
  const deps = { ...systemDependencies, run(command: string, args: string[]) {
    calls.push(`${command} ${args.join(' ')}`);
    return { status: command === 'pgrep' ? 1 : 7, stdout: '', stderr: 'service start failed' };
  } };
  assert.equal(await mainLinux(['on'], deps, io.output), 7);
  assert.deepEqual(calls, ['pgrep -x kanata', 'systemctl --user start kanata.service']);
  assert.match(io.stderr[0], /service start failed/);
  calls.length = 0;
  assert.equal(await mainLinux(['strat'], deps, io.output), 1);
  assert.equal(calls.length, 0);
});

test('doctor returns structured findings and exits nonzero when unhealthy', async () => {
  const f = fixture({ missing: config.binary });
  const result = await f.controller.invoke('doctor');
  assert.equal(result.status, 'diagnosed');
  if (result.status !== 'diagnosed') throw new Error('wrong outcome');
  assert.equal(result.report.healthy, false);
  assert.ok(result.report.findings.some(f => f.code === 'missing'));
  assert.ok(result.report.findings.some(f => f.code === 'not-running'));
  const io = capture();
  assert.equal(await main(['doctor'], config, f.deps, io.output), 1);
  assert.ok(f.calls.every(call => !call.startsWith('root ')));
});

test('doctor distinguishes pending driver approval from missing files', async () => {
  const f = fixture({ loaded: true, delay: 0 });
  const run = f.deps.run;
  f.deps.run = (command, args, privileged) => command === '/usr/bin/systemextensionsctl'
    ? { status: 0, stdout: 'extension waiting for user', stderr: '' } : run(command, args, privileged);
  const result = await f.controller.invoke('doctor');
  if (result.status !== 'diagnosed') throw new Error('wrong outcome');
  assert.ok(result.report.findings.some(f => f.code === 'driver-approval'));
  assert.ok(!result.report.findings.some(f => f.code === 'missing'));
});

test('timed test refuses an existing job without writes', async () => {
  const f = fixture({ loaded: true });
  await assert.rejects(f.controller.testSession(), error => error instanceof Error && 'code' in error && error.code === 'conflict');
  assert.ok(f.calls.every(call => !call.startsWith('root ')));
});

test('timed test uses checked startup then stops only its managed job', async () => {
  const f = fixture();
  await f.controller.testSession();
  assert.equal(f.time(), 70_000);
  assert.equal(f.controller.inspect().loaded, false);
  assert.equal(f.calls.filter(c => c.includes('bootout')).length, 1);
  assert.ok(!f.calls.some(c => /killall|pkill/.test(c)));
});

test('timed test cleans up failed startup and cancellation; CLI failures stay nonzero', async () => {
  const failed = fixture({ crash: true });
  await assert.rejects(failed.controller.testSession(), /did not become ready/);
  assert.equal(failed.controller.inspect().loaded, false);
  const f = fixture();
  const abort = new AbortController();
  const sleep = f.deps.sleep;
  f.deps.sleep = async (ms, signal) => {
    if (ms === 60_000) abort.abort(new Error('test interrupted'));
    signal?.throwIfAborted();
    await sleep(ms, signal);
  };
  const io = capture();
  assert.equal(await testMain([JSON.stringify(config)], f.deps, abort.signal, io.output), 130);
  assert.equal(f.controller.inspect().loaded, false);
  assert.ok(!io.stdout.some(line => line.includes('test finished')));
});

test('a live PID in backend recovery cannot satisfy start or doctor', async () => {
  for (const options of [{ backend: false }, { stale: true }, { log: 'virtual_hid_keyboard_ready true\nkanata v1.12 starting\noutput backend unavailable' }]) {
    const f = fixture({ loaded: true, delay: 0, ...options });
    await assert.rejects(f.controller.invoke('start'), /did not become ready/);
    const report = await f.controller.invoke('doctor');
    if (report.status !== 'diagnosed') throw new Error('wrong outcome');
    assert.equal(report.report.healthy, false);
    assert.ok(report.report.findings.some(finding => finding.code === 'backend-unavailable'));
  }
});

test('failed submit that registered a session is reconciled without ps or stopping the normal job', async () => {
  const f = fixture();
  const run = f.deps.run;
  f.deps.run = (command, args, privileged) => {
    if (command === '/bin/ps') throw new Error('ps is unavailable');
    const result = run(command, args, privileged);
    return args.includes('submit') ? { status: 1, stdout: '', stderr: 'submit response interrupted after registration' } : result;
  };
  await assert.rejects(f.controller.testSession(), /submit response interrupted/);
  assert.ok(f.calls.includes(`root /bin/launchctl bootout system/${config.label}.test.fixture`));
  assert.ok(!f.calls.includes(`root /bin/launchctl bootout system/${config.label}`));
  assert.notEqual(run('/bin/launchctl', ['print', `system/${config.label}.test.fixture`]).status, 0);
});

test('stop does not require process-table inspection', async () => {
  const f = fixture({ loaded: true, fail: '/bin/ps' });
  assert.equal((await f.controller.invoke('stop')).status, 'stopped');
  assert.ok(!f.calls.some(call => call.includes('/bin/ps')));
});

test('native lifecycle commands have a completion-safe command policy', () => {
  assert.equal(commandTimeout('/usr/sbin/installer', ['-pkg', '/fixture']), 1_500_000);
  assert.equal(commandTimeout('/bin/launchctl', ['bootstrap', 'system', '/fixture']), 0);
  assert.equal(commandTimeout('/bin/launchctl', ['bsexec', '1', '/bin/launchctl', 'submit']), 0);
  assert.equal(commandTimeout('/bin/ps', ['-axo', 'pid=']), 15_000);
});

test('Linux manual-process status and stop do not require an active unit', async () => {
  const calls: string[] = [];
  const io = capture();
  let running = true;
  const deps = { ...systemDependencies, run(command: string, args: string[]) {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'pkill') running = false;
    return { status: command === 'systemctl' ? 3 : command === 'pgrep' && !running ? 1 : 0, stdout: '', stderr: '' };
  } };
  assert.equal(await mainLinux(['status'], deps, io.output), 0);
  assert.equal(io.stdout[0], '●');
  assert.equal(await mainLinux([], deps, io.output), 0);
  assert.ok(calls.includes('pkill -x kanata'));
});

test('readiness in the first half-second is accepted without dating it by file modification', async () => {
  const f = fixture({ loaded: true, delay: 0, log: `${new Date(0).toISOString()} [INFO] kanata v1.12.0 starting\n${new Date(500).toISOString()} [INFO] keyboard grabbed, entering event processing loop\nvirtual_hid_keyboard_ready true\nunrelated later output` });
  assert.equal((await f.controller.invoke('start')).status, 'started');
});

test('manual Linux stop cannot report success while the process survives', async () => {
  let clock = 0;
  const deps = { ...systemDependencies, now: () => clock, sleep: async (ms: number) => { clock += ms; }, run(command: string) {
    return { status: command === 'systemctl' ? 3 : 0, stdout: '', stderr: '' };
  } };
  const io = capture();
  assert.equal(await mainLinux(['stop'], deps, io.output), 1);
  assert.match(io.stderr[0], /still running/);
});

test('transient test uses a session-specific log rather than the normal daemon log', async () => {
  const f = fixture();
  await f.controller.testSession();
  const submit = f.calls.find(call => call.includes(' submit '));
  assert.match(submit ?? '', /-o \/var\/log\/test.kanata.test.fixture.log -e \/var\/log\/test.kanata.test.fixture.log/);
});

test('repeated Ctrl-C stays handled through real session cleanup', async () => {
  const f = fixture();
  const signals = new EventEmitter();
  const run = f.deps.run;
  const sleep = f.deps.sleep;
  f.deps.sleep = async (ms, signal) => {
    if (ms === 60_000) signals.emit('SIGINT');
    signal?.throwIfAborted();
    await sleep(ms, signal);
  };
  f.deps.run = (command, args, privileged) => {
    if (args[0] === 'bootout') {
      assert.equal(signals.listenerCount('SIGINT'), 1);
      signals.emit('SIGINT');
      assert.equal(signals.listenerCount('SIGINT'), 1);
    }
    return run(command, args, privileged);
  };
  assert.equal(await signalTestMain([JSON.stringify(config)], f.deps, signals), 130);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.ok(f.calls.includes(`root /bin/launchctl bootout system/${config.label}.test.fixture`));
});

test('time-only legacy startup records are not promoted to current-run readiness', async () => {
  const stamp = new Date(0).toTimeString().slice(0, 8);
  const f = fixture({ loaded: true, delay: 0, log: `${stamp}.0000 [INFO] kanata v1.12.0 starting\nkeyboard grabbed, entering event processing loop\nvirtual_hid_keyboard_ready true` });
  await assert.rejects(f.controller.invoke('start'), /did not become ready/);
});

test('a real spawn ENOTDIR after manual stop is not interpreted as no match', async () => {
  let probes = 0;
  const deps = { ...systemDependencies, run(command: string, args: string[]) {
    if (command === 'pgrep' && ++probes > 1) return systemDependencies.run('/dev/null/pgrep', args);
    return { status: command === 'systemctl' ? 3 : 0, stdout: '', stderr: '' };
  } };
  const io = capture();
  assert.equal(await mainLinux(['stop'], deps, io.output), 1);
  assert.match(io.stderr[0], /cannot inspect manual kanata/);
  assert.match(io.stderr[0], /ENOTDIR/);
});

test('actual CLI help and invalid input use real process exit codes without service access', () => {
  for (const [arg, status] of [['--help', 0], ['strat', 1]] as const) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', new URL('./control.ts', import.meta.url).pathname, JSON.stringify(config), arg], { encoding: 'utf8' });
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stdout + result.stderr, /toggle-kanata/);
  }
});
