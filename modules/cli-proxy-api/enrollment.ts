import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { capture, isMain, privateFile } from "../tool-auth/process.ts";
import { readClient, type Client } from "./broker.ts";
import { configuredHosts } from "./fleet.ts";
import { operation, failure, journalId, type EventSink, type EventFields } from "./events.ts";

const nodePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const devicePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const peerPort = 18817;
type Kind = "peer" | "client";
export class EnrollmentError extends Error {
  readonly reason: "invalid-input" | "invalid-state" | "denied" | "unavailable" | "conflict";
  constructor(reason: EnrollmentError["reason"]) {
    super(`enrollment not completed (${reason}); inspect private state before retrying`);
    this.reason = reason;
  }
}
type Identity = { nodeId: string; deviceId: string };
type Device = Identity & { dnsName: string; online: boolean; self: boolean };
export interface Inventory { hosts(): string[]; status(): unknown }
export const nativeInventory: Inventory = {
  hosts: configuredHosts,
  status: () => JSON.parse(capture({ executable: "tailscale", args: ["status", "--json"] })),
};
type Grant = { version: 1; grantId: string; kind: Kind; owner: Identity; recipient: Identity };
type Member = { nodeId: string; deviceId: string; kind: Kind; grantId: string; state: "active" | "revoked"; clientFile: string; origin: string };
export interface Membership { version: 1; owner: Identity; incoming: Member[]; outgoing: Member[] }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function identity(value: unknown): value is Identity & Record<string, unknown> {
  return record(value) && typeof value.nodeId === "string" && nodePattern.test(value.nodeId) && typeof value.deviceId === "string" && devicePattern.test(value.deviceId);
}
function same(a: Identity, b: Identity) { return a.nodeId === b.nodeId && a.deviceId === b.deviceId; }
function origin(device: Device) { return `https://${device.dnsName}:${peerPort}`; }

/** Like the tailnet directory, read native status, not a network scan or remote
 * manifest. Exact DNS labels and stable device IDs prevent name/URL substitution. */
function devices(status: unknown): Device[] {
  if (!record(status) || status.BackendState !== "Running" || !record(status.Self) || !record(status.Peer)
    || !record(status.CurrentTailnet) || typeof status.CurrentTailnet.MagicDNSSuffix !== "string") throw new EnrollmentError("unavailable");
  const suffix = status.CurrentTailnet.MagicDNSSuffix.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9-]+\.ts\.net$/.test(suffix)) throw new EnrollmentError("unavailable");
  const rows: Device[] = [];
  for (const raw of [status.Self, ...Object.values(status.Peer)]) {
    if (!record(raw) || typeof raw.ID !== "string" || !devicePattern.test(raw.ID) || typeof raw.DNSName !== "string" || typeof raw.HostName !== "string") continue;
    const dnsName = raw.DNSName.toLowerCase().replace(/\.$/, "");
    const nodeId = raw.HostName.toLowerCase().replace(/\.local$/, "");
    if (!nodePattern.test(nodeId) || dnsName !== `${nodeId}.${suffix}`) continue;
    rows.push({ nodeId, deviceId: raw.ID, dnsName, online: raw.Online === true, self: raw === status.Self });
  }
  // Ambiguous identities are not enrollment or routing targets.
  return rows.filter(row => rows.filter(other => other.nodeId === row.nodeId || other.deviceId === row.deviceId).length === 1);
}
function target(rows: Device[], deviceId: string): Device {
  const device = rows.find(row => row.deviceId === deviceId);
  if (!device || !device.online) throw new EnrollmentError("unavailable");
  return device;
}
function parseMembership(value: unknown): Membership {
  if (!record(value) || value.version !== 1 || !identity(value.owner) || !Array.isArray(value.incoming) || !Array.isArray(value.outgoing)) throw new Error("invalid enrollment membership");
  for (const list of [value.incoming, value.outgoing]) {
    const seen = new Set<string>();
    for (const row of list) {
      if (!identity(row) || !record(row) || !["peer", "client"].includes(String(row.kind)) || !["active", "revoked"].includes(String(row.state))
        || typeof row.grantId !== "string" || !uuidPattern.test(row.grantId) || typeof row.clientFile !== "string" || !isAbsolute(row.clientFile)
        || typeof row.origin !== "string" || !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net:18817$/.test(row.origin)
        || row.nodeId === value.owner.nodeId || row.deviceId === value.owner.deviceId || seen.has(`${row.kind}:${row.nodeId}`)) throw new Error("invalid enrollment member");
      seen.add(`${row.kind}:${row.nodeId}`);
    }
  }
  return value as unknown as Membership;
}
export function readMembership(file: string): Membership { return parseMembership(JSON.parse(privateFile(file))); }

