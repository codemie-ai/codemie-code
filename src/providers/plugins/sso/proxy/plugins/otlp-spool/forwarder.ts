import { readFile, appendFile } from 'node:fs/promises';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import type { SSOCredentials, JWTCredentials } from '../../../../../core/types.js';
import { isSSOCredentials, isJWTCredentials } from '../../../../../core/types.js';
import { buildAuthHeaders } from '../../../../../core/codemie-auth-helpers.js';
import { CODEMIE_ENDPOINTS } from '../../../sso.http-client.js';
import { sessionFile, spoolRoot } from './spool-paths.js';
import type { SessionStatus } from './completeness-gate.js';
import { withSessionLock } from './session-lock.js';

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

const MAX_PROMPT_CHARS = 200;
const MAX_TOOL_FIELD_CHARS = 300;
const FORWARD_TIMEOUT_MS = 10_000;

function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveUserEmail(credentials: SSOCredentials | JWTCredentials): string {
  if (isJWTCredentials(credentials)) {
    try {
      const claims = decodeJwtClaims(credentials.token);
      if (typeof claims['email'] === 'string' && claims['email']) return claims['email'];
    } catch { /* ignore */ }
  }
  if (isSSOCredentials(credentials)) {
    const accessToken = credentials.cookies['codemie_access_token'];
    if (accessToken) {
      try {
        const claims = decodeJwtClaims(accessToken);
        const email = claims['email'] ?? claims['preferred_username'];
        if (typeof email === 'string' && email) return email;
      } catch { /* ignore */ }
    }
  }
  return '';
}

function hookEventType(hookName: string, rawEvent: Record<string, unknown>): string {
  if (hookName === 'PreToolUse') {
    return rawEvent['input'] && (rawEvent['input'] as Record<string, unknown>)['denied']
      ? 'agent.tool.denied'
      : 'agent.tool.start';
  }
  return HOOK_EVENT_TYPE_MAP[hookName] ?? 'agent.event';
}

function buildAuthHeadersFromCreds(credentials: SSOCredentials | JWTCredentials): Record<string, string> | null {
  if (isSSOCredentials(credentials)) {
    return buildAuthHeaders(credentials.cookies);
  }
  if (isJWTCredentials(credentials)) {
    return buildAuthHeaders(credentials.token);
  }
  return null;
}

async function postToBackend(
  url: string,
  body: string | Buffer,
  contentType: string,
  credentials: SSOCredentials | JWTCredentials
): Promise<Response> {
  const headers = buildAuthHeadersFromCreds(credentials);
  if (!headers) throw new Error('Unsupported credential type');
  headers['Content-Type'] = contentType;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readStatusFile(sessionId: string): Promise<SessionStatus | null> {
  try {
    const raw = await readFile(sessionFile(sessionId, 'status'), 'utf-8');
    return JSON.parse(raw) as SessionStatus;
  } catch {
    return null;
  }
}

async function writeStatusFile(sessionId: string, status: SessionStatus): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(spoolRoot(), { recursive: true });
  await writeFile(sessionFile(sessionId, 'status'), JSON.stringify(status), 'utf-8');
}

/**
 * Forward a session's spool data to the CodeMie analytics backend.
 * On 401/403: retry once with a fresh credential refresh; on second failure set authExpired.
 * On other failures: leave data on disk, retry next tick.
 */
