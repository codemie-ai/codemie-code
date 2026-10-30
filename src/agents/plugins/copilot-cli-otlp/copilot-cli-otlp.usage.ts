import type { CopilotEvent, CopilotShutdownData } from '@/agents/plugins/copilot-cli/copilot-cli-event-types.js';
import { extractCopilotToolActivity } from '@/agents/plugins/copilot-cli/copilot-cli.tool-activity.js';
import { buildUsageRows, stableEventId, USAGE_REQUEST_EVENT_TYPE } from './copilot-cli-otlp.request-usage.js';

export { stableEventId, USAGE_REQUEST_EVENT_TYPE };
export const SESSION_SUMMARY_EVENT_TYPE = 'agent.session.summary';

/** Running totals a summary is built from; also what the `agentStop` cursor persists. */
export interface SummaryCounters {
  toolCalls: number;
  toolErrors: number;
  apiCalls: number;
  turns: number;
  models: Record<string, number>;
}

export interface SummaryDetails {
  tools?: Record<string, { calls: number; errors: number }>;
  filesWritten: string[];
  filesEdited: string[];
  linesAdded: number | null;
  linesRemoved: number | null;
}

export const EMPTY_COUNTERS: SummaryCounters = { toolCalls: 0, toolErrors: 0, apiCalls: 0, turns: 0, models: {} };

/** Counters of one slice of the transcript, plus the usage rows built from it. */
export function summarizeSlice(
  sessionId: string,
  events: CopilotEvent[],
  mode: 'full' | 'incremental'
): { counters: SummaryCounters; details: SummaryDetails; rows: Record<string, unknown>[]; partial: boolean } {
  const { rows, partial } = buildUsageRows(sessionId, events, mode);
  const activity = extractCopilotToolActivity(events);
  const mainRequests = new Set<string>();
  const models: Record<string, number> = {};
  for (const row of rows) {
    if (row['scope_kind'] !== 'main') continue;
    const requestId = String(row['request_id']);
    if (mainRequests.has(requestId)) continue;
    mainRequests.add(requestId);
    const model = String(row['model']);
    models[model] = (models[model] ?? 0) + 1;
  }

  let toolCalls = 0;
  let toolErrors = 0;
  const tools: Record<string, { calls: number; errors: number }> = {};
  for (const [name, count] of Object.entries(activity.tools)) {
    const errors = activity.toolStatus[name]?.failure ?? 0;
    tools[name] = { calls: count, errors };
    toolCalls += count;
    toolErrors += errors;
  }

  const written = new Set(activity.fileOperations.filter((o) => o.type === 'write').map((o) => o.path));
  const edited = new Set(activity.fileOperations.filter((o) => o.type === 'edit').map((o) => o.path));
  let linesAdded: number | null = null;
  let linesRemoved: number | null = null;
  const shutdown = [...events].reverse().find((e) => e.type === 'session.shutdown')?.data as CopilotShutdownData | undefined;
  if (shutdown?.codeChanges) {
    linesAdded = shutdown.codeChanges.linesAdded ?? null;
    linesRemoved = shutdown.codeChanges.linesRemoved ?? null;
    for (const path of shutdown.codeChanges.filesModified ?? []) {
      if (!written.has(path)) edited.add(path);
    }
  }

  return {
    counters: {
      toolCalls,
      toolErrors,
      apiCalls: mainRequests.size,
      turns: events.filter((e) => e.type === 'user.message').length,
      models,
    },
    details: { tools, filesWritten: [...written], filesEdited: [...edited], linesAdded, linesRemoved },
    rows,
    partial,
  };
}

export function addCounters(a: SummaryCounters, b: SummaryCounters): SummaryCounters {
  const models = { ...a.models };
  for (const [model, count] of Object.entries(b.models)) models[model] = (models[model] ?? 0) + count;
  return {
    toolCalls: a.toolCalls + b.toolCalls,
    toolErrors: a.toolErrors + b.toolErrors,
    apiCalls: a.apiCalls + b.apiCalls,
    turns: a.turns + b.turns,
    models,
  };
}

