/**
 * Per-agent token usage extraction from a parsed native session.
 *
 * Each agent stores token usage differently in its native transcript. These
 * readers normalize that into a per-model {@link TokenUsage} map. Agents without
 * a reader (or sessions with no usage data) return an empty map, which the
 * enricher treats as "unpriced".
 */

import type { ParsedSession } from '../../../../agents/core/session/BaseSessionAdapter.js';
import type { TokenUsage } from './types.js';
import { emptyUsage, addUsage } from './cost-calculator.js';
import { isCodexFamilyAgent } from './codex-agent.js';

/** model -> usage */
type UsageMap = Map<string, TokenUsage>;

function accumulate(map: UsageMap, model: string, usage: TokenUsage): void {
  map.set(model, addUsage(map.get(model) ?? emptyUsage(), usage));
}

/**
 * Adapters are contracted to return `messages: unknown[]`, but a malformed or partially-written
 * native log can yield a non-array. Coerce defensively so a single bad session never throws out
 * of cost enrichment (matching the graceful degradation used elsewhere in the cost pipeline).
 */
function messagesOf(parsed: ParsedSession): unknown[] {
  return Array.isArray(parsed.messages) ? parsed.messages : [];
}

/**
 * The session's message arrays: main transcript first, then each sub-agent transcript
 * (transcripts of Task/Agent dispatches that the adapter parsed into `parsed.subagents`). Sub-agent token
 * usage belongs to the owning session — readers that skip these undercount sessions
 * that dispatch agents. Non-array `messages` entries are skipped with the same
 * defensive posture as {@link messagesOf}.
 */
function allMessageArrays(parsed: ParsedSession): unknown[][] {
  const arrays: unknown[][] = [messagesOf(parsed)];
  for (const sub of parsed.subagents ?? []) {
    if (Array.isArray(sub.messages)) {
      arrays.push(sub.messages);
    }
  }
  return arrays;
}

interface ClaudeRawMessage {
  requestId?: string;
  timestamp?: string; // top-level ISO timestamp on the native JSONL line
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: {
        ephemeral_1h_input_tokens?: number;
        ephemeral_5m_input_tokens?: number;
      };
    };
  };
}

/** One assistant API response's usage, plus a dedup key for cross-session de-duplication. */
export interface UsageRecord {
  /** `${message.id}::${requestId}` — null when neither is present (cannot dedupe ⇒ always counted). */
  key: string | null;
  /** Message epoch ms (for per-turn series); null when absent/unparseable. */
  ts: number | null;
  model: string;
  usage: TokenUsage;
}

/**
 * Extract one {@link UsageRecord} per Claude assistant message (skipping `<synthetic>`),
 * across the main transcript AND every sub-agent transcript in `parsed.subagents`.
 * Claude Code replays prior turns into resumed/forked session files, so the SAME API
 * response (same message.id + requestId) appears in multiple logs — callers dedupe by `key`.
 * Records are returned in chronological order when every record is timed; otherwise in
 * concatenation order (main transcript first, then sub-agent files in discovery order).
 */
export function extractClaudeUsageRecords(parsed: ParsedSession): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const messages of allMessageArrays(parsed)) {
    for (const raw of messages as ClaudeRawMessage[]) {
      const usage = raw.message?.usage;
      if (!usage) {
        continue;
      }
      const model = raw.message?.model ?? 'unknown';
      if (model === '<synthetic>') {
        continue; // synthetic system messages — not a billable model
      }
      const input = usage.input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheCreation = usage.cache_creation_input_tokens ?? 0;
      const cacheCreation1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const id = raw.message?.id;
      const reqId = raw.requestId;
      const key = id || reqId ? `${id ?? ''}::${reqId ?? ''}` : null;
      const parsedTs = raw.timestamp ? Date.parse(raw.timestamp) : NaN;
      const ts = Number.isFinite(parsedTs) ? parsedTs : null;
      records.push({
        key,
        ts,
        model,
        usage: { input, output, cacheRead, cacheCreation, cacheCreation1h, total: input + output + cacheRead + cacheCreation },
      });
    }
  }
  // Main and sub-agent records interleave in real time. Sort chronologically when every
  // record is timed — the same condition buildCostSeries uses for its real time axis — so
  // the cumulative cost/token series stays monotonic in time. Single-file sessions are
  // already in order (stable sort ⇒ no-op); any untimed record ⇒ keep concatenation order,
  // matching the series' ordinal-axis fallback.
  if (records.length > 1 && records.every((r) => r.ts !== null)) {
    records.sort((a, b) => (a.ts as number) - (b.ts as number));
  }
  return records;
}