export function discoverOwners(file?: string, inventory = nativeInventory, eventSink?: EventSink) {
  const event = operation("inference.enrollment.discover", { stage: "inventory" }, eventSink);
  try {
    const membership = file ? readMembership(file) : undefined;
    const hosts = new Set(inventory.hosts());
    const rows = devices(inventory.status());
    const known = membership?.outgoing.filter(row => row.kind === "peer") ?? [];
    const candidates = rows.map(row => {
      const enrolled = known.find(member => same(member, row));
      return { nodeId: row.nodeId, deviceId: row.deviceId, online: row.online, self: row.self, configured: hosts.has(row.nodeId),
        authorization: enrolled?.state ?? "untrusted" as "active" | "revoked" | "untrusted", availability: row.online ? "online" : "offline" };
    });
    for (const member of known) if (!rows.some(row => same(row, member))) candidates.push({ nodeId: member.nodeId, deviceId: member.deviceId, online: false, self: false,
      configured: hosts.has(member.nodeId), authorization: member.state, availability: "missing" });
    event.finish({ outcome: "success", counts: { candidates: candidates.length, authorized: candidates.filter(row => row.authorization === "active").length } });
    return candidates.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  } catch (error) { event.finish({ outcome: "failure", ...failure(error, "configuration") }); throw new EnrollmentError("unavailable"); }
}
function ownedDirectory(path: string): void {
  if (!isAbsolute(path) || path === "/" || path.startsWith("/nix/store")) throw new Error("private writable enrollment storage required");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // Do not chmod existing shared directories or follow private-directory symlinks.
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("owned private enrollment directory required");
}
function seed(file: string, contents: string): void {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
}
function writable(file: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error("owned editable enrollment file required");
  privateFile(file);
}
/** One writer per store, plus a byte comparison for native edits. Crash leftovers
 * stay private and unauthorized; a stale lock needs deliberate operator recovery. */
function update(file: string, change: (membership: Membership) => void): void {
  writable(file);
  const lock = `${file}.lock`;
  seed(lock, "enrollment write in progress\n");
  let temporary: string | undefined;
  try {
    const before = privateFile(file);
    const membership = parseMembership(JSON.parse(before));
    change(membership);
    parseMembership(membership);
    temporary = `${file}.staged-${randomUUID()}`;
    seed(temporary, JSON.stringify(membership) + "\n");
    writable(file);
    if (privateFile(file) !== before) throw new EnrollmentError("conflict");
    renameSync(temporary, file);
  } finally {
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
    unlinkSync(lock);
  }
}
function completion(command: string, eventSink: EventSink | undefined, action: () => void, context: EventFields = {}): void {
  const event = operation("inference.enrollment.change", { command, stage: "persist", ...context }, eventSink);
  try { action(); event.finish({ outcome: "success" }); }
  catch (error) {
    event.finish({ outcome: "failure", ...failure(error, "configuration") });
    if (error instanceof EnrollmentError) throw error;
    throw new EnrollmentError((error as NodeJS.ErrnoException)?.code === "EEXIST" ? "conflict" : "invalid-state");
  }
}
/** Opt in with PeeringConfig.membershipFile; existing incoming/peers arrays stay
 * intact. Client grants target the caller HTTP/SSE lane, not native port 8317.
 * Native gateway clients still use issue-client; provider login stays native.
 *
 * Direct: initializeEnrollment(store, "node-a");
 * CLI: node enrollment.ts initialize /private/store.json node-a
 * Owner: grantEnrollment(store, { recipientId, kind: "peer", outputFile });
 * Recipient: acceptEnrollment(store, { ownerId, grantFile });
 * Transfer only the handoff, using an operator-approved authenticated private
 * channel. No operation contacts another host or changes default client settings.
 */
