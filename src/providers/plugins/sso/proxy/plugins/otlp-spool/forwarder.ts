import { rawProjectHeader } from '@/utils/header-value.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import type { ClassResult } from '@/agents/core/evidence/classify.js';
import type { SSOCredentials, JWTCredentials } from '../../../../../core/types.js';
import { CODEMIE_ENDPOINTS } from '../../../sso.http-client.js';
import { OTEL_STREAMS, type OtelStream, type SpoolStream } from './spool-paths.js';
import {
  advanceCursor,
  markSessionEnded,
  readStatus,
  type Discard,
} from './session-status.js';
import { OtlpHookSpoolData } from '../otlp.plugin.js';
import {
  isSendAllowed,
  noteStreamHold,
  snapshotPendingBytes,
  snapshotPendingHookRecords,
} from './spool-io.js';
import { areCredentialsStale, markCredentialsStale } from './auth-state.js';
import { withSessionLock } from './session-lock.js';
import { authHeadersFor, resolveAnalyticsEndpoint, type AnalyticsEndpoint } from './classification.js';
import { MAX_SNAPSHOT_BYTES, proveHookLines, proveRange, type ProofReason } from './otlp-reader.js';
import { PROJECT_HEADER, evidenceContext, evidenceHeaders, reclassify, type EvidenceContext } from './evidence-send.js';
import { decodeResponse, readBoundedBody, type BodyRead, type SendOutcome } from './response.js';

export type { SendOutcome } from './response.js';

const SESSION_END_EVENT_TYPE = 'agent.session.end';

const OTEL_ENDPOINTS: Record<OtelStream, string> = {
  logs: CODEMIE_ENDPOINTS.CLI_ANALYTICS_LOGS,
  metrics: CODEMIE_ENDPOINTS.CLI_ANALYTICS_METRICS,
  traces: CODEMIE_ENDPOINTS.CLI_ANALYTICS_TRACES,
};

const FORWARD_TIMEOUT_MS = 20_000;

/* ------------------------------------------------------------------ http --- */

async function postToBackend(
  url: string,
  body: string | Buffer,
  contentType: string,
  credentials: SSOCredentials | JWTCredentials,
  extra: Record<string, string>
): Promise<WireResponse> {
  const headers = authHeadersFor(credentials);
  if (!headers) {
    throw new Error('Unsupported credential type');
  }
  Object.assign(headers, extra);
  headers['Content-Type'] = contentType;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual',
    });
    // The one bounded body read, inside the same timeout as the request.
    return {
      status: response.status,
      contentType: response.headers?.get('content-type') ?? '',
      body: await readBoundedBody(response),
    };
  } finally {
    clearTimeout(timer);
  }
}

interface WireResponse {
  status: number;
  contentType: string;
  body: BodyRead;
}

const isAuthFailure = (response: WireResponse): boolean =>
  response.status === 401 ||
  response.status === 403 ||
  response.status === 302;

interface SendRequest {
  sessionId: string;
  stream: SpoolStream;
  url: string;
  body: string | Buffer;
  contentType: string;
  credentials: SSOCredentials | JWTCredentials;
  /** Session-bound project, for the pre-send check (and the legacy Project header). */
  project: string;
  range: { cursor: number; end: number; filtered: boolean };
  evidence?: EvidenceContext;
}

function requestHeaders(req: SendRequest): Record<string, string> {
  if (req.evidence) return evidenceHeaders(req.sessionId, req.evidence);
  // Legacy request: no Session-Id or evidence header; no project = no Project header (AC8).
  const project = rawProjectHeader(req.project);
  return project ? { [PROJECT_HEADER]: project } : {};
}

/**
 * POST a batch, retrying once on auth failures or login redirects, and decode the one response body.
 * Only `ok` and `discarded` acknowledge the range; every other kind leaves the bytes and cursor alone.
 * A 409 stale_policy refreshes the policy, re-classifies and resends once.
 */
