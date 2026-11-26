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

const RESUMED_NO_TOKENS_REASON = 'No tokens in this run of a resumed Copilot session';

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

/** A shutdown counter's growth; Copilot's counters are cumulative across resumed processes, so the clamp is a defence, not a path. */
const minus = (value: number | undefined, prior: number | undefined) =>
  value === undefined ? undefined : Math.max(0, value - (prior ?? 0));

/**
 * The two shutdowns a run's share of a cumulative counter lies between: the last before the run's end and
 * the last before its start. With no shutdown before the start the base is 0 when the copilot session
 * started inside the run, else the share is unknown (a resumed session after a kill). A start or resume
 * after the base with no shutdown of its own before the run is a killed run whose work the counters
 * include: the share is unknown. So is a run with no shutdown inside it (a kill): its last value is the base.
 */
function runShutdowns(events: CopilotEvent[], run: RunBounds): { base?: CopilotShutdownData; last: CopilotShutdownData } | undefined {
  let base: CopilotShutdownData | undefined;
  let last: CopilotShutdownData | undefined;
  let unclosedBefore = false;
  for (const event of events) {
    const time = eventTime(event);
    if ((event.type === 'session.start' || event.type === 'session.resume') && time < run.startTime) unclosedBefore = true;
    if (event.type !== 'session.shutdown' || !event.data) continue;
    if (time < run.startTime) {
      base = event.data as CopilotShutdownData;
      unclosedBefore = false;
    }
    if (beforeRunEnd(time, run)) last = event.data as CopilotShutdownData;
  }
  if (!last || last === base || unclosedBefore || (!base && !startedInRun(events, run))) return undefined;
  return { base, last };
}

/** A cumulative counter's share of the run: its last value before the run's end minus its last before the run's start. */
export function runShutdownShare(events: CopilotEvent[], run: RunBounds): ShutdownShare | undefined {
  const shutdowns = runShutdowns(events, run);
  if (!shutdowns) return undefined;
  const { base, last } = shutdowns;
  const priorFiles = new Set(base?.codeChanges?.filesModified ?? []);
  return {
    premiumRequests: minus(last.totalPremiumRequests, base?.totalPremiumRequests),
    linesAdded: minus(last.codeChanges?.linesAdded, base?.codeChanges?.linesAdded),
    linesRemoved: minus(last.codeChanges?.linesRemoved, base?.codeChanges?.linesRemoved),
    filesModified: (last.codeChanges?.filesModified ?? []).filter((path) => !priorFiles.has(path)),
  };
}

/**
 * Per-model usage summed over the run's `session.usage_record` events, one request each. A record without
 * its own model goes under the model in effect at its time: the latest model event at or before it, either a
 * `session.model_change` (`newModel`) or an `assistant.message` (`model`), whichever came last. One with no
 * model in effect is not counted and makes the result partial.
 */
