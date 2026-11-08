import { constants } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UUID, NODE_ID, TOKEN, MAX_BATCH, EMPTY_SHA, validProof } from './replication-protocol.ts';
import type { Proof } from './replication-protocol.ts';
import { durableJson, missing, prefixHash, privateDirectory, privateOpen, privateText, readRange, rootLock, scanReplicationJournal, loadConfiguration } from './replication-store.ts';

export type ReplicationConfiguration = { root: string; endpoint: string; nodeId: string; tokenFile: string; intervalMs?: number; maxBatchBytes?: number };
export type ReplicationOptions = ReplicationClientOptions & { root: string; batchBytes?: number };
export type ReplicationClientOptions = {
  nodeId: string; endpoint: string; token: string; timeoutMs?: number;
  /** Test transport seam; production uses fetch with redirects forbidden. */
  fetch?: typeof fetch;
};
export class ReplicationError extends Error {
  status?: number;
  constructor(status?: number) { super('archive replication failed; source retained'); this.status = status; }
}
type Boundary = { offset: number; sha256: string };
export type ReplicationReceipt = Proof & { endpoint: string };

/** Endpoint credentials cannot appear in URLs; redirect:error prevents bearer
 * forwarding, including redirects to another path on the same host.
 */
export function replicationClient(options: ReplicationClientOptions) {
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); } catch { throw new ReplicationError(); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(endpoint.pathname) ||
      !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname))) ||
      !NODE_ID.test(options.nodeId) || !TOKEN.test(options.token)) throw new ReplicationError();
  const basePath = endpoint.pathname.replace(/\/$/, '');
  const transport = options.fetch ?? fetch;
  const call = async (id: string, boundary?: Boundary, end?: Boundary, body?: Buffer, sealed = false): Promise<Proof> => {
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${options.token}`, 'x-archive-node': options.nodeId };
      if (boundary && end) Object.assign(headers, { 'content-type': 'application/octet-stream', 'x-archive-offset': String(boundary.offset), 'x-archive-prefix-sha256': boundary.sha256, 'x-archive-sha256': end.sha256, 'x-archive-sealed': String(sealed) });
      // A shared HTTPS listener may route only /archive/* to this collector.
      // Absolute URL resolution would silently drop that authorized base path.
      const target = new URL(endpoint); target.pathname = `${basePath}/v1/journals/${id}`;
      const response = await transport(target, { method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : new Uint8Array(body), redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 60_000) });
      if (!response.ok) { await response.body?.cancel(); throw new ReplicationError(response.status); }
      // A proof is tiny and fixed-schema. Never log unexpected server bodies.
      const reader = response.body?.getReader(); let text = '', size = 0;
      if (!reader) throw new ReplicationError();
      try {
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4096) throw new ReplicationError(); text += new TextDecoder().decode(part.value); }
      } finally { await reader.cancel(); }
      const proof: Proof = JSON.parse(text);
      if (!validProof(proof, id, options.nodeId)) throw new ReplicationError();
      return proof;
    } catch (error) { if (error instanceof ReplicationError) throw error; throw new ReplicationError(); }
  };
  return { endpoint: endpoint.origin + basePath, status: (id: string) => { if (!UUID.test(id)) throw new ReplicationError(); return call(id); },
    append: (id: string, start: Boundary, end: Boundary, body: Buffer, sealed: boolean) => { if (!UUID.test(id) || body.length > MAX_BATCH) throw new ReplicationError(); return call(id, start, end, body, sealed); } };
}

/** One uploader instance owns its root until close(). Capture/indexer use separate
 * locks and never wait for this worker. A failed pass only leaves a backlog.
 */
export async function createReplicator(options: ReplicationOptions) {
  const root = resolve(options.root), client = replicationClient(options);
  const batchBytes = options.batchBytes ?? MAX_BATCH;
  if (!Number.isSafeInteger(batchBytes) || batchBytes < 1 || batchBytes > MAX_BATCH) throw new ReplicationError();
  await privateDirectory(root); await privateDirectory(join(root, 'journal'));
  const unlock = await rootLock(root, 'replicate');
  const receipts = join(root, 'replication-receipts');
  try { await privateDirectory(receipts, true); } catch (error) { await unlock(); throw error; }
  let tail: Promise<unknown> = Promise.resolve(), closed = false;
  const replicateFile = async (name: string) => {
    const match = /^(.+)\.(open|jsonl)$/.exec(name);
    if (!match || !UUID.test(match[1])) throw new ReplicationError();
    const id = match[1], sealed = match[2] === 'jsonl', path = join(root, 'journal', name);
    const receiptPath = join(receipts, id + '.json');
    const fd = await privateOpen(path, constants.O_RDONLY);
    try {
      const identity = await fd.stat();
      const boundaries: Boundary[] = [{ offset: 0, sha256: EMPTY_SHA }];
      for await (const line of scanReplicationJournal(path, id, sealed)) {
        boundaries.push({ offset: line.end, sha256: line.prefixSha256 });
      }
      // Renaming .open to .jsonl is normal; replacing its inode is not.
      try { const now = await lstat(path); if (!now.isFile() || now.ino !== identity.ino || now.dev !== identity.dev) throw new ReplicationError(); }
      catch (error) { if (!missing(error) || sealed) throw error; const now = await lstat(join(root, 'journal', id + '.jsonl')); if (!now.isFile() || now.ino !== identity.ino || now.dev !== identity.dev) throw new ReplicationError(); }
      const last = boundaries[boundaries.length - 1];
      if (await prefixHash(fd, last.offset) !== last.sha256 || (sealed && (await fd.stat()).size !== last.offset)) throw new ReplicationError();
      const byOffset = new Map(boundaries.map(b => [b.offset, b]));
      const validate = (p: Proof) => {
        if (byOffset.get(p.offset)?.sha256 !== p.sha256 || (p.sealed && (!sealed || p.offset !== last.offset))) throw new ReplicationError(409);
      };
      let prior: ReplicationReceipt | undefined;
      try {
        prior = JSON.parse(await privateText(receiptPath));
        if (!prior || prior.schemaVersion !== 1 || prior.nodeId !== options.nodeId || prior.requestId !== id || prior.endpoint !== client.endpoint || !Number.isSafeInteger(prior.offset) || typeof prior.sealed !== 'boolean') throw new ReplicationError(409);
        validate(prior);
      } catch (error) { if (!missing(error)) throw error; }
      let proof = await client.status(id); validate(proof);
      if (prior && (proof.offset < prior.offset || (prior.sealed && !proof.sealed))) throw new ReplicationError(409);
      const receipt = async (p: Proof) => {
        validate(p);
        if (await prefixHash(fd, p.offset) !== p.sha256 || (sealed && (await fd.stat()).size !== last.offset)) throw new ReplicationError(409);
        await durableJson(receiptPath, { ...p, endpoint: client.endpoint } satisfies ReplicationReceipt);
      };
      await receipt(proof);
      while (proof.offset < last.offset) {
        const start = byOffset.get(proof.offset)!;
        let end = start;
        for (const b of boundaries) {
          if (b.offset <= start.offset) continue;
          if (b.offset - start.offset > batchBytes) { if (end === start) throw new ReplicationError(); break; }
          end = b;
        }
        const body = await readRange(fd, start.offset, end.offset - start.offset);
        // Rehash both the source prefix and the actual bytes read before sending.
        if (await prefixHash(fd, start.offset) !== start.sha256 || await prefixHash(fd, end.offset) !== end.sha256) throw new ReplicationError(409);
        const next = await client.append(id, start, end, body, sealed && end.offset === last.offset);
        validate(next);
        if (next.offset < end.offset || next.offset <= proof.offset) throw new ReplicationError();
        proof = next; await receipt(proof);
      }
      if (sealed && !proof.sealed) { proof = await client.append(id, last, last, Buffer.alloc(0), true); if (!proof.sealed) throw new ReplicationError(); await receipt(proof); }
      if (await prefixHash(fd, last.offset) !== last.sha256 || (sealed && (await fd.stat()).size !== last.offset)) throw new ReplicationError(409);
      return proof;
    } finally { await fd.close(); }
  };
  return {
    /** Retries are pass-scoped. Other journals continue even when one collides.
     * No native error/cause or HTTP body escapes this API.
     */
    once: () => {
      if (closed) return Promise.reject(new ReplicationError());
      const result = tail.then(async () => {
        await privateDirectory(root); await privateDirectory(join(root, 'journal')); await privateDirectory(receipts);
        let uploaded = 0, failed = 0;
        for (const name of (await readdir(join(root, 'journal'))).sort()) {
          if (!/\.(open|jsonl)$/.test(name)) continue;
          try { await replicateFile(name); uploaded++; } catch { failed++; }
        }
        return { uploaded, failed };
      });
      tail = result.catch(() => {}); return result;
    },
    close: async () => { if (closed) return; closed = true; await tail; await unlock(); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new ReplicationError();
    const config = await loadConfiguration<ReplicationConfiguration>(process.argv[2]);
    if (!config || typeof config.root !== 'string' || !config.root || typeof config.endpoint !== 'string' || typeof config.nodeId !== 'string' || typeof config.tokenFile !== 'string' || !config.tokenFile) throw new ReplicationError();
    const interval = config.intervalMs ?? 5000;
    if (!Number.isSafeInteger(interval) || interval < 100 || interval > 300_000) throw new ReplicationError();
    const worker = await createReplicator({ root: config.root, nodeId: config.nodeId, endpoint: config.endpoint, token: (await privateText(config.tokenFile)).trim(), batchBytes: config.maxBatchBytes });
    let stopping = false, failures = 0;
    const abort = new AbortController();
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopping = true; abort.abort(); });
    try {
      do {
        const result = await worker.once();
        if (result.failed) console.error('inference archive replication deferred; source retained');
        failures = result.failed ? Math.min(failures + 1, 6) : 0;
        const delay = Math.min(300_000, interval * 2 ** failures);
        if (!stopping) { const { setTimeout } = await import('node:timers/promises'); await setTimeout(delay, undefined, { signal: abort.signal }).catch(() => {}); }
      } while (!stopping);
    } finally { await worker.close(); }
  } catch { console.error('inference archive replication stopped; source retained; check private configuration and journal integrity'); process.exitCode = 1; }
}
