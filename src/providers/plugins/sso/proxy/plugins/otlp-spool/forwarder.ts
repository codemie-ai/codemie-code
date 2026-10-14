import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import type { SSOCredentials, JWTCredentials } from '../../../../../core/types.js';
import { isSSOCredentials, isJWTCredentials } from '../../../../../core/types.js';
import { buildAuthHeaders } from '../../../../../core/codemie-auth-helpers.js';
import { CODEMIE_ENDPOINTS } from '../../../sso.http-client.js';
import { OTEL_STREAMS, type OtelStream } from './spool-paths.js';
import {
  advanceCursor,
  markSessionEnded,
} from './session-status.js';
import { OtlpHookSpoolData } from '../otlp.plugin.js';
import { snapshotPendingBytes, snapshotPendingHookRecords } from './spool-io.js';
import { areCredentialsStale, markCredentialsStale } from './auth-state.js';

const SESSION_END_EVENT_TYPE = 'agent.session.end';

const OTEL_ENDPOINTS: Record<OtelStream, string> = {
  logs: CODEMIE_ENDPOINTS.CLI_ANALYTICS_LOGS,
  metrics: CODEMIE_ENDPOINTS.CLI_ANALYTICS_METRICS,
  traces: CODEMIE_ENDPOINTS.CLI_ANALYTICS_TRACES,
};

const FORWARD_TIMEOUT_MS = 20_000;

type SendResult = 'ok' | 'failed' | 'auth-expired';

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
  credentials: SSOCredentials | JWTCredentials
): Promise<Response> {
  const headers = buildAuthHeadersFromCreds(credentials);
  if (!headers) {
    throw new Error('Unsupported credential type');
  }
  headers['Content-Type'] = contentType;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  try {
    return await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const isAuthFailure = (response: Response): boolean =>
  response.status === 401 || response.status === 403;

/**
 * POST a batch, retrying once on 401/403. Anything other than `'ok'` leaves the
 * bytes on disk with the cursor untouched, so the next tick retries them.
 */
async function send(
  sessionId: string,
  stream: string,
  url: string,
  body: string | Buffer,
  contentType: string,
  credentials: SSOCredentials | JWTCredentials
): Promise<SendResult> {
  if (areCredentialsStale()) {
    return 'failed';
  }

  try {
    let response = await postToBackend(url, body, contentType, credentials);
    if (isAuthFailure(response)) {
      response = await postToBackend(url, body, contentType, credentials);
      if (isAuthFailure(response)) {
        return 'auth-expired';
      }
    }
    if (response.ok) {
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

  const payload = unwrapHookRecords(batch.records);
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

  const url = `${baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS}`;
  const result = await send(
    sessionId, 'hooks', url, payload.ndjson, 'application/x-ndjson', credentials
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
    sessionId, stream, url, pending.bytes, 'application/x-protobuf', credentials
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