async function send(req: SendRequest): Promise<SendOutcome> {
  if (areCredentialsStale()) {
    return { kind: 'failed', reason: 'credentials_stale' };
  }
  const { sessionId, stream } = req;

  // Local re-check before every attempt, per stream and per snapshotted byte range: narrows the
  // window between the locked snapshot and the wire, it does not close it. A sealed session passes
  // it for its hooks prefix only. `null` = no longer sendable, nothing is fetched (the next
  // snapshot applies the policy under the lock).
  const attempt = async (): Promise<WireResponse | null> =>
    (await isSendAllowed(sessionId, stream, req.project, req.range))
      ? postToBackend(req.url, req.body, req.contentType, req.credentials, requestHeaders(req))
      : null;

  const exchange = async (): Promise<SendOutcome> => {
    let response = await attempt();
    if (response && isAuthFailure(response)) {
      response = await attempt();
      if (response && isAuthFailure(response)) return { kind: 'auth-expired' };
    }
    if (!response) return { kind: 'failed', reason: 'not_sendable' };
    return decodeResponse(response.status, response.contentType, response.body, stream === 'hooks');
  };

  try {
    let outcome = await exchange();
    if (outcome.kind === 'stale' && req.evidence && (await reclassify(req.evidence))) {
      outcome = await exchange();
    }
    if (outcome.kind === 'discarded' || (outcome.kind === 'ok' && outcome.reason)) {
      // Final backend answer (discard / rejected records): acknowledged, recorded with the real reason.
      logger.warn(
        '[otlp-forwarder] backend dropped analytics',
        ...sanitizeLogArgs({ sessionId, stream, reason: outcome.reason, rejected: outcome.rejected })
      );
    } else if (outcome.kind !== 'ok') {
      logger.debug('[otlp-forwarder] not acknowledged', ...sanitizeLogArgs({ sessionId, stream, ...outcome }));
    }
    return outcome;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(
      '[otlp-forwarder] request error',
      ...sanitizeLogArgs({ sessionId, stream, err: msg })
    );
    return { kind: 'retry', reason: 'request_error' };
  }
}

const acknowledged = (o: SendOutcome): boolean => o.kind === 'ok' || o.kind === 'discarded';

/**
 * Advance exactly the acknowledged range. A final discard / rejection reason (e.g. the backend's
 * `session_project_conflict`) is persisted with it as `lastDiscard` (AC18), never an accepted send.
 */
function acknowledge(sessionId: string, stream: SpoolStream, end: number, bytes: number, o: SendOutcome): Promise<void> {
  if (!o.reason) return advanceCursor(sessionId, stream, end);
  const discard: Discard = { reason: o.reason, stream, bytes, at: Date.now() };
  return advanceCursor(sessionId, stream, end, discard);
}

/** Head-of-line proof hold: `reason` past the verified prefix, `null` when fully verified. */
function noteProof(
  sessionId: string,
  stream: SpoolStream,
  verified: number,
  total: number,
  hold: ProofReason | undefined
): Promise<'held' | 'lost' | 'clear'> {
  return noteStreamHold(sessionId, stream, verified < total ? (hold ?? 'otlp_unparseable') : null);
}

/* ------------------------------------------------------------- unwrapping --- */

interface HookPayload {
  ndjson: string;
  containsSessionEnd: boolean;
  malformed: number;
}

/**
 * Unwraps the spool envelopes. `hookEvent` is already the final wire event, built at hook time
 * by the adapter, so it is forwarded byte for byte: same bytes on every retry.
 */
export function unwrapHookRecords(records: string[]): HookPayload {
  const unwrapped: string[] = [];
  let containsSessionEnd = false;
  let malformed = 0;

  for (const record of records) {
    let serialized: string;
    let wireEvent: Record<string, unknown>;
    try {
      serialized = (JSON.parse(record) as OtlpHookSpoolData).hookEvent;
      wireEvent = JSON.parse(serialized) as Record<string, unknown>;
    } catch {
      // Complete but unusable record: dropped deliberately. Its bytes are still
      // acknowledged with the batch so the cursor can never get stuck on it.
      malformed += 1;
      continue;
    }

    if (wireEvent['type'] === SESSION_END_EVENT_TYPE) {
      containsSessionEnd = true;
    }
    unwrapped.push(serialized);
  }

  return {
    ndjson: unwrapped.length > 0 ? `${unwrapped.join('\n')}\n` : '',
    containsSessionEnd,
    malformed,
  };
}

