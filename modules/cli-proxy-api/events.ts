import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { writeSync } from 'node:fs';

export type Outcome = 'success' | 'failure' | 'deferred' | 'skipped' | 'cancelled' | 'rejected';
export type FailureCategory = 'configuration' | 'filesystem' | 'transport' | 'timeout' | 'cancelled' | 'http' | 'integrity' | 'capacity' | 'process' | 'unexpected';
export interface EventFields {
  nodeId?: string; sourceNode?: string; requestId?: string; parentRequestId?: string; parentOperationId?: string; passId?: string; delegationId?: string;
  stage?: string; outcome?: Outcome; destination?: string; lane?: string; method?: string; route?: string;
  sourceBytes?: number; bytesTransferred?: number; requestBytes?: number; responseBytes?: number; records?: number;
  receiverOffsetBefore?: number; receiverOffsetAfter?: number; checkpointOffsetBefore?: number; checkpointOffsetAfter?: number;
  sealed?: boolean; sourceRetained?: boolean; receiptPersisted?: boolean; dispatched?: boolean; delegated?: boolean;
  selectedNode?: string; httpStatus?: number; errorCategory?: FailureCategory; errorCode?: string; retryDelayMs?: number;
  counts?: Record<string, number>; snapshotId?: string; repositoryId?: string; port?: number; signal?: string;
  activeRequests?: number; websockets?: boolean; command?: string; clientId?: string; credentialOutput?: boolean; exitCode?: number; childPid?: number;
  retryPlanned?: boolean; expectedBytes?: number; receivedBytes?: number; configuredLimitBytes?: number; availableBytes?: number;
  usedBytes?: number; reserveBytes?: number;
  journalOutcome?: 'complete' | 'aborted' | 'error' | 'recovered-incomplete';
}
export interface OperationEvent extends EventFields {
  schemaVersion: 1; event: `inference.${string}`; operationId: string; timestamp: string; startedAt: string;
  durationMs: number; pid: number; nodeId: string; outcome: Outcome; stage: string;
}
export type EventSink = (event: OperationEvent) => void;
// stderr preserves machine-readable CLI stdout and reaches launchd's existing error log.
export const writeEvent: EventSink = event => { writeSync(2, JSON.stringify(event) + '\n'); };

/** Never serialize native errors: messages/causes can contain keys, URLs, or bodies. */
export function failure(error: unknown, fallback: FailureCategory = 'unexpected'): Pick<EventFields, 'errorCategory' | 'errorCode' | 'httpStatus'> {
  const integrity = new Set(['journal-record', 'journal-lifecycle', 'journal-start', 'journal-data', 'journal-finish',
    'journal-bound', 'journal-truncated', 'journal-utf8', 'journal-json', 'journal-unterminated', 'journal-empty', 'journal-checksum',
    'catalog-invalid', 'catalog-bound', 'database-response']);
  const codes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EMFILE', 'ENFILE', 'EADDRINUSE', 'EADDRNOTAVAIL',
    'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ABORT_ERR', 'ERR_STREAM_PREMATURE_CLOSE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
  let value = error;
  for (let depth = 0; depth < 3 && value && typeof value === 'object'; depth++) {
    const e = value as { code?: unknown; name?: unknown; status?: unknown; cause?: unknown };
    if (typeof e.code === 'string' && integrity.has(e.code)) return { errorCategory: 'integrity', errorCode: e.code };
    if (typeof e.code === 'string' && codes.has(e.code)) {
      const category = e.code === 'ENOSPC' ? 'capacity' : /TIMEOUT/.test(e.code) || e.code === 'ETIMEDOUT' ? 'timeout' : e.code === 'ABORT_ERR' ? 'cancelled'
        : /^(?:ECONN|ENOTFOUND|EAI_|ERR_STREAM|UND_ERR|ERR_TLS|CERT_|DEPTH_|UNABLE_)/.test(e.code) ? 'transport' : 'filesystem';
      return { errorCategory: category, errorCode: e.code };
    }
    if (e.name === 'TimeoutError') return { errorCategory: 'timeout' };
    if (e.name === 'AbortError') return { errorCategory: 'cancelled' };
    if (typeof e.status === 'number' && Number.isInteger(e.status) && e.status >= 400 && e.status <= 599)
      return { errorCategory: e.status === 507 ? 'capacity' : 'http', httpStatus: e.status };
    value = e.cause;
  }
  return { errorCategory: fallback };
}

/** IDs are useful context, not permission to log an arbitrary journal filename. */
export function journalId(value: string): string {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) ? value.toLowerCase()
    : `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
export function destination(value: string): string {
  try { const url = new URL(value); return `${url.protocol}//${url.host}`; } catch { return 'invalid'; }
}

/** Exactly one completion event per operation; nested operations carry pass/parent IDs. */
export function operation(event: OperationEvent['event'], context: EventFields = {}, sink: EventSink = writeEvent) {
  const startedAt = new Date().toISOString(), started = performance.now(), operationId = randomUUID();
  let finished = false;
  return { operationId, finish(fields: EventFields & { outcome: Outcome }) {
    if (finished) return; finished = true;
    const record: OperationEvent = { ...context, ...fields, schemaVersion: 1, event, operationId, startedAt,
      timestamp: new Date().toISOString(), durationMs: Math.max(0, performance.now() - started), pid: process.pid,
      nodeId: fields.nodeId ?? context.nodeId ?? hostname().replace(/\.local$/, ''), outcome: fields.outcome,
      stage: fields.stage ?? context.stage ?? event.split('.').at(-1)! };
    // Observability must not turn an accepted operation into a retry or dropped capture.
    try { sink(record); } catch { /* sink failures never replay the underlying operation */ }
  } };
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  test('completion is self-contained, timed, correlated and emitted exactly once', () => {
    const events: OperationEvent[] = [];
    const op = operation('inference.archive.example', { passId: 'pass', requestId: 'request', stage: 'verify' }, e => events.push(e));
    op.finish({ outcome: 'success', records: 2 }); op.finish({ outcome: 'failure' });
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ schemaVersion: 1, passId: 'pass', requestId: 'request', stage: 'verify', records: 2, outcome: 'success' });
    expect(Date.parse(events[0]!.timestamp)).toBeGreaterThanOrEqual(Date.parse(events[0]!.startedAt));
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0); expect(events[0]!.operationId).toBe(op.operationId);
  });
  test('failure classification never relays error messages, arbitrary codes, or URL secrets', () => {
    const secret = 'private-token-body-query';
    expect(failure(Object.assign(new Error(secret), { code: secret }))).toEqual({ errorCategory: 'unexpected' });
    expect(failure(new Error(secret, { cause: Object.assign(new Error(secret), { code: 'ECONNREFUSED' }) }))).toEqual({ errorCategory: 'transport', errorCode: 'ECONNREFUSED' });
    expect(failure({ status: 507, message: secret })).toEqual({ errorCategory: 'capacity', httpStatus: 507 });
    expect(destination(`https://user:${secret}@example.com/${secret}?key=${secret}`)).toBe('https://example.com');
    expect(journalId(secret).includes(secret)).toBe(false);
  });
  test('a failed observer does not change the underlying operation outcome', () => {
    const op = operation('inference.archive.example', {}, () => { throw new Error('sink unavailable'); });
    op.finish({ outcome: 'success' });
  });
}
