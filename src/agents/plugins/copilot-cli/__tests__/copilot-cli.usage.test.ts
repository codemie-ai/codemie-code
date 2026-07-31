/**
 * Copilot CLI token-extraction unit tests.
 *
 * Figures reflect Copilot CLI 1.0.x on-disk shapes, taken from a real transcript.
 */

import { describe, it, expect } from 'vitest';
import { extractCopilotUsage } from '../copilot-cli.usage.js';
import type { CopilotEvent } from '../copilot-cli-event-types.js';

/** A representative mixed-model session (gpt-5.2 + claude-sonnet-4.5). */
const shutdownEvent: CopilotEvent = {
  type: 'session.shutdown',
  data: {
    shutdownType: 'routine',
    totalPremiumRequests: 3,
    modelMetrics: {
      'gpt-5.2': {
        requests: { count: 374, cost: 3 },
        usage: {
          inputTokens: 14076695,
          outputTokens: 173180,
          cacheReadTokens: 13694976,
          cacheWriteTokens: 0,
          reasoningTokens: 90359,
        },
      },
      'claude-sonnet-4.5': {
        requests: { count: 60, cost: 0 },
        usage: {
          inputTokens: 1654378,
          outputTokens: 27215,
          cacheReadTokens: 1504366,
          cacheWriteTokens: 125660,
          reasoningTokens: 0,
        },
      },
    },
  },
};

function turn(model: string, outputTokens: number): CopilotEvent {
  return { type: 'assistant.message', data: { model, outputTokens } };
}

describe('extractCopilotUsage — tier 1 (session.shutdown)', () => {
  it('returns raw per-model buckets and premium requests', () => {
    const result = extractCopilotUsage([{ type: 'session.start', data: {} }, shutdownEvent]);

    expect(result.partial).toBe(false);
    expect(result.premiumRequests).toBe(3);
    expect(result.messages).toHaveLength(2);

    const gpt = result.messages.find((m) => m.model === 'gpt-5.2')!;
    expect(gpt.usage.inputTokens).toBe(14076695);
    expect(gpt.usage.cacheReadTokens).toBe(13694976);
    expect(gpt.usage.reasoningTokens).toBe(90359);
    expect(gpt.requests).toBe(374);

    const claude = result.messages.find((m) => m.model === 'claude-sonnet-4.5')!;
    expect(claude.usage.cacheWriteTokens).toBe(125660);
    expect(claude.requests).toBe(60);
  });

  it('treats requests.cost 0 as real data rather than missing', () => {
    const result = extractCopilotUsage([shutdownEvent]);
    expect(result.premiumRequests).toBe(3);
    expect(result.unavailableReason).toBeUndefined();
  });

  it('emits buckets verbatim so the reader owns the convention conversion', () => {
    const result = extractCopilotUsage([shutdownEvent]);
    const gpt = result.messages.find((m) => m.model === 'gpt-5.2')!;
    // NOT decomposed here — inputTokens is still Copilot's cache-inclusive total.
    expect(gpt.usage.inputTokens).toBe(14076695);
  });
});

describe('extractCopilotUsage — tier 2 (per-turn fallback)', () => {
  it('reconstructs per-model output tokens and marks the result partial', () => {
    const result = extractCopilotUsage([
      { type: 'session.start', data: {} },
      turn('gpt-5.2', 100),
      turn('gpt-5.2', 250),
      turn('claude-sonnet-4.5', 40),
    ]);

    expect(result.partial).toBe(true);

    const gpt = result.messages.find((m) => m.model === 'gpt-5.2')!;
    expect(gpt.usage.outputTokens).toBe(350);
    expect(gpt.requests).toBe(2);
    expect(gpt.usage.inputTokens ?? 0).toBe(0); // unrecoverable per turn
    expect(gpt.partial).toBe(true);

    const claude = result.messages.find((m) => m.model === 'claude-sonnet-4.5')!;
    expect(claude.usage.outputTokens).toBe(40);
    expect(claude.requests).toBe(1);
  });

  it('prefers shutdown over per-turn when both are present', () => {
    const result = extractCopilotUsage([turn('gpt-5.2', 999), shutdownEvent]);
    expect(result.partial).toBe(false);
    expect(result.messages.find((m) => m.model === 'gpt-5.2')!.usage.outputTokens).toBe(173180);
  });

  it('uses the last shutdown when a resumed session records more than one', () => {
    const second: CopilotEvent = {
      type: 'session.shutdown',
      data: {
        totalPremiumRequests: 5,
        modelMetrics: {
          'gpt-5.2': { requests: { count: 2 }, usage: { inputTokens: 10, outputTokens: 2 } },
        },
      },
    };

    const result = extractCopilotUsage([shutdownEvent, second]);

    expect(result.premiumRequests).toBe(5);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].usage.inputTokens).toBe(10);
  });

  it('falls back to per-turn when a shutdown carries no modelMetrics', () => {
    const empty: CopilotEvent = { type: 'session.shutdown', data: { totalPremiumRequests: 1 } };
    const result = extractCopilotUsage([empty, turn('gpt-5.2', 77)]);

    expect(result.partial).toBe(true);
    expect(result.messages[0].usage.outputTokens).toBe(77);
    expect(result.premiumRequests).toBe(1);
  });
});

