/**
 * `agent.subagent.usage` discovery and event builder.
 *
 * Discovery (`findSubagentFiles`) follows the same path convention as the existing,
 * `private`/unexported `findSubagentFiles` in `src/agents/plugins/claude/claude.session.ts`
 * (`<parentDir>/<sessionId>/subagents/agent-*.jsonl` + sibling `<name>.meta.json`), but is a
 * fresh, smaller implementation returning only the narrower {@link SubagentFile} shape this
 * event needs — no `parentAgentId`/`requestShape`/`requestNonInteractive`.
 *
 * The event builder (`buildSubagentUsageEvent`) aggregates token/cache fields by summing an
 * already-scoped `OpenUsageRequest[]` (`./usage-request.ts`'s shape, reused — not redefined), and passes
 * caller-built `tool_calls`/`tool_errors`/`skills_invoked` maps through verbatim: this module has
 * no access to a subagent's own tool-use/tool-error/skill-invocation occurrences, only to the
 * aggregates its caller already computed from that subagent's transcript.
 *
 * `description`/`workflow_run`/`worktree` have no identified source anywhere in this codebase
 * (per spec.md's "Open risks") — always emitted as literal empty strings, never fabricated.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { OpenUsageRequest } from './parse-state.js';

export interface SubagentFile {
  agentId: string;
  filePath: string;
  toolUseId?: string;
  agentType?: string;
  spawnDepth?: number;
}

/**
 * Discover subagent transcript files for a main transcript at `mainTranscriptPath`.
 *
 * Looks under `<parentDir>/<sessionId>/subagents/` (where `sessionId` is `mainTranscriptPath`'s
 * own basename, minus `.jsonl`) for `agent-*.jsonl` files, reading each one's sibling
 * `<name>.meta.json` sidecar (when present and parseable) for `toolUseId`/`agentType`/
 * `spawnDepth`. Never reads `mainTranscriptPath`'s own content — only its path is used to derive
 * the subagents directory.
 *
 * Never throws: a missing subagents directory, an unreadable directory, or any other failure all
 * resolve to `[]`. A missing or malformed per-agent `.meta.json` sidecar is likewise swallowed —
 * that agent is still returned, just without the sidecar-derived fields.
 */
export async function findSubagentFiles(mainTranscriptPath: string): Promise<SubagentFile[]> {
  try {
    const parentDir = dirname(mainTranscriptPath);
    const filename = basename(mainTranscriptPath);
    const sessionId = filename.replace(/\.jsonl$/, '');
    const subagentsDir = join(parentDir, sessionId, 'subagents');

    if (!existsSync(subagentsDir)) {
      return [];
    }

    const files = await readdir(subagentsDir);
    const agentFiles = await Promise.all(
      files
        .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
        .map(async (f): Promise<SubagentFile> => {
          const agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
          const filePath = join(subagentsDir, f);

          let toolUseId: string | undefined;
          let agentType: string | undefined;
          let spawnDepth: number | undefined;

          try {
            const metaRaw = JSON.parse(
              await readFile(join(subagentsDir, f.replace(/\.jsonl$/, '.meta.json')), 'utf-8')
            ) as Record<string, unknown>;
            if (typeof metaRaw.toolUseId === 'string') toolUseId = metaRaw.toolUseId;
            if (typeof metaRaw.agentType === 'string') agentType = metaRaw.agentType;
            if (typeof metaRaw.spawnDepth === 'number') spawnDepth = metaRaw.spawnDepth;
          } catch {
            // meta file absent or malformed — proceed without it.
          }

          return { agentId, filePath, toolUseId, agentType, spawnDepth };
        })
    );

    return agentFiles;
  } catch {
    return [];
  }
}

/**
 * Build the `agent.subagent.usage` event payload for one subagent file.
 *
 * `usageRequests` is an array of {@link OpenUsageRequest} the caller has already parsed and
 * scoped to this one subagent (`scope_kind: 'agent'`) — this function only sums it, it does not
 * filter or scope it itself. `toolCalls`/`toolErrors`/`skillsInvoked` are likewise caller-built
 * `Record<string, number>` maps (keyed by tool/skill name) and are passed through verbatim.
 *
 * `started_at`/`duration_ms` are forwarded verbatim from the caller, which derives them from the
 * subagent transcript's own first/last line timestamps — not this function's job.
 *
 * `spawn_depth` defaults to `0` when `file.spawnDepth` is absent (top-level subagents, whose
 * sidecar omits the field — per spec.md's Open risks, not treated as an error).
 *
 * Carries its own explicit `type`, so `event_id`/`schema_version` are stamped later, daemon-side.
 */
export function buildSubagentUsageEvent(
  sessionId: string,
  file: SubagentFile,
  usageRequests: OpenUsageRequest[],
  toolCalls: Record<string, number>,
  toolErrors: Record<string, number>,
  skillsInvoked: Record<string, number>,
  startedAt: string,
  durationMs: number
): Record<string, unknown> {
  const sum = (selector: (req: OpenUsageRequest) => number): number =>
    usageRequests.reduce((total, req) => total + selector(req), 0);

  return {
    type: 'agent.subagent.usage',
    session_id: sessionId,
    agent_id: file.agentId,
    tool_use_id: file.toolUseId ?? '',
    agent_type: file.agentType ?? '',
    spawn_depth: file.spawnDepth ?? 0,
    description: '',
    workflow_run: '',
    worktree: '',
    started_at: startedAt,
    duration_ms: durationMs,
    input_tokens: sum((r) => r.inputTokens),
    cache_creation_5m_tokens: sum((r) => r.cacheCreation5mTokens),
    cache_creation_1h_tokens: sum((r) => r.cacheCreation1hTokens),
    cache_read_tokens: sum((r) => r.cacheReadTokens),
    output_tokens: sum((r) => r.outputTokens),
    web_search_requests: sum((r) => r.webSearchRequests),
    web_fetch_requests: sum((r) => r.webFetchRequests),
    api_calls: usageRequests.length,
    tool_calls: toolCalls,
    tool_errors: toolErrors,
    skills_invoked: skillsInvoked,
  };
}
