import { describe, it, expect, afterEach } from 'vitest';
import { gateDecision } from '../completeness-gate.js';
import { hooksOnlyWaitTicks } from '../spool-config.js';
import { createStatus } from '../session-status.js';
import type { SpoolState, StreamState } from '../spool-state.js';

const stream = (size: number): StreamState => ({ exists: size > 0, size, cursor: 0, mtimeMs: size > 0 ? 1 : null });

function spool(data: { hooks?: number; logs?: number }): SpoolState {
  return {
    sessionId: 's1',
    streams: {
      hooks: stream(data.hooks ?? 0),
      logs: stream(data.logs ?? 0),
      metrics: stream(0),
      traces: stream(0),
    },
    latestWriteMs: null,
  };
}

const statusWith = (waitTicks: number) => ({ ...createStatus(), waitTicks });

describe('gateDecision', () => {
  const original = process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD;
    }
    else process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD = original;
  });

  it('sends when hooks and OTEL are both present', () => {
    expect(gateDecision(spool({ hooks: 1, logs: 1 }), statusWith(0))).toBe('send');
  });

  it('is a noop when neither group is present', () => {
    expect(gateDecision(spool({}), statusWith(0))).toBe('noop');
  });

  it('waits for OTEL-only sessions below the limit and skips at the limit', () => {
    const limit = hooksOnlyWaitTicks();
    expect(gateDecision(spool({ logs: 1 }), statusWith(limit - 1))).toBe('wait');
    expect(gateDecision(spool({ logs: 1 }), statusWith(limit))).toBe('skip');
  });

  it('never sends OTEL-only data, for any waitTicks and hooks-only setting', () => {
    for (const setting of ['true', 'false']) {
      process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD = setting;
      for (let ticks = 0; ticks < 50; ticks++) {
        expect(['wait', 'skip']).toContain(gateDecision(spool({ logs: 1 }), statusWith(ticks)));
      }
    }
  });

  it('keeps the hooks-only behavior', () => {
    const limit = hooksOnlyWaitTicks();
    process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD = 'true';
    expect(gateDecision(spool({ hooks: 1 }), statusWith(limit - 1))).toBe('wait');
    expect(gateDecision(spool({ hooks: 1 }), statusWith(limit))).toBe('hooks-only-force');
  });
});
