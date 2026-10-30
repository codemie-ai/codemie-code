import { createHash } from 'node:crypto';
import type {
  CopilotAssistantMessageData,
  CopilotEvent,
  CopilotShutdownData,
  CopilotUsageBuckets,
} from '@/agents/plugins/copilot-cli/copilot-cli-event-types.js';

export const USAGE_REQUEST_EVENT_TYPE = 'agent.usage.request';

/** Stable across re-runs: the backend dedups on (type, session_id, event_id). */
export function stableEventId(type: string, sessionId: string, discriminator: string): string {
  return createHash('sha256').update(`${type}\0${sessionId}\0${discriminator}`).digest('hex').slice(0, 32);
}

/**
 * Copilot reports `inputTokens` as the TOTAL prompt (OpenAI convention, cache reads and writes
 * included); the backend's `input_tokens` is the non-cached part only. Same peel-off as
 * `readCopilotCli` in `src/cli/commands/analytics/cost/usage-readers.ts`: cache writes are
 * clamped to the fresh input they were written from.
 */
export function toBackendTokens(usage: CopilotUsageBuckets): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  thinking: number;
} {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const freshInput = Math.max(0, (usage.inputTokens ?? 0) - cacheRead);
  const cacheCreation = Math.min(usage.cacheWriteTokens ?? 0, freshInput);
  return {
    input: freshInput - cacheCreation,
    output: usage.outputTokens ?? 0,
    cacheRead,
    cacheCreation,
    thinking: usage.reasoningTokens ?? 0,
  };
}

/** Dotted Claude versions become dashed (`claude-sonnet-4.6` → `claude-sonnet-4-6`); other names pass through. */
export function resolveCopilotBillableModel(raw: string): string {
  return raw.startsWith('claude-') ? raw.replace(/(\d)\.(\d)/g, '$1-$2') : raw;
}

interface UsageRecordData {
  usage?: UsageRecordUsage;
}

interface UsageRecordUsage extends CopilotUsageBuckets {
  model?: string;
  apiCallId?: string;
  finishReason?: string;
  initiator?: string;
  duration?: number;
}

export interface UsageRowsResult {
  rows: Record<string, unknown>[];
  /** True when some usage could not be attributed or reconciled. */
  partial: boolean;
  /** Last model seen in the slice; seeds the next incremental slice. */
  lastModel?: string;
}

interface MessageRow {
  requestId: string;
  model: string;
  output: number;
  timestamp: string;
  segment: number;
}

function toRow(
  sessionId: string,
  requestId: string,
  rawModel: string,
  tokens: ReturnType<typeof toBackendTokens>,
  extra: { timestamp: string; stopReason: string; scope: 'main' | 'agent'; attached: boolean }
): Record<string, unknown> {
  return {
    type: USAGE_REQUEST_EVENT_TYPE,
    session_id: sessionId,
    request_id: requestId,
    message_id: '',
    model_raw: rawModel,
    model: resolveCopilotBillableModel(rawModel),
    input_tokens: tokens.input,
    cache_creation_5m_tokens: tokens.cacheCreation,
    cache_creation_1h_tokens: 0,
    cache_read_tokens: tokens.cacheRead,
    output_tokens: tokens.output,
    thinking_tokens: tokens.thinking,
    stop_reason: extra.stopReason,
    scope_kind: extra.scope,
    timestamp: extra.timestamp,
    event_id: stableEventId(USAGE_REQUEST_EVENT_TYPE, sessionId, requestId + (extra.attached ? ':final' : '')),
  };
}

const EMPTY_BUCKETS: CopilotUsageBuckets = {};

function subtract(total: CopilotUsageBuckets, prev: CopilotUsageBuckets): CopilotUsageBuckets {
  const diff = (a?: number, b?: number): number => Math.max(0, (a ?? 0) - (b ?? 0));
  return {
    inputTokens: diff(total.inputTokens, prev.inputTokens),
    outputTokens: diff(total.outputTokens, prev.outputTokens),
    cacheReadTokens: diff(total.cacheReadTokens, prev.cacheReadTokens),
    cacheWriteTokens: diff(total.cacheWriteTokens, prev.cacheWriteTokens),
    reasoningTokens: diff(total.reasoningTokens, prev.reasoningTokens),
  };
}

function hasTokens(b: CopilotUsageBuckets): boolean {
  return Object.values(b).some((v) => typeof v === 'number' && v > 0);
}

/**
 * Builds one `agent.usage.request` per API request.
 *
 * Tier A (`session.usage_record`, Copilot ≥ 1.0.92): one row per record, complete when written.
 * Tier B (segments without usage records): one row per `assistant.message`; on a `full` read
 * each shutdown segment's totals are attached to that segment's last message of the model.
 * An `incremental` read sends per-message rows only, without totals.
 */