/* ------------------------------------------------------------ forwarding --- */

/**
 * Evidence mode: the longest verified prefix of the hook records (whole lines). The cursor may only
 * advance by source bytes, so a partial prefix is sent only when the records map 1:1 onto the
 * snapshotted bytes (no blank lines, not filtered); otherwise nothing is sent until it verifies.
 */
async function verifiedHookPrefix(
  sessionId: string,
  batch: { records: string[]; byteLength: number; filtered: boolean },
  evidence: EvidenceContext
): Promise<{ records: string[]; consumed: number } | null> {
  const lines = batch.records.map((r) => `${r}\n`);
  const total = lines.reduce((n, l) => n + Buffer.byteLength(l), 0);
  const proof = proveHookLines(lines.join(''), { sessionId, project: evidence.record.project || undefined });
  if ((await noteProof(sessionId, 'hooks', proof.verified, total, proof.hold)) === 'lost') return null;
  if (proof.verified >= total) return { records: batch.records, consumed: batch.byteLength };
  // ponytail: no prefix salvage when blank lines/filtering break the 1:1 byte mapping (never written today).
  if (batch.filtered || total !== batch.byteLength) return null;
  let consumed = 0;
  let count = 0;
  while (count < lines.length && consumed + Buffer.byteLength(lines[count]) <= proof.verified) {
    consumed += Buffer.byteLength(lines[count++]);
  }
  return count > 0 ? { records: batch.records.slice(0, count), consumed } : null;
}

/** Forward the complete hook records after the hooks cursor. */
async function forwardHooks(
  sessionId: string,
  baseUrl: string,
  credentials: SSOCredentials | JWTCredentials,
  evidence?: EvidenceContext
): Promise<SendOutcome | 'idle'> {
  const batch = await snapshotPendingHookRecords(sessionId);
  if (!batch) {
    return 'idle';
  }

  let records = batch.records;
  let consumed = batch.byteLength;
  if (evidence) {
    const prefix = await verifiedHookPrefix(sessionId, { ...batch, filtered: batch.filtered === true }, evidence);
    if (!prefix) return 'idle';
    ({ records, consumed } = prefix);
  }

  const payload = unwrapHookRecords(records);
  if (payload.malformed > 0) {
    logger.debug(
      '[otlp-forwarder] skipped malformed hook records',
      ...sanitizeLogArgs({ sessionId, count: payload.malformed })
    );
  }

  if (payload.ndjson.length === 0) {
    // Nothing sendable, but the bytes were consumed — keep the cursor aligned.
    await advanceCursor(sessionId, 'hooks', batch.cursor + consumed);
    return 'idle';
  }

  if (batch.dropped > 0) {
    logger.debug(
      '[otlp-forwarder] hook records not provably the sealed project were not sent',
      ...sanitizeLogArgs({ sessionId, count: batch.dropped })
    );
  }

  const result = await send({
    sessionId, stream: 'hooks', url: `${baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS}`,
    body: payload.ndjson, contentType: 'application/x-ndjson', credentials, project: batch.project,
    range: { cursor: batch.cursor, end: batch.cursor + consumed, filtered: batch.filtered === true },
    evidence,
  });
  if (!acknowledged(result)) {
    return result;
  }

  // Exactly this request's range; a hooks answer never acknowledges an OTLP stream.
  await acknowledge(sessionId, 'hooks', batch.cursor + consumed, consumed, result);

  if (result.kind === 'ok' && payload.containsSessionEnd) {
    await markSessionEnded(sessionId);
  }

  return result;
}

/** Windows drained per tick and stream; the rest waits for the next tick. */
const MAX_OTEL_WINDOWS = 8;

/**
 * Forward the raw protobuf bytes after an OTEL stream's cursor. Evidence mode reads, proves and sends
 * bounded windows (at most MAX_SNAPSHOT_BYTES) cut at resource-entry boundaries, one request each, so a
 * backlog larger than the cap drains instead of being rejected whole.
 */
