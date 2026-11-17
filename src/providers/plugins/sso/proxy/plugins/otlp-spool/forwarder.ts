import { rawProjectHeader } from '@/utils/header-value.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import type { ClassResult } from '@/agents/core/evidence/classify.js';
import type { SSOCredentials, JWTCredentials } from '../../../../../core/types.js';
import { CODEMIE_ENDPOINTS } from '../../../sso.http-client.js';
import {
  OTEL_STREAMS,
  OTEL_JSON_STREAMS,
  OTEL_SIGNAL_BY_JSON_STREAM,
  type OtelStream,
  type OtelJsonStream,
  type SpoolStream,
} from './spool-paths.js';
import {
  advanceCursor,
  endsSessionDiscard,
  markSessionEnded,
  readStatus,
  type Discard,
} from './session-status.js';
import { OtlpHookSpoolData } from '../otlp.plugin.js';
import { holdForIdleReopen } from './reopen-hold.js';
import { deliveryGate, ENDED_MARKER_UNWRITTEN, recordUnacknowledged, type HoldExpiry } from './delivery-state.js';
import {
  isSendAllowed,
  noteStreamHold,
  snapshotPendingBytes,
  snapshotPendingHookRecords,
  snapshotPendingNdjsonRecords,
} from './spool-io.js';
import { areCredentialsStale, markCredentialsStale } from './auth-state.js';
import { withSessionLock } from './session-lock.js';
import { authHeadersFor, resolveAnalyticsEndpoint, sessionPolicyState, type AnalyticsEndpoint } from './classification.js';
import { advertisesContract } from './policy-cache.js';
import { MAX_SNAPSHOT_BYTES, proveHookLines, proveRange, type ProofReason } from './otlp-reader.js';
import { proveJsonRecord } from './otlp-json-reader.js';
import { PROJECT_HEADER, evidenceContext, evidenceHeaders, reclassify, sendGuard, type EvidenceContext } from './evidence-send.js';
import { BOUND_PROJECT_HEADER, CONTRACT_HEADER, DESTINATION_HEADER, PUBLICATION_CONTRACT } from '@/agents/core/evidence/publication-contract.js';
import { writeNotice, writeStop } from '@/agents/core/evidence/stop-marker.js';
import { recordDestinationMarker } from './destination-intent.js';
import { writeDestinationMarker } from '@/agents/core/evidence/accepted-marker.js';
import { beginSend, endSend, stopOrRecordIntent, tryStop } from './stop-intent.js';
import { projectTag, readRecord, recordKey, type EvidenceRecord } from '@/agents/core/evidence/record-store.js';
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
      echo: {
        contract: response.headers?.get(CONTRACT_HEADER) ?? undefined,
        destination: response.headers?.get(DESTINATION_HEADER) ?? undefined,
        boundProject: response.headers?.get(BOUND_PROJECT_HEADER) ?? undefined,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

interface WireResponse {
  status: number;
  contentType: string;
  body: BodyRead;
  echo: { contract?: string; destination?: string; boundProject?: string };
}

/**
 * An accepted new-contract response is publication only with the contract echo and a destination; for consent
 * (N1) the destination must be the project and the bound project must equal the frozen one (case-insensitive).
 * Funding is never compared. A recognised discard needs no echo (the backend omits it).
 */
function echoVerified(echo: WireResponse['echo'], ctx: EvidenceContext): boolean {
  if (echo.contract !== PUBLICATION_CONTRACT) return false;
  const dest = echo.destination?.toLowerCase();
  if (dest !== 'project' && dest !== 'personal') return false;
  if (!ctx.consent) return true;
  return dest === 'project' && !!echo.boundProject && echo.boundProject.toLowerCase() === (ctx.record.project ?? '').toLowerCase();
}

/** Persist the stop; a failed marker write is kept as a stop intent that blocks every later send and retries (stop-intent.ts). */
async function stopSession(ctx: EvidenceContext, reason: Parameters<typeof writeStop>[1]): Promise<'marker' | 'intent' | 'volatile'> {
  return stopOrRecordIntent(ctx.key, reason, ctx.record.session_id);
}

/** First-hold notice per 503 hold cause (create-once: the first hold of a session is the one the user is told about). */
const HOLD_NOTICE: Record<string, Parameters<typeof writeNotice>[1]> = {
  publication_contract_unavailable: 'hold_contract_unavailable',
  personal_storage_unsupported: 'hold_personal_unsupported',
  project_unavailable: 'hold_project_unavailable',
  project_analytics_not_enabled: 'hold_project_unavailable',
  destination_unsupported: 'hold_destination_unsupported',
};

/** A backend hold that reached its original retention bound suspends the session (nothing more is published) with a notice. */
/**
 * What makes an expiring hold durable. A refusal whose ended marker was lost (`ENDED_MARKER_UNWRITTEN`) expires only once
 * that marker is written, whatever the wire protocol: until then the hold keeps the legacy gate pending. A new-contract
 * hold stops the session; any other hold just expires.
 */
function holdExpiredStop(ctx: EvidenceContext | undefined, guard?: RecordGuard): HoldExpiry {
  return async (hold) => {
    if (hold.detail === ENDED_MARKER_UNWRITTEN) {
      const recorded = ctx ?? guard;
      if (!recorded) return true; // unrecorded legacy session: no gate reads a marker for it
      return writeDestinationMarker({ marker: 'ended' }, recorded.key, recorded.record.session_id).then(() => true, () => false);
    }
    return ctx?.newContract ? tryStop(ctx.key, 'hold_expired', ctx.record.session_id) : true;
  };
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
  /** The recorded session's privacy guard for every attempt, whatever the wire headers (an evidence context is one too). */
  guard?: RecordGuard;
}

/** A recorded session's key and frozen record: all  needs. */
export interface RecordGuard { key: string; record: EvidenceRecord }

function requestHeaders(req: SendRequest): Record<string, string> {
  if (req.evidence && req.evidence.wireMode !== 'legacy') return evidenceHeaders(req.sessionId, req.evidence);
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
  // A new-contract attempt first makes its write-ahead checkpoint durable (no checkpoint = no request), see stop-intent.ts.
  let stopUnrecorded = false;
  const attempt = async (): Promise<WireResponse | null> => {
    const guard = req.evidence ?? req.guard;
    if (!(await isSendAllowed(sessionId, stream, req.project, req.range)) || (guard && !(await sendGuard(guard.key, guard.record)))) return null;
    if (req.evidence?.newContract && !(await beginSend(req.evidence.key, sessionId))) return null;
    return postToBackend(req.url, req.body, req.contentType, req.credentials, requestHeaders(req));
  };
  const stopped = async (ctx: EvidenceContext, reason: Parameters<typeof writeStop>[1]): Promise<void> => {
    if ((await stopSession(ctx, reason)) === 'volatile') stopUnrecorded = true;
  };

  // A 422 publication_contract_unsupported gets exactly one capability refresh before it is final.
  let contractRefreshed = false;
  const exchange = async (): Promise<SendOutcome> => {
    let response = await attempt();
    if (response && isAuthFailure(response)) {
      response = await attempt();
      if (response && isAuthFailure(response)) return { kind: 'auth-expired' };
    }
    if (!response) return { kind: 'failed', reason: 'not_sendable' };
    let outcome = decodeResponse(response.status, response.contentType, response.body, stream === 'hooks', !!req.evidence);
    if (req.evidence?.newContract) {
      const ctx = req.evidence;
      if (outcome.final && outcome.reason === 'publication_contract_unsupported' && !contractRefreshed) {
        contractRefreshed = true;
        const state = await sessionPolicyState(ctx.ns, ctx.baseUrl, ctx.credentials, true, undefined, true);
        // Still advertised after the refresh: resend once (a second refusal is final). No longer advertised: hold, not stop.
        if (advertisesContract(state)) return exchange();
        outcome = { kind: 'retry', reason: 'http_422', detail: 'publication_contract_unavailable', hold: true };
      }
      if (outcome.kind === 'ok' && !echoVerified(response.echo, ctx)) {
        // Never acknowledged, and never retried into more unverified publication: the session stops with a notice.
        outcome = { kind: 'failed', reason: 'response_unverified' };
        await stopped(ctx, 'response_unverified');
      } else if (outcome.kind === 'ok' && !outcome.reason && ctx.consent) {
        // The backend accepted the consented project as the destination: the legacy /v1/metrics gate waits for this.
        // Before the cursor advances: a marker that cannot be written is kept as an intent and repaired from there.
        // Tagged with the accepted project: it never confirms a later resume of the session under another project
        await recordDestinationMarker({ marker: 'accepted', projectTag: projectTag(ctx.record.project ?? '') }, ctx.key, sessionId);
      } else if (outcome.final) {
        await stopped(ctx, outcome.reason === 'publication_contract_requires_session' ? 'requires_session'
          : outcome.reason?.startsWith('consent') ? 'consent_invalid' : 'contract_unsupported');
      } else if (outcome.hold) {
        await writeNotice(ctx.key, HOLD_NOTICE[outcome.detail ?? ''] ?? 'hold_contract_unavailable', ctx.record.session_id).catch(() => undefined);
      }
    }
    // Legacy JSON exports are independent records; retain main's payload-rejection policy.
    // Evidence requests keep 400 retryable because missing evidence headers are recoverable.
    if (!req.evidence && OTEL_JSON_STREAMS.includes(stream as OtelJsonStream) && [400, 413, 422].includes(response.status)) {
      return { kind: 'discarded', reason: 'payload_rejected' };
    }
    return outcome;
  };

  let outcome: SendOutcome;
  try {
    outcome = await exchange();
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(
      '[otlp-forwarder] request error',
      ...sanitizeLogArgs({ sessionId, stream, err: msg })
    );
    outcome = { kind: 'retry', reason: 'request_error' };
  }
  // A discard that ends the session's publication outlives the swept status as a marker the legacy gate checks first,
  // written before the cursor advances (acknowledge records the same discard in the status). Neither the marker nor its
  // intent durable: the batch stays unacknowledged, so its resend meets the same final answer and tries again.
  const recorded = req.evidence ?? req.guard;
  if (recorded && acknowledged(outcome) && outcome.reason && endsSessionDiscard({ reason: outcome.reason, stream })) {
    if ((await recordDestinationMarker({ marker: 'ended' }, recorded.key, sessionId)) === 'lost') {
      // Held, not failed: the legacy gate reads a held delivery as pending, so no older acceptance is used meanwhile
      outcome = { kind: 'retry', reason: ENDED_MARKER_UNWRITTEN, detail: ENDED_MARKER_UNWRITTEN, hold: true };
    }
  }
  await recordUnacknowledged(sessionId, stream, outcome, req.range, holdExpiredStop(req.evidence, req.guard));
  // Outcome processed (acknowledged, held or retried): the checkpoint is released unless a required stop is recorded nowhere durable.
  if (req.evidence?.newContract) await endSend(req.evidence.key, sessionId, stopUnrecorded);
  return outcome;
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
  evidence?: EvidenceContext,
  guard?: RecordGuard
): Promise<SendOutcome | 'idle'> {
  if ((await deliveryGate(sessionId, 'hooks', Date.now(), holdExpiredStop(evidence, guard))) === 'wait') return 'idle';
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
    evidence, guard,
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
  evidence?: EvidenceContext,
  guard?: RecordGuard
): Promise<SendOutcome | 'idle'> {
  let last: SendOutcome | 'idle' = 'idle';
  if ((await deliveryGate(sessionId, stream, Date.now(), holdExpiredStop(evidence, guard))) === 'wait') return last;
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
      evidence, guard,
    });
    if (!acknowledged(result)) return result;

    await acknowledge(sessionId, stream, pending.cursor + bytes.length, bytes.length, result);
    last = result;
    if (!pending.more) break;
  }
  return last;
}

