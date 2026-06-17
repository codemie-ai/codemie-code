import { readFile } from 'fs/promises';
import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import { ClaudePluginMetadata } from '@/agents/plugins/claude/claude.plugin.js';
import { ClaudeSessionAdapter } from '@/agents/plugins/claude/claude.session.js';
import { readJSONL } from '@/agents/core/session/utils/jsonl-reader.js';
import type { ClaudeMessage, ContentItem } from '@/agents/plugins/claude/claude-message-types.js';
import type { LocalTelemetryDiscoveredSession } from '@/telemetry/runtime/types.js';
import { extractClaudeDesktopMetrics } from './claude-desktop.metrics.js';

interface DesktopMetadata {
  sessionId: string;
  cliSessionId?: string;
  createdAt: number;
  lastActivityAt: number;
  model?: string;
}

interface DesktopAuditEvent {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  timestamp?: string;
  cwd?: string;
  message?: ClaudeMessage['message'];
  toolUseResult?: ClaudeMessage['toolUseResult'];
  parent_tool_use_id?: string | null;
  _audit_timestamp?: string;
  [key: string]: unknown;
}

function normalizeTimestamp(event: DesktopAuditEvent, metadata: DesktopMetadata): string {
  return event.timestamp
    || event._audit_timestamp
    || new Date(metadata.lastActivityAt || metadata.createdAt).toISOString();
}

function normalizeMessage(event: DesktopAuditEvent, metadata: DesktopMetadata): ClaudeMessage {
  const content = event.message?.content;
  const normalizedContent = Array.isArray(content)
    ? content
    : typeof content === 'string'
      ? content
      : [];

  return {
    type: event.type,
    subtype: event.subtype,
    uuid: event.uuid || `${event.type}-${normalizeTimestamp(event, metadata)}`,
    parentUuid: typeof event.parent_tool_use_id === 'string' ? event.parent_tool_use_id : undefined,
    sessionId: event.session_id || metadata.cliSessionId || metadata.sessionId,
    timestamp: normalizeTimestamp(event, metadata),
    cwd: event.cwd,
    message: event.message ? {
      ...event.message,
      model: event.message.model || metadata.model,
      content: normalizedContent as string | ContentItem[]
    } : undefined,
    toolUseResult: event.toolUseResult
  };
}

/**
 * Cowork writes its transcript as `audit.jsonl`, which also ends with `.jsonl` and so takes the
 * raw Claude Code parsing branch (parseSessionFile preserves records verbatim). Its records carry
 * the wall-clock time in `_audit_timestamp` and leave `timestamp` empty (assistant records always
 * do). Backfill `timestamp` from `_audit_timestamp` so the conversations processor can compute
 * message date and response_time — otherwise the chat view renders broken metadata like
 * "Processed in: s /". Lives here (the Claude Desktop layer) rather than in ClaudeSessionAdapter
 * because `_audit_timestamp` is a Cowork audit-log artifact; real Claude Code sessions never carry
 * it, so this is a no-op for them.
 */
function backfillTimestampsFromAuditLog(messages: ClaudeMessage[]): void {
  for (const message of messages) {
    if (!message.timestamp) {
      const auditTimestamp = (message as { _audit_timestamp?: string })._audit_timestamp;
      if (auditTimestamp) {
        message.timestamp = auditTimestamp;
      }
    }
  }
}

export async function parseClaudeDesktopSession(
  discovered: LocalTelemetryDiscoveredSession,
  codemieSessionId: string
): Promise<ParsedSession> {
  if (discovered.transcriptPath.endsWith('.jsonl')) {
    const parsed = await new ClaudeSessionAdapter(ClaudePluginMetadata).parseSessionFile(
      discovered.transcriptPath,
      codemieSessionId
    );

    backfillTimestampsFromAuditLog(parsed.messages as ClaudeMessage[]);

    return {
      ...parsed,
      agentName: 'claude-desktop'
    };
  }

  const metadata = JSON.parse(await readFile(discovered.metadataPath, 'utf-8')) as DesktopMetadata;
  const auditEvents = await readJSONL<DesktopAuditEvent>(discovered.transcriptPath);
  const messages = auditEvents
    .filter((event) => event.type === 'user' || event.type === 'assistant' || event.type === 'system')
    .map((event) => normalizeMessage(event, metadata));

  return {
    sessionId: codemieSessionId,
    agentName: 'claude-desktop',
    agentVersion: undefined,
    metadata: {
      projectPath: discovered.transcriptPath,
      createdAt: new Date(discovered.createdAt).toISOString(),
      updatedAt: new Date(discovered.updatedAt).toISOString()
    },
    messages,
    metrics: extractClaudeDesktopMetrics(messages)
  };
}
