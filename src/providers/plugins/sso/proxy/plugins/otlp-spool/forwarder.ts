import { rawProjectHeader } from '@/utils/header-value.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import type { SSOCredentials, JWTCredentials } from '../../../../../core/types.js';
import { isSSOCredentials, isJWTCredentials } from '../../../../../core/types.js';
import { buildAuthHeaders } from '../../../../../core/codemie-auth-helpers.js';
import { CODEMIE_ENDPOINTS } from '../../../sso.http-client.js';
import { OTEL_STREAMS, type OtelStream, type SpoolStream } from './spool-paths.js';
import {
  advanceCursor,
  markSessionEnded,
} from './session-status.js';
import {
  isSendAllowed,
  snapshotPendingBytes,
  snapshotPendingHookRecords,
} from './spool-io.js';
import { areCredentialsStale, markCredentialsStale } from './auth-state.js';
import { groupHookRecords } from './hook-records.js';

const OTEL_ENDPOINTS: Record<OtelStream, string> = {
  logs: CODEMIE_ENDPOINTS.CLI_ANALYTICS_LOGS,
  metrics: CODEMIE_ENDPOINTS.CLI_ANALYTICS_METRICS,
  traces: CODEMIE_ENDPOINTS.CLI_ANALYTICS_TRACES,
};

const FORWARD_TIMEOUT_MS = 20_000;

/**
 * Project of the request: one per hook group (each event's own project, unnamed events under the
 * session's bound project), the bound project for OTLP streams. The backend gates analytics on it.
 */
const PROJECT_HEADER = 'X-CodeMie-Project';

type SendResult = 'ok' | 'failed' | 'auth-expired';

/**
 * Reasons the backend reports when it discards a request it answered with 200: the `REASON_*`
 * constants of the backend's `cli_analytics_project_gate.py`, as surfaced by `postgres/ingestor.py`
 * (`_otlp_result` for the OTLP routes, the discard body of the hooks route).
 */
export const BACKEND_DROP_REASONS: ReadonlySet<string> = new Set([
  'cli_analytics_disabled',
  'project_context_required',
  'project_context_conflict',
]);

/* ------------------------------------------------------------------ auth --- */

function buildAuthHeadersFromCreds(
  credentials: SSOCredentials | JWTCredentials
): Record<string, string> | null {
  if (isSSOCredentials(credentials)) {
    return buildAuthHeaders(credentials.cookies);
  }
  if (isJWTCredentials(credentials)) {
    return buildAuthHeaders(credentials.token);
  }
  return null;
}

/* ------------------------------------------------------------------ http --- */

async function postToBackend(
  url: string,
  body: string | Buffer,
  contentType: string,
  credentials: SSOCredentials | JWTCredentials,
  project: string
): Promise<Response> {
  const headers = buildAuthHeadersFromCreds(credentials);
  if (!headers) {
    throw new Error('Unsupported credential type');
  }
  headers['Content-Type'] = contentType;
  const projectValue = rawProjectHeader(project);
  if (projectValue !== undefined) {
    headers[PROJECT_HEADER] = projectValue;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual',
    });
  } finally {
    clearTimeout(timer);
  }
}

const DROP_BODY_TIMEOUT_MS = 2_000;
const DROP_BODY_MAX_CHARS = 4_096;

const DROP_WARN_INTERVAL_MS = 60_000;
const lastDropWarn = new Map<string, number>();

/** The drop reason and count from a response body. The body is read whole; `DROP_BODY_MAX_CHARS` bounds only how much of it is parsed. */
function parseDropBody(body: string): { reason?: unknown; dropped?: unknown } {
  if (body.length <= DROP_BODY_MAX_CHARS) {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  }
  const head = body.slice(0, DROP_BODY_MAX_CHARS);
  const reason = /"reason"\s*:\s*"([^"\\]{1,64})"/.exec(head)?.[1];
  const dropped = /"dropped"\s*:\s*(\d{1,9})\b/.exec(head)?.[1];
  return { reason, dropped: dropped === undefined ? undefined : Number(dropped) };
}

/**
 * The OTLP routes answer a discarded request with a protobuf `partial_success` whose
 * `error_message` is the reason string; the reason is plain ASCII inside the binary body.
 */