/** Forward masked-JSON OTEL records: one complete application/json POST per NDJSON line. */
async function forwardOtelJsonStream(
  sessionId: string,
  stream: OtelJsonStream,
  baseUrl: string,
  credentials: SSOCredentials | JWTCredentials,
  evidence?: EvidenceContext,
  guard?: RecordGuard
): Promise<SendOutcome | 'idle'> {
  if ((await deliveryGate(sessionId, stream, Date.now(), holdExpiredStop(evidence, guard))) === 'wait') return 'idle';
  const batch = await snapshotPendingNdjsonRecords(sessionId, stream);
  if (!batch) {
    return 'idle';
  }

  if (batch.records.length === 0) {
    // Nothing sendable, but the bytes were consumed — keep the cursor aligned.
    await advanceCursor(sessionId, stream, batch.cursor + batch.byteLength);
    return 'idle';
  }

  const url = `${baseUrl}${OTEL_ENDPOINTS[OTEL_SIGNAL_BY_JSON_STREAM[stream]]}`;
  // Acknowledge each record right after its own confirmed send — not once for the whole
  // batch — so a failure partway through a batch never re-sends what already succeeded.
  let cursor = batch.cursor;
  for (const record of batch.records) {
    const recordByteLength = Buffer.byteLength(record, 'utf8') + 1; // +1 for the newline cut off when the batch was split
    const range = { cursor, end: cursor + recordByteLength, filtered: false };
    if (evidence) {
      const proof = proveJsonRecord(record, { sessionId, project: evidence.record.project || undefined, signal: OTEL_SIGNAL_BY_JSON_STREAM[stream] });
      if ((await noteProof(sessionId, stream, proof.verified, Buffer.byteLength(record), proof.hold)) === 'lost') return 'idle';
      if (proof.hold) return 'idle';
    }
    const result = await send({ sessionId, stream, url, body: record, contentType: 'application/json', credentials,
      project: batch.project, range, evidence, guard });
    if (!acknowledged(result)) return result;
    cursor += recordByteLength;
    await acknowledge(sessionId, stream, cursor, recordByteLength, result);
  }

  return { kind: 'ok' };
}
const authExpired = (r: SendOutcome | 'idle'): boolean => r !== 'idle' && r.kind === 'auth-expired';

