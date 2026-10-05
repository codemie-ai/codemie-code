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

const HOOK_EVENT_TYPE_MAP: Record<string, string> = {
  SessionStart: 'agent.session.start',
  Stop: 'agent.session.stop',
  StopFailure: 'agent.turn.error',
  SessionEnd: 'agent.session.end',
  UserPromptSubmit: 'agent.prompt.submit',
  PreToolUse: 'agent.tool.start',
  PostToolUse: 'agent.tool.end',
  PostToolUseFailure: 'agent.tool.error',
  SubagentStart: 'agent.subagent.start',
  SubagentStop: 'agent.subagent.stop',
  PreCompact: 'agent.session.compact',
  Notification: 'agent.notification',
};

const OTEL_ENDPOINTS: Record<OtelStream, string> = {
  logs: CODEMIE_ENDPOINTS.CLI_ANALYTICS_LOGS,
  metrics: CODEMIE_ENDPOINTS.CLI_ANALYTICS_METRICS,
  traces: CODEMIE_ENDPOINTS.CLI_ANALYTICS_TRACES,
};

const MAX_PROMPT_CHARS = 200;
const MAX_TOOL_FIELD_CHARS = 300;
const FORWARD_TIMEOUT_MS = 20_000;

type SendResult = 'ok' | 'failed' | 'auth-expired';

interface ForwardContext {
  credentials: SSOCredentials | JWTCredentials;
  baseUrl: string;
  projectName: string;
  userEmail: string;
  /** Per-session git info cache, resolved lazily from the first hook `cwd`. */
  git: { branch?: string; remote?: string };
}

/* ------------------------------------------------------------------ auth --- */

function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function resolveUserEmail(credentials: SSOCredentials | JWTCredentials): string {
  if (isJWTCredentials(credentials)) {
    const claims = decodeJwtClaims(credentials.token);
    if (typeof claims['email'] === 'string' && claims['email']) {
      return claims['email'];
    }
  }
  if (isSSOCredentials(credentials)) {
    const accessToken = credentials.cookies['codemie_access_token'];
    if (accessToken) {
      const claims = decodeJwtClaims(accessToken);
      const email = claims['email'] ?? claims['preferred_username'];
      if (typeof email === 'string' && email) {
        return email;
      }
    }
  }
  return '';
}

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

/* --------------------------------------------------------------- mapping --- */

function hookEventType(hookName: string, event: Record<string, unknown>): string {
  if (hookName === 'PreToolUse') {
    return event['input'] && (event['input'] as Record<string, unknown>)['denied']
      ? 'agent.tool.denied'
      : 'agent.tool.start';
  }
  return HOOK_EVENT_TYPE_MAP[hookName] ?? 'agent.event';
}

function boundedText(value: unknown, maxChars: number): string {
  if (value === undefined || value === null) {
    return '';
  }
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value) ?? String(value);
          } catch {
            return String(value);
          }
        })();
  return text.slice(0, maxChars);
}

function limitHookPayload(hookEvent: Record<string, unknown>): Record<string, unknown> {
  const limited: Record<string, unknown> = { ...hookEvent };

  if (Object.prototype.hasOwnProperty.call(hookEvent, 'prompt')) {
    limited.prompt = boundedText(hookEvent.prompt, MAX_PROMPT_CHARS);
  }
  for (const field of ['tool_input', 'tool_response', 'error']) {
    if (Object.prototype.hasOwnProperty.call(hookEvent, field)) {
      limited[field] = boundedText(hookEvent[field], MAX_TOOL_FIELD_CHARS);
    }
  }
  // Prevent a nested/raw copy from bypassing the limits.
  delete limited.raw;

  return limited;
}

async function resolveGitInfo(ctx: ForwardContext, cwd: string): Promise<void> {
  if (!cwd || ctx.git.branch !== undefined) {
    return;
  }
  try {
    const { detectGitBranch, detectGitRemoteRepo } = await import('@/utils/processes.js');
    const [branch, remote] = await Promise.all([
      detectGitBranch(cwd).then((v) => v ?? ''),
      detectGitRemoteRepo(cwd).then((v) => v ?? ''),
    ]);
    ctx.git.branch = branch;
    ctx.git.remote = remote;
  } catch {
    /* best-effort */
  }
}

