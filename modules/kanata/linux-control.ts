import { pathToFileURL } from 'node:url';
import { parseArgs, systemDependencies, type Dependencies } from './control.ts';

export async function mainLinux(args: string[], deps: Pick<Dependencies, 'run' | 'sleep' | 'now'>, output: { log(message: string): void; error(message: string): void } = console) {
  try {
    const options = parseArgs(args);
    if (options.help) {
      output.log('toggle-kanata [start|stop|restart|toggle|status] [-v] [-n]');
      return 0;
    }
    if (options.action === 'doctor') throw new Error('doctor is only supported on macOS');
    let action = options.action;
    const manuallyRunning = () => {
      const result = deps.run('pgrep', ['-x', 'kanata']);
      if (result.status === 0) return true;
      if (result.status === 1) return false;
      throw new Error(`cannot inspect manual kanata: ${result.stderr || `pgrep exited ${result.status}`}`);
    };
    if (action === 'start' && manuallyRunning()) { output.log('kanata already running'); return 0; }
    if (action === 'status' || action === 'toggle') {
      const active = deps.run('systemctl', ['--user', 'is-active', '--quiet', 'kanata.service']).status === 0 || manuallyRunning();
      if (action === 'status') { output.log(active ? '●' : '○'); return 0; }
      action = active ? 'stop' : 'start';
    }
    if (options.dryRun) { output.log(`[dry-run] would ${action} kanata.service`); return 0; }
    const manualStop = action === 'stop'
      && deps.run('systemctl', ['--user', 'is-active', '--quiet', 'kanata.service']).status !== 0
      && manuallyRunning();
    const result = manualStop ? deps.run('pkill', ['-x', 'kanata']) : deps.run('systemctl', ['--user', action, 'kanata.service']);
    if (manualStop && result.status === 0) {
      const deadline = deps.now() + 2_000;
      while (manuallyRunning()) {
        if (deps.now() >= deadline) throw new Error('manual kanata is still running after stop');
        await deps.sleep(100);
      }
    }
    if (result.stdout) output.log(result.stdout.trimEnd());
    if (result.status !== 0) output.error(result.stderr || `kanata.service ${action} failed`);
    return result.status;
  } catch (error) {
    output.error((error as Error).message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await mainLinux(process.argv.slice(2), systemDependencies);
}
