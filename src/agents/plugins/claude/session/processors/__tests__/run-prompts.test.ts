/**
 * Unit tests for the per-run named-invocation collection (EPMCDME-15557): the run only sees a
 * slice of the messages, so the set of failed tool calls has to come from the full session.
 */
import { describe, it, expect } from 'vitest';
import { collectRunPromptsAndInvocations } from '../run-prompts.js';

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

function collect(failedToolUseIds: ReadonlySet<string>) {
  return collectRunPromptsAndInvocations([deniedTaskCall, deniedResult], new Map(), {
    sessionId: 's',
    processedIds: new Set<string>(),
    attachedUserPrompts: new Set<string>(),
    lastProcessedMsgIndex: -1,
    lastEmittedIndex: 0,
    emittedDeltas: true,
    finalPass: false,
    namedOnly: true,
    failedToolUseIds,
  });
}

describe('collectRunPromptsAndInvocations — failed tool calls', () => {
  it('excludes a denied Agent call whose result is outside the processed slice', () => {
    expect(collect(new Set(['tool-1'])).named.agentInvocations).toEqual({});
  });

  it('counts the same call when the full-session failed set does not list it', () => {
    expect(collect(new Set()).named.agentInvocations).toEqual({ Explore: 1 });
  });
});