/**
 * Tier 2 exists for CLI builds that never write session.shutdown — and those are exactly
 * the builds that also omit per-turn `model`. Requiring `model` on the message made the
 * fallback unreachable where it was needed, so those sessions were reported as having no
 * telemetry even though their output tokens were sitting in the transcript.
 */
describe('extractCopilotUsage — tier 2 model recovery on older builds', () => {
  it('attributes unlabelled turns to the model in effect from session.model_change', () => {
    const result = extractCopilotUsage([
      { type: 'session.model_change', data: { newModel: 'gpt-5.2' } },
      { type: 'assistant.message', data: { outputTokens: 100 } },
      { type: 'assistant.message', data: { outputTokens: 250 } },
    ]);

    expect(result.partial).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].model).toBe('gpt-5.2');
    expect(result.messages[0].usage.outputTokens).toBe(350);
    expect(result.messages[0].requests).toBe(2);
  });

  it('follows a mid-session model switch', () => {
    const result = extractCopilotUsage([
      { type: 'session.model_change', data: { newModel: 'gpt-5.2' } },
      { type: 'assistant.message', data: { outputTokens: 10 } },
      { type: 'session.model_change', data: { previousModel: 'gpt-5.2', newModel: 'claude-sonnet-4.6' } },
      { type: 'assistant.message', data: { outputTokens: 20 } },
    ]);

    const byModel = Object.fromEntries(result.messages.map((m) => [m.model, m.usage.outputTokens]));
    expect(byModel).toEqual({ 'gpt-5.2': 10, 'claude-sonnet-4.6': 20 });
  });

  it('still prefers an explicit per-turn model over the tracked one', () => {
    const result = extractCopilotUsage([
      { type: 'session.model_change', data: { newModel: 'gpt-5.2' } },
      { type: 'assistant.message', data: { model: 'claude-sonnet-4.5', outputTokens: 7 } },
    ]);

    expect(result.messages[0].model).toBe('claude-sonnet-4.5');
  });

  it('leaves turns unattributed when no model signal exists at all', () => {
    const result = extractCopilotUsage([{ type: 'assistant.message', data: { outputTokens: 5 } }]);
    expect(result.messages).toEqual([]);
    expect(result.unavailableReason).toBeTruthy();
  });
});

describe('extractCopilotUsage — tier 3 (no usage data)', () => {
  it('returns empty with a reason when no usage events exist', () => {
    const result = extractCopilotUsage([
      { type: 'session.start', data: {} },
      { type: 'user.message', data: {} },
    ]);

    expect(result.messages).toEqual([]);
    expect(result.partial).toBe(false);
    expect(result.unavailableReason).toBeTruthy();
  });

  it('ignores assistant.message events that carry no outputTokens', () => {
    const result = extractCopilotUsage([{ type: 'assistant.message', data: { model: 'gpt-5.2' } }]);
    expect(result.messages).toEqual([]);
    expect(result.unavailableReason).toBeTruthy();
  });

  it('ignores assistant.message events that carry no model', () => {
    const result = extractCopilotUsage([{ type: 'assistant.message', data: { outputTokens: 10 } }]);
    expect(result.messages).toEqual([]);
  });

  it('handles an empty event list', () => {
    const result = extractCopilotUsage([]);
    expect(result.messages).toEqual([]);
    expect(result.unavailableReason).toBeTruthy();
  });
});
