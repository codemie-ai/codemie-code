/**
 * Raw Cursor hook event capture, project-local.
 *
 * This is the primary acceptance signal for the analytics-ingestion effort:
 * every hook event Cursor delivers must be captured verbatim (modulo
 * sanitization) to `<projectRoot>/.codemie/logs/cursor-hook-events.jsonl`,
 * one JSON line per event, without ever blocking or slowing the user's
 * action in Cursor.
 *
 * Project-local, not `~/.codemie`, as requested - and resolved via the
 * shared `resolveProjectRoot()` (see `src/utils/project-root.ts`) so this
 * file's location can never drift from Task 8's `.cursor/hooks.json`
 * resolution.
 *
 * Every failure here is swallowed: an unwritable path or a read-only
 * workspace must never break a hook or delay the agent.
 */

import { appendFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { resolveProjectRoot } from '../../../utils/project-root.js';

const LOG_RELATIVE_PATH = join('.codemie', 'logs', 'cursor-hook-events.jsonl');

// `beforeReadFile` payloads carry the full file content, `afterFileEdit`
// carries old/new strings, `beforeShellExecution` carries raw commands -
// any of these can be large. Cap the field, not the whole record, so
// truncation is visible and explicit rather than silently dropping the
// record.
const MAX_FIELD_LENGTH = 8192;
const TRUNCATION_MARKER = '…[truncated by codemie: field exceeded 8192 chars]';

// Fields on Cursor payloads known to carry potentially large content.
const LARGE_FIELDS = ['content', 'output', 'old_string', 'new_string', 'command', 'stdout', 'stderr'];

/**
 * Env var gating capture. Default ON for this release (it is the
 * acceptance signal); set to '0' or 'false' to disable.
 */
export function isCursorHookTraceEnabled(): boolean {
  const value = process.env.CODEMIE_CURSOR_HOOK_TRACE;
  return value !== '0' && value !== 'false';
}

function truncateLargeFields(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    if (value.length > MAX_FIELD_LENGTH) {
      return `${value.slice(0, MAX_FIELD_LENGTH)}${TRUNCATION_MARKER}`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(truncateLargeFields);
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (LARGE_FIELDS.includes(key) && typeof entryValue === 'string' && entryValue.length > MAX_FIELD_LENGTH) {
        result[key] = `${entryValue.slice(0, MAX_FIELD_LENGTH)}${TRUNCATION_MARKER}`;
      } else {
        result[key] = truncateLargeFields(entryValue);
      }
    }
    return result;
  }

  return value;
}

/**
 * Append one JSON line for a single Cursor hook event to the project-local
 * capture log. Never throws - every failure (unwritable path, read-only
 * workspace, disk full) is swallowed so capture can never break a hook or
 * delay the agent.
 *
 * @param payload - The raw (or transformed) Cursor event payload
 * @param cursorEventName - Cursor-native event name (`hook_event_name`)
 * @param internalEventName - CodeMie internal event name it maps onto
 * @param sessionId - Resolved session id (conversation_id fallback included)
 */
export async function appendCursorEventLog(
  payload: unknown,
  cursorEventName: string,
  internalEventName: string,
  sessionId: string
): Promise<void> {
  if (!isCursorHookTraceEnabled()) {
    return;
  }

  try {
    const record = payload as Record<string, unknown> | undefined;
    const conversationId = typeof record?.conversation_id === 'string' ? record.conversation_id : undefined;

    const sanitizedPayload = sanitizeLogArgs(truncateLargeFields(payload))[0];

    const line = JSON.stringify({
      received_at: new Date().toISOString(),
      hook_event_name: cursorEventName,
      internal_event_name: internalEventName,
      session_id: sessionId,
      conversation_id: conversationId,
      payload: sanitizedPayload,
    });

    const logPath = join(resolveProjectRoot(), LOG_RELATIVE_PATH);
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${line}\n`, 'utf-8');
  } catch {
    // Capture must never break a hook or delay the agent.
  }
}
