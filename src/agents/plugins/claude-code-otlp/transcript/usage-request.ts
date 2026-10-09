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
 * `gitBranch`/`isApiError`. Not exported — callers only see {@link parseUsageLine}'s result.
 */
interface TranscriptUsageLine {
  timestamp?: string;
  gitBranch?: string;
  isApiError?: boolean;
  requestId?: string;
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
    };
  };
}

/**
 * Parse one transcript JSONL line into an {@link OpenUsageRequest}, or `null` when the line
 * carries no `message.usage` block (not a billable API response — e.g. a plain user/system
 * message) or is not valid JSON.
 *
 * `scopeKind`/`scopeName`/`agentId` are passed through verbatim from the caller, which already
 * knows which transcript (main vs. a named skill context vs. a subagent transcript) `line` came
 * from — this function has no way to derive that from the line itself.
 */
export function parseUsageLine(
  line: string,
  scopeKind: 'main' | 'skill' | 'agent',
  scopeName: string,
  agentId: string
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
    cacheCreation5mTokens: Number(usage.cache_creation?.ephemeral_5m_input_tokens ?? 0),
    cacheCreation1hTokens: Number(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0),
    cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
    webSearchRequests: Number(usage.server_tool_use?.web_search_requests ?? 0),
    webFetchRequests: Number(usage.server_tool_use?.web_fetch_requests ?? 0),
    scopeKind,
    scopeName,
    agentId,
    // Sibling of usage on message, not nested inside it.
    stopReason: parsed.message?.stop_reason ?? '',
    isApiError: Boolean(parsed.isApiError),
    gitBranch: parsed.gitBranch ?? '',
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
 * does not blank it out.
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
    webSearchRequests: Math.max(a.webSearchRequests, b.webSearchRequests),
    webFetchRequests: Math.max(a.webFetchRequests, b.webFetchRequests),
    scopeKind: b.scopeKind || a.scopeKind,
    scopeName: b.scopeName || a.scopeName,
    agentId: b.agentId || a.agentId,
    stopReason: b.stopReason || a.stopReason,
    isApiError: b.isApiError || a.isApiError,
    gitBranch: b.gitBranch || a.gitBranch,
  };
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
    web_search_requests: req.webSearchRequests,
    web_fetch_requests: req.webFetchRequests,
    scope_kind: req.scopeKind,
    scope_name: req.scopeName,
    agent_id: req.agentId,
    stop_reason: req.stopReason,
    is_api_error: req.isApiError,
    git_branch: req.gitBranch,
    timestamp: req.timestamp,
  };
}
