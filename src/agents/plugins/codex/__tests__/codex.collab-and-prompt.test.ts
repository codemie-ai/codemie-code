import { describe, it, expect } from 'vitest';
import { isCodexInjectedUserText, firstCodexUserText } from '../session/codex-user-prompt.js';
import { collectCodexChildThreadIds, extractCodexSpawnLinks } from '../session/codex-collab-links.js';

describe('isCodexInjectedUserText', () => {
  it('flags AGENTS.md and environment injections', () => {
    expect(isCodexInjectedUserText('# AGENTS.md instructions for /repo')).toBe(true);
    expect(isCodexInjectedUserText('<environment_context>\n  <cwd>/repo</cwd>')).toBe(true);
    expect(isCodexInjectedUserText("let's run explore subagent")).toBe(false);
  });
});

describe('firstCodexUserText', () => {
  it('skips injected blocks and returns the first real user_message', () => {
    const records = [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>' },
            { type: 'input_text', text: '<environment_context>\n  <cwd>/repo</cwd>' },
          ],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: "let's run explore subagent and explain providers" },
      },
    ];
    expect(firstCodexUserText(records)).toBe("let's run explore subagent and explain providers");
  });
});

describe('collectCodexChildThreadIds', () => {
  it('includes thread ids from wait_agent targets', () => {
    const records = [
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait_agent',
          call_id: 'wait1',
          arguments: '{"targets":["child-thread-uuid"]}',
        },
      },
    ];
    expect([...collectCodexChildThreadIds(records)]).toEqual(['child-thread-uuid']);
  });
});

describe('extractCodexSpawnLinks', () => {
  it('pairs spawn_agent with wait_agent function_call_output', () => {
    const records = [
      { timestamp: '2026-06-23T10:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn1', arguments: '{"agent_type":"explorer"}' } },
      { timestamp: '2026-06-23T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn2', arguments: '{"agent_type":"explorer"}' } },
      { timestamp: '2026-06-23T10:00:10.000Z', type: 'response_item', payload: { type: 'function_call', name: 'wait_agent', call_id: 'wait1', arguments: '{"targets":["child-thread-uuid"]}' } },
      { timestamp: '2026-06-23T10:00:46.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'wait1', output: 'done' } },
    ];
    const links = extractCodexSpawnLinks(records);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      spawnCallId: 'spawn2',
      threadId: 'child-thread-uuid',
      agentType: 'explorer',
    });
    expect(links[0].waitEnd).toBe(Date.parse('2026-06-23T10:00:46.000Z'));
  });
});
