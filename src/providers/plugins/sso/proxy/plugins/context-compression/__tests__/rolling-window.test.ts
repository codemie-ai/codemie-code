import { describe, it, expect } from 'vitest';
import { findToolUnits } from '../transforms/rolling-window.js';
import type { ICMMessage } from '../transforms/icm.js';

describe('findToolUnits', () => {
  it('pairs assistant tool_calls with following tool responses', () => {
    const messages: ICMMessage[] = [
      { role: 'user', content: 'run the search' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
      { role: 'tool', content: 'search results here', tool_call_id: 'tc1' },
      { role: 'user', content: 'thank you' },
    ];

    const units = findToolUnits(messages);
    expect(units).toHaveLength(1);
    expect(units[0].assistantIdx).toBe(1);
    expect(units[0].responseIndices).toContain(2);
  });

  it('returns empty array for conversations without tool calls', () => {
    const messages: ICMMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const units = findToolUnits(messages);
    expect(units).toHaveLength(0);
  });

  it('handles multiple tool calls in one assistant turn', () => {
    const messages: ICMMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'tc2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'result a', tool_call_id: 'tc1' },
      { role: 'tool', content: 'result b', tool_call_id: 'tc2' },
    ];
    const units = findToolUnits(messages);
    expect(units).toHaveLength(1);
    expect(units[0].responseIndices).toContain(1);
    expect(units[0].responseIndices).toContain(2);
  });
});
