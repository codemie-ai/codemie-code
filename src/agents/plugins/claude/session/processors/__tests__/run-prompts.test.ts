/**
 * Unit tests for the per-run named-invocation collection (EPMCDME-15557): the run only sees a
 * slice of the messages, so the set of failed tool calls has to come from the full session.
 */
import { describe, it, expect } from 'vitest';
import { collectRunPromptsAndInvocations } from '../run-prompts.js';
import type { ToolOutcome } from '../../claude-named-invocations.js';

const deniedTaskCall = {
  uuid: 'a1',
  type: 'assistant',
  message: {
    role: 'assistant',
    id: 'msg-a1',
    content: [{ type: 'tool_use', id: 'tool-1', name: 'Task', input: { subagent_type: 'Explore' } }],
  },
};

// The denying result sits after the slice the run counts (lastEmittedIndex = 0).
const deniedResult = {
  uuid: 'u1',
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'QA-15557 deny', is_error: true }],
  },
};

function collect(
  toolOutcomes: ReadonlyMap<string, ToolOutcome>,
  {
    messages = [deniedTaskCall, deniedResult],
    finalPass = false,
    lastEmittedIndex = 0,
    lastProcessedMsgIndex = -1,
    emittedGroupLines = [deniedTaskCall] as unknown[],
  } = {}
) {
  return collectRunPromptsAndInvocations(messages, new Map(), {
    sessionId: 's',
    processedIds: new Set<string>(),
    attachedUserPrompts: new Set<string>(),
    lastProcessedMsgIndex,
    lastEmittedIndex,
    emittedDeltas: true,
    finalPass,
    namedOnly: true,
    toolOutcomes,
    emittedGroupLines: emittedGroupLines as never,
  });
}

describe('collectRunPromptsAndInvocations — failed and pending tool calls', () => {
  it('excludes a denied Agent call whose result is outside the processed slice', () => {
    expect(collect(new Map([['tool-1', 'failed']])).named.agentInvocations).toEqual({});
  });

  it('counts the same call when the full-session outcomes say its result succeeded', () => {
    expect(collect(new Map([['tool-1', 'ok']])).named.agentInvocations).toEqual({ Explore: 1 });
  });

  it('does not count a call still unresolved on the final pass, which nothing could correct later', () => {
    const out = collect(new Map(), {
      messages: [deniedTaskCall],
      finalPass: true,
      lastEmittedIndex: -1,
      emittedGroupLines: [],
    });
    expect(out.named.agentInvocations).toEqual({});
  });

  it('counts a call from a group this run emitted even when the group lies before the run slice', () => {
    const laterGroup = { uuid: 'a2', type: 'assistant', message: { role: 'assistant', id: 'msg-a2', content: [{ type: 'text', text: 'done' }] } };
    const out = collect(new Map([['tool-1', 'ok']]), {
      messages: [deniedTaskCall, laterGroup, deniedResult],
      lastProcessedMsgIndex: 1,
      lastEmittedIndex: 1,
      emittedGroupLines: [deniedTaskCall],
    });
    expect(out.named.agentInvocations).toEqual({ Explore: 1 });
  });

  it('does not count a call whose group this run did not emit, even if its result succeeded and it lies in the slice', () => {
    const out = collect(new Map([['tool-1', 'ok']]), { emittedGroupLines: [] });
    expect(out.named.agentInvocations).toEqual({});
  });
});
