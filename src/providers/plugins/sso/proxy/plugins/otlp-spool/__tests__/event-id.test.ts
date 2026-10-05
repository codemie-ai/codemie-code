import { describe, it, expect } from 'vitest';
import { resolveEventId } from '../event-id.js';

describe('resolveEventId', () => {
  describe('existing hook event types', () => {
    it('returns the byte-offset formula for an existing-event type', () => {
      expect(resolveEventId('agent.session.start', 'sid1', { byteOffset: 42 })).toBe(
        'sid1:agent.session.start:42'
      );
    });

    it('returns a different id for a different byte offset', () => {
      const first = resolveEventId('agent.session.stop', 'sid1', { byteOffset: 0 });
      const second = resolveEventId('agent.session.stop', 'sid1', { byteOffset: 128 });
      expect(first).not.toBe(second);
      expect(first).toBe('sid1:agent.session.stop:0');
      expect(second).toBe('sid1:agent.session.stop:128');
    });
  });

  describe('agent.usage.request', () => {
    it('returns the request/model-keyed formula', () => {
      expect(
        resolveEventId('agent.usage.request', 'sid1', { request_id: 'req1', model: 'gpt-4' })
      ).toBe('sid1:agent.usage.request:req1:gpt-4');
    });
  });

  describe('agent.subagent.usage', () => {
    it('returns the tool_use_id-keyed formula', () => {
      expect(resolveEventId('agent.subagent.usage', 'sid1', { tool_use_id: 'tu1' })).toBe(
        'sid1:agent.subagent.usage:tu1'
      );
    });

    it('falls back to agent_id when tool_use_id is absent', () => {
      expect(
        resolveEventId('agent.subagent.usage', 'sid1', { tool_use_id: '', agent_id: 'agent-1' })
      ).toBe('sid1:agent.subagent.usage:agent-1');
    });

    it('keeps two top-level subagents (no tool_use_id each) from colliding when agent_id differs', () => {
      const first = resolveEventId('agent.subagent.usage', 'sid1', { agent_id: 'agent-1' });
      const second = resolveEventId('agent.subagent.usage', 'sid1', { agent_id: 'agent-2' });
      expect(first).not.toBe(second);
    });
  });

  describe('agent.session.summary', () => {
    it('returns the phase-keyed formula', () => {
      expect(resolveEventId('agent.session.summary', 'sid1', { phase: 'end' })).toBe(
        'sid1:agent.session.summary:end'
      );
    });
  });
});
