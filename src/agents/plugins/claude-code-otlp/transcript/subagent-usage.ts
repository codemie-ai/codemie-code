/**
 * `agent.subagent.usage` discovery and event builder.
 *
 * Discovery (`findSubagentFiles`) uses the same path convention as the private
 * `findSubagentFiles` in `src/agents/plugins/claude/claude.session.ts`
 * (`<parentDir>/<sessionId>/subagents/agent-*.jsonl` + sibling `<name>.meta.json`) but returns
 * only the narrower {@link SubagentFile} shape this event needs. The sidecar reader is also
 * exported ({@link readSubagentMeta}) so a `SubagentStop` hook — which only sees its own single
 * transcript path, not the whole `subagents/` directory — can fill in the same fields.
 *
 * The event builder (`buildSubagentUsageEvent`) sums an already-scoped `OpenUsageRequest[]` into
 * the contract's `usage[]` rows (one per distinct model/speed/inference_geo/service_tier/
 * scope_kind/scope_name) and passes the caller-built tool-call/tool-error/skill maps through as
 * the contract's `tools`/`skills` objects; it has no access to the subagent transcript itself.
 *
 * `workflow_run`/`worktree` have no known source and are always empty strings, never fabricated.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { OpenUsageRequest } from './parse-state.js';

export interface SubagentFile {
  agentId: string;
  filePath: string;
  toolUseId?: string;
  agentType?: string;
  spawnDepth?: number;
  description?: string;
}

interface SubagentMeta {
  toolUseId?: string;
  agentType?: string;
  spawnDepth?: number;
  description?: string;
}

/**
 * Read one subagent's `.meta.json` sidecar (same path, `.jsonl` swapped for `.meta.json`).
 * Never throws: a missing or malformed sidecar resolves to `{}`.
 */
export async function readSubagentMeta(jsonlFilePath: string): Promise<SubagentMeta> {
  const meta: SubagentMeta = {};
  try {
    const metaPath = jsonlFilePath.replace(/\.jsonl$/, '.meta.json');
    const metaRaw = JSON.parse(await readFile(metaPath, 'utf-8')) as Record<string, unknown>;
    if (typeof metaRaw.toolUseId === 'string') meta.toolUseId = metaRaw.toolUseId;
    if (typeof metaRaw.agentType === 'string') meta.agentType = metaRaw.agentType;
    if (typeof metaRaw.spawnDepth === 'number') meta.spawnDepth = metaRaw.spawnDepth;
    if (typeof metaRaw.description === 'string') meta.description = metaRaw.description;
  } catch {
    // sidecar absent or malformed — proceed without it.
  }
  return meta;
}

/**
 * Discover subagent transcript files for a main transcript at `mainTranscriptPath`.
 *
 * Looks under `<parentDir>/<sessionId>/subagents/` (where `sessionId` is `mainTranscriptPath`'s
 * own basename, minus `.jsonl`) for `agent-*.jsonl` files, reading each one's sidecar via
 * {@link readSubagentMeta}.
 *
 * Never throws: a missing subagents directory, an unreadable directory, or any other failure all
 * resolve to `[]`.
 */
export async function findSubagentFiles(mainTranscriptPath: string): Promise<SubagentFile[]> {
  try {
    const parentDir = dirname(mainTranscriptPath);
    const filename = basename(mainTranscriptPath);
    const sessionId = filename.replace(/\.jsonl$/, '');
    const subagentsDir = join(parentDir, sessionId, 'subagents');

    const files = await readdir(subagentsDir);
    const agentFiles = await Promise.all(
      files
        .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
        .map(async (f): Promise<SubagentFile> => {
          const agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
          const filePath = join(subagentsDir, f);
          const meta = await readSubagentMeta(filePath);
          return { agentId, filePath, ...meta };
        })
    );

    return agentFiles;
  } catch {
    return [];
  }
}

/** One row of the contract's `usage[]`: `agent.usage.request`'s own fields, plus `api_calls`. */
export interface SubagentUsageTotal {
  model: string;
  model_raw: string;
  speed: string;
  inference_geo: string;
  service_tier: string;
  scope_kind: string;
  scope_name: string;
  input_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  web_search_requests: number;
  web_fetch_requests: number;
  api_calls: number;
}

/**
 * Group `usageRequests` by `(model, speed, inferenceGeo, serviceTier, scopeKind, scopeName)` —
 * the contract's grouping for `agent.subagent.usage`'s `usage[]` — summing every token/call
 * field within each group.
 */