function parseOtlpDropBody(body: string): { reason?: unknown; dropped?: unknown } {
  const head = body.slice(0, DROP_BODY_MAX_CHARS);
  return { reason: [...BACKEND_DROP_REASONS].find((reason) => head.includes(reason)) };
}

/**
 * The backend answers 200 even when its project gate discards a request. The hooks route says so
 * in its JSON body and the OTLP routes in `partial_success`; surface it, without ever affecting the send result. The warning is throttled
 * per session, project and reason so a persistent drop cannot flood the log, while a drop for
 * another project of the same session still shows.
 */
async function warnOnBackendDrop(
  response: Response,
  sessionId: string,
  stream: SpoolStream,
  project: string
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const body = await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error('body read timeout')), DROP_BODY_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    const { reason, dropped } = stream === 'hooks' ? parseDropBody(body) : parseOtlpDropBody(body);
    if (typeof reason !== 'string' || !BACKEND_DROP_REASONS.has(reason)) {
      return;
    }
    const key = `${sessionId}:${project.toLowerCase()}:${reason}`;
    const now = Date.now();
    const last = lastDropWarn.get(key);
    if (last !== undefined && now - last < DROP_WARN_INTERVAL_MS) {
      return;
    }
    if (lastDropWarn.size > 256) lastDropWarn.clear();
    lastDropWarn.set(key, now);
    logger.warn(
      '[otlp-forwarder] backend dropped analytics events',
      ...sanitizeLogArgs({
        sessionId,
        stream,
        project,
        reason,
        dropped: typeof dropped === 'number' ? dropped : undefined,
      })
    );
  } catch {
    // Unreadable or non-JSON body: nothing to report.
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await response.body?.cancel();
    } catch {
      // Body already consumed or closed.
    }
  }
}

const isAuthFailure = (response: Response): boolean =>
  response.status === 401 ||
  response.status === 403 ||
  response.status === 302;

/**
 * POST a batch, retrying once on auth failures or login redirects. Anything other than
 * `'ok'` leaves the bytes on disk with the cursor untouched, so the next tick retries them.
 */
async function send(
  sessionId: string,
  stream: SpoolStream,
  url: string,
  body: string | Buffer,
  contentType: string,
  credentials: SSOCredentials | JWTCredentials,
  project: string,
  range: { cursor: number; end: number; filtered: boolean }
): Promise<SendResult> {
  if (areCredentialsStale()) {
    return 'failed';
  }

  // Local re-check before every attempt, per stream and per snapshotted byte range: narrows the
  // window between the locked snapshot and the wire, it does not close it. A sealed session passes
  // it for its hooks prefix only. `null` = no longer sendable, nothing is fetched (the next
  // snapshot applies the policy under the lock).
  const attempt = async (): Promise<Response | null> =>
    (await isSendAllowed(sessionId, stream, project, range))
      ? postToBackend(url, body, contentType, credentials, project)
      : null;

  try {
    let response = await attempt();
    if (!response) {
      return 'failed';
    }
    if (isAuthFailure(response)) {
      response = await attempt();
      if (!response) {
        return 'failed';
      }
      if (isAuthFailure(response)) {
        return 'auth-expired';
      }
    }
    if (response.ok) {
      void warnOnBackendDrop(response, sessionId, stream, project);
      return 'ok';
    }

    logger.debug(
      '[otlp-forwarder] non-success response',
      ...sanitizeLogArgs({ sessionId, stream, status: response.status })
    );

    return 'failed';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(
      '[otlp-forwarder] request error',
      ...sanitizeLogArgs({ sessionId, stream, err: msg })
    );
    return 'failed';
  }
}

/* ------------------------------------------------------------ forwarding --- */

async function resolveBaseUrl(): Promise<string> {
  const { readState } = await import(
    '../../../../../../cli/commands/proxy/daemon-manager.js'
  );
  const state = await readState();
  return state?.targetUrl ?? state?.url ?? '';
}

/**
 * Forward the complete hook records after the hooks cursor, one request per project group, in
 * order. The groups share one byte range: the cursor advances only after every group returned
 * `ok`; the first other result stops the batch and is returned with the cursor untouched, so the
 * next tick re-sends the whole range, accepted groups included (the backend skips records it
 * already ingested). One persistently failing group therefore holds back the whole range.
 */