interface HookPayload {
  ndjson: string;
  containsSessionEnd: boolean;
  malformed: number;
}

async function mapHookRecords(records: string[], ctx: ForwardContext): Promise<HookPayload> {
  const mapped: string[] = [];
  let containsSessionEnd = false;
  let malformed = 0;

  for (const record of records) {
    let spoolData: OtlpHookSpoolData;
    let hookEvent: Record<string, unknown>;
    try {
      spoolData = JSON.parse(record) as OtlpHookSpoolData;
      hookEvent = JSON.parse(spoolData.raw) as Record<string, unknown>;
    } catch {
      // Complete but unusable record: dropped deliberately. Its bytes are still
      // acknowledged with the batch so the cursor can never get stuck on it.
      malformed += 1;
      continue;
    }

    const hookName = String(hookEvent['hook_event_name'] ?? '');
    if (hookName === 'SessionEnd') {
      containsSessionEnd = true;
    }

    const cwd = String(hookEvent['cwd'] ?? '');
    await resolveGitInfo(ctx, cwd);

    const limited = limitHookPayload(hookEvent);
    mapped.push(
      JSON.stringify({
        ...limited,
        type: hookEventType(hookName, hookEvent),
        session_id: String(hookEvent['session_id'] ?? ''),
        timestamp: new Date(spoolData.timestamp).toISOString(),
        user_email: ctx.userEmail,
        developer_name: ctx.userEmail,
        git_branch: ctx.git.branch ?? '',
        repo_remote: ctx.git.remote ?? '',
        codemie_project_name: ctx.projectName,
        cwd,
        prompt_body: boundedText(hookEvent['prompt'], MAX_PROMPT_CHARS),
        raw: limited,
      })
    );
  }

  return {
    ndjson: mapped.length > 0 ? `${mapped.join('\n')}\n` : '',
    containsSessionEnd,
    malformed,
  };
}

/* ------------------------------------------------------------ forwarding --- */

async function buildForwardContext(
  credentials: SSOCredentials | JWTCredentials
): Promise<ForwardContext> {
  const { readState } = await import(
    '../../../../../../cli/commands/proxy/daemon-manager.js'
  );
  const state = await readState();

  return {
    credentials,
    baseUrl: state?.targetUrl ?? state?.url ?? '',
    projectName: state?.project ?? '',
    userEmail: resolveUserEmail(credentials),
    git: {},
  };
}

/** Forward the complete hook records after the hooks cursor. */
async function forwardHooks(
  sessionId: string,
  ctx: ForwardContext
): Promise<SendResult | 'idle'> {
  const batch = await snapshotPendingHookRecords(sessionId);
  if (!batch) {
    return 'idle';
  }

  const payload = await mapHookRecords(batch.records, ctx);
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

  const url = `${ctx.baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS}`;
  const result = await send(
    sessionId, 'hooks', url, payload.ndjson, 'application/x-ndjson', ctx.credentials
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
  ctx: ForwardContext
): Promise<SendResult | 'idle'> {
  const pending = await snapshotPendingBytes(sessionId, stream);
  if (!pending) {
    return 'idle';
  }

  const url = `${ctx.baseUrl}${OTEL_ENDPOINTS[stream]}`;
  const result = await send(
    sessionId, stream, url, pending.bytes, 'application/x-protobuf', ctx.credentials
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
  const ctx = await buildForwardContext(credentials);

  const hooksResult = await forwardHooks(sessionId, ctx);
  if (hooksResult === 'auth-expired') {
    markCredentialsStale()
    return;
  }

  if (hooksOnly) {
    return;
  }

  for (const stream of OTEL_STREAMS) {
    const result = await forwardOtelStream(sessionId, stream, ctx);
    if (result === 'auth-expired') {
      markCredentialsStale();
      return;
    }
  }
}