/**
 * A session sent without an evidence context answers to its record, if it has one (no record = the unstamped legacy path,
 * unchanged). Returns the guard every attempt re-checks, `null` when the scope does not hold now, `undefined` when unrecorded.
 */
async function recordedGuard(sessionId: string, endpoint: AnalyticsEndpoint): Promise<RecordGuard | null | undefined> {
  const id = endpoint.identity;
  if (!id) return undefined;
  const key = recordKey(id.api_identity, id.owner_hash, sessionId);
  const found = await readRecord(key);
  if (!found) return undefined;
  if (found.kind !== 'existing' && found.kind !== 'created') return null;
  // A lost/unreadable sendMode must not strip the contract from a recorded contract session.
  if (found.record.funding_route !== undefined) return null;
  return (await sendGuard(key, found.record)) ? { key, record: found.record } : null;
}

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
  let guard: RecordGuard | undefined;
  if (status?.sendMode === 'evidence') {
    const ctx = await evidenceContext(sessionId, baseUrl, credentials, endpoint, classification);
    if (!ctx) {
      logger.debug('[otlp-forwarder] evidence record unavailable, nothing sent', ...sanitizeLogArgs({ sessionId }));
      return;
    }
    evidence = ctx;
  } else {
    // A legacy-mode send still answers to a recorded session's privacy continuity, at the start and again before EACH request.
    const recorded = await recordedGuard(sessionId, endpoint);
    if (recorded === null) {
      logger.debug('[otlp-forwarder] recorded scope does not hold, nothing sent', ...sanitizeLogArgs({ sessionId }));
      return;
    }
    guard = recorded;
  }

  const hooksResult = await forwardHooks(sessionId, baseUrl, credentials, evidence, guard);
  if (authExpired(hooksResult)) {
    markCredentialsStale();
    return;
  }

  if (hooksOnly) {
    return;
  }

  // A reopened session without activity of its own sends nothing of Claude Code's startup records.
  if (await holdForIdleReopen(sessionId)) return;

  for (const stream of OTEL_STREAMS) {
    const result = await forwardOtelStream(sessionId, stream, baseUrl, credentials, evidence, guard);
    if (authExpired(result)) {
      markCredentialsStale();
      return;
    }
  }

  for (const stream of OTEL_JSON_STREAMS) {
    const result = await forwardOtelJsonStream(sessionId, stream, baseUrl, credentials, evidence, guard);
    if (authExpired(result)) {
      markCredentialsStale();
      return;
    }
  }
}