export function initializeEnrollment(file: string, nodeId: string, inventory = nativeInventory, eventSink?: EventSink): void {
  completion("initialize", eventSink, () => {
    const self = devices(inventory.status()).find(row => row.self && row.nodeId === nodeId && row.online);
    if (!self) throw new EnrollmentError("denied");
    ownedDirectory(dirname(file));
    if (existsSync(file)) { if (!same(readMembership(file).owner, self)) throw new Error("enrollment owner differs"); return; }
    seed(file, JSON.stringify({ version: 1, owner: { nodeId, deviceId: self.deviceId }, incoming: [], outgoing: [] }) + "\n");
  }, { clientId: journalId(String(nodeId)) });
}
function ownerDevices(membership: Membership, inventory: Inventory) {
  const rows = devices(inventory.status());
  const self = target(rows, membership.owner.deviceId);
  if (!self.self || !same(self, membership.owner)) throw new EnrollmentError("denied");
  return { rows, self };
}
function clientFile(file: string, grantId: string, contents: string): string {
  const directory = join(dirname(file), `${basename(file)}.credentials`);
  ownedDirectory(directory);
  const path = join(directory, `${grantId}.json`);
  if (existsSync(path)) { if (privateFile(path) !== contents) throw new Error("enrollment credential differs"); }
  else seed(path, contents);
  readClient(path);
  return path;
}
function grantFrom(file: string): { client: Client; grant: Grant; contents: string } {
  const client = readClient(file);
  const raw: unknown = JSON.parse(privateFile(file));
  if (!record(raw) || !record(raw.enrollment)) throw new Error("execution enrollment artifact required");
  const value = raw.enrollment;
  if (value.version !== 1 || typeof value.grantId !== "string" || !uuidPattern.test(value.grantId) || !["peer", "client"].includes(String(value.kind)) || !identity(value.owner) || !identity(value.recipient)) throw new Error("invalid execution enrollment artifact");
  if (raw.version !== client.version || raw.name !== client.name || raw.baseUrl !== client.baseUrl || raw.apiKey !== client.apiKey) throw new Error("handoff changed during read");
  const grant: Grant = { version: 1, grantId: value.grantId, kind: value.kind as Kind,
    owner: { nodeId: value.owner.nodeId, deviceId: value.owner.deviceId }, recipient: { nodeId: value.recipient.nodeId, deviceId: value.recipient.deviceId } };
  if (client.name !== grant.recipient.nodeId) throw new Error("handoff client identity differs");
  // Whitelist the transfer payload: no OAuth, settings, or management material.
  return { client, grant, contents: JSON.stringify({ ...client, enrollment: grant }) + "\n" };
}
export function grantEnrollment(file: string, input: { recipientId: string; kind: Kind; outputFile: string; reenroll?: boolean }, inventory = nativeInventory, eventSink?: EventSink): void {
  completion("grant", eventSink, () => {
    if (!input || !devicePattern.test(input.recipientId) || !["peer", "client"].includes(input.kind) || typeof input.outputFile !== "string" || !isAbsolute(input.outputFile) || input.reenroll !== undefined && typeof input.reenroll !== "boolean") throw new EnrollmentError("invalid-input");
    update(file, membership => {
      const { rows, self } = ownerDevices(membership, inventory);
      const recipient = target(rows, input.recipientId);
      if (recipient.self) throw new EnrollmentError("denied");
      const previous = membership.incoming.find(row => row.nodeId === recipient.nodeId && row.kind === input.kind);
      if (previous && (!same(previous, recipient) || previous.state === "revoked") && !input.reenroll) throw new EnrollmentError("conflict");
      let contents: string;
      let member: Member;
      if (previous?.state === "active" && same(previous, recipient)) {
        contents = grantFrom(previous.clientFile).contents; member = previous;
      } else {
        const grant: Grant = { version: 1, grantId: randomUUID(), kind: input.kind, owner: { nodeId: membership.owner.nodeId, deviceId: membership.owner.deviceId }, recipient: { nodeId: recipient.nodeId, deviceId: recipient.deviceId } };
        contents = JSON.stringify({ version: 1, name: recipient.nodeId, baseUrl: origin(self), apiKey: `broker-${randomBytes(32).toString("base64url")}`, enrollment: grant }) + "\n";
        member = { ...grant.recipient, kind: input.kind, grantId: grant.grantId, state: "active", origin: origin(self), clientFile: clientFile(file, grant.grantId, contents) };
      }
      ownedDirectory(dirname(input.outputFile));
      if (existsSync(input.outputFile)) { if (privateFile(input.outputFile) !== contents) throw new EnrollmentError("conflict"); }
      else seed(input.outputFile, contents);
      if (previous) membership.incoming[membership.incoming.indexOf(previous)] = member;
      else membership.incoming.push(member);
    });
  }, { clientId: journalId(String(input?.recipientId)), lane: input?.kind === "peer" || input?.kind === "client" ? input.kind : "invalid" });
}
/** The operator transfers this execution-only artifact over an approved private
 * channel (e.g. authenticated SSH). Discovery is not a key exchange or approval. */
export function acceptEnrollment(file: string, input: { grantFile: string; ownerId: string; reenroll?: boolean }, inventory = nativeInventory, eventSink?: EventSink): void {
  completion("accept", eventSink, () => {
    if (!input || typeof input.grantFile !== "string" || !devicePattern.test(input.ownerId) || input.reenroll !== undefined && typeof input.reenroll !== "boolean") throw new EnrollmentError("invalid-input");
    const { client, grant, contents } = grantFrom(input.grantFile);
    update(file, membership => {
      const { rows } = ownerDevices(membership, inventory);
      const owner = target(rows, input.ownerId);
      if (owner.self || !same(owner, grant.owner) || !same(membership.owner, grant.recipient) || client.name !== membership.owner.nodeId || client.baseUrl !== origin(owner)) throw new EnrollmentError("denied");
      const previous = membership.outgoing.find(row => row.nodeId === owner.nodeId && row.kind === grant.kind);
      if (previous && (previous.grantId !== grant.grantId || previous.state === "revoked") && !input.reenroll) throw new EnrollmentError("conflict");
      if (previous?.state === "revoked" && previous.grantId === grant.grantId) throw new EnrollmentError("denied");
      const member: Member = { ...grant.owner, kind: grant.kind, grantId: grant.grantId, state: "active", clientFile: clientFile(file, grant.grantId, contents), origin: origin(owner) };
      if (previous) membership.outgoing[membership.outgoing.indexOf(previous)] = member;
      else membership.outgoing.push(member);
    });
  }, { clientId: journalId(String(input?.ownerId)) });
}
export function revokeEnrollment(file: string, input: { direction: "incoming" | "outgoing"; nodeId: string; kind: Kind }, eventSink?: EventSink): void {
  completion("revoke", eventSink, () => {
    if (!input || !["incoming", "outgoing"].includes(input.direction) || !nodePattern.test(input.nodeId) || !["peer", "client"].includes(input.kind)) throw new EnrollmentError("invalid-input");
    update(file, membership => {
      const member = membership[input.direction].find(row => row.nodeId === input.nodeId && row.kind === input.kind);
      if (!member) throw new Error("enrollment not found");
      member.state = "revoked";
    });
  }, { clientId: journalId(String(input?.nodeId)), lane: input?.direction === "incoming" || input?.direction === "outgoing" ? input.direction : "invalid" });
}

