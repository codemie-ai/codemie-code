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
 * `worktree` is the hook's own `cwd` (the contract's "its worktree path") reduced to the
 * repository identifier (`extractRepository`, the same value `cwd` carries): the caller fills
 * `cwd` in from the triggering hook payload, since no sidecar or transcript signal carries it,
 * and no absolute path leaves the hook process.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { extractRepository, isPathWithinDirectory } from '@/utils/paths.js';
import { isSyntheticModel } from './synthetic-model.js';
import type { OpenUsageRequest } from './parse-state.js';
import { isOutputTokensPartial } from './usage-request.js';

export interface SubagentFile {
  agentId: string;
  filePath: string;
  toolUseId?: string;
  agentType?: string;
  spawnDepth?: number;
  description?: string;
  /**
   * The triggering hook's absolute `cwd` — reduced to a repository identifier by the `worktree`
   * field. `''` when the caller has none.
   */
  cwd?: string;
  /** The forked skill's name, when this subagent is actually a slash-command-invoked skill run
   *  in the background (EPMCDME-15968) — absent for a regular agent dispatch. Sourced from the
   *  `<agent>.forked-skill.marker.json` sidecar, never from `.meta.json`'s `name` (see
   *  {@link readForkedSkillMarker}: that field is the Agent tool's optional addressing name,
   *  which any named agent can carry, forked skill or not). */
  skillName?: string;
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
 * Read one subagent's `.forked-skill.marker.json` sidecar (same path, `.jsonl` swapped) — the
 * signal Claude Code itself writes only for a slash-command skill forked as a background
 * subagent (`{"forkedSkill": true, "skillName": "<name>"}`), never for a regular named agent
 * dispatch (which only ever gets a `.meta.json` with its own `name`, a different, unrelated
 * field — see {@link SubagentMeta}'s removed `name`). Never throws: a missing or malformed
 * sidecar (the common case — most subagents are not forked skills) resolves to `{}`.
 */
export async function readForkedSkillMarker(jsonlFilePath: string): Promise<{ skillName?: string }> {
  try {
    const markerPath = jsonlFilePath.replace(/\.jsonl$/, '.forked-skill.marker.json');
    const markerRaw = JSON.parse(await readFile(markerPath, 'utf-8')) as Record<string, unknown>;
    if (markerRaw.forkedSkill === true && typeof markerRaw.skillName === 'string') {
      return { skillName: markerRaw.skillName };
    }
  } catch {
    // sidecar absent or malformed — this subagent is not a forked skill (or we can't tell).
  }
  return {};
}

/**
 * The directory Claude Code writes a main transcript's subagent files under:
 * `<parentDir>/<sessionId>/subagents/`, where `sessionId` is `mainTranscriptPath`'s own
 * basename minus `.jsonl`. Shared by {@link findSubagentFiles} (lists every file there) and
 * {@link subagentFilePath} (builds one specific agent's path from a `SubagentStart` hook, which
 * — unlike `SubagentStop` — carries no `agent_transcript_path` of its own).
 */
function subagentsDirFor(mainTranscriptPath: string): string {
  const parentDir = dirname(mainTranscriptPath);
  const sessionId = basename(mainTranscriptPath).replace(/\.jsonl$/, '');
  return join(parentDir, sessionId, 'subagents');
}

/**
 * The transcript path a `SubagentStart` hook's own subagent would be written to, built from the
 * triggering hook's `transcript_path` (the *main* transcript — `SubagentStart`'s payload has no
 * `agent_transcript_path` field, unlike `SubagentStop`'s) and its `agent_id`. Same convention
 * {@link findSubagentFiles} discovers files with. The file may not exist yet if called too
 * early; callers read it the same tolerant way as any other subagent sidecar.
 *
 * `agentId` comes straight from the hook payload (CR-002): confine the result to the subagents
 * directory (`isPathWithinDirectory`, same containment check `.ai-run/guides/security/
 * security-practices.md` documents) so a crafted `agent_id` can never make the caller read a
 * marker sidecar from outside it. Never throws — an out-of-bounds `agentId` resolves to a path
 * guaranteed not to exist inside the subagents directory, the same "degrade, don't throw"
 * contract every other sidecar reader in this module keeps.
 */
export function subagentFilePath(mainTranscriptPath: string, agentId: string): string {
  const subagentsDir = subagentsDirFor(mainTranscriptPath);
  const candidate = join(subagentsDir, `agent-${agentId}.jsonl`);
  if (!isPathWithinDirectory(subagentsDir, candidate)) {
    return join(subagentsDir, 'agent-invalid.jsonl');
  }
  return candidate;
}

/**
 * Discover subagent transcript files for a main transcript at `mainTranscriptPath`.
 *
 * Looks under `<parentDir>/<sessionId>/subagents/` (where `sessionId` is `mainTranscriptPath`'s
 * own basename, minus `.jsonl`) for `agent-*.jsonl` files, reading each one's `.meta.json` via
 * {@link readSubagentMeta} and its `.forked-skill.marker.json` via {@link readForkedSkillMarker}.
 *
 * Never throws: a missing subagents directory, an unreadable directory, or any other failure all
 * resolve to `[]`.
 */
export async function findSubagentFiles(mainTranscriptPath: string): Promise<SubagentFile[]> {
  try {
    const subagentsDir = subagentsDirFor(mainTranscriptPath);

    const files = await readdir(subagentsDir);
    const agentFiles = await Promise.all(
      files
        .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
        .map(async (f): Promise<SubagentFile> => {
          const agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
          const filePath = join(subagentsDir, f);
          const [meta, marker] = await Promise.all([readSubagentMeta(filePath), readForkedSkillMarker(filePath)]);
          return { agentId, filePath, ...meta, ...marker };
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
  /** True when any request in this group has no final `stop_reason`, so `output_tokens` may undercount. */
  output_tokens_partial: boolean;
  thinking_tokens: number | null;
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
      existing.output_tokens_partial = existing.output_tokens_partial || isOutputTokensPartial(r);
      existing.thinking_tokens =
        existing.thinking_tokens === null && r.thinkingTokens === null
          ? null
          : (existing.thinking_tokens ?? 0) + (r.thinkingTokens ?? 0);
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
        output_tokens_partial: isOutputTokensPartial(r),
        thinking_tokens: r.thinkingTokens,
        web_search_requests: r.webSearchRequests,
        web_fetch_requests: r.webFetchRequests,
        api_calls: 1,
      });
    }
  }

  return [...groups.values()];
}

/**
 * The `model` of the `usage[]` row with the most `api_calls` — the contract's top-level `model`.
 * `<synthetic>` API-error placeholder rows are skipped (they are not real models), so a subagent
 * whose only rows are placeholders reports `''` rather than a fake model.
 */
function primaryModel(totals: SubagentUsageTotal[]): string {
  let best: SubagentUsageTotal | undefined;
  for (const total of totals) {
    if (isSyntheticModel(total.model)) continue;
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
 * `spawn_depth` is emitted only when `file.spawnDepth` is present: a sidecar that omits it (which
 * is how top-level subagents look) leaves the depth unknown, and an unknown value is omitted
 * rather than reported as `0` (contract rule 4). `description` defaults to `''` when the sidecar
 * has none.
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
    ...(typeof file.spawnDepth === 'number' ? { spawn_depth: file.spawnDepth } : {}),
    worktree: file.cwd ? extractRepository(file.cwd) : '',
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
