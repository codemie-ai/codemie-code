import { describe, expect, it } from 'vitest';
import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import { synthesizeRawSession } from '../native-loader.js';

const descriptor = { sessionId: 'root', filePath: '/sanitized/root.jsonl', createdAt: 1000, agentName: 'claude' };
const row = (timestamp: string, content = 'activity') => ({ type: 'user', timestamp, message: { role: 'user', content } });

describe('native Claude family timing regressions', () => {
  it('CR-013 reduces a family larger than the JavaScript argument limit', () => {
    const parsed: ParsedSession = { sessionId: 'root', agentName: 'claude', metadata: {}, messages: [row('2026-09-15T01:00:00Z')],
      subagents: Array.from({ length: 4 }, (_, index) => ({
        agentId: `child-${index}`, filePath: `/sanitized/child-${index}.jsonl`,
        messages: Array.from({ length: 50_000 }, () => row('2026-09-15T02:00:00Z')),
      })),
    };
    const raw = synthesizeRawSession('claude', descriptor, parsed);
    expect(raw.startEvent?.data.startTime).toBe(Date.parse('2026-09-15T01:00:00Z'));
    expect(raw.endEvent?.data.endTime).toBe(Date.parse('2026-09-15T02:00:00Z'));
  });

  it('CR-014 keeps the post-clear start while extending to child activity', () => {
    const parsed: ParsedSession = { sessionId: 'root', agentName: 'claude', metadata: {}, messages: [
      row('2026-09-15T00:00:00Z', 'old'), row('2026-09-15T01:00:00Z', '<command-name>/clear</command-name>'), row('2026-09-15T02:00:00Z', 'new'),
    ], subagents: [{ agentId: 'child', filePath: '/sanitized/child.jsonl', messages: [row('2026-09-15T03:00:00Z')] }] };
    const raw = synthesizeRawSession('claude', descriptor, parsed);
    expect(raw.startEvent?.data.startTime).toBe(Date.parse('2026-09-15T02:00:00Z'));
    expect(raw.endEvent?.data.endTime).toBe(Date.parse('2026-09-15T03:00:00Z'));
    expect(parsed.messages).toHaveLength(3);
  });
});