export function enrolledClient(member: Member, owner: Identity, direction: "incoming" | "outgoing"): Client {
  const { client, grant } = grantFrom(member.clientFile);
  const issuer = direction === "incoming" ? owner : member;
  const recipient = direction === "incoming" ? member : owner;
  if (member.state !== "active" || grant.grantId !== member.grantId || grant.kind !== member.kind || client.baseUrl !== member.origin
    || !same(grant.owner, issuer) || !same(grant.recipient, recipient) || client.name !== recipient.nodeId) throw new Error("enrollment credential changed");
  return client;
}
/** Runtime inventory must not block the listener while a native CLI is stuck.
 * No status lookup is needed for local execution; cancellation kills the probe. */
export async function reachablePeer(member: Member, inventory?: Pick<Inventory, "status">, signal?: AbortSignal, timeoutMs = 2000): Promise<boolean> {
  try {
    const status = inventory ? await inventory.status() : await new Promise<unknown>((resolve, reject) => {
      execFile("tailscale", ["status", "--json"], { signal, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
        if (error) { reject(new EnrollmentError("unavailable")); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new EnrollmentError("unavailable")); }
      });
    });
    return devices(status).some(row => same(row, member) && row.online && !row.self && origin(row) === member.origin);
  } catch { return false; }
}

export function enrollmentMain(args: string[], inventory = nativeInventory, eventSink?: EventSink): number {
  try {
    const [command, file, ...rest] = args;
    if (command === "help" && args.length === 1) {
      console.log("enrollment.ts discover [membership] | initialize membership node-id | grant membership recipient-device-id peer|client private-output [--reenroll] | accept membership owner-device-id private-handoff [--reenroll] | revoke membership incoming|outgoing node-id peer|client");
      return 0;
    }
    if (command === "discover" && rest.length === 0) { console.log(JSON.stringify(discoverOwners(file, inventory, eventSink))); return 0; }
    if (!file) throw new Error("membership required");
    if (command === "initialize" && rest.length === 1) initializeEnrollment(file, rest[0]!, inventory, eventSink);
    else if (command === "grant" && (rest.length === 3 || rest.length === 4 && rest[3] === "--reenroll")) grantEnrollment(file, { recipientId: rest[0]!, kind: rest[1] as Kind, outputFile: rest[2]!, reenroll: rest[3] === "--reenroll" }, inventory, eventSink);
    else if (command === "accept" && (rest.length === 2 || rest.length === 3 && rest[2] === "--reenroll")) acceptEnrollment(file, { ownerId: rest[0]!, grantFile: rest[1]!, reenroll: rest[2] === "--reenroll" }, inventory, eventSink);
    else if (command === "revoke" && rest.length === 3) revokeEnrollment(file, { direction: rest[0] as "incoming" | "outgoing", nodeId: rest[1]!, kind: rest[2] as Kind }, eventSink);
    else throw new Error("invalid enrollment command");
    console.log("execution enrollment persisted; default client settings unchanged");
    return 0;
  } catch { console.error("enrollment command failed; private diagnostics withheld"); return 1; }
}
if (isMain(import.meta.url)) process.exitCode = enrollmentMain(process.argv.slice(2));

