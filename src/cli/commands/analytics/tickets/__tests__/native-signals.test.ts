import { describe, it, expect } from 'vitest';
import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import { readNativeSignals } from '../native-signals.js';

function parsed(messages: unknown[]): ParsedSession {
  return { sessionId: 's1', agentName: 'claude', metadata: {}, messages } as ParsedSession;
}

function prompts(messages: unknown[]): string[] {
  return readNativeSignals('claude', parsed(messages)).rows.flatMap((r) => (r.prompt ? [r.prompt.trim()] : []));
}

describe('readNativeSignals (Claude)', () => {
  it('reads only text the user typed', () => {
    const user = (extra: Record<string, unknown>, content: unknown = 'typed CAKE-1') => ({ type: 'user', message: { role: 'user', content }, ...extra });
    expect(prompts([
      user({}),
      user({ isMeta: true }, 'injected skill NUTLA-1'),
      user({ isCompactSummary: true }, 'summary of CAKE-9'),
      user({ isSidechain: true }, 'subagent prompt CAKE-8'),
      user({}, [{ type: 'tool_result', content: 'CAKE-7' }]),
    ])).toEqual(['typed CAKE-1']);
  });

  it('strips slash-command plumbing and local command output but keeps the typed arguments', () => {
    const content = '<command-message>pm</command-message><command-name>/pm</command-name><command-args>plan CAKE-5</command-args>';
    expect(prompts([{ type: 'user', message: { role: 'user', content } }])).toEqual(['<command-args>plan CAKE-5</command-args>']);
    expect(prompts([{ type: 'user', message: { role: 'user', content: '<local-command-stdout>NUTLA-1 done</local-command-stdout>' } }])).toEqual([]);
  });

  it('keeps the branch of rows that carry no prompt', () => {
    const { rows } = readNativeSignals('claude', parsed([{ type: 'assistant', uuid: 'a1', gitBranch: 'feature/CAKE-3' }]));
    expect(rows).toEqual([{ key: 'claude:a1', ts: null, branch: 'feature/CAKE-3' }]);
  });
});
