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
import { OtlpHookSpoolData } from '../otlp.plugin.js';
import {
  isSendAllowed,
  snapshotPendingBytes,
  snapshotPendingHookRecords,
} from './spool-io.js';
import { areCredentialsStale, markCredentialsStale } from './auth-state.js';

const SESSION_END_EVENT_TYPE = 'agent.session.end';

const OTEL_ENDPOINTS: Record<OtelStream, string> = {
  logs: CODEMIE_ENDPOINTS.CLI_ANALYTICS_LOGS,
  metrics: CODEMIE_ENDPOINTS.CLI_ANALYTICS_METRICS,
  traces: CODEMIE_ENDPOINTS.CLI_ANALYTICS_TRACES,
};

const FORWARD_TIMEOUT_MS = 20_000;

/** Project the session is bound to; the backend gates analytics on it. */
const PROJECT_HEADER = 'X-CodeMie-Project';

type SendResult = 'ok' | 'failed' | 'auth-expired';

const BACKEND_DROP_REASONS: ReadonlySet<string> = new Set([
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

/**
 * The backend answers 200 even when its project gate discards a request. The hooks route says so
 * in its JSON body; surface it, without ever affecting the send result.
 */
async function warnOnBackendDrop(
  response: Response,
  sessionId: string,
  stream: SpoolStream
): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await response.text());
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }
    const { reason, dropped } = parsed as { reason?: unknown; dropped?: unknown };
    if (typeof reason !== 'string' || !BACKEND_DROP_REASONS.has(reason)) {
      return;
    }
    logger.warn(
      '[otlp-forwarder] backend dropped analytics events',
      ...sanitizeLogArgs({
        sessionId,
        stream,
        reason,
        dropped: typeof dropped === 'number' ? dropped : undefined,
      })
    );
  } catch {
    // Unreadable or non-JSON body: nothing to report.
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
      if (stream === 'hooks') {
        await warnOnBackendDrop(response, sessionId, stream);
      }
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

/* ------------------------------------------------------------- unwrapping --- */

interface HookPayload {
  ndjson: string;
  containsSessionEnd: boolean;
  malformed: number;
}

function pinEventProject(serialized: string, wireEvent: Record<string, unknown>, project: string): string {
  let changed = false;
  const pin = (holder: unknown): void => {
    if (typeof holder !== 'object' || holder === null) return;
    const fields = holder as Record<string, unknown>;
    const value = fields['codemie_project_name'];
    if (typeof value === 'string' && value !== project) {
      fields['codemie_project_name'] = project;
      changed = true;
    }
  };
  pin(wireEvent);
  pin(wireEvent['raw']);
  return changed ? JSON.stringify(wireEvent) : serialized;
}

/**
 * Unwraps the spool envelopes. `hookEvent` is already the final wire event, built at hook time
 * by the adapter, so it is forwarded as is: same bytes on every retry. With `project`, an event
 * whose `codemie_project_name` (top level or `raw`) differs is rewritten to it, so the header and
 * every event agree and the backend never sees two projects in one request.
 */
export function unwrapHookRecords(records: string[], project?: string): HookPayload {
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
    unwrapped.push(project ? pinEventProject(serialized, wireEvent, project) : serialized);
  }

  return {
    ndjson: unwrapped.length > 0 ? `${unwrapped.join('\n')}\n` : '',
    containsSessionEnd,
    malformed,
  };
}

/* ------------------------------------------------------------ forwarding --- */

async function resolveBaseUrl(): Promise<string> {
  const { readState } = await import(
    '../../../../../../cli/commands/proxy/daemon-manager.js'
  );
  const state = await readState();
  return state?.targetUrl ?? state?.url ?? '';
}

/** Forward the complete hook records after the hooks cursor. */
async function forwardHooks(
  sessionId: string,
  baseUrl: string,
  credentials: SSOCredentials | JWTCredentials
): Promise<SendResult | 'idle'> {
  const batch = await snapshotPendingHookRecords(sessionId);
  if (!batch) {
    return 'idle';
  }

  const payload = unwrapHookRecords(batch.records, batch.project);
  if (payload.malformed > 0) {
    logger.debug(
      '[otlp-forwarder] skipped malformed hook records',
      ...sanitizeLogArgs({ sessionId, count: payload.malformed })
    );
  }

  if (payload.ndjson.length === 0) {
    // Nothing sendable, but the bytes were consumed — keep the cursor aligned.
    await advanceCursor(sessionId, 'hooks', batch.cursor + batch.byteLength);
    return 'idle';
  }

  if (batch.dropped > 0) {
    logger.debug(
      '[otlp-forwarder] hook records not provably the sealed project were not sent',
      ...sanitizeLogArgs({ sessionId, count: batch.dropped })
    );
  }

  const url = `${baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS}`;
  const result = await send(
    sessionId, 'hooks', url, payload.ndjson, 'application/x-ndjson', credentials, batch.project,
    { cursor: batch.cursor, end: batch.cursor + batch.byteLength, filtered: batch.filtered === true }
  );
  if (result !== 'ok') {
    return result;
  }

  await advanceCursor(sessionId, 'hooks', batch.cursor + batch.byteLength);

  if (payload.containsSessionEnd) {
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
