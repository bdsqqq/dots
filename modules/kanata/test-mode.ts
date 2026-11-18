import { pathToFileURL } from 'node:url';
import { createController, systemDependencies, type Config, type Dependencies } from './control.ts';

export async function testMain(args: string[], deps: Dependencies = systemDependencies, signal?: AbortSignal, output: { log(message: string): void; error(message: string): void } = console) {
  try {
    if (args.length !== 1) throw new Error('kanata-test takes no arguments');
    const config: Config = JSON.parse(args[0]);
    output.log('testing kanata for 60s after verified startup; Ctrl-C stops this test. An existing kanata job will not be replaced.');
    await createController(config, deps).testSession(signal);
    output.log('kanata test finished; kanata stopped, shared VirtualHID left running');
    return 0;
  } catch (error) {
    output.error((error as Error).message);
    return signal?.aborted ? 130 : 1;
  }
}

type SignalSource = {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

export async function signalTestMain(args: string[], deps: Dependencies = systemDependencies, signals: SignalSource = process) {
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('kanata test interrupted'));
  signals.on('SIGINT', cancel);
  signals.on('SIGTERM', cancel);
  try {
    return await testMain(args, deps, abort.signal);
  } finally {
    signals.removeListener('SIGINT', cancel);
    signals.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await signalTestMain(process.argv.slice(2));
}
