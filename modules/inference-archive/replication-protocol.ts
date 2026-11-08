import { createHash } from 'node:crypto';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const NODE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const TOKEN = /^[A-Za-z0-9_-]{43,256}$/;
export const MAX_BATCH = 32 * 1024 * 1024;
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const EMPTY_SHA = sha256(Buffer.alloc(0));
export type Proof = { schemaVersion: 1; nodeId: string; requestId: string; offset: number; sha256: string; sealed: boolean };

/** Identity is part of an acknowledgement, not just its byte offset. */
export function validProof(value: unknown, requestId: string, nodeId: string): value is Proof {
  if (!value || typeof value !== 'object') return false;
  const p = value as Proof;
  return p.schemaVersion === 1 && p.nodeId === nodeId && p.requestId === requestId
    && Number.isSafeInteger(p.offset) && p.offset >= 0 && /^[a-f0-9]{64}$/.test(p.sha256) && typeof p.sealed === 'boolean';
}
