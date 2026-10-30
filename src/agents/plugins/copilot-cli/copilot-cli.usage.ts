/**
 * Token extraction from a Copilot CLI transcript, in three tiers.
 *
 * Tier 1 — `session.shutdown`.`modelMetrics`: the authoritative per-model rollup, carrying
 *          input, output, cache-read, cache-write and reasoning buckets plus request counts.
 * Tier 2 — per-turn `assistant.message`: recovers output tokens and request counts exactly
 *          (verified against tier 1 on real mixed-model sessions), but NO event carries
 *          per-turn input or cache tokens. Marked partial, because input outweighs output
 *          by roughly 100:1 and an output-only figure is a severe undercount.
 * Tier 3 — neither: the session carries no usage data and is listed unpriced with a reason.
 *
 * Buckets are emitted RAW, in Copilot's own OpenAI-convention field names. Conversion into
 * the repository's Anthropic-convention `TokenUsage` happens in exactly one place —
 * `readCopilotCli` in `src/cli/commands/analytics/cost/usage-readers.ts` — so the
 * convention mismatch has a single, testable seam.
 */

import type {
  CopilotEvent,
  CopilotShutdownData,
  CopilotAssistantMessageData,
  CopilotUsageBuckets,
} from './copilot-cli-event-types.js';

/** One model's usage within a session, as Copilot reported it. */
export interface CopilotUsageMessage {
  model: string;
  usage: CopilotUsageBuckets;
  /** API request count for this model; not the same as premium requests. */
  requests?: number;
  /** True when reconstructed from per-turn events (output tokens only). */
  partial?: boolean;
}

export interface CopilotUsageExtract {
  messages: CopilotUsageMessage[];
  /** GitHub's actual billing unit for the session, when recorded. */
  premiumRequests?: number;
  /** True when any model's usage was reconstructed rather than read from the rollup. */
  partial: boolean;
  /** Why the session could not be priced; absent when usage was found. */
  unavailableReason?: string;
}

const NO_USAGE_REASON =
  'No usage data in transcript — this Copilot CLI version recorded no token telemetry';

interface UsageRecord extends CopilotUsageBuckets {
  model?: string;
  apiCallId?: string;
}

const BUCKET_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const;

/** Last shutdown wins: a resumed session can record more than one. */
function lastShutdown(events: CopilotEvent[]): CopilotShutdownData | null {
  let found: CopilotShutdownData | null = null;
  for (const event of events) {
    if (event.type === 'session.shutdown' && event.data) {
      found = event.data as CopilotShutdownData;
    }
  }
  return found;
}

function fromShutdown(data: CopilotShutdownData): CopilotUsageMessage[] {
  const messages: CopilotUsageMessage[] = [];
  for (const [model, entry] of Object.entries(data.modelMetrics ?? {})) {
    if (!entry?.usage) {
      continue;
    }
    messages.push({ model, usage: entry.usage, requests: entry.requests?.count });
  }
  return messages;
}

function fromPerTurn(events: CopilotEvent[]): CopilotUsageMessage[] {
  const byModel = new Map<string, { output: number; requests: number }>();

  // Tier 2 exists for builds that never write session.shutdown — and those are exactly the
  // builds that also omit per-turn `model`. Tracking the model in effect from
  // session.model_change is what makes this fallback reachable at all; requiring
  // `data.model` would skip every turn on the versions this tier is for.
  let currentModel: string | undefined;

  for (const event of events) {
    if (event.type === 'session.model_change') {
      const next = (event.data as { newModel?: string } | undefined)?.newModel;
      if (next) {
        currentModel = next;
      }
      continue;
    }
    if (event.type !== 'assistant.message' || !event.data) {
      continue;
    }
    const data = event.data as CopilotAssistantMessageData;
    const model = data.model ?? currentModel;
    if (!model || typeof data.outputTokens !== 'number') {
      continue; // no model signal anywhere — attributing it would be a guess
    }
    const accumulated = byModel.get(model) ?? { output: 0, requests: 0 };
    accumulated.output += data.outputTokens;
    accumulated.requests += 1;
    byModel.set(model, accumulated);
  }

  return [...byModel.entries()].map(([model, accumulated]) => ({
    model,
    usage: { outputTokens: accumulated.output },
    requests: accumulated.requests,
    partial: true,
  }));
}

/**
 * Tier 0 — `session.usage_record` (Copilot ≥ 1.0.92): one record per API request, summed per
 * model. Request counts are distinct `apiCallId`s, so they match the backend's API-call count.
 */
function fromUsageRecords(events: CopilotEvent[]): CopilotUsageMessage[] {
  const byModel = new Map<string, { usage: CopilotUsageBuckets; ids: Set<string> }>();
  for (const event of events) {
    if (event.type !== 'session.usage_record' || !event.data) continue;
    const data = event.data as { usage?: UsageRecord } & UsageRecord;
    const record = data.usage ?? data;
    if (!record.model || !record.apiCallId) continue;
    const entry = byModel.get(record.model) ?? { usage: {}, ids: new Set<string>() };
    if (entry.ids.has(record.apiCallId)) continue;
    entry.ids.add(record.apiCallId);
    for (const key of BUCKET_KEYS) {
      entry.usage[key] = (entry.usage[key] ?? 0) + (record[key] ?? 0);
    }
    byModel.set(record.model, entry);
  }
  return [...byModel.entries()].map(([model, entry]) => ({ model, usage: entry.usage, requests: entry.ids.size }));
}

export function extractCopilotUsage(events: CopilotEvent[]): CopilotUsageExtract {
  const shutdown = lastShutdown(events);

  const records = fromUsageRecords(events);
  if (records.length > 0) {
    // A resumed session upgraded mid-way has older requests only in the shutdown rollup:
    // use the rollup for any model where it counts more requests than the records do.
    const rollup = new Map((shutdown ? fromShutdown(shutdown) : []).map((m) => [m.model, m]));
    const merged = records.map((m) => {
      const fallback = rollup.get(m.model);
      return fallback && (fallback.requests ?? 0) > (m.requests ?? 0) ? fallback : m;
    });
    return { messages: merged, premiumRequests: shutdown?.totalPremiumRequests, partial: false };
  }

  if (shutdown) {
    const messages = fromShutdown(shutdown);
    if (messages.length > 0) {
      return { messages, premiumRequests: shutdown.totalPremiumRequests, partial: false };
    }
  }

  const perTurn = fromPerTurn(events);
  if (perTurn.length > 0) {
    return {
      messages: perTurn,
      premiumRequests: shutdown?.totalPremiumRequests,
      partial: true,
    };
  }

  return {
    messages: [],
    premiumRequests: shutdown?.totalPremiumRequests,
    partial: false,
    unavailableReason: NO_USAGE_REASON,
  };
}
