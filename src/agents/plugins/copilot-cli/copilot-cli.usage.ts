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
  CopilotUsageRecordData,
} from './copilot-cli-event-types.js';
import type { RunBounds } from '../../core/session/BaseSessionAdapter.js';

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

const RESUMED_NO_RECORD_REASON =
  'No usage record in this run\'s window of a resumed Copilot session — its share of the session rollup is unknown';

const USAGE_BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const;

const eventTime = (event: CopilotEvent): number => Date.parse(event.timestamp ?? '');

/**
 * The rule for every time comparison against a run: an event with no usable time lies in no bounded
 * window, so the runs sharing a transcript never each count it; only the whole-session window holds it.
 */
function isWholeSession(run: RunBounds): boolean {
  return run.startTime === -Infinity && run.upperBound === undefined;
}

/** Whether a time lies before the run's end (an untimed one only in the whole-session window). */
function beforeRunEnd(time: number, run: RunBounds): boolean {
  if (!Number.isFinite(time)) return isWholeSession(run);
  return !(run.upperBound !== undefined && time >= run.upperBound);
}

/** Whether an event lies in the run's window (an untimed one only in the whole-session window). */
export function inRun(event: CopilotEvent, run: RunBounds): boolean {
  const time = eventTime(event);
  return beforeRunEnd(time, run) && (!Number.isFinite(time) || time >= run.startTime);
}

/**
 * Whether the copilot session itself started inside the run (a fresh session, not a resumed one). A
 * missing or untimed `session.start` counts as fresh only for a run with no start bound.
 */
export function startedInRun(events: CopilotEvent[], run: RunBounds): boolean {
  const start = events.find((event) => event.type === 'session.start');
  const time = start ? eventTime(start) : NaN;
  if (!Number.isFinite(time)) return run.startTime === -Infinity;
  return !(time < run.startTime);
}

/** The run's share of the cumulative `session.shutdown` counters. */
export interface ShutdownShare {
  premiumRequests?: number;
  linesAdded?: number;
  linesRemoved?: number;
  filesModified: string[];
}

/**
 * A cumulative counter's share of the run: its last value before the run's end minus its last value
 * before the run's start. With no shutdown before the start the base is 0 when the copilot session
 * started inside the run, else the counters are not carried (a resumed session after a kill).
 */
export function runShutdownShare(events: CopilotEvent[], run: RunBounds): ShutdownShare | undefined {
  let base: CopilotShutdownData | undefined;
  let last: CopilotShutdownData | undefined;
  for (const event of events) {
    if (event.type !== 'session.shutdown' || !event.data) continue;
    const time = eventTime(event);
    if (time < run.startTime) base = event.data as CopilotShutdownData;
    if (beforeRunEnd(time, run)) last = event.data as CopilotShutdownData;
  }
  if (!last || (!base && !startedInRun(events, run))) return undefined;
  // Copilot's counters are cumulative across resumed processes: the clamp is a defence, not a path
  const minus = (value: number | undefined, prior: number | undefined) =>
    value === undefined ? undefined : Math.max(0, value - (prior ?? 0));
  const priorFiles = new Set(base?.codeChanges?.filesModified ?? []);
  return {
    premiumRequests: minus(last.totalPremiumRequests, base?.totalPremiumRequests),
    linesAdded: minus(last.codeChanges?.linesAdded, base?.codeChanges?.linesAdded),
    linesRemoved: minus(last.codeChanges?.linesRemoved, base?.codeChanges?.linesRemoved),
    filesModified: (last.codeChanges?.filesModified ?? []).filter((path) => !priorFiles.has(path)),
  };
}

/** Per-model usage summed over `session.usage_record` events, one request each. */
function fromUsageRecords(records: CopilotEvent[]): CopilotUsageMessage[] {
  const byModel = new Map<string, CopilotUsageMessage & { requests: number }>();
  for (const record of records) {
    const usage = (record.data as CopilotUsageRecordData | undefined)?.usage;
    if (!usage?.model) continue;
    const entry = byModel.get(usage.model) ?? { model: usage.model, usage: {}, requests: 0 };
    for (const bucket of USAGE_BUCKETS) {
      entry.usage[bucket] = (entry.usage[bucket] ?? 0) + (usage[bucket] ?? 0);
    }
    entry.requests += 1;
    byModel.set(usage.model, entry);
  }
  return [...byModel.values()];
}

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

export function extractCopilotUsage(events: CopilotEvent[]): CopilotUsageExtract {
  const shutdown = lastShutdown(events);

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

/**
 * The run's own usage: tokens and requests from the `session.usage_record` events inside its window;
 * a window with none carries the session rollup only for a fresh session, nothing for a resumed one.
 * Premium requests (no per-event source) by the shutdown subtraction.
 */
export function extractCopilotRunUsage(events: CopilotEvent[], run: RunBounds): CopilotUsageExtract {
  const premiumRequests = runShutdownShare(events, run)?.premiumRequests;
  const records = events.filter((event) => event.type === 'session.usage_record' && inRun(event, run));
  if (records.length > 0) {
    return { messages: fromUsageRecords(records), premiumRequests, partial: false };
  }
  if (startedInRun(events, run)) {
    return extractCopilotUsage(events.filter((event) => beforeRunEnd(eventTime(event), run)));
  }
  return { messages: [], premiumRequests, partial: false, unavailableReason: RESUMED_NO_RECORD_REASON };
}
