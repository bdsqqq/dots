import { pathToFileURL } from 'node:url';
import { OperationError, systemDependencies, type Dependencies } from './control.ts';

export type Installation = {
  package: string;
  version: string;
  daemon: string;
  manager: string;
  stage: string[];
};
type InstallDeps = Pick<Dependencies, 'run' | 'exists' | 'executable'>;
const receipt = 'org.pqrs.Karabiner-DriverKit-VirtualHIDDevice';

// Nix pins the package bytes. The native installer preserves the vendor's signed
// apps and receipt; copying an unsigned driver out of a derivation would not.
export function ensureInstalled(binding: Installation, deps: InstallDeps) {
  function checked(command: string, args: string[], privileged = false) {
    const result = deps.run(command, args, privileged);
    if (result.status !== 0) throw new OperationError('command-failed', `${command} failed (${result.status}): ${result.stderr || result.stdout}`);
    return result.stdout;
  }
  function installedVersion() {
    const result = deps.run('/usr/sbin/pkgutil', ['--pkg-info', receipt]);
    if (result.status !== 0) {
      if (/No receipt|not found/i.test(result.stderr + result.stdout)) return null;
      throw new OperationError('command-failed', `cannot read VirtualHID receipt: ${result.stderr || result.stdout}`);
    }
    const version = result.stdout.match(/^version: (.+)$/m)?.[1];
    if (!version) throw new OperationError('unavailable', 'VirtualHID receipt has no version');
    return version;
  }
  let version = installedVersion();
  if (version && !['6.0.0', '6.1.0', binding.version].includes(version)) {
    throw new OperationError('conflict', `VirtualHID ${version} is installed; refusing to replace it with ${binding.version}. Kanata 1.12 requires the v6 protocol.`);
  }
  const changed = version !== binding.version || !deps.executable(binding.daemon) || !deps.executable(binding.manager);
  if (changed) {
    if (!deps.exists(binding.package)) throw new OperationError('unavailable', `missing pinned VirtualHID package: ${binding.package}`);
    const signature = checked('/usr/sbin/pkgutil', ['--check-signature', binding.package]);
    if (!signature.includes('Developer ID Installer: Fumihiko Takayama (G43BCU2T37)')) {
      throw new OperationError('denied', 'VirtualHID installer does not have the expected vendor identity');
    }
    checked('/usr/sbin/installer', ['-pkg', binding.package, '-target', '/'], true);
    version = installedVersion();
  }
  if (version !== binding.version || !deps.executable(binding.daemon) || !deps.executable(binding.manager)) {
    throw new OperationError('unavailable', 'VirtualHID installation did not produce the expected receipt, daemon and manager');
  }
  checked('/bin/bash', binding.stage, true);
  return { status: 'installed' as const, changed, approval: 'not-verified' as const };
}

export function installMain(args: string[], deps: InstallDeps = systemDependencies, output: { log(message: string): void; error(message: string): void } = console) {
  try {
    if (args.length !== 1) throw new OperationError('invalid-input', 'kanata-install takes no user arguments');
    const binding: Installation = JSON.parse(args[0]);
    const result = ensureInstalled(binding, deps);
    output.log(`kanata dependencies installed${result.changed ? ' (VirtualHID updated)' : ''}; macOS approvals are separate. Run toggle-kanata doctor.`);
    return 0;
  } catch (error) {
    output.error((error as Error).message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = installMain(process.argv.slice(2));
}
