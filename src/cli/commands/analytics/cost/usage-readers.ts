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
 * Extract one {@link UsageRecord} per Claude assistant message (skipping `<synthetic>`).
 * Claude Code replays prior turns into resumed/forked session files, so the SAME API
 * response (same message.id + requestId) appears in multiple logs — callers dedupe by `key`.
 */
export function extractClaudeUsageRecords(parsed: ParsedSession): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const raw of messagesOf(parsed) as ClaudeRawMessage[]) {
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
    const id = raw.message?.id;
    const reqId = raw.requestId;
    const key = id || reqId ? `${id ?? ''}::${reqId ?? ''}` : null;
    const parsedTs = raw.timestamp ? Date.parse(raw.timestamp) : NaN;
    const ts = Number.isFinite(parsedTs) ? parsedTs : null;
    records.push({
      key,
      ts,
      model,
      usage: { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation },
    });
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
      total: t.total ?? input + output + cacheRead,
    });
  }
  return out;
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
    default:
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
 * Ordered, deduped per-message Claude usage records (for a per-session time-series).
 * Mirrors {@link gatherUsageDeduped}'s dedup (skips keys already in `seen`, mutates `seen`)
 * but preserves message order instead of summing. Returns [] when there is no per-message
 * order to series-ize: an authoritative SDK `modelUsage` rollup, or a non-Claude agent.
 * MUST be called at most once per session against a shared `seen` set (it consumes keys).
 */
export function gatherDedupedUsageRecords(agentName: string, parsed: ParsedSession, seen: Set<string>): UsageRecord[] {
  const a = agentName.toLowerCase();
  if (a !== 'claude' && a !== 'claude-acp' && a !== 'claude-desktop') {
    return []; // gemini/codex/etc — no per-turn series in v1
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