async function forwardOtelStream(
  sessionId: string,
  stream: OtelStream,
  baseUrl: string,
  credentials: SSOCredentials | JWTCredentials,
  evidence?: EvidenceContext
): Promise<SendOutcome | 'idle'> {
  let last: SendOutcome | 'idle' = 'idle';
  for (let window = 0; window < (evidence ? MAX_OTEL_WINDOWS : 1); window++) {
    const pending = await snapshotPendingBytes(sessionId, stream, evidence ? MAX_SNAPSHOT_BYTES : undefined);
    if (!pending) return last;

    let bytes = pending.bytes;
    if (evidence) {
      // Send only the structurally verified prefix, byte for byte (I1); hold the rest with its reason.
      const proof = proveRange(bytes, { sessionId, project: evidence.record.project || undefined, signal: stream, more: pending.more });
      const covered = proof.windowCut ? proof.verified : bytes.length;
      if ((await noteProof(sessionId, stream, proof.verified, covered, proof.hold)) === 'lost') return last;
      bytes = bytes.subarray(0, proof.verified);
      if (bytes.length === 0) return last;
    }

    const result = await send({
      sessionId, stream, url: `${baseUrl}${OTEL_ENDPOINTS[stream]}`, body: bytes,
      contentType: 'application/x-protobuf', credentials, project: pending.project,
      range: { cursor: pending.cursor, end: pending.cursor + bytes.length, filtered: false },
      evidence,
    });
    if (!acknowledged(result)) return result;

    await acknowledge(sessionId, stream, pending.cursor + bytes.length, bytes.length, result);
    last = result;
    if (!pending.more) break;
  }
  return last;
}

const authExpired = (r: SendOutcome | 'idle'): boolean => r !== 'idle' && r.kind === 'auth-expired';

/**
 * Forward everything a session has pending to the CodeMie analytics backend.
 *
 * Each stream is read from its own cursor and acknowledged independently, so a
 * failure on one stream never blocks or rewinds another. Cursors only advance
 * after an acknowledging response (accepted, or a final discard), which yields
 * at-least-once delivery: a crash between backend success and cursor persistence
 * re-sends that batch.
 *
 * A session the tick decided to send with evidence (`sendMode: 'evidence'`) sends only with its
 * durable record found at the forwarder's own key; without one nothing is sent (fail closed).
 * `classification` is the tick's decision for that session (see classification.ts).
 *
 * A forwarded `SessionEnd` only records `endedAt`; it never stops later ticks
 * from delivering bytes that failed or were appended afterwards.
 */
export async function forwardSession(
  sessionId: string,
  hooksOnly: boolean,
  credentials: SSOCredentials | JWTCredentials,
  classification?: ClassResult,
  resolved?: AnalyticsEndpoint
): Promise<void> {
  // Resolved once per pass (the tick passes its own); a mismatching destination sends nothing.
  const endpoint = resolved ?? (await resolveAnalyticsEndpoint(credentials));
  if (!endpoint) return;
  const { baseUrl } = endpoint;

  const status = await withSessionLock(sessionId, () => readStatus(sessionId));
  let evidence: EvidenceContext | undefined;
  if (status?.sendMode === 'evidence') {
    const ctx = await evidenceContext(sessionId, baseUrl, credentials, endpoint, classification);
    if (!ctx) {
      logger.debug('[otlp-forwarder] evidence record unavailable, nothing sent', ...sanitizeLogArgs({ sessionId }));
      return;
    }
    evidence = ctx;
  }

  const hooksResult = await forwardHooks(sessionId, baseUrl, credentials, evidence);
  if (authExpired(hooksResult)) {
    markCredentialsStale();
    return;
  }

  if (hooksOnly) {
    return;
  }

  for (const stream of OTEL_STREAMS) {
    const result = await forwardOtelStream(sessionId, stream, baseUrl, credentials, evidence);
    if (authExpired(result)) {
      markCredentialsStale();
      return;
    }
  }
}