async function forwardHooks(
  sessionId: string,
  baseUrl: string,
  credentials: SSOCredentials | JWTCredentials
): Promise<SendResult | 'idle'> {
  const batch = await snapshotPendingHookRecords(sessionId);
  if (!batch) {
    return 'idle';
  }

  const filtered = batch.filtered === true;
  const payload = groupHookRecords(batch.records, batch.project, filtered);
  if (payload.malformed > 0) {
    logger.debug(
      '[otlp-forwarder] skipped malformed hook records',
      ...sanitizeLogArgs({ sessionId, count: payload.malformed })
    );
  }
  if (payload.unsendable > 0) {
    logger.debug(
      '[otlp-forwarder] hook record groups with a project name that cannot be sent were not sent',
      ...sanitizeLogArgs({ sessionId, count: payload.unsendable })
    );
  }
  if (batch.dropped > 0) {
    logger.debug(
      '[otlp-forwarder] hook records not provably the sealed project were not sent',
      ...sanitizeLogArgs({ sessionId, count: batch.dropped })
    );
  }

  const end = batch.cursor + batch.byteLength;
  if (payload.groups.length === 0) {
    // Nothing sendable, but the bytes were consumed — keep the cursor aligned. No request will
    // carry a session end held by an unsent group, so it is recorded here rather than left to
    // the abandoned-session grace.
    await advanceCursor(sessionId, 'hooks', end);
    if (payload.unsendableSessionEnd) {
      await markSessionEnded(sessionId);
    }
    return 'idle';
  }

  const url = `${baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS}`;
  const range = { cursor: batch.cursor, end, filtered };
  for (const group of payload.groups) {
    const result = await send(
      sessionId, 'hooks', url, group.ndjson, 'application/x-ndjson', credentials, group.project, range
    );
    if (result !== 'ok') {
      return result;
    }
  }

  await advanceCursor(sessionId, 'hooks', end);

  if (payload.groups.some((group) => group.containsSessionEnd)) {
    await markSessionEnded(sessionId);
  }

  return 'ok';
}

/** Forward the raw protobuf bytes after an OTEL stream's cursor. */
async function forwardOtelStream(
  sessionId: string,
  stream: OtelStream,
  baseUrl: string,
  credentials: SSOCredentials | JWTCredentials
): Promise<SendResult | 'idle'> {
  const pending = await snapshotPendingBytes(sessionId, stream);
  if (!pending) {
    return 'idle';
  }

  const url = `${baseUrl}${OTEL_ENDPOINTS[stream]}`;
  const result = await send(
    sessionId, stream, url, pending.bytes, 'application/x-protobuf', credentials, pending.project,
    { cursor: pending.cursor, end: pending.cursor + pending.bytes.length, filtered: false }
  );
  if (result !== 'ok') {
    return result;
  }

  await advanceCursor(sessionId, stream, pending.cursor + pending.bytes.length);
  return 'ok';
}

/**
 * Forward everything a session has pending to the CodeMie analytics backend.
 *
 * Each stream is read from its own cursor and acknowledged independently, so a
 * failure on one stream never blocks or rewinds another. Cursors only advance
 * after a successful response, which yields at-least-once delivery: a crash
 * between backend success and cursor persistence re-sends that batch.
 *
 * Hook events go out in one request per project, each with its own `X-CodeMie-Project` header
 * (unnamed events under the session's bound project); the OTLP streams carry the bound project.
 *
 * A forwarded `SessionEnd` only records `endedAt`; it never stops later ticks
 * from delivering bytes that failed or were appended afterwards.
 */
export async function forwardSession(
  sessionId: string,
  hooksOnly: boolean,
  credentials: SSOCredentials | JWTCredentials
): Promise<void> {
  const baseUrl = await resolveBaseUrl();

  const hooksResult = await forwardHooks(sessionId, baseUrl, credentials);
  if (hooksResult === 'auth-expired') {
    markCredentialsStale();
    return;
  }

  if (hooksOnly) {
    return;
  }

  for (const stream of OTEL_STREAMS) {
    const result = await forwardOtelStream(sessionId, stream, baseUrl, credentials);
    if (result === 'auth-expired') {
      markCredentialsStale();
      return;
    }
  }
}