function readClaude(parsed: ParsedSession): UsageMap {
  const out: UsageMap = new Map();
  for (const r of extractClaudeUsageRecords(parsed)) {
    accumulate(out, r.model, r.usage);
  }
  return out;
}

/** Claude Agent SDK `result` line — the authoritative per-model usage rollup. */
interface ClaudeSdkResult {
  type?: string;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
}

/**
 * Claude-3p / Agent SDK transcripts (Claude Desktop local-agent mode, audit.jsonl)
 * emit `result` lines carrying an authoritative `modelUsage` rollup. Summing the
 * streamed assistant turns over-counts cache reads (and some turns carry no usage at
 * all), so prefer modelUsage when present. Returns null when there is no result line.
 */
function readClaudeSdkResult(parsed: ParsedSession): UsageMap | null {
  const out: UsageMap = new Map();
  let found = false;
  for (const raw of messagesOf(parsed) as ClaudeSdkResult[]) {
    if (raw.type !== 'result' || !raw.modelUsage) {
      continue;
    }
    for (const [model, u] of Object.entries(raw.modelUsage)) {
      if (model === '<synthetic>') {
        continue;
      }
      found = true;
      const input = u.inputTokens ?? 0;
      const output = u.outputTokens ?? 0;
      const cacheRead = u.cacheReadInputTokens ?? 0;
      const cacheCreation = u.cacheCreationInputTokens ?? 0;
      accumulate(out, model, {
        input,
        output,
        cacheRead,
        cacheCreation,
        // SDK modelUsage rollup carries no TTL breakdown, so any 1h-TTL writes here
        // fall back to the 5m rate in costBreakdown (a conservative under-estimate).
        cacheCreation1h: 0,
        total: input + output + cacheRead + cacheCreation,
      });
    }
  }
  return found ? out : null;
}

/** Claude Desktop: prefer the SDK modelUsage rollup, else sum assistant usage. */
function readClaudeDesktop(parsed: ParsedSession): UsageMap {
  return readClaudeSdkResult(parsed) ?? readClaude(parsed);
}

interface GeminiRawMessage {
  model?: string;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    total?: number;
  };
}

function readGemini(parsed: ParsedSession): UsageMap {
  const out: UsageMap = new Map();
  for (const raw of messagesOf(parsed) as GeminiRawMessage[]) {
    const t = raw.tokens;
    if (!t) {
      continue;
    }
    const model = raw.model ?? 'gemini';
    const input = t.input ?? 0;
    const output = t.output ?? 0;
    const cacheRead = t.cached ?? 0;
    accumulate(out, model, {
      input,
      output,
      cacheRead,
      cacheCreation: 0,
      cacheCreation1h: 0,
      total: t.total ?? input + output + cacheRead,
    });
  }
  return out;
}

interface CodexRolloutLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    model?: string;
    turn_id?: string;
    info?: {
      total_token_usage?: CodexTokenBlock;
      last_token_usage?: CodexTokenBlock;
    } | null;
  };
}

