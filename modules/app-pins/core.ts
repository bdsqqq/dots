/** shared by every kind of pinned artifact: app bundles (pins.ts) and vendor CLIs (vendor.ts). */
export type Artifact = { url: string; sha256: string };
export type Installed = { version: string; build: string };
export type Deps = {
  text: (url: string) => Promise<string>;
  download: (url: string, dest: string) => Promise<void>;
  run: (command: string, args: string[]) => string;
};
export type Store = { read(path: string): string | null; write(path: string, text: string): void };

export type RecordResult =
  | { status: "absent" }
  | { status: "recorded" | "unchanged"; from?: string; to: string; linuxAdvanced: boolean; changed: boolean };
export type InstallResult = { status: "installed" | "current" | "newer" | "running" | "unpinned" | "record_only"; version?: string };

/** expected failures carry a stable code; callers map it, never the message, into events. */
export type AppPinErrorCode =
  | "bundle_identity_mismatch" | "foreign_install" | "invalid_pin" | "feed_missing_build" | "artifact_hash_mismatch"
  | "artifact_not_pinned_build" | "rex_commit_mismatch" | "unsupported_platform";
export class AppPinError extends Error {
  readonly code: AppPinErrorCode;
  constructor(code: AppPinErrorCode, message: string) { super(message); this.code = code; }
}

export const sha = /^[a-f0-9]{64}$/;
export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** numeric runs only: "0.1.11-nightly.20261118.4877" -> [0,1,11,20261118,4877]. */
export function compare(a: string, b: string): number {
  const x = a.match(/\d+/g)?.map(Number) ?? [], y = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return Math.sign(d);
  }
  return 0;
}