if (import.meta.vitest) {
  const { test, expect, afterEach, vi } = import.meta.vitest;
  const { mkdtempSync, readFileSync, rmSync, chmodSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createServer } = await import("node:http");
  const { spawnSync, spawn } = await import("node:child_process");
  const cleanups: (() => unknown | Promise<unknown>)[] = [];
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  const silent: EventSink = () => {};
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "inference-enrollment-"));
    cleanups.push(() => rmSync(root, { force: true, recursive: true }));
    const ids = ["node-a", "node-b", "node-c", "outsider"];
    const raw = (nodeId: string) => ({ ID: `device-${nodeId}`, HostName: nodeId, DNSName: `${nodeId}.tail-test.ts.net.`, Online: true });
    const inventory = (self: string): Inventory => ({ hosts: () => ["node-a", "node-b"], status: () => ({ BackendState: "Running", CurrentTailnet: { MagicDNSSuffix: "tail-test.ts.net" }, Self: raw(self), Peer: Object.fromEntries(ids.filter(id => id !== self).map(id => [id, raw(id)])) }) });
    const stores = Object.fromEntries(ids.map(id => {
      const file = join(root, id, "membership.json");
      initializeEnrollment(file, id, inventory(id), silent);
      return [id, file];
    }));
    const artifact = (name = randomUUID()) => join(root, `${name}.json`);
    function enroll(owner: string, recipient: string, kind: Kind = "peer") {
      const outputFile = artifact();
      grantEnrollment(stores[owner]!, { recipientId: `device-${recipient}`, kind, outputFile }, inventory(owner), silent);
      acceptEnrollment(stores[recipient]!, { ownerId: `device-${owner}`, grantFile: outputFile }, inventory(recipient), silent);
      return outputFile;
    }
    return { root, stores, artifact, inventory, enroll };
  }
  test("discovery uses lazy configured hosts and native identities, never grants trust; explicit enrollment adds non-flake owners", () => {
    const f = fixture();
    expect(discoverOwners(f.stores["node-a"], f.inventory("node-a"), silent).find(row => row.nodeId === "node-c")).toMatchObject({ configured: false, authorization: "untrusted" });
    f.enroll("node-c", "node-a");
    expect(discoverOwners(f.stores["node-a"], f.inventory("node-a"), silent).find(row => row.nodeId === "node-c")).toMatchObject({ configured: false, authorization: "active" });
    const inventory = f.inventory("node-a");
    const status = inventory.status() as any;
    status.Peer["node-c"].Online = false;
    expect(discoverOwners(f.stores["node-a"], { ...inventory, status: () => status }, silent).find(row => row.nodeId === "node-c")).toMatchObject({ online: false, authorization: "active", availability: "offline" });
    expect(() => grantEnrollment(f.stores["node-a"]!, { recipientId: "device-node-c", kind: "peer", outputFile: f.artifact() }, { ...inventory, status: () => status }, silent)).toThrow();
    const ambiguous = inventory.status() as any; ambiguous.Peer.duplicate = ambiguous.Peer["node-b"];
    expect(discoverOwners(undefined, { ...inventory, status: () => ambiguous }, silent).some(row => row.nodeId === "node-b")).toBe(false);
    expect(() => grantEnrollment(f.stores["node-a"]!, { recipientId: "device-node-b", kind: "peer", outputFile: f.artifact() }, { ...inventory, status: () => ambiguous }, silent)).toThrow();
    status.Peer["node-c"].ID = "replacement-device";
    expect(discoverOwners(f.stores["node-a"], { ...inventory, status: () => status }, silent).filter(row => row.nodeId === "node-c").map(row => row.authorization).sort()).toEqual(["active", "untrusted"]);
    revokeEnrollment(f.stores["node-a"]!, { direction: "outgoing", nodeId: "node-c", kind: "peer" }, silent);
    status.Peer["node-c"].DNSName = "https://arbitrary.invalid/private?token=CANARY";
    expect(discoverOwners(f.stores["node-a"], { ...inventory, status: () => status }, silent).find(row => row.nodeId === "node-c")).toMatchObject({ authorization: "revoked", availability: "missing" });
    expect(() => discoverOwners(undefined, { ...inventory, status: () => { throw new Error("CANARY"); } }, silent)).toThrow(expect.objectContaining({ reason: "unavailable" }));
  });
  test("private handoffs bind recipient, stable owner identity, origin and purpose; revoked artifacts cannot resurrect", () => {
    const f = fixture(); const file = f.artifact();
    grantEnrollment(f.stores["node-b"]!, { recipientId: "device-node-a", kind: "peer", outputFile: file }, f.inventory("node-b"), silent);
    const accept = (grantFile: string, extra = {}) => acceptEnrollment(f.stores["node-a"]!, { ownerId: "device-node-b", grantFile, ...extra }, f.inventory("node-a"), silent);
    const wrongRecipient = f.artifact();
    const value = JSON.parse(privateFile(file)); value.enrollment.recipient.deviceId = "device-node-c";
    seed(wrongRecipient, JSON.stringify(value)); expect(() => accept(wrongRecipient)).toThrow(expect.objectContaining({ reason: "denied" }));
    expect(readMembership(f.stores["node-a"]!).outgoing).toHaveLength(0);
    const withExtras = JSON.parse(privateFile(file)); withExtras.oauth = "UPSTREAM_CANARY"; withExtras.enrollment.owner.extra = "UPSTREAM_CANARY";
    writeFileSync(file, JSON.stringify(withExtras)); accept(file);
    expect(privateFile(readMembership(f.stores["node-a"]!).outgoing[0]!.clientFile)).not.toContain("UPSTREAM_CANARY");
    value.enrollment.recipient.deviceId = "device-node-a"; value.enrollment.grantId = randomUUID(); value.baseUrl = "https://arbitrary.invalid";
    const wrongOrigin = f.artifact(); seed(wrongOrigin, JSON.stringify(value)); expect(() => accept(wrongOrigin, { reenroll: true })).toThrow();
    chmodSync(file, 0o644); expect(() => accept(file)).toThrow(); chmodSync(file, 0o600);
    revokeEnrollment(f.stores["node-a"]!, { direction: "outgoing", nodeId: "node-b", kind: "peer" }, silent);
    expect(() => accept(file, { reenroll: true })).toThrow();
    revokeEnrollment(f.stores["node-b"]!, { direction: "incoming", nodeId: "node-a", kind: "peer" }, silent);
    expect(() => grantEnrollment(f.stores["node-b"]!, { recipientId: "device-node-a", kind: "peer", outputFile: f.artifact() }, f.inventory("node-b"), silent)).toThrow();
    const renewed = f.artifact();
    grantEnrollment(f.stores["node-b"]!, { recipientId: "device-node-a", kind: "peer", outputFile: renewed, reenroll: true }, f.inventory("node-b"), silent);
    expect(readClient(renewed).apiKey).not.toBe(readClient(file).apiKey);
    expect(() => accept(renewed)).toThrow(); accept(renewed, { reenroll: true });
    expect(readMembership(f.stores["node-a"]!).outgoing[0]!.state).toBe("active");
  });
  test("atomic writes preserve native fields and reject concurrent writers and partial handoffs without authorizing them", () => {
    const f = fixture(); const store = f.stores["node-b"]!;
    const before = JSON.parse(privateFile(store)); before.native = { untouched: "CANARY" }; before.owner.extra = "PRIVATE_OWNER_CANARY"; writeFileSync(store, JSON.stringify(before));
    const outputFile = f.artifact(); seed(outputFile, "different private work");
    const grant = (output = outputFile, inventory = f.inventory("node-b")) => grantEnrollment(store, { recipientId: "device-node-a", kind: "peer", outputFile: output }, inventory, silent);
    expect(() => grant()).toThrow(expect.objectContaining({ reason: "conflict" })); expect(readMembership(store).incoming).toHaveLength(0); expect(privateFile(outputFile)).toBe("different private work");
    expect(() => grantEnrollment(store, { recipientId: "device-node-a", kind: "invalid" as Kind, outputFile: f.artifact() }, f.inventory("node-b"), silent)).toThrow(expect.objectContaining({ reason: "invalid-input" }));
    seed(`${store}.lock`, "another writer"); expect(() => grant(f.artifact())).toThrow(expect.objectContaining({ reason: "conflict" })); unlinkSync(`${store}.lock`);
    const inventory = f.inventory("node-b");
    const interrupted = { ...inventory, status: () => { const native = JSON.parse(privateFile(store)); native.native.concurrent = true; writeFileSync(store, JSON.stringify(native)); return inventory.status(); } };
    const partial = f.artifact(); expect(() => grant(partial, interrupted)).toThrow();
    expect(readMembership(store).incoming).toHaveLength(0); expect(readClient(partial)).toBeDefined();
    const good = f.artifact(); grant(good); grant(good);
    expect(readMembership(store).incoming).toHaveLength(1);
    expect(JSON.parse(privateFile(store)).native).toEqual({ untouched: "CANARY", concurrent: true });
    expect(readClient(good).apiKey).not.toBe(readClient(partial).apiKey);
    expect(privateFile(good)).not.toContain("PRIVATE_OWNER_CANARY"); expect(JSON.parse(privateFile(store)).owner.extra).toBe("PRIVATE_OWNER_CANARY");
  });
  async function runtime() {
    const { startPeering, connect } = await import("./peering.ts");
    const f = fixture(); const events: import("./events.ts").OperationEvent[] = [];
    const counts = { "node-a": 0, "node-b": 0, "node-c": 0 };
    const modes = { a: "ok", b: "ok", c: "ok" };
    const availability: { offline: boolean; failed: boolean; substituted: boolean; pending?: Promise<unknown>; waiting: boolean } = { offline: false, failed: false, substituted: false, waiting: false };
    const peers: Record<string, { url: string; caller: string; config: import("./peering.ts").PeeringConfig }> = {};
    const transport: typeof connect = (client, ...args) => {
      if (client.baseUrl.startsWith("https:")) {
        const name = new URL(client.baseUrl).hostname.split(".")[0]!;
        if (!peers[name]) throw new Error("unmapped private transport CANARY");
        return connect({ ...client, baseUrl: peers[name]!.url }, ...args);
      }
      return connect(client, ...args);
    };
    for (const [nodeId, modeKey] of [["node-a", "a"], ["node-b", "b"], ["node-c", "c"]] as const) {
      const apiKey = `broker-${randomBytes(32).toString("base64url")}`;
      const native = createServer(async (req, res) => {
        if (req.headers.authorization !== `Bearer ${apiKey}`) { res.writeHead(401); res.end(); return; }
        if (req.method === "GET" && req.url === "/v1/models") { res.end(JSON.stringify({ data: modes[modeKey] === "absent" ? [] : [{ id: "test-model" }] })); return; }
        for await (const _part of req) { /* drain synthetic input, never journal it */ }
        counts[nodeId]++;
        if (modes[modeKey] === "disconnect") { res.destroy(); return; }
        if (modes[modeKey] === "quota") { res.writeHead(429); res.end("quota"); return; }
        res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"type":"response.completed"}\n\n');
      });
      await new Promise<void>(resolve => native.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise<void>(resolve => { native.close(() => resolve()); native.closeAllConnections(); }));
      const local = join(dirname(f.stores[nodeId]!), "local.json");
      seed(local, JSON.stringify({ version: 1, name: nodeId, baseUrl: `http://127.0.0.1:${(native.address() as { port: number }).port}`, apiKey }));
      const caller = `broker-${randomBytes(32).toString("base64url")}`;
      const keyFile = join(dirname(local), "caller.key"); seed(keyFile, caller);
      const config: import("./peering.ts").PeeringConfig = { localClientFile: local, callerKeyFile: keyFile, incoming: [], peers: [], membershipFile: f.stores[nodeId], probeTimeoutMs: 100, requestTimeoutMs: 2000 };
      const inventory = f.inventory(nodeId);
      const instance = await startPeering({ nodeId, port: 0, config, transport, inventory: { ...inventory, status: () => {
        if (availability.pending) { availability.waiting = true; return availability.pending; }
        if (availability.failed) throw new Error("private inventory CANARY");
        const status = inventory.status() as any;
        if (status.Peer["node-b"]) {
          if (availability.offline) status.Peer["node-b"].Online = false;
          if (availability.substituted) status.Peer["node-b"].ID = "new-device-same-name";
        }
        return status;
      } }, eventSink: value => events.push(value) });
      cleanups.push(() => instance.close());
      peers[nodeId] = { url: `http://127.0.0.1:${instance.port}`, caller, config };
    }
    const send = (nodeId: string, token = peers[nodeId]!.caller, preferred?: string, delegated = false) => fetch(`${peers[nodeId]!.url}/${delegated ? "peer/" : ""}v1/responses`, { method: "POST", body: JSON.stringify({ model: "test-model", stream: true, input: "synthetic-CANARY" }), headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(preferred ? { "x-inference-prefer-node": preferred } : {}) } });
    return { ...f, peers, modes, availability, counts, events, send };
  }
  test("isolated discovery -> private enrollment -> authenticated peer SSE; revocation reloads, clients cannot delegate", async () => {
    const f = await runtime();
    expect(discoverOwners(f.stores["node-a"], f.inventory("node-a"), silent).find(row => row.nodeId === "node-b")!.authorization).toBe("untrusted");
    const ownerInventory = f.inventory("node-b");
    const partial = f.artifact();
    expect(() => grantEnrollment(f.stores["node-b"]!, { recipientId: "device-node-a", kind: "peer", outputFile: partial }, { ...ownerInventory, status: () => {
      const native = JSON.parse(privateFile(f.stores["node-b"]!)); native.nativeEdit = true; writeFileSync(f.stores["node-b"]!, JSON.stringify(native));
      return ownerInventory.status();
    } }, value => f.events.push(value))).toThrow();
    const incomplete = await f.send("node-b", readClient(partial).apiKey, undefined, true); expect(incomplete.status).toBe(401); await incomplete.text();
    let result = await f.send("node-a", undefined, "node-b"); expect(result.status).toBe(400); await result.text();
    const handoff = f.enroll("node-b", "node-a");
    result = await f.send("node-a", undefined, "node-b"); expect(result.status).toBe(200); expect(result.headers.get("x-inference-executed-by")).toBe("node-b"); expect(await result.text()).toContain("response.completed");
    expect(f.counts).toEqual({ "node-a": 0, "node-b": 1, "node-c": 0 });
    const clientHandoff = f.enroll("node-a", "node-c", "client"); const client = readClient(clientHandoff);
    result = await f.send("node-a", client.apiKey); expect(result.status).toBe(200); await result.text();
    result = await f.send("node-a", client.apiKey, undefined, true); expect(result.status).toBe(401); await result.text();
    // A client grant never becomes an outgoing execution candidate.
    expect(discoverOwners(f.stores["node-c"], f.inventory("node-c"), silent).find(row => row.nodeId === "node-a")!.authorization).toBe("untrusted");
    // Deliberately duplicated legacy membership cannot bypass a tombstone.
    f.peers["node-b"]!.config.incoming.push({ nodeId: "node-a", keyFile: join(f.root, "legacy.key") }); seed(join(f.root, "legacy.key"), readClient(handoff).apiKey);
    revokeEnrollment(f.stores["node-b"]!, { direction: "incoming", nodeId: "node-a", kind: "peer" }, silent);
    result = await f.send("node-b", readClient(handoff).apiKey, undefined, true); expect(result.status).toBe(401); await result.text();
    result = await f.send("node-a", undefined, "node-b"); expect(result.status).toBe(200); expect(result.headers.get("x-inference-executed-by")).toBe("node-a"); await result.text();
    revokeEnrollment(f.stores["node-a"]!, { direction: "incoming", nodeId: "node-c", kind: "client" }, silent);
    result = await f.send("node-a", client.apiKey); expect(result.status).toBe(401); await result.text();
    f.peers["node-a"]!.config.peers.push({ nodeId: "node-b", clientFile: handoff });
    revokeEnrollment(f.stores["node-a"]!, { direction: "outgoing", nodeId: "node-b", kind: "peer" }, silent);
    result = await f.send("node-a", undefined, "node-b"); expect(result.status).toBe(400); await result.text();
    const exposed = JSON.stringify(f.events);
    for (const secret of [f.root, readClient(handoff).apiKey, client.apiKey, "synthetic-CANARY", ...Object.values(f.peers).map(row => row.caller)]) expect(exposed).not.toContain(secret);
  });
  test("a pending inventory probe does not block unrelated local inference", async () => {
    const f = await runtime(); f.enroll("node-b", "node-a");
    let release!: () => void;
    f.availability.pending = new Promise(resolve => { release = () => resolve(f.inventory("node-a").status()); });
    const remote = f.send("node-a", undefined, "node-b");
    try {
      await vi.waitFor(() => expect(f.availability.waiting).toBe(true));
      const local = await f.send("node-a"); expect(local.status).toBe(200); expect(local.headers.get("x-inference-executed-by")).toBe("node-a"); await local.text();
    } finally { release(); delete f.availability.pending; }
    const result = await remote; expect(result.status).toBe(200); await result.text();
  });
  test("local remains independent; offline and malformed peers fail before dispatch, never replay attempted POSTs, one hop", async () => {
    const f = await runtime(); f.enroll("node-b", "node-a"); f.enroll("node-c", "node-b");
    let result = await f.send("node-a"); expect(result.headers.get("x-inference-executed-by")).toBe("node-a"); await result.text();
    for (const flag of ["offline", "failed", "substituted"] as const) {
      f.availability[flag] = true;
      result = await f.send("node-a", undefined, "node-b"); expect(result.headers.get("x-inference-executed-by")).toBe("node-a"); await result.text();
      expect(f.counts["node-b"]).toBe(0); f.availability[flag] = false;
    }
    for (const mode of ["quota", "disconnect"]) {
      f.modes.b = mode; const before = { ...f.counts };
      result = await f.send("node-a", undefined, "node-b"); expect(result.status).toBe(mode === "quota" ? 429 : 502); await result.text();
      expect(f.counts["node-b"]).toBe(before["node-b"] + 1); expect(f.counts["node-a"]).toBe(before["node-a"]); expect(f.counts["node-c"]).toBe(0);
    }
    f.modes.b = "absent";
    result = await f.send("node-a", undefined, "node-b"); expect(result.headers.get("x-inference-executed-by")).toBe("node-a"); await result.text(); expect(f.counts["node-c"]).toBe(0);
    writeFileSync(f.stores["node-a"]!, "{private-CANARY");
    result = await f.send("node-a"); expect(result.status).toBe(200); await result.text();
    result = await f.send("node-a", undefined, "node-b"); expect(result.status).toBe(400); await result.text();
  });
  test("native CLI shares validation and persists private state without printing keys, paths, native errors or settings", async () => {
    const f = fixture();
    const bin = join(f.root, "bin"); mkdirSync(bin, { mode: 0o700 });
    const statusFile = join(f.root, "status.json"); seed(statusFile, JSON.stringify(f.inventory("node-b").status()));
    for (const name of ["tailscale", "nix"]) {
      const path = join(bin, `${name}.ts`);
      writeFileSync(path, `#!/usr/bin/env -S node --experimental-strip-types\nimport {readFileSync} from "node:fs";\nconst value: string = ${name === "tailscale" ? 'readFileSync(process.env.FIXTURE_STATUS!, "utf8")' : 'JSON.stringify(["node-a", "node-b"])'};\nprocess.stdout.write(value);\n`, { mode: 0o700 });
      symlinkSync(path, join(bin, name));
    }
    const script = new URL("./enrollment.ts", import.meta.url).pathname;
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_STATUS: statusFile };
    const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
    const outputFile = f.artifact(); const grantArgs = ["grant", f.stores["node-b"]!, "device-node-a", "peer", outputFile];
    let result = run(grantArgs); expect(result.status).toBe(0);
    const client = readClient(outputFile);
    for (const secret of [f.root, client.apiKey, "apiKey", "management"]) expect(result.stdout + result.stderr).not.toContain(secret);
    result = run(["grant", f.stores["node-b"]!, "device-node-a", "INVALID", f.artifact()]); expect(result.status).toBe(1); expect(result.stderr).not.toContain(f.root);
    writeFileSync(statusFile, JSON.stringify(f.inventory("node-a").status()));
    result = run(["accept", f.stores["node-a"]!, "device-node-b", outputFile]); expect(result.status).toBe(0);
    result = run(["discover", f.stores["node-a"]!]); expect(result.status).toBe(0); expect(JSON.parse(result.stdout).find((row: any) => row.nodeId === "node-b").authorization).toBe("active");
    vi.stubEnv("PATH", env.PATH); vi.stubEnv("FIXTURE_STATUS", statusFile);
    const member = readMembership(f.stores["node-a"]!).outgoing[0]!;
    expect(await reachablePeer(member)).toBe(true);
    writeFileSync(join(bin, "tailscale.ts"), '#!/usr/bin/env -S node --experimental-strip-types\nsetInterval(() => {}, 60000);\n');
    const started = performance.now();
    expect(await reachablePeer(member, undefined, AbortSignal.timeout(25), 1000)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1500);
    const runAsync = (args: string[]) => new Promise<number | null>(resolve => { const child = spawn(process.execPath, [script, ...args], { env, stdio: "ignore" }); child.once("exit", resolve); });
    const revoked = ["revoke", f.stores["node-a"]!, "outgoing", "node-b", "peer"];
    const codes = await Promise.all([runAsync(revoked), runAsync(revoked)]);
    expect(codes).toContain(0); expect(codes.every(code => code === 0 || code === 1)).toBe(true);
    expect(readMembership(f.stores["node-a"]!).outgoing[0]!.state).toBe("revoked");
    expect(readFileSync(outputFile, "utf8")).toContain(client.apiKey);
    writeFileSync(join(bin, "tailscale.ts"), '#!/usr/bin/env -S node --experimental-strip-types\nprocess.stderr.write("CANARY-private-native-error");process.exit(1);\n');
    result = run(["discover", f.stores["node-a"]!]); expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("CANARY"); expect(result.stdout + result.stderr).not.toContain(f.root);
  });
}
