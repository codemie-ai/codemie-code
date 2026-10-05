import { describe, it, expect } from 'vitest';
import { computeEventId } from '../event-id.js';

describe('computeEventId', () => {
  describe('existing hook event types', () => {
    it('returns the byte-offset formula for an existing-event type', () => {
      expect(computeEventId('agent.session.start', 'sid1', { byteOffset: 42 })).toBe(
        'sid1:agent.session.start:42'
      );
    });

    it('returns a different id for a different byte offset', () => {
      const first = computeEventId('agent.session.stop', 'sid1', { byteOffset: 0 });
      const second = computeEventId('agent.session.stop', 'sid1', { byteOffset: 128 });
      expect(first).not.toBe(second);
      expect(first).toBe('sid1:agent.session.stop:0');
      expect(second).toBe('sid1:agent.session.stop:128');
    });
  });

  describe('agent.usage.request', () => {
    it('returns the request/model-keyed formula', () => {
      expect(
        computeEventId('agent.usage.request', 'sid1', { request_id: 'req1', model: 'gpt-4' })
      ).toBe('sid1:agent.usage.request:req1:gpt-4');
    });
  });

  describe('agent.subagent.usage', () => {
    it('returns the tool_use_id-keyed formula', () => {
      expect(computeEventId('agent.subagent.usage', 'sid1', { tool_use_id: 'tu1' })).toBe(
        'sid1:agent.subagent.usage:tu1'
      );
    });
  });

  describe('agent.session.summary', () => {
    it('returns the phase-keyed formula', () => {
      expect(computeEventId('agent.session.summary', 'sid1', { phase: 'end' })).toBe(
        'sid1:agent.session.summary:end'
      );
    });
  });
});