function fromUsageRecords(events: CopilotEvent[], run: RunBounds): { messages: CopilotUsageMessage[]; partial: boolean } {
  const byModel = new Map<string, CopilotUsageMessage & { requests: number }>();
  let inEffect: string | undefined;
  let partial = false;
  for (const event of events) {
    if (event.type === 'session.model_change') inEffect = (event.data as { newModel?: string } | undefined)?.newModel ?? inEffect;
    if (event.type === 'assistant.message') inEffect = (event.data as CopilotAssistantMessageData | undefined)?.model ?? inEffect;
    if (event.type !== 'session.usage_record' || !inRun(event, run)) continue;
    const usage = (event.data as CopilotUsageRecordData | undefined)?.usage;
    if (!usage) continue;
    const model = usage.model ?? inEffect;
    if (!model) {
      partial = true;
      continue;
    }
    const entry = byModel.get(model) ?? { model, usage: {}, requests: 0 };
    for (const bucket of USAGE_BUCKETS) {
      entry.usage[bucket] = (entry.usage[bucket] ?? 0) + (usage[bucket] ?? 0);
    }
    entry.requests += 1;
    byModel.set(model, entry);
  }
  return { messages: [...byModel.values()], partial };
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

/** Whether any counter of the base stands above `last`'s; a counter or model `last` no longer carries reads as 0. */
function isBelowBase(base: CopilotUsageMessage[], last: CopilotUsageMessage[]): boolean {
  const current = new Map(last.map((message) => [message.model, message]));
  return base.some(({ model, usage, requests }) => {
    const now = current.get(model);
    return (requests ?? 0) > (now?.requests ?? 0)
      || USAGE_BUCKETS.some((bucket) => (usage[bucket] ?? 0) > (now?.usage[bucket] ?? 0));
  });
}

/**
 * Per-model usage between two shutdowns; a model that did not move yields nothing. Undefined when either
 * shutdown carries no `modelMetrics`, or an entry with no `usage`, which `fromShutdown` would drop: a figure with
 * no base would hand the run its earlier runs' tokens, and a model dropped from `last` would leave its share out.
 * Undefined too when `last` is below the base: the counters are cumulative, so going down means this rollup is
 * not comparable with the base (a build that resets them) and the run's share is unknown, not zero.
 */
function fromShutdownDelta({ base, last }: { base?: CopilotShutdownData; last: CopilotShutdownData }): CopilotUsageMessage[] | undefined {
  if (!base?.modelMetrics || !last.modelMetrics) return undefined;
  if ([base.modelMetrics, last.modelMetrics].some((metrics) => Object.values(metrics).some((entry) => !entry?.usage))) return undefined;
  const baseMessages = fromShutdown(base);
  const lastMessages = fromShutdown(last);
  if (isBelowBase(baseMessages, lastMessages)) return undefined;
  const prior = new Map(baseMessages.map((message) => [message.model, message]));
  return lastMessages.flatMap(({ model, usage, requests }) => {
    const before = prior.get(model);
    const delta: CopilotUsageBuckets = {};
    for (const bucket of USAGE_BUCKETS) {
      if (usage[bucket] !== undefined) delta[bucket] = minus(usage[bucket], before?.usage[bucket]);
    }
    const requestDelta = minus(requests, before?.requests);
    return USAGE_BUCKETS.some((bucket) => delta[bucket]) || requestDelta ? [{ model, usage: delta, requests: requestDelta }] : [];
  });
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
 * Whole-session tier 0 — `session.usage_record` (Copilot >= 1.0.92): one record per API request, summed per
 * model. Request counts are distinct `apiCallId`s, so they match the backend's API-call count.
 */
function fromDistinctUsageRecords(events: CopilotEvent[]): CopilotUsageMessage[] {
  const byModel = new Map<string, { usage: CopilotUsageBuckets; ids: Set<string> }>();
  for (const event of events) {
    if (event.type !== 'session.usage_record' || !event.data) continue;
    const record = (event.data as CopilotUsageRecordData).usage ?? (event.data as CopilotUsageBuckets & { model?: string; apiCallId?: string });
    if (!record.model || !record.apiCallId) continue;
    const entry = byModel.get(record.model) ?? { usage: {}, ids: new Set<string>() };
    if (entry.ids.has(record.apiCallId)) continue;
    entry.ids.add(record.apiCallId);
    for (const bucket of USAGE_BUCKETS) {
      entry.usage[bucket] = (entry.usage[bucket] ?? 0) + (record[bucket] ?? 0);
    }
    byModel.set(record.model, entry);
  }
  return [...byModel.entries()].map(([model, entry]) => ({ model, usage: entry.usage, requests: entry.ids.size }));
}

export function extractCopilotUsage(events: CopilotEvent[]): CopilotUsageExtract {
  const shutdown = lastShutdown(events);

  const records = fromDistinctUsageRecords(events);
  if (records.length > 0) {
    // A resumed session upgraded mid-way has older requests only in the shutdown rollup:
    // use the rollup for any model where it counts more requests than the records do.
    const rollup = new Map((shutdown ? fromShutdown(shutdown) : []).map((m) => [m.model, m]));
    const merged = records.map((m) => {
      const fallback = rollup.get(m.model);
      return fallback && (fallback.requests ?? 0) > (m.requests ?? 0) ? fallback : m;
    });
    for (const [model, entry] of rollup) {
      if (!merged.some((m) => m.model === model)) merged.push(entry);
    }
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

/**
 * The run's own usage: tokens and requests from the `session.usage_record` events inside its window.
 * A window with none (builds up to 1.0.83 write no such event) carries the session rollup for a fresh
 * session; for a resumed one its delta over the run's shutdowns. A delta with no growth carries its own
 * reason, so the report reads it as not measurable rather than as an unreadable log; a share that is unknown
 * carries another. Premium requests (no per-event source) by the shutdown subtraction.
 */
export function extractCopilotRunUsage(events: CopilotEvent[], run: RunBounds): CopilotUsageExtract {
  const premiumRequests = runShutdownShare(events, run)?.premiumRequests;
  const { messages, partial } = fromUsageRecords(events, run);
  if (messages.length > 0) {
    return { messages, premiumRequests, partial };
  }
  if (startedInRun(events, run)) {
    return extractCopilotUsage(events.filter((event) => beforeRunEnd(eventTime(event), run)));
  }
  const shutdowns = runShutdowns(events, run);
  const delta = shutdowns && fromShutdownDelta(shutdowns);
  if (delta) {
    return {
      messages: delta,
      premiumRequests,
      partial: false,
      ...(delta.length === 0 && { unavailableReason: RESUMED_NO_TOKENS_REASON }),
    };
  }
  return { messages: [], premiumRequests, partial: false, unavailableReason: RESUMED_NO_RECORD_REASON };
}
