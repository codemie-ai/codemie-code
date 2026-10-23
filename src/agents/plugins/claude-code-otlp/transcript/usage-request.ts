/**
 * `agent.usage.request` extraction and merge.
 *
 * One record per Claude transcript JSONL line that carries `message.usage` — the same
 * per-API-response usage shape the cost-reporting parser
 * (`src/cli/commands/analytics/cost/usage-readers.ts`) reads, adapted to
 * {@link OpenUsageRequest} (`parse-state.ts`) instead of that pipeline's `UsageRecord`.
 *
 * Claude Code can write more than one JSONL row for the same API response (progressive
 * streaming chunks, or a later row that fills in `stop_reason` once the turn finishes), so
 * callers parse every candidate line and merge same-identity records with
 * {@link mergeUsageRequest} — this module trusts the caller to key records with
 * {@link usageRequestKey} (see `parse-state.ts`'s `openRequests`) before merging; it does
 * not itself check that two records it is asked to merge actually share that identity.
 *
 * Request identity follows the CLI analytics contract: `requestId` is the API request id
 * (`req_...`, the transcript's top-level `requestId`; `''` when the transcript has none, as
 * behind the proxy) and `messageId` is `message.id` (`msg_...`).
 */

import { type RoutingHeaderSource } from '../../../../utils/routing-headers.mjs';
import { parseBackendModelName } from '../../../../utils/bedrock-pricing.mjs';
import type { OpenUsageRequest } from './parse-state.js';

/**
 * Loose shape of one transcript JSONL line, mirroring `usage-readers.ts`'s `ClaudeRawMessage`
 * plus `message.stop_reason`, `message.usage`'s extra nested groups, and the top-level
 * `gitBranch`/`isApiErrorMessage`. Not exported — callers only see {@link parseUsageLine}'s result.
 */
interface TranscriptUsageLine {
  timestamp?: string;
  gitBranch?: string;
  isApiErrorMessage?: boolean;
  requestId?: string;
  requestedModel?: unknown;
  attributionSkill?: unknown;
  message?: RoutingHeaderSource & {
    id?: string;
    model?: string;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      service_tier?: string;
      speed?: string;
      inference_geo?: string;
      cache_creation?: {
        ephemeral_1h_input_tokens?: number;
        ephemeral_5m_input_tokens?: number;
      };
      server_tool_use?: {
        web_search_requests?: number;
        web_fetch_requests?: number;
      };
      output_tokens_details?: {
        thinking_tokens?: number;
      };
    };
  };
}

/**
 * Parse one transcript JSONL line into an {@link OpenUsageRequest}, or `null` when the line
 * carries no `message.usage` block (not a billable API response — e.g. a plain user/system
 * message) or is not valid JSON.
 *
 * `scopeKind`/`scopeName`/`agentId`/`agentType` are passed through verbatim from the caller, which
 * already knows which transcript (main vs. a named skill context vs. a subagent transcript) `line`
 * came from — this function has no way to derive that from the line itself.
 */
export function parseUsageLine(
  line: string,
  scopeKind: 'main' | 'skill' | 'agent',
  scopeName: string,
  agentId: string,
  agentType: string
): OpenUsageRequest | null {
  let parsed: TranscriptUsageLine;
  try {
    parsed = JSON.parse(line) as TranscriptUsageLine;
  } catch {
    return null;
  }

  const usage = parsed.message?.usage;
  if (!usage) {
    return null;
  }

  // openRequests keys on `${requestId || messageId}::${model}` — with neither id every such
  // line in the session would collide into one record, so it is skipped instead.
  const requestId = parsed.requestId ?? '';
  const messageId = parsed.message?.id ?? '';
  if (!requestId && !messageId) {
    return null;
  }

  // Same resolution chain the statusline and usage-readers.ts already use:
  // parseBackendModelName() (the raw LiteLLM backend id, when the proxy injected one) wins over
  // the transcript's own literal `message.model`, since it reflects the actual billable backend
  // model for a routed/capable-tier request. `modelRaw` keeps the literal, unresolved alias.
  const modelRaw = parsed.message?.model ?? 'unknown';
  const model = parseBackendModelName(parsed.message) ?? modelRaw;

  // `cache_creation_input_tokens` is the aggregate for both TTL tiers, while `cache_creation`
  // splits it. Rows without that split (older Claude Code versions, some providers) would lose
  // their cache-write tokens entirely, so the aggregate's remainder is attributed to the default
  // 5m TTL — the same arithmetic the cost pipeline uses (cost-calculator.ts's tokens5m).
  const nested5m = usage.cache_creation?.ephemeral_5m_input_tokens;
  const nested1h = usage.cache_creation?.ephemeral_1h_input_tokens;
  const cacheCreation1hTokens = typeof nested1h === 'number' ? nested1h : 0;
  const cacheCreation5mTokens =
    typeof nested5m === 'number'
      ? nested5m
      : Math.max(Number(usage.cache_creation_input_tokens ?? 0) - cacheCreation1hTokens, 0);

  return {
    requestId,
    messageId,
    model,
    modelRaw,
    timestamp: parsed.timestamp ?? '',
    speed: usage.speed ?? '',
    inferenceGeo: usage.inference_geo ?? '',
    serviceTier: usage.service_tier ?? '',
    inputTokens: Number(usage.input_tokens ?? 0),
    cacheCreation5mTokens,
    cacheCreation1hTokens,
    cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
    thinkingTokens:
      usage.output_tokens_details?.thinking_tokens === undefined
        ? null
        : Number(usage.output_tokens_details.thinking_tokens),
    webSearchRequests: Number(usage.server_tool_use?.web_search_requests ?? 0),
    webFetchRequests: Number(usage.server_tool_use?.web_fetch_requests ?? 0),
    scopeKind,
    scopeName,
    agentId,
    agentType,
    // Sibling of usage on message, not nested inside it.
    stopReason: parsed.message?.stop_reason ?? '',
    isApiError: Boolean(parsed.isApiErrorMessage),
    gitBranch: parsed.gitBranch ?? '',
    requestedModel: typeof parsed.requestedModel === 'string' ? parsed.requestedModel : '',
    attributionSkill: typeof parsed.attributionSkill === 'string' ? parsed.attributionSkill : '',
  };
}