export function buildUsageTotals(usageRequests: OpenUsageRequest[]): SubagentUsageTotal[] {
  const groups = new Map<string, SubagentUsageTotal>();

  for (const r of usageRequests) {
    const key = [r.model, r.speed, r.inferenceGeo, r.serviceTier, r.scopeKind, r.scopeName].join('\u0000');
    const existing = groups.get(key);
    if (existing) {
      existing.input_tokens += r.inputTokens;
      existing.cache_creation_5m_tokens += r.cacheCreation5mTokens;
      existing.cache_creation_1h_tokens += r.cacheCreation1hTokens;
      existing.cache_read_tokens += r.cacheReadTokens;
      existing.output_tokens += r.outputTokens;
      existing.web_search_requests += r.webSearchRequests;
      existing.web_fetch_requests += r.webFetchRequests;
      existing.api_calls += 1;
    } else {
      groups.set(key, {
        model: r.model,
        model_raw: r.modelRaw,
        speed: r.speed,
        inference_geo: r.inferenceGeo,
        service_tier: r.serviceTier,
        scope_kind: r.scopeKind,
        scope_name: r.scopeName,
        input_tokens: r.inputTokens,
        cache_creation_5m_tokens: r.cacheCreation5mTokens,
        cache_creation_1h_tokens: r.cacheCreation1hTokens,
        cache_read_tokens: r.cacheReadTokens,
        output_tokens: r.outputTokens,
        web_search_requests: r.webSearchRequests,
        web_fetch_requests: r.webFetchRequests,
        api_calls: 1,
      });
    }
  }

  return [...groups.values()];
}

/** The `model` of the `usage[]` row with the most `api_calls` — the contract's top-level `model`. */
function primaryModel(totals: SubagentUsageTotal[]): string {
  let best: SubagentUsageTotal | undefined;
  for (const total of totals) {
    if (!best || total.api_calls > best.api_calls) {
      best = total;
    }
  }
  return best?.model ?? '';
}

/** Sum of a `{name: count}` map's values — the contract's flat `tool_calls`/`tool_errors` totals. */
function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, n) => total + n, 0);
}

/** Merge per-tool call/error counts into the contract's `tools: {tool: {calls, errors}}`. */
function buildToolsBreakdown(
  toolCalls: Record<string, number>,
  toolErrors: Record<string, number>
): Record<string, { calls: number; errors: number }> {
  const tools: Record<string, { calls: number; errors: number }> = {};
  for (const [name, calls] of Object.entries(toolCalls)) {
    tools[name] = { calls, errors: toolErrors[name] ?? 0 };
  }
  for (const [name, errors] of Object.entries(toolErrors)) {
    if (!(name in tools)) {
      tools[name] = { calls: 0, errors };
    }
  }
  return tools;
}

/**
 * Build the `agent.subagent.usage` event payload for one subagent file.
 *
 * `usageRequests` is an array of {@link OpenUsageRequest} the caller has already parsed and
 * scoped to this one subagent (`scope_kind: 'agent'`) — summed into `usage[]` by
 * {@link buildUsageTotals}, never into flat token fields (the contract has none for this event).
 * `toolCalls`/`toolErrors` are caller-built `Record<string, number>` maps (keyed by tool name),
 * folded into the flat `tool_calls`/`tool_errors` totals and the per-tool `tools` breakdown.
 * `skills` is passed through verbatim — it is already the contract's `{name: count}` shape.
 *
 * `startedAt`/`endedAt`/`durationMs`/`toolResults` are forwarded verbatim from the caller, which
 * derives them from the subagent transcript's own lines — not this function's job.
 *
 * `spawn_depth` defaults to `0` when `file.spawnDepth` is absent (top-level subagents, whose
 * sidecar omits the field — not treated as an error). `description` defaults to `''` when the
 * sidecar has none.
 *
 * Carries its own explicit `type`, so `event_id`/`schema_version` are stamped later, by the adapter base class at hook time.
 */
export function buildSubagentUsageEvent(
  sessionId: string,
  file: SubagentFile,
  usageRequests: OpenUsageRequest[],
  toolCalls: Record<string, number>,
  toolErrors: Record<string, number>,
  toolResults: number,
  skills: Record<string, number>,
  startedAt: string,
  endedAt: string,
  durationMs: number
): Record<string, unknown> {
  const usage = buildUsageTotals(usageRequests);

  return {
    type: 'agent.subagent.usage',
    session_id: sessionId,
    agent_id: file.agentId,
    tool_use_id: file.toolUseId ?? '',
    agent_type: file.agentType ?? '',
    description: file.description ?? '',
    workflow_run: '',
    spawn_depth: file.spawnDepth ?? 0,
    worktree: '',
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    model: primaryModel(usage),
    api_calls: usageRequests.length,
    tool_calls: sumCounts(toolCalls),
    tool_results: toolResults,
    tool_errors: sumCounts(toolErrors),
    tools: buildToolsBreakdown(toolCalls, toolErrors),
    skills,
    commands: [],
    compactions: [],
    usage,
  };
}