export function buildUsageRows(
  sessionId: string,
  events: CopilotEvent[],
  mode: 'full' | 'incremental',
  initialModel?: string
): UsageRowsResult {
  let partial = false;
  const rows: Record<string, unknown>[] = [];

  const shutdownByModelBySegment: Array<CopilotShutdownData | undefined> = [];
  const segmentHasRecords: boolean[] = [];
  const shutdownTimestamps: string[] = [];
  const messages: MessageRow[] = [];
  const unlabelled: MessageRow[] = [];
  const records: Array<{ segment: number; row: Record<string, unknown> }> = [];

  let segment = 0;
  let currentModel: string | undefined = initialModel || undefined;
  for (const event of events) {
    const timestamp = event.timestamp ?? '';
    switch (event.type) {
      case 'session.model_change': {
        const next = (event.data as { newModel?: string } | undefined)?.newModel;
        if (next) currentModel = next;
        break;
      }
      case 'session.usage_record': {
        const data = (event.data ?? {}) as UsageRecordData & UsageRecordUsage;
        const usage: UsageRecordUsage = data.usage ?? data;
        if (!usage.apiCallId || !usage.model) break;
        segmentHasRecords[segment] = true;
        records.push({
          segment,
          row: toRow(sessionId, usage.apiCallId, usage.model, toBackendTokens(usage), {
            timestamp,
            stopReason: usage.finishReason ?? 'end_turn',
            scope: usage.initiator === 'sub-agent' ? 'agent' : 'main',
            attached: false,
          }),
        });
        break;
      }
      case 'assistant.message': {
        const data = (event.data ?? {}) as CopilotAssistantMessageData;
        const message: MessageRow = {
          requestId: data.messageId ?? `${sessionId}:msg:${event.id ?? messages.length}`,
          model: data.model ?? currentModel ?? '',
          output: typeof data.outputTokens === 'number' ? data.outputTokens : 0,
          timestamp,
          segment,
        };
        messages.push(message);
        // Remembered so the next incremental slice can label messages that omit `data.model`.
        if (data.model) currentModel = data.model;
        if (!message.model) unlabelled.push(message);
        break;
      }
      case 'session.shutdown': {
        shutdownByModelBySegment[segment] = (event.data ?? {}) as CopilotShutdownData;
        shutdownTimestamps[segment] = timestamp;
        segment += 1;
        break;
      }
      default:
        break;
    }
  }

  // Single-model backfill per segment, from that segment's own rollup.
  for (const message of unlabelled) {
    const models = Object.keys(shutdownByModelBySegment[message.segment]?.modelMetrics ?? {});
    if (models.length === 1) message.model = models[0];
  }

  for (const record of records) rows.push(record.row);

  const tierBMessages = messages.filter((m) => m.model && !segmentHasRecords[m.segment]);
  // A message that still has no model after backfill would otherwise vanish without a trace.
  if (messages.some((m) => !m.model && !segmentHasRecords[m.segment])) partial = true;
  // A trailing segment with Tier B messages and no shutdown (killed session) has no totals to reconcile.
  if (mode === 'full' && tierBMessages.some((m) => !shutdownByModelBySegment[m.segment])) partial = true;
  const lastByKey = new Map<string, number>();
  const tierBRows = tierBMessages.map((m, index) => {
    lastByKey.set(`${m.segment}|${m.model}`, index);
    return {
      message: m,
      tokens: { input: 0, output: m.output, cacheRead: 0, cacheCreation: 0, thinking: 0 },
      attached: false,
    };
  });

  if (mode === 'full') {
    partial = attachSegmentTotals({
      sessionId,
      messages,
      tierBRows,
      lastByKey,
      shutdowns: shutdownByModelBySegment,
      segmentHasRecords,
      shutdownTimestamps,
      rows,
    }) || partial;
  }

  for (const r of tierBRows) {
    rows.push(toRow(sessionId, r.message.requestId, r.message.model, r.tokens, {
      timestamp: r.message.timestamp,
      stopReason: 'end_turn',
      scope: 'main',
      attached: r.attached,
    }));
  }

  return { rows, partial, lastModel: currentModel };
}

interface AttachInput {
  sessionId: string;
  messages: MessageRow[];
  tierBRows: Array<{ message: MessageRow; tokens: ReturnType<typeof toBackendTokens>; attached: boolean }>;
  lastByKey: Map<string, number>;
  shutdowns: Array<CopilotShutdownData | undefined>;
  segmentHasRecords: boolean[];
  shutdownTimestamps: string[];
  rows: Record<string, unknown>[];
}

/** Classifies each shutdown segment (cumulative vs reset) and attaches its totals. Returns the partial flag. */
function attachSegmentTotals(input: AttachInput): boolean {
  let partial = false;
  let previous: CopilotShutdownData | undefined;

  input.shutdowns.forEach((shutdown, k) => {
    if (!shutdown) return;
    const prior = previous;
    previous = shutdown;
    if (input.segmentHasRecords[k]) return; // Tier A segments carry complete rows already

    for (const [model, metric] of Object.entries(shutdown.modelMetrics ?? {})) {
      if (!metric?.usage) continue;
      const count = metric.requests?.count ?? 0;
      const cumulativeMessages = input.messages.filter((m) => m.model === model && m.segment <= k).length;
      const segmentMessages = input.messages.filter((m) => m.model === model && m.segment === k);

      let totals: CopilotUsageBuckets;
      if (cumulativeMessages > 0 && count === cumulativeMessages) {
        totals = subtract(metric.usage, prior?.modelMetrics?.[model]?.usage ?? EMPTY_BUCKETS);
      } else if (count === segmentMessages.length || cumulativeMessages === 0) {
        totals = metric.usage;
      } else {
        partial = true;
        continue;
      }

      const lastIndex = input.lastByKey.get(`${k}|${model}`);
      if (lastIndex === undefined) {
        if (hasTokens(totals)) {
          const requestId = `${input.sessionId}:${model}:seg${k}`;
          input.rows.push(toRow(input.sessionId, requestId, model, toBackendTokens(totals), {
            timestamp: input.shutdownTimestamps[k] || new Date(0).toISOString(),
            stopReason: 'end_turn',
            scope: 'main',
            attached: false,
          }));
        }
        continue;
      }

      const target = input.tierBRows[lastIndex];
      const attached = toBackendTokens(totals);
      const outputSum = input.tierBRows
        .filter((r) => r.message.segment === k && r.message.model === model)
        .reduce((sum, r) => sum + r.tokens.output, 0);
      if (outputSum > attached.output) partial = true;
      target.tokens = {
        ...attached,
        output: target.tokens.output + Math.max(0, attached.output - outputSum),
      };
      target.attached = true;
    }
  });
  return partial;
}