/**
 * Identity key for a logical request: the API request id when the transcript has one, else
 * `message.id`, plus the resolved model. Single source of truth for every `openRequests` /
 * dedupe key.
 */
export function usageRequestKey(r: { requestId: string; messageId: string; model: string }): string {
  return `${r.requestId || r.messageId}::${r.model}`;
}

/**
 * Merge two {@link OpenUsageRequest} records the caller has already identified as the same
 * logical request (same {@link usageRequestKey} — this function does not verify that itself).
 * Every numeric field takes the max of the two (a later streaming/finalizing row only ever adds
 * usage, never subtracts it); every non-numeric field takes `b`'s value when non-empty, else
 * falls back to `a`'s — so a later row that fills in a previously-empty field (e.g.
 * `stop_reason` once the turn finishes) wins, while a later row that is missing a field `a` had
 * does not blank it out. `scopeKind` and `scopeName` are the exception: the pair is taken whole
 * from `b` when `b.scopeKind` is non-empty, else from `a`, so the result never pairs one line's
 * kind with another line's name.
 *
 * Returns a new object; neither `a` nor `b` is mutated.
 */
export function mergeUsageRequest(a: OpenUsageRequest, b: OpenUsageRequest): OpenUsageRequest {
  return {
    requestId: b.requestId || a.requestId,
    messageId: b.messageId || a.messageId,
    model: b.model || a.model,
    modelRaw: b.modelRaw || a.modelRaw,
    timestamp: b.timestamp || a.timestamp,
    speed: b.speed || a.speed,
    inferenceGeo: b.inferenceGeo || a.inferenceGeo,
    serviceTier: b.serviceTier || a.serviceTier,
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    cacheCreation5mTokens: Math.max(a.cacheCreation5mTokens, b.cacheCreation5mTokens),
    cacheCreation1hTokens: Math.max(a.cacheCreation1hTokens, b.cacheCreation1hTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    // null only when neither side has ever reported thinking tokens; token counts are never
    // negative, so 0 is a safe stand-in for "no info" on whichever side Math.max still needs one.
    thinkingTokens:
      a.thinkingTokens === null && b.thinkingTokens === null
        ? null
        : Math.max(a.thinkingTokens ?? 0, b.thinkingTokens ?? 0),
    webSearchRequests: Math.max(a.webSearchRequests, b.webSearchRequests),
    webFetchRequests: Math.max(a.webFetchRequests, b.webFetchRequests),
    scopeKind: b.scopeKind ? b.scopeKind : a.scopeKind,
    scopeName: b.scopeKind ? b.scopeName : a.scopeName,
    agentId: b.agentId || a.agentId,
    agentType: b.agentType || a.agentType,
    stopReason: b.stopReason || a.stopReason,
    isApiError: b.isApiError || a.isApiError,
    gitBranch: b.gitBranch || a.gitBranch,
    requestedModel: b.requestedModel || a.requestedModel || '',
    attributionSkill: b.attributionSkill || a.attributionSkill || '',
  };
}

/**
 * True when the request's `output_tokens` cannot be trusted as final: Claude Code can write an
 * assistant row mid-stream (`stop_reason` null) and never rewrite it, leaving a placeholder count.
 * A request whose merged record still has no `stop_reason` never saw its finalizing row.
 * API-error rows legitimately carry no `stop_reason` and are not partial.
 */
export function isOutputTokensPartial(req: Pick<OpenUsageRequest, 'stopReason' | 'isApiError'>): boolean {
  return !req.stopReason && !req.isApiError;
}

/**
 * Build the `agent.usage.request` event payload for `req`. Carries its own explicit `type`, so
 * the adapter base class stamps `event_id`/`schema_version` onto it at hook time —
 * this function deliberately does not set either.
 */
export function buildUsageRequestEvent(sessionId: string, req: OpenUsageRequest): Record<string, unknown> {
  return {
    type: 'agent.usage.request',
    session_id: sessionId,
    request_id: req.requestId,
    message_id: req.messageId,
    model_raw: req.modelRaw,
    model: req.model,
    speed: req.speed,
    inference_geo: req.inferenceGeo,
    service_tier: req.serviceTier,
    input_tokens: req.inputTokens,
    cache_creation_5m_tokens: req.cacheCreation5mTokens,
    cache_creation_1h_tokens: req.cacheCreation1hTokens,
    cache_read_tokens: req.cacheReadTokens,
    output_tokens: req.outputTokens,
    output_tokens_partial: isOutputTokensPartial(req),
    thinking_tokens: req.thinkingTokens,
    web_search_requests: req.webSearchRequests,
    web_fetch_requests: req.webFetchRequests,
    scope_kind: req.scopeKind,
    scope_name: req.scopeName,
    agent_id: req.agentId,
    agent_type: req.agentType,
    stop_reason: req.stopReason,
    is_api_error: req.isApiError,
    git_branch: req.gitBranch,
    timestamp: req.timestamp,
  };
}