export function mergeDetails(a: SummaryDetails, b: SummaryDetails): SummaryDetails {
  const tools: Record<string, { calls: number; errors: number }> = { ...(a.tools ?? {}) };
  for (const [name, t] of Object.entries(b.tools ?? {})) {
    const prior = tools[name] ?? { calls: 0, errors: 0 };
    tools[name] = { calls: prior.calls + t.calls, errors: prior.errors + t.errors };
  }
  const written = new Set([...a.filesWritten, ...b.filesWritten]);
  const edited = new Set([...a.filesEdited, ...b.filesEdited].filter((p) => !written.has(p)));
  return {
    tools,
    filesWritten: [...written],
    filesEdited: [...edited],
    linesAdded: b.linesAdded ?? a.linesAdded,
    linesRemoved: b.linesRemoved ?? a.linesRemoved,
  };
}

export function buildSessionSummaryEvent(input: {
  sessionId: string;
  phase: 'incremental' | 'final';
  counters: SummaryCounters;
  details: SummaryDetails;
  startedAt: string;
  endedAt: string;
  usagePartial: boolean;
}): Record<string, unknown> {
  const { sessionId, phase, counters, details, startedAt, endedAt } = input;
  const diff = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : NaN;
  const ranked = Object.entries(counters.models).sort((a, b) => b[1] - a[1]).map(([model]) => model);
  const filesChanged = new Set([...details.filesWritten, ...details.filesEdited]);
  return {
    type: SESSION_SUMMARY_EVENT_TYPE,
    session_id: sessionId,
    timestamp: endedAt || undefined,
    event_id: stableEventId(SESSION_SUMMARY_EVENT_TYPE, sessionId, `${phase}:${endedAt}`),
    is_final: phase === 'final',
    started_at: startedAt,
    ended_at: endedAt || null,
    duration_ms: Number.isFinite(diff) && diff >= 0 ? diff : null,
    api_calls: counters.apiCalls,
    tool_calls: counters.toolCalls,
    tool_errors: counters.toolErrors,
    tool_results: counters.toolCalls,
    ...(details.tools ? { tools: details.tools } : {}),
    turns: counters.turns,
    models: ranked,
    primary_model: ranked[0] ?? '',
    lines_added: details.linesAdded,
    lines_removed: details.linesRemoved,
    files_changed: filesChanged.size,
    files_written: details.filesWritten.length,
    files_edited: details.filesEdited.length,
    usage_partial: input.usagePartial,
  };
}

/**
 * Identity and project fields the hook-time adapter already resolved on the session's own
 * `agent.session.end` event. Reused verbatim so deferred events carry the same user, project,
 * repo and branch as the lifecycle events, without the daemon resolving anything itself.
 */
export const TEMPLATE_FIELDS = [
  'user_email', 'developer_name', 'identity_source', 'codemie_project_name', 'codemie_cli_version',
  'git_branch', 'repo_remote', 'story_id', 'story_source', 'platform', 'client_version', 'entrypoint', 'cwd', 'schema_version',
] as const;

/** Wire-ready deferred events (every usage row + the final summary) for one finished session, built from scratch. */
export function buildDeferredUsageEvents(
  template: Record<string, unknown>,
  events: CopilotEvent[],
  fallbackClientVersion = ''
): Record<string, unknown>[] {
  const sessionId = String(template['session_id'] ?? '');
  const common: Record<string, unknown> = {};
  for (const key of TEMPLATE_FIELDS) {
    if (template[key] !== undefined) common[key] = template[key];
  }
  if (!common['client_version'] && fallbackClientVersion) common['client_version'] = fallbackClientVersion;

  const slice = summarizeSlice(sessionId, events, 'full');
  const start = events.find((e) => e.type === 'session.start')?.data as { startTime?: string } | undefined;
  const lastShutdown = [...events].reverse().find((e) => e.type === 'session.shutdown');
  const endedAt = lastShutdown?.timestamp ?? '';
  const summary = buildSessionSummaryEvent({
    sessionId,
    phase: 'final',
    counters: slice.counters,
    details: slice.details,
    startedAt: start?.startTime ?? events[0]?.timestamp ?? endedAt,
    endedAt,
    usagePartial: slice.partial,
  });

  return [...slice.rows, summary].map((event) => ({ ...common, ...event }));
}
