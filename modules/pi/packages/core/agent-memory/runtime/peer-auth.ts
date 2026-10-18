import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";

export type PeerAddressResolver = (
  destination: string,
) => Promise<readonly string[]>;
const normalize = (address: string): string =>
  address.toLowerCase().replace(/^::ffff:/, "");
/** SSH aliases must resolve through local ssh configuration before DNS. no remote command runs. */
export const configuredPeerAddresses: PeerAddressResolver = async (
  destination,
) => {
  const { stdout } = await promisify(execFile)(
    "ssh",
    ["-G", "--", destination],
    { timeout: 5000, maxBuffer: 256 * 1024 },
  );
  const hosts = stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith("hostname "))
    .map((l) => l.slice(9).trim());
  if (hosts.length !== 1 || !hosts[0])
    throw new Error("ambiguous SSH hostname");
  const host = hosts[0];
  return isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((a) => a.address);
};
/**
 * this is an SSH account/address binding to a locally trusted same-owner roster.
 * payloads never select a peer. unknown and duplicate address mappings fail closed.
 */
export async function authenticateInboundPeer(input: {
  readonly connection: string | undefined;
  readonly peers: readonly string[];
  readonly resolve?: PeerAddressResolver;
}): Promise<string> {
  const parts = input.connection?.trim().split(/\s+/);
  if (
    !parts ||
    parts.length !== 4 ||
    !isIP(parts[0]!) ||
    !isIP(parts[2]!) ||
    !parts[1]?.match(/^\d+$/) ||
    !parts[3]?.match(/^\d+$/)
  )
    throw new Error("exchange requires an authenticated SSH connection");
  const remote = normalize(parts[0]!);
  const matches: string[] = [];
  for (const peer of input.peers) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,253}$/.test(peer))
      throw new Error("invalid trusted peer");
    // inability to resolve one roster member cannot establish an unambiguous binding.
    const addresses = await (input.resolve ?? configuredPeerAddresses)(peer);
    if (addresses.some((address) => normalize(address) === remote))
      matches.push(peer);
  }
  if (matches.length !== 1)
    throw new Error("unknown or ambiguous SSH memory peer");
  return matches[0]!;
}
