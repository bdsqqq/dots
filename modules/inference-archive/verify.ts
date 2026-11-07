import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export type RecordV1 = { schemaVersion: 1; requestId: string; sequence: number; timestamp: string; lane: 'client' | 'codex-upstream'; kind: string; [key: string]: unknown };
export type JournalLine = { record: RecordV1; raw: string; end: number; prefixSha256: string };

/** LF is the durable record boundary. Active trailing bytes are not acknowledged. */
export async function* scanJournal(path: string, sealed = true): AsyncGenerator<JournalLine> {
  const hash = createHash('sha256');
  let pending = Buffer.alloc(0), offset = 0, sequence = 0, requestId: string | undefined;
  let finished = false, lane: string | undefined;
  for await (const chunk of createReadStream(path)) {
    pending = Buffer.concat([pending, chunk]);
    let lf: number;
    while ((lf = pending.indexOf(10)) !== -1) {
      const bytes = pending.subarray(0, lf + 1);
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1));
      const record: RecordV1 = JSON.parse(raw);
      if (!record || record.schemaVersion !== 1 || typeof record.requestId !== 'string' || !record.requestId ||
          !Number.isSafeInteger(record.sequence) || record.sequence !== sequence ||
          typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp)) ||
          !['client', 'codex-upstream'].includes(record.lane) || typeof record.kind !== 'string') throw new Error('invalid journal record or sequence');
      requestId ??= record.requestId; lane ??= record.lane;
      if (requestId !== record.requestId || lane !== record.lane || finished || (sequence === 0 && record.kind !== 'start')) throw new Error('invalid journal lifecycle');
      if (record.kind === 'start' && (sequence !== 0 || typeof record.method !== 'string' || typeof record.pathname !== 'string' ||
          !['http', 'websocket'].includes(String(record.transport)) || typeof record.upstream !== 'string')) throw new Error('invalid start');
      if (record.kind === 'data' && (!['request', 'response'].includes(String(record.direction)) || typeof record.data !== 'string' ||
          (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.data) || Buffer.from(record.data, 'base64').toString('base64') !== record.data))) throw new Error('invalid data');
      if (record.kind === 'finish') {
        if (!['complete', 'aborted', 'error', 'recovered-incomplete'].includes(String(record.outcome))) throw new Error('invalid finish');
        finished = true;
      }
      hash.update(bytes); offset += bytes.length; sequence++;
      yield { record, raw, end: offset, prefixSha256: hash.copy().digest('hex') };
      pending = pending.subarray(lf + 1);
    }
  }
  if (sealed && (pending.length || !finished || !sequence)) throw new Error('truncated or unterminated sealed journal');
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
