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
 * The session's message arrays: main transcript first, then every linked transcript the adapter
 * parsed into `parsed.subagents` — transcripts of Task/Agent dispatches, and for Pi also the
 * `/fork` continuations that carry the rest of the same conversation. Their token usage belongs
 * to the owning session — readers that skip them undercount sessions that dispatch agents.
 * Non-array `messages` entries are skipped with the same defensive posture as {@link messagesOf}.
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

function usageWeight(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
}

function isMoreCompleteUsageRecord(candidate: UsageRecord, current: UsageRecord): boolean {
  const candidateWeight = usageWeight(candidate.usage);
  const currentWeight = usageWeight(current.usage);
  if (candidateWeight !== currentWeight) {
    return candidateWeight > currentWeight;
  }
  if (candidate.ts !== null && current.ts !== null && candidate.ts !== current.ts) {
    return candidate.ts > current.ts;
  }
  return false;
}

/**
 * Append `record`, collapsing repeats of the same dedup key in place.
 *
 * One API response can legitimately appear more than once in the transcripts an extractor
 * walks — Claude Code writes progressive JSONL rows for a streaming response, and Pi copies
 * inherited history verbatim into a forked log. Keeping the most complete row (rather than the
 * first or the last) stops a partial chunk from winning, and replacing in place keeps the
 * record's original position so chronological order survives.
 */
function appendDedupedRecord(records: UsageRecord[], keyed: Map<string, UsageRecord>, record: UsageRecord): void {
  if (record.key === null) {
    records.push(record); // unkeyable ⇒ always counted
    return;
  }
  const current = keyed.get(record.key);
  if (!current) {
    keyed.set(record.key, record);
    records.push(record);
    return;
  }
  if (isMoreCompleteUsageRecord(record, current)) {
    const index = records.indexOf(current);
    if (index !== -1) {
      records[index] = record;
    }
    keyed.set(record.key, record);
  }
}

/**
 * Records whose dedup key no earlier session has claimed, marking each survivor as claimed.
 * Order is preserved. `seen` is shared across every session in a run, so the EARLIEST session
 * owns a response that several transcripts replay.
 */
function takeUnseenRecords(records: UsageRecord[], seen: Set<string>): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const record of records) {
    if (record.key !== null) {
      if (seen.has(record.key)) {
        continue; // duplicate API response replayed into another session file
      }
      seen.add(record.key);
    }
    out.push(record);
  }
  return out;
}

/**
 * Extract one {@link UsageRecord} per Claude assistant message (skipping `<synthetic>`),
 * across the main transcript AND every sub-agent transcript in `parsed.subagents`.
 * Claude Code replays prior turns into resumed/forked session files, so the SAME API
 * response (same message.id + requestId) appears in multiple logs — callers dedupe by `key`.
 * Claude Code can also write progressive JSONL rows for a streaming response before the
 * final usage arrives; keep the most complete same-key row so partial chunks do not win.
 * Records are returned in chronological order when every record is timed; otherwise in
 * concatenation order (main transcript first, then sub-agent files in discovery order).
 */