export async function forwardSession(
  sessionId: string,
  hooksOnly: boolean,
  credentials: SSOCredentials | JWTCredentials
): Promise<void> {
  const status = await readStatusFile(sessionId);
  if (!status) return;

  // True once a successfully forwarded batch contains a SessionEnd event.
  // OTEL data and the final forwarded=true marker are deferred until then
  // so that all hook events produced during the session reach the backend.
  let sessionEnded = false;

  // Resolve syncApiUrl from daemon state for the backend base URL
  const { readState } = await import('../../../../../../cli/commands/proxy/daemon-manager.js');
  const state = await readState();
  const baseUrl = state?.syncApiUrl ?? state?.url ?? '';

  // Resolve project name
  const projectName = state?.project ?? '';

  // Resolve user email
  const userEmail = resolveUserEmail(credentials);

  // Per-session git info cache
  const gitCache: { branch?: string; remote?: string } = {};

  // Forward hooks NDJSON
  if (status.hooksWritten) {
    const hooksPath = sessionFile(sessionId, 'hooks');
    let hooksContent = '';
    try {
      hooksContent = await readFile(hooksPath, 'utf-8');
    } catch {
      // File may not exist yet
    }

    const cursor = status.cursor ?? 0;
    const slice = hooksContent.slice(cursor);
    const lines = slice.split('\n').filter((l) => l.trim().length > 0);

    if (lines.length > 0) {
      const mapped: string[] = [];
      for (const line of lines) {
        try {
          const wrapper = JSON.parse(line) as Record<string, unknown>;
          // Spool lines are stored as { agentName, raw: "<hook-json>", timestamp }.
          // Parse the inner field to get hook_event_name, session_id, cwd, etc.
          const rawField = wrapper['raw'];
          let hookEvent: Record<string, unknown>;
          try {
            hookEvent = typeof rawField === 'string'
              ? (JSON.parse(rawField) as Record<string, unknown>)
              : (rawField as Record<string, unknown> ?? wrapper);
          } catch {
            hookEvent = wrapper;
          }
          const hookName = String(hookEvent['hook_event_name'] ?? '');
          const eventType = hookEventType(hookName, hookEvent);
          const cwd = String(hookEvent['cwd'] ?? '');

          if (cwd && !gitCache.branch) {
            try {
              const { detectGitBranch, detectGitRemoteRepo } = await import('@/utils/processes.js');
              const [branch, remote] = await Promise.all([
                detectGitBranch(cwd).then((v) => v ?? ''),
                detectGitRemoteRepo(cwd).then((v) => v ?? ''),
              ]);
              gitCache.branch = branch;
              gitCache.remote = remote;
            } catch { /* best-effort */ }
          }

          const limitedHookEvent = limitHookPayload(hookEvent);

          const mappedEvent = {
            ...limitedHookEvent,
            type: eventType,
            session_id: String(hookEvent['session_id'] ?? ''),
            timestamp: new Date().toISOString(),
            user_email: userEmail,
            developer_name: userEmail,
            git_branch: gitCache.branch ?? '',
            repo_remote: gitCache.remote ?? '',
            codemie_project_name: projectName,
            cwd,
            prompt_body: boundedText(
              hookEvent['prompt'],
              MAX_PROMPT_CHARS
            ),
            raw: limitedHookEvent,
          };

          mapped.push(JSON.stringify(mappedEvent));
        } catch {
          // Skip malformed lines
        }
      }

      if (mapped.length > 0) {
        const ndjsonBody = mapped.join('\n') + '\n';
        const url = `${baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS}`;
        try {
          let response = await postToBackend(url, ndjsonBody, 'application/x-ndjson', credentials);
          if (response.status === 401 || response.status === 403) {
            // Retry once — in practice credentials refresh is opaque here, so just retry
            response = await postToBackend(url, ndjsonBody, 'application/x-ndjson', credentials);
            if (response.status === 401 || response.status === 403) {
              await withSessionLock(sessionId, async () => {
                const s = await readStatusFile(sessionId);
                if (s) {
                  s.authExpired = true;
                  await writeStatusFile(sessionId, s);
                }
              });
              return;
            }
          }
          if (response.ok) {
            // Advance cursor
            await withSessionLock(sessionId, async () => {
              const s = await readStatusFile(sessionId);
              if (s) {
                s.cursor = (s.cursor ?? 0) + Buffer.byteLength(slice.slice(0, mapped.length ? slice.lastIndexOf('\n') + 1 : 0), 'utf-8');
                // Recalculate: cursor = cursor + bytes consumed
                const consumed = Buffer.byteLength(lines.join('\n') + '\n', 'utf-8');
                s.cursor = cursor + consumed;
                await writeStatusFile(sessionId, s);
              }
            });
            // Detect SessionEnd among the successfully forwarded lines
            sessionEnded = lines.some((line) => {
              try {
                const wrapper = JSON.parse(line) as Record<string, unknown>;
                const rawField = wrapper['raw'];
                const hookEvent: Record<string, unknown> = typeof rawField === 'string'
                  ? (JSON.parse(rawField) as Record<string, unknown>)
                  : (rawField as Record<string, unknown> ?? wrapper);
                return String(hookEvent['hook_event_name'] ?? '') === 'SessionEnd';
              } catch {
                return false;
              }
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.debug('[otlp-forwarder] hooks forward error', ...sanitizeLogArgs({ sessionId, err: msg }));
          return;
        }
      }
    }
  }

  if (hooksOnly) {
    // Only mark the session done once SessionEnd has been forwarded; until
    // then keep the cursor advancing on subsequent ticks.
    if (sessionEnded) {
      await withSessionLock(sessionId, async () => {
        const s = await readStatusFile(sessionId);
        if (s) {
          s.forwarded = true;
          await writeStatusFile(sessionId, s);
        }
      });
    }
    return;
  }

  // Forward OTLP bins — cursor-based so each tick only sends bytes appended
  // since the previous tick, not the whole accumulated file.
  const otlpSignals: Array<{
    signal: 'otel_logs' | 'otel_metrics' | 'otel_traces';
    endpoint: string;
    writtenFlag: 'otelLogsWritten' | 'otelMetricsWritten' | 'otelTracesWritten';
    getCursor: (s: SessionStatus) => number;
    setCursor: (s: SessionStatus, v: number) => void;
  }> = [
    {
      signal: 'otel_logs',
      endpoint: CODEMIE_ENDPOINTS.CLI_ANALYTICS_LOGS,
      writtenFlag: 'otelLogsWritten',
      getCursor: (s) => s.otelLogsCursor ?? 0,
      setCursor: (s, v) => { s.otelLogsCursor = v; },
    },
    {
      signal: 'otel_metrics',
      endpoint: CODEMIE_ENDPOINTS.CLI_ANALYTICS_METRICS,
      writtenFlag: 'otelMetricsWritten',
      getCursor: (s) => s.otelMetricsCursor ?? 0,
      setCursor: (s, v) => { s.otelMetricsCursor = v; },
    },
    {
      signal: 'otel_traces',
      endpoint: CODEMIE_ENDPOINTS.CLI_ANALYTICS_TRACES,
      writtenFlag: 'otelTracesWritten',
      getCursor: (s) => s.otelTracesCursor ?? 0,
      setCursor: (s, v) => { s.otelTracesCursor = v; },
    },
  ];

  for (const { signal, endpoint, writtenFlag, getCursor, setCursor } of otlpSignals) {
    if (!status[writtenFlag]) continue;
    const binPath = sessionFile(sessionId, signal);
    let fullBinData: Buffer;
    try {
      fullBinData = await readFile(binPath);
    } catch {
      continue;
    }
    const otelCursor = getCursor(status);
    const slice = fullBinData.subarray(otelCursor);
    if (slice.length === 0) continue; // Nothing new since last tick

    const url = `${baseUrl}${endpoint}`;
    try {
      let response = await postToBackend(url, slice, 'application/x-protobuf', credentials);
      if (response.status === 401 || response.status === 403) {
        response = await postToBackend(url, slice, 'application/x-protobuf', credentials);
        if (response.status === 401 || response.status === 403) {
          await withSessionLock(sessionId, async () => {
            const s = await readStatusFile(sessionId);
            if (s) {
              s.authExpired = true;
              await writeStatusFile(sessionId, s);
            }
          });
          return;
        }
      }
      if (response.ok) {
        await withSessionLock(sessionId, async () => {
          const s = await readStatusFile(sessionId);
          if (s) {
            setCursor(s, otelCursor + slice.length);
            await writeStatusFile(sessionId, s);
          }
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`[otlp-forwarder] ${signal} forward error`, ...sanitizeLogArgs({ sessionId, err: msg }));
    }
  }

  // Mark the session done once SessionEnd has been forwarded in the hooks batch
  if (sessionEnded) {
    await withSessionLock(sessionId, async () => {
      const s = await readStatusFile(sessionId);
      if (s) {
        s.forwarded = true;
        await writeStatusFile(sessionId, s);
      }
    });
  }
}

function boundedText(value: unknown, maxChars: number): string {
  if (value === undefined || value === null) return '';

  const text = typeof value === 'string'
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

function limitHookPayload(
  hookEvent: Record<string, unknown>
): Record<string, unknown> {
  const limited: Record<string, unknown> = { ...hookEvent };

  if (Object.prototype.hasOwnProperty.call(hookEvent, 'prompt')) {
    limited.prompt = boundedText(
      hookEvent.prompt,
      MAX_PROMPT_CHARS
    );
  }

  for (const field of ['tool_input', 'tool_response', 'error']) {
    if (Object.prototype.hasOwnProperty.call(hookEvent, field)) {
      limited[field] = boundedText(
        hookEvent[field],
        MAX_TOOL_FIELD_CHARS
      );
    }
  }

  // Prevent a nested/raw copy from bypassing the limits if the wrapper was
  // used as the fallback hookEvent.
  delete limited.raw;

  return limited;
}

// Re-export helpers needed by tick-processor
export { readStatusFile, writeStatusFile, appendFile };
