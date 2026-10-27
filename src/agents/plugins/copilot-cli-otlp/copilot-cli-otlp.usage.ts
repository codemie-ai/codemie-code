import { createHash } from 'node:crypto';
import type { CopilotUsageMessage } from '@/agents/plugins/copilot-cli/copilot-cli.usage.js';

export const USAGE_REQUEST_EVENT_TYPE = 'agent.usage.request';
export const SESSION_SUMMARY_EVENT_TYPE = 'agent.session.summary';

/**
 * Copilot reports `inputTokens` as the TOTAL prompt (OpenAI convention, cache reads and writes
 * included); the backend's `input_tokens` is the non-cached part only. Same peel-off as
 * `readCopilotCli` in `src/cli/commands/analytics/cost/usage-readers.ts`: cache writes are
 * clamped to the fresh input they were written from so an inconsistent rollup cannot bill more
 * cache creation than the prompt contained.
 */
function toBackendTokens(usage: CopilotUsageMessage['usage']): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  thinking: number;
} {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const freshInput = Math.max(0, (usage.inputTokens ?? 0) - cacheRead);
  const cacheCreation = Math.min(usage.cacheWriteTokens ?? 0, freshInput);
  return {
    input: freshInput - cacheCreation,
    output: usage.outputTokens ?? 0,
    cacheRead,
    cacheCreation,
    thinking: usage.reasoningTokens ?? 0,
  };
}

/**
 * One `agent.usage.request` per model in the session rollup. Copilot records usage per model for
 * the whole session, not per request, so `request_id` is derived from the session and model: a
 * re-sent sessionEnd then carries the same identity instead of inflating the totals.
 * Copilot exposes no cache-TTL split, so cache writes go to the 5m bucket.
 */
export function buildUsageRequestEvents(
  sessionId: string,
  messages: CopilotUsageMessage[],
  timestamp: string
): Record<string, unknown>[] {
  return messages.map((message) => {
    const tokens = toBackendTokens(message.usage);
    return {
      type: USAGE_REQUEST_EVENT_TYPE,
      session_id: sessionId,
      request_id: `${sessionId}:${message.model}`,
      model_raw: message.model,
      model: message.model,
      input_tokens: tokens.input,
      cache_creation_5m_tokens: tokens.cacheCreation,
      cache_creation_1h_tokens: 0,
      cache_read_tokens: tokens.cacheRead,
      output_tokens: tokens.output,
      thinking_tokens: tokens.thinking,
      timestamp,
    };
  });
}

/** Minimal final summary: lets the backend stamp the session's end and primary model. */
export function buildSessionSummaryEvent(
  sessionId: string,
  messages: CopilotUsageMessage[],
  startedAt: string,
  endedAt: string
): Record<string, unknown> {
  const diff = Date.parse(endedAt) - Date.parse(startedAt);
  const ranked = [...messages].sort((a, b) => (b.requests ?? 0) - (a.requests ?? 0));
  const primary = ranked[0]?.model ?? '';
  return {
    type: SESSION_SUMMARY_EVENT_TYPE,
    session_id: sessionId,
    timestamp: endedAt,
    is_final: true,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: Number.isFinite(diff) && diff >= 0 ? diff : null,
    primary_model: primary,
    models: ranked.map((m) => m.model),
  };
}

/** Stable across re-runs: the backend dedups on (type, session_id, event_id). */
export function stableEventId(type: string, sessionId: string, discriminator: string): string {
  return createHash('sha256').update(`${type}\0${sessionId}\0${discriminator}`).digest('hex').slice(0, 32);
}

/**
 * Identity and project fields the hook-time adapter already resolved on the session's own
 * `agent.session.end` event. Reused verbatim so deferred events carry the same user, project,
 * repo and branch as the lifecycle events, without the daemon resolving anything itself.
 */
const TEMPLATE_FIELDS = [
  'user_email', 'developer_name', 'identity_source', 'codemie_project_name', 'codemie_cli_version',
  'git_branch', 'repo_remote', 'story_id', 'story_source', 'platform', 'client_version', 'cwd', 'schema_version',
] as const;

/** Wire-ready deferred events (usage per model + final summary) for one finished session. */
export function buildDeferredUsageEvents(
  template: Record<string, unknown>,
  messages: CopilotUsageMessage[],
  startedAt: string,
  endedAt: string
): Record<string, unknown>[] {
  const sessionId = String(template['session_id'] ?? '');
  const common: Record<string, unknown> = {};
  for (const key of TEMPLATE_FIELDS) {
    if (template[key] !== undefined) common[key] = template[key];
  }
  const raw = [
    ...buildUsageRequestEvents(sessionId, messages, endedAt),
    buildSessionSummaryEvent(sessionId, messages, startedAt, endedAt),
  ];
  return raw.map((event) => {
    const discriminator = String(event['request_id'] ?? 'summary');
    const wire = { ...common, ...event, event_id: stableEventId(String(event['type']), sessionId, discriminator) };
    return { ...wire, raw: { ...wire } };
  });
}