export function extractClaudeUsageRecords(parsed: ParsedSession): UsageRecord[] {
  const records: UsageRecord[] = [];
  const keyedRecords = new Map<string, UsageRecord>();
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
      appendDedupedRecord(records, keyedRecords, {
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

/**
 * Raw per-model buckets exactly as the Copilot adapter emits them (Copilot's own field
 * names). Copilot normalizes every provider it proxies to the OpenAI convention.
 */
interface CopilotCliRawMessage {
  model?: string;
  requests?: number;
  partial?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
}

/**
 * GitHub Copilot CLI.
 *
 * CONVENTION MISMATCH — the reason this reader is not a pass-through:
 *   Copilot:    `inputTokens` INCLUDES `cacheReadTokens` (OpenAI convention), applied to
 *               every provider it proxies, Anthropic models included.
 *   This repo:  {@link costBreakdown} bills `input` at full rate AND `cacheRead`
 *               separately, so `TokenUsage.input` must EXCLUDE cache reads.
 * Passing `inputTokens` through unchanged over-counts the input component ~36x on a real
 * measured session.
 *
 * `reasoningTokens` is a SUBSET of `outputTokens` (OpenAI convention, corroborated by
 * per-turn output sums matching the shutdown rollup exactly), so it is never billed
 * separately. `cacheWriteTokens` is treated as a subset of fresh input: on observed data
 * cache-write (125,660) fits inside fresh input (150,012), and subtracting can never
 * over-bill. Copilot exposes no cache-TTL split, so all writes fall in the 5m bucket.
 */
function readCopilotCli(parsed: ParsedSession): UsageMap {
  const out: UsageMap = new Map();
  for (const arr of allMessageArrays(parsed)) {
    for (const raw of arr as CopilotCliRawMessage[]) {
      if (!raw || typeof raw !== 'object' || !raw.model || !raw.usage) {
        continue;
      }
      const u = raw.usage;
      const cacheRead = u.cacheReadTokens ?? 0;
      const output = u.outputTokens ?? 0;

      // inputTokens is the TOTAL prompt; peel off the cached and cache-written parts.
      const freshInput = Math.max(0, (u.inputTokens ?? 0) - cacheRead);
      // Clamp cache writes to the fresh input they were written from. Cache creation is
      // priced ABOVE the base input rate, so an inconsistent transcript must not be able
      // to bill more of it than the prompt actually contained. Clamping also keeps `input`
      // non-negative by construction.
      const cacheCreation = Math.min(u.cacheWriteTokens ?? 0, freshInput);
      const input = freshInput - cacheCreation;

      accumulate(out, raw.model, {
        input,
        output,
        cacheRead,
        cacheCreation,
        cacheCreation1h: 0,
        total: input + output + cacheRead + cacheCreation,
      });
    }
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
 * Pi's normalized per-response usage block, exactly as Pi persists it (`Usage` in the upstream
 * `packages/ai/src/types.ts:368-389`).
 *
 * NO SUBTRACTION HERE — and that is deliberate. Pi converts EVERY provider it talks to into the
 * Anthropic (disjoint) convention before writing the transcript, so `input`, `cacheRead` and
 * `cacheWrite` never overlap:
 *   - openai-completions: `input = max(0, prompt_tokens - cached_tokens - cache_write_tokens)`
 *     (`packages/ai/src/api/openai-completions.ts:1384-1396`)
 *   - anthropic-messages: the provider's already-disjoint fields are copied through unchanged
 *     (`packages/ai/src/api/anthropic-messages.ts:576-584`)
 * {@link readCopilotCli} and {@link codexBlockToUsage} subtract because THEIR sources report an
 * inclusive prompt total. Applying the same subtraction to Pi would remove the cached prompt a
 * second time and undercount every Pi session by the size of its cache reads — which, on real
 * transcripts, is the overwhelming majority of the prompt.
 *
 * `reasoning` is documented as a subset of `output` (`packages/ai/src/types.ts:375-380`), so it
 * is never billed separately. `cost` is present but always zero for CodeMie-proxied models
 * (Pi has no price table for them), which is why the report prices from `pricing.json` instead.
 */
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  totalTokens?: number;
}

/** A Pi v3 session-log line, narrowed to the fields the usage reader needs. */
interface PiUsageEntry {
  type?: string;
  id?: string;
  /** ISO timestamp on the entry envelope — the only timestamp `branch_summary`/`compaction` carry. */
  timestamp?: string;
  /** Model the user switched to, on a `model_change` entry. */
  modelId?: string;
  /** Summary-generation spend, recorded at entry level with no model attached. */
  usage?: PiUsage;
  message?: {
    role?: string;
    model?: string;
    /** Concrete model when it differs from the requested one (e.g. an `auto` route). */
    responseModel?: string;
    responseId?: string;
    usage?: PiUsage;
    /** Epoch ms. */
    timestamp?: number;
  };
}

function piBlockToUsage(block: PiUsage): TokenUsage {
  const input = block.input ?? 0;
  const output = block.output ?? 0;
  const cacheRead = block.cacheRead ?? 0;
  const cacheCreation = block.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheCreation,
    cacheCreation1h: block.cacheWrite1h ?? 0,
    total: block.totalTokens ?? input + output + cacheRead + cacheCreation,
  };
}

function piRecordTimestamp(entry: PiUsageEntry): number | null {
  const messageTs = entry.message?.timestamp;
  if (typeof messageTs === 'number' && Number.isFinite(messageTs)) {
    return messageTs;
  }
  const entryTs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(entryTs) ? entryTs : null;
}

/**
 * Dedup key for a Pi usage entry, or null when the entry carries no identity.
 *
 * `responseId` is the provider's own response identifier and is the strongest available key.
 * When it is absent (aborted turns, and every summary entry), fall back to the Pi entry id plus
 * its timestamp. Pi's `/fork` copies inherited entries VERBATIM, ids included
 * (`packages/coding-agent/src/core/session-manager.ts:1621-1626`), so the entry id is exactly
 * what stops a fork from double-counting the history it inherited.
 *
 * An entry with neither is unkeyable and returns null, per {@link UsageRecord.key}. Synthesizing
 * a key from the timestamp alone would be worse than useless: an entry lacking both id and
 * timestamp would then key on the constant `"::"`, and `takeUnseenRecords` would discard every
 * such record after the first ACROSS THE WHOLE RUN. Pi always writes an entry id
 * (`SessionEntryBase.id`), so null here means a corrupt line — counted once, never suppressing
 * an unrelated one.
 */
function piRecordKey(entry: PiUsageEntry, ts: number | null): string | null {
  const responseId = entry.message?.responseId;
  if (typeof responseId === 'string' && responseId.length > 0) {
    return responseId;
  }
  return entry.id ? `${entry.id}::${ts ?? ''}` : null;
}

/**
 * Extract one {@link UsageRecord} per billable Pi entry, across the main transcript AND every
 * linked transcript in `parsed.subagents` (nested sub-agent runs and `/fork` continuations —
 * see `pi.session.ts loadLinkedTranscripts`). Pi records NO usage on the parent's `toolResult`
 * entries for a sub-agent dispatch, so the nested files are the only place that spend exists.
 *
 * Upstream bills three kinds of entry (`packages/coding-agent/src/core/usage-totals.ts:36-70`):
 *   1. `message` / role `assistant` — the model is `responseModel ?? model`.
 *   2. `message` / role `toolResult` carrying its own `usage` — sub-agent and summary spend.
 *   3. `branch_summary` / `compaction` with a top-level `entry.usage`.
 *
 * Pi attributes NO model to (2) and (3) — it buckets them under a single "Tools/summaries" key.
 * The report is per-model, so they are APPROXIMATED to the model in effect at that point in the
 * transcript: the last assistant response's model, or — before any assistant reply — the last
 * `model_change` entry, which is what Pi writes at session start and on every `/model` switch.
 * Without the `model_change` source a transcript whose first usage-bearing entry is a
 * `compaction` or `branch_summary` (routine right after `/compact` in a forked session) would
 * bill real dollars to a phantom `unknown` model row. Dropping the entries instead would
 * silently undercount sub-agent-heavy sessions outright, which is the worse error.
 *
 * Records come back in chronological order when every record is timed; otherwise in
 * concatenation order (main transcript first, then linked transcripts in discovery order).
 */
export function extractPiUsageRecords(parsed: ParsedSession): UsageRecord[] {
  const records: UsageRecord[] = [];
  const keyedRecords = new Map<string, UsageRecord>();

  for (const messages of allMessageArrays(parsed)) {
    // Model attribution never crosses a transcript boundary: a sub-agent log is its own
    // conversation, so its first unattributed entry must not inherit the parent's last model.
    let currentModel: string | undefined;

    for (const entry of messages as PiUsageEntry[]) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      if (entry.type === 'model_change' && typeof entry.modelId === 'string' && entry.modelId) {
        currentModel = entry.modelId;
        continue;
      }
      const message = entry.type === 'message' ? entry.message : undefined;
      let block: PiUsage | undefined;

      if (message?.role === 'assistant') {
        currentModel = message.responseModel ?? message.model ?? currentModel;
        block = message.usage;
      } else if (message?.role === 'toolResult') {
        block = message.usage;
      } else if (entry.type === 'branch_summary' || entry.type === 'compaction') {
        block = entry.usage;
      }
      if (!block) {
        continue;
      }

      const ts = piRecordTimestamp(entry);
      appendDedupedRecord(records, keyedRecords, {
        key: piRecordKey(entry, ts),
        ts,
        model: currentModel ?? 'unknown',
        usage: piBlockToUsage(block),
      });
    }
  }

  // Same chronological normalization as the Claude reader: main and sub-agent records
  // interleave in real time, so sort when every record is timed and otherwise keep
  // concatenation order (matching buildCostSeries' ordinal-axis fallback).
  if (records.length > 1 && records.every((r) => r.ts !== null)) {
    records.sort((a, b) => (a.ts as number) - (b.ts as number));
  }
  return records;
}

/**
 * Session total for Pi. No separate linked-transcript fold is needed (unlike {@link readCodex})
 * because {@link extractPiUsageRecords} already walks `parsed.subagents` via
 * {@link allMessageArrays}.
 */
function readPi(parsed: ParsedSession): UsageMap {
  const out: UsageMap = new Map();
  for (const r of extractPiUsageRecords(parsed)) {
    accumulate(out, r.model, r.usage);
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
    case 'kimi':
      return readKimi(parsed);
    case 'pi':
      return readPi(parsed);
    case 'copilot-cli':
      return readCopilotCli(parsed);
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
  if (a === 'copilot-cli') {
    // Session-local, like gemini/kimi: Copilot never replays one API response into
    // another session file, so there is no cross-session key to dedup on.
    return readCopilotCli(parsed);
  }
  if (isCodexFamilyAgent(a)) {
    return readCodex(parsed);
  }
  if (a === 'pi') {
    // Cross-session dedup, like Claude and unlike the session-local readers above: `/fork`
    // copies the inherited history verbatim into the new transcript, so one API response
    // really does appear in several files and must be billed to the earliest one only.
    const out: UsageMap = new Map();
    for (const r of takeUnseenRecords(extractPiUsageRecords(parsed), seen)) {
      accumulate(out, r.model, r.usage);
    }
    return out;
  }
  if (a === 'claude' || a === 'claude-acp' || a === 'claude-desktop') {
    const rollup = readClaudeSdkResult(parsed);
    if (rollup) {
      return rollup; // authoritative SDK rollup
    }
    const out: UsageMap = new Map();
    for (const r of takeUnseenRecords(extractClaudeUsageRecords(parsed), seen)) {
      accumulate(out, r.model, r.usage);
    }
    return out;
  }
  return new Map(); // opencode/etc — no usage reader yet
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
    return takeUnseenRecords(extractCodexUsageRecords(parsed), seen);
  }
  if (a === 'pi') {
    return takeUnseenRecords(extractPiUsageRecords(parsed), seen);
  }
  if (a !== 'claude' && a !== 'claude-acp' && a !== 'claude-desktop') {
    return []; // gemini/opencode/etc — no per-turn series
  }
  if (readClaudeSdkResult(parsed)) {
    return []; // authoritative rollup carries no per-message order
  }
  return takeUnseenRecords(extractClaudeUsageRecords(parsed), seen);
}

/** Sum ordered usage records into a per-model {@link UsageMap} (equivalent to the summed dedup path). */
export function sumUsageRecords(records: UsageRecord[]): UsageMap {
  const out: UsageMap = new Map();
  for (const r of records) {
    accumulate(out, r.model, r.usage);
  }
  return out;
}