interface CodexTokenBlock {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

function codexBlockToUsage(block: CodexTokenBlock): TokenUsage {
  const cacheRead = block.cached_input_tokens ?? 0;
  // Codex/OpenAI `input_tokens` is the FULL prompt count and already INCLUDES cached tokens
  // (unlike Anthropic, where input and cache-read are disjoint fields). Subtract so the cached
  // portion is priced once — at the cache-read rate — instead of also at the full input rate,
  // since costBreakdown sums `input + cacheRead`. See cost-calculator.costBreakdown.
  const input = Math.max(0, (block.input_tokens ?? 0) - cacheRead);
  const output = block.output_tokens ?? 0;
  const total = block.total_tokens ?? input + output + cacheRead;
  return { input, output, cacheRead, cacheCreation: 0, cacheCreation1h: 0, total };
}

function codexLines(parsed: ParsedSession): CodexRolloutLine[] {
  return messagesOf(parsed) as CodexRolloutLine[];
}

function codexDefaultModel(parsed: ParsedSession): string {
  const meta = parsed.metadata as { model?: string } | undefined;
  return meta?.model?.trim() || 'unknown';
}

/**
 * Per-turn usage from Codex `token_count` events (`last_token_usage`), correlated with the
 * most recent `turn_context.model`. Sub-agent rollouts attached to `parsed.subagents` are
 * included in the session total but not in the per-turn series (parent transcript only).
 */
export function extractCodexUsageRecords(parsed: ParsedSession): UsageRecord[] {
  const records: UsageRecord[] = [];
  let currentModel = codexDefaultModel(parsed);
  let turnIndex = 0;

  for (const raw of codexLines(parsed)) {
    if (raw.type === 'turn_context' && raw.payload?.model?.trim()) {
      currentModel = raw.payload.model.trim();
    }
    if (raw.type !== 'event_msg' || raw.payload?.type !== 'token_count' || !raw.payload.info?.last_token_usage) {
      continue;
    }
    const ts = raw.timestamp ? Date.parse(raw.timestamp) : NaN;
    const turnId = raw.payload.turn_id ?? `turn-${turnIndex}`;
    turnIndex += 1;
    records.push({
      key: `${parsed.sessionId}::${turnId}`,
      ts: Number.isFinite(ts) ? ts : null,
      model: currentModel,
      usage: codexBlockToUsage(raw.payload.info.last_token_usage),
    });
  }
  return records;
}

/** Session total from the final authoritative `total_token_usage` on the main transcript. */
function readCodex(parsed: ParsedSession): UsageMap {
  const out: UsageMap = new Map();
  let currentModel = codexDefaultModel(parsed);
  let lastTotal: CodexTokenBlock | undefined;

  for (const raw of codexLines(parsed)) {
    if (raw.type === 'turn_context' && raw.payload?.model?.trim()) {
      currentModel = raw.payload.model.trim();
    }
    if (raw.type === 'event_msg' && raw.payload?.type === 'token_count' && raw.payload.info?.total_token_usage) {
      lastTotal = raw.payload.info.total_token_usage;
    }
  }

  if (lastTotal) {
    accumulate(out, currentModel, codexBlockToUsage(lastTotal));
  }

  for (const sub of parsed.subagents ?? []) {
    if (!Array.isArray(sub.messages)) {
      continue;
    }
    const subParsed = { ...parsed, messages: sub.messages, subagents: undefined } as ParsedSession;
    const subMap = readCodex(subParsed);
    for (const [model, usage] of subMap) {
      accumulate(out, model, usage);
    }
  }

  return out;
}

/**
 * Sub-agent-only session usage for Codex. The parent transcript total is already carried by the
 * per-turn records ({@link extractCodexUsageRecords}); this returns just the linked child rollouts
 * so callers on the per-turn path can fold sub-agent spend into the session/run total without
 * touching the parent-only series.
 */
export function readCodexSubagentUsage(parsed: ParsedSession): UsageMap {
  const out: UsageMap = new Map();
  for (const sub of parsed.subagents ?? []) {
    if (!Array.isArray(sub.messages)) {
      continue;
    }
    const subParsed = { ...parsed, messages: sub.messages, subagents: undefined } as ParsedSession;
    for (const [model, usage] of readCodex(subParsed)) {
      accumulate(out, model, usage);
    }
  }
  return out;
}

interface KimiUsageRecord {
  type?: string;
  time?: number;
  model?: string;
  usage?: {
    inputOther?: number;
    output?: number;
    inputCacheRead?: number;
    inputCacheCreation?: number;
  };
}

/**
 * Read Kimi Code usage.record events.
 * Kimi records one usage event per assistant step with inputOther/output/cache fields.
 */
function readKimi(parsed: ParsedSession): UsageMap {
  const out: UsageMap = new Map();
  for (const raw of messagesOf(parsed) as KimiUsageRecord[]) {
    if (raw.type !== 'usage.record' || !raw.usage) {
      continue;
    }
    const model = raw.model ?? 'unknown';
    const input = raw.usage.inputOther ?? 0;
    const output = raw.usage.output ?? 0;
    const cacheRead = raw.usage.inputCacheRead ?? 0;
    const cacheCreation = raw.usage.inputCacheCreation ?? 0;
    accumulate(out, model, {
      input,
      output,
      cacheRead,
      cacheCreation,
      cacheCreation1h: 0,
      total: input + output + cacheRead + cacheCreation,
    });
  }
  return out;
}

/**
 * Extract ordered, deduped usage records from Kimi wire events for per-turn cost series.
 * Kimi has no stable message/request id, so records cannot be cross-session deduped;
 * each record is session-local and keyed by timestamp when available.
 */
export function extractKimiUsageRecords(parsed: ParsedSession): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const raw of messagesOf(parsed) as KimiUsageRecord[]) {
    if (raw.type !== 'usage.record' || !raw.usage) {
      continue;
    }
    const model = raw.model ?? 'unknown';
    const input = raw.usage.inputOther ?? 0;
    const output = raw.usage.output ?? 0;
    const cacheRead = raw.usage.inputCacheRead ?? 0;
    const cacheCreation = raw.usage.inputCacheCreation ?? 0;
    records.push({
      key: null,
      ts: typeof raw.time === 'number' ? raw.time : null,
      model,
      usage: { input, output, cacheRead, cacheCreation, cacheCreation1h: 0, total: input + output + cacheRead + cacheCreation },
    });
  }
  return records;
}

