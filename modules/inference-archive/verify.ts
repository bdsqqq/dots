import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export type RecordV1 = { schemaVersion: 1; requestId: string; sequence: number; timestamp: string; lane: 'client' | 'codex-upstream'; kind: string; [key: string]: unknown };
export type JournalLine = { record: RecordV1; raw: string; end: number; prefixSha256: string };

export const MAX_RECORD_BYTES = 24 * 1024 * 1024;
export type JournalState = { sequence: number; requestId?: string; lane?: string; finished: boolean };

/** Collector appends and file scans must accept the same v1 lifecycle. */
export function validateRecord(record: RecordV1, state: JournalState): void {
  if (!record || record.schemaVersion !== 1 || typeof record.requestId !== 'string' || !record.requestId ||
      !Number.isSafeInteger(record.sequence) || record.sequence !== state.sequence ||
      typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp)) ||
      !['client', 'codex-upstream'].includes(record.lane) || typeof record.kind !== 'string') throw new Error('invalid journal record or sequence');
  if ((state.requestId !== undefined && state.requestId !== record.requestId) || (state.lane !== undefined && state.lane !== record.lane) || state.finished || (state.sequence === 0 && record.kind !== 'start')) throw new Error('invalid journal lifecycle');
  if (record.kind === 'start' && (state.sequence !== 0 || typeof record.method !== 'string' || typeof record.pathname !== 'string' ||
      !['http', 'websocket'].includes(String(record.transport)) || typeof record.upstream !== 'string')) throw new Error('invalid start');
  if (record.kind === 'data' && (!['request', 'response'].includes(String(record.direction)) || typeof record.data !== 'string' ||
      (record.data.length % 4 !== 0 || Buffer.from(record.data, 'base64').toString('base64') !== record.data))) throw new Error('invalid data');
  if (record.kind === 'finish' && !['complete', 'aborted', 'error', 'recovered-incomplete'].includes(String(record.outcome))) throw new Error('invalid finish');
  state.requestId ??= record.requestId; state.lane ??= record.lane;
  state.finished = record.kind === 'finish'; state.sequence++;
}

/** Accumulate slices instead of repeatedly copying a large websocket record. */
async function* completeLines(path: string, sealed: boolean): AsyncGenerator<Buffer> {
  let parts: Buffer[] = [], length = 0;
  for await (const chunk of createReadStream(path)) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end === -1 ? chunk.length : end + 1);
      length += part.length;
      if (length > MAX_RECORD_BYTES) throw new Error('journal record exceeds bound');
      parts.push(part);
      if (end === -1) break;
      yield parts.length === 1 ? part : Buffer.concat(parts, length);
      parts = []; length = 0; start = end + 1;
    }
  }
  if (sealed && length) throw new Error('truncated sealed journal');
}

/** LF is the durable record boundary. Active trailing bytes are not acknowledged. */
export async function* scanJournal(path: string, sealed = true): AsyncGenerator<JournalLine> {
  const hash = createHash('sha256');
  let offset = 0;
  const state: JournalState = { sequence: 0, finished: false };
  for await (const bytes of completeLines(path, sealed)) {
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1));
      const record: RecordV1 = JSON.parse(raw);
      validateRecord(record, state);
      hash.update(bytes); offset += bytes.length;
      yield { record, raw, end: offset, prefixSha256: hash.copy().digest('hex') };
  }
  if (sealed && (!state.finished || !state.sequence)) throw new Error('truncated or unterminated sealed journal');
}

export async function verifyJournal(path: string, expectedSha256?: string) {
  let last: JournalLine | undefined, records = 0;
  for await (const line of scanJournal(path, true)) { last = line; records++; }
  if (!last) throw new Error('empty journal');
  if (expectedSha256 && last.prefixSha256 !== expectedSha256) throw new Error('source sha256 mismatch');
  return { schemaVersion: 1, requestId: last.record.requestId, records, bytes: last.end, sha256: last.prefixSha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, expected] = process.argv.slice(2);
  if (!path || !/^[a-f0-9]{64}$/.test(expected ?? '')) { console.error('usage: node verify.ts JOURNAL.jsonl EXPECTED_SHA256'); process.exitCode = 2; }
  else try { console.log(JSON.stringify(await verifyJournal(path, expected))); }
  catch { console.error('journal verification failed'); process.exitCode = 1; }
}
