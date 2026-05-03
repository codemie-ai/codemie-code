import type { ICMMessage } from './icm.js';

export interface ToolUnit {
  assistantIdx: number;
  responseIndices: number[];
}

export function findToolUnits(messages: ICMMessage[]): ToolUnit[] {
  const units: ToolUnit[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;

    const toolCalls = msg['tool_calls'] as Array<{ id: string }> | undefined;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;

    const callIds = new Set(toolCalls.map(tc => tc.id));
    const responseIndices: number[] = [];

    for (let j = i + 1; j < messages.length; j++) {
      const r = messages[j];
      if (r.role !== 'tool') break;
      const toolCallId = r['tool_call_id'] as string | undefined;
      if (toolCallId && callIds.has(toolCallId)) {
        responseIndices.push(j);
      }
    }

    if (responseIndices.length > 0) {
      units.push({ assistantIdx: i, responseIndices });
    }
  }

  return units;
}

export function getToolUnitIndices(units: ToolUnit[]): Set<number> {
  const indices = new Set<number>();
  for (const u of units) {
    indices.add(u.assistantIdx);
    for (const idx of u.responseIndices) indices.add(idx);
  }
  return indices;
}