/**
 * Returns per-model {@link TokenUsage}. An empty map means the agent is
 * unsupported or the session carried no usage data. (Session-local; does NOT
 * dedupe across sessions — use {@link gatherUsageDeduped} for run-level totals.)
 */
export function readUsageByModel(agentName: string, parsed: ParsedSession): UsageMap {
  switch (agentName.toLowerCase()) {
    case 'claude':
    case 'claude-acp':
      return readClaude(parsed);
    case 'claude-desktop': // native logs are Claude-shaped (~/.claude/projects + Claude-3p audit.jsonl)
      return readClaudeDesktop(parsed);
    case 'gemini':
      return readGemini(parsed);
    case 'kimi':
      return readKimi(parsed);
    default:
      if (isCodexFamilyAgent(agentName)) {
        return readCodex(parsed);
      }
      return new Map();
  }
}

/**
 * Per-model usage for the cost enricher, deduping Claude API responses across sessions
 * by `(message.id, requestId)`. `seen` is shared across all sessions in a run (pass a
 * fresh set to disable cross-session dedup). When a Claude session carries an authoritative
 * SDK `modelUsage` rollup (audit.jsonl), that is used as-is (session-local, no cross-file dup).
 */
export function gatherUsageDeduped(agentName: string, parsed: ParsedSession, seen: Set<string>): UsageMap {
  const a = agentName.toLowerCase();
  if (a === 'gemini') {
    return readGemini(parsed);
  }
  if (a === 'kimi') {
    return readKimi(parsed);
  }
  if (isCodexFamilyAgent(a)) {
    return readCodex(parsed);
  }
  if (a === 'claude' || a === 'claude-acp' || a === 'claude-desktop') {
    const rollup = readClaudeSdkResult(parsed);
    if (rollup) {
      return rollup; // authoritative SDK rollup
    }
    const out: UsageMap = new Map();
    for (const r of extractClaudeUsageRecords(parsed)) {
      if (r.key !== null) {
        if (seen.has(r.key)) {
          continue; // duplicate API response replayed into another session file
        }
        seen.add(r.key);
      }
      accumulate(out, r.model, r.usage);
    }
    return out;
  }
  return new Map(); // codex/opencode/etc — no usage reader yet
}

/**
 * Ordered, deduped per-message usage records (for a per-session time-series).
 * Mirrors {@link gatherUsageDeduped}'s dedup (skips keys already in `seen`, mutates `seen`)
 * but preserves chronological record order instead of summing. Returns [] when there is no per-message
 * order to series-ize: an authoritative SDK `modelUsage` rollup, or a non-supported agent.
 * MUST be called at most once per session against a shared `seen` set (it consumes keys).
 */
export function gatherDedupedUsageRecords(agentName: string, parsed: ParsedSession, seen: Set<string>): UsageRecord[] {
  const a = agentName.toLowerCase();
  if (a === 'kimi') {
    // Kimi records are session-local (no cross-session dedup key), so pass through as-is.
    return extractKimiUsageRecords(parsed);
  }
  if (isCodexFamilyAgent(a)) {
    const out: UsageRecord[] = [];
    for (const r of extractCodexUsageRecords(parsed)) {
      if (r.key !== null) {
        if (seen.has(r.key)) {
          continue;
        }
        seen.add(r.key);
      }
      out.push(r);
    }
    return out;
  }
  if (a !== 'claude' && a !== 'claude-acp' && a !== 'claude-desktop') {
    return []; // gemini/opencode/etc — no per-turn series
  }
  if (readClaudeSdkResult(parsed)) {
    return []; // authoritative rollup carries no per-message order
  }
  const out: UsageRecord[] = [];
  for (const r of extractClaudeUsageRecords(parsed)) {
    if (r.key !== null) {
      if (seen.has(r.key)) {
        continue; // duplicate API response replayed into another session file
      }
      seen.add(r.key);
    }
    out.push(r);
  }
  return out;
}

/** Sum ordered usage records into a per-model {@link UsageMap} (equivalent to the summed dedup path). */
export function sumUsageRecords(records: UsageRecord[]): UsageMap {
  const out: UsageMap = new Map();
  for (const r of records) {
    accumulate(out, r.model, r.usage);
  }
  return out;
}
