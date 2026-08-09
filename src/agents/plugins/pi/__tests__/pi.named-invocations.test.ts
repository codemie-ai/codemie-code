/**
 * Pi named-invocation extraction.
 *
 * The signals are deliberately narrow: Pi expands prompt templates into plain user text
 * before persisting them, so no regex over the transcript can recover a `/command`. The
 * tests below pin that boundary as much as they pin what is extracted.
 *
 * @group unit
 */

import { describe, it, expect } from 'vitest';
import { extractPiNamedInvocations, parseSkillWrapper } from '../session/pi-named-invocations.js';

function userEntry(id: string, content: unknown): Record<string, unknown> {
  return { type: 'message', id, parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content, timestamp: 1 } };
}

function subagentCall(id: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'assistant',
      timestamp: 1,
      content: [{ type: 'toolCall', id: `call-${id}`, name: 'subagent', arguments: args }],
    },
  };
}

/**
 * A skill expansion exactly as Pi writes it (`_expandSkillCommand`): the block alone when
 * the `/skill:<name>` call carried no arguments, `block\n\nargs` when it did.
 */
function skillBlock(name: string, trailing = 'do the thing', body = 'Instructions.'): string {
  const block = `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\n${body}\n</skill>`;
  return trailing ? `${block}\n\n${trailing}` : block;
}

describe('parseSkillWrapper', () => {
  it('splits the wrapper name from the prompt the user actually typed', () => {
    expect(parseSkillWrapper(skillBlock('brainstorming'))).toEqual({
      name: 'brainstorming',
      rest: 'do the thing',
    });
  });

  it('returns the text unchanged when there is no wrapper', () => {
    expect(parseSkillWrapper('just a prompt')).toEqual({ rest: 'just a prompt' });
  });

  it('does not match a wrapper that only appears mid-text', () => {
    const quoted = `See below:\n${skillBlock('docs')}`;
    expect(parseSkillWrapper(quoted)).toEqual({ rest: quoted });
  });

  it('yields an empty rest for a message that is nothing but the wrapper', () => {
    const { name, rest } = parseSkillWrapper(skillBlock('review', ''));
    expect(name).toBe('review');
    expect(rest).toBe('');
  });

  // A skill file that documents Pi's own wrapper carries `</skill>` lines in its body. The
  // parser must reach the LAST one whatever follows the inner one, because `rest` is
  // uploaded verbatim as the user's prompt and titles the analytics session. Both spacings
  // are pinned: a lazy left-to-right match stops at the inner `</skill>` whenever the text
  // after it happens to be well-formed, which a blank line makes it.
  it.each([
    ['a non-blank line', ['A skill that documents Pi\'s own format:', '</skill>', 'SECRET-BODY-LINE']],
    ['a blank line', ['A skill that documents Pi\'s own format:', '</skill>', '', 'SECRET-BODY-LINE']],
  ])('does not leak a skill body whose inner </skill> is followed by %s', (_spacing, lines) => {
    const { name, rest } = parseSkillWrapper(skillBlock('pi-format', 'summarise it', lines.join('\n')));

    expect(name).toBe('pi-format');
    expect(rest).toBe('summarise it');
  });

  it('does not leak a skill body when the invocation carried no arguments at all', () => {
    // Same body, no user text after the wrapper: there is nothing legitimate to report, so
    // the whole block must collapse to an empty prompt.
    const body = ['A skill that documents Pi\'s own format:', '</skill>', '', 'SECRET-BODY-LINE'].join('\n');
    const { name, rest } = parseSkillWrapper(skillBlock('pi-format', '', body));

    expect(name).toBe('pi-format');
    expect(rest).toBe('');
  });

  it('drops the text rather than returning a body it could not parse', () => {
    // A wrapper opening Pi alone writes, with a shape this parser does not recognise.
    const drifted = '<skill name="pi-format" location="/skills/pi-format/SKILL.md">\nSECRET-BODY-LINE\n</SKILL>';

    expect(parseSkillWrapper(drifted)).toEqual({ rest: '' });
  });
});

describe('extractPiNamedInvocations', () => {
  it('counts skill wrappers by name across string and block content', () => {
    const { skillInvocations } = extractPiNamedInvocations([
      userEntry('u1', skillBlock('review')),
      userEntry('u2', [{ type: 'text', text: skillBlock('review') }]),
      userEntry('u3', [{ type: 'text', text: skillBlock('brainstorming') }]),
    ]);

    expect(skillInvocations).toEqual({ review: 2, brainstorming: 1 });
  });

  it('counts a subagent tool call under its agent argument', () => {
    const { agentInvocations } = extractPiNamedInvocations([
      subagentCall('a1', { agent: 'code-reviewer', task: 'review the diff' }),
      subagentCall('a2', { agent: 'code-reviewer', task: 'review again' }),
      subagentCall('a3', { agent: 'tech-analyst', task: 'research' }),
    ]);

    expect(agentInvocations).toEqual({ 'code-reviewer': 2, 'tech-analyst': 1 });
  });

  it('accepts the defensive nested toolCall wrapper', () => {
    const nested = {
      type: 'message',
      id: 'a1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        timestamp: 1,
        content: [{ type: 'toolCall', toolCall: { id: 'c1', name: 'subagent', arguments: { agent: 'planner' } } }],
      },
    };

    expect(extractPiNamedInvocations([nested]).agentInvocations).toEqual({ planner: 1 });
  });

  it('ignores management calls, whose agent names a record rather than a child', () => {
    const { agentInvocations } = extractPiNamedInvocations([
      subagentCall('a1', { action: 'get', agent: 'code-reviewer' }),
      subagentCall('a2', { action: 'status', id: 'run-1' }),
      subagentCall('a3', { action: 'schedule.run', id: 'sched-1' }),
    ]);

    expect(agentInvocations).toEqual({});
  });

  it('counts schedule.create, which arms a deferred launch rather than managing a record', () => {
    const { agentInvocations } = extractPiNamedInvocations([
      subagentCall('a1', { action: 'schedule.create', at: '+10m', agent: 'nightly-auditor', task: 'audit' }),
      subagentCall('a2', {
        action: 'schedule.create',
        every: '6h',
        name: 'housekeeping',
        workflowScript: 'await runs.run("sweep", { agent: "janitor", task });',
      }),
    ]);

    // `name` is the schedule's display label, never an agent, so it must not be counted.
    expect(agentInvocations).toEqual({ 'nightly-auditor': 1, janitor: 1 });
  });

  it('counts each launch site of a workflowScript, which is opaque JavaScript', () => {
    const workflowScript = [
      'const a = await runs.run("plan", { agent: "planner", task: task });',
      'await runs.all([{ agent: \'builder\', task: a }, { agent: "builder", task: a }]);',
    ].join('\n');

    expect(extractPiNamedInvocations([subagentCall('a1', { workflowScript })]).agentInvocations).toEqual({
      planner: 1,
      builder: 2,
    });
  });

  it('invents no name from a prompt that merely looks like a command', () => {
    // Pi expands a prompt template into plain user text before persisting it, so neither
    // the literal `/review` nor its expansion may be turned into a skill or agent name.
    // Commands are counted from the run ledger instead; see the module comment.
    const { skillInvocations, agentInvocations } = extractPiNamedInvocations([
      userEntry('u1', '/review the staged changes'),
      userEntry('u2', '/skill:review'),
      userEntry('u3', 'Review the staged changes (`git diff --cached`). Focus on: bugs'),
    ]);

    expect(skillInvocations).toEqual({});
    expect(agentInvocations).toEqual({});
  });

  it('skips the roles no guard claims, including the two that carry conversation text', () => {
    // These must fall through rather than be mistaken for a user or assistant message: the
    // summaries embed prior conversation content verbatim, so a skill wrapper quoted inside
    // one is a quotation, not an invocation.
    const unclaimedRoles = [
      { role: 'compactionSummary', summary: skillBlock('review'), tokensBefore: 10, timestamp: 1 },
      { role: 'branchSummary', summary: skillBlock('review'), fromId: 'e1', timestamp: 1 },
      { role: 'custom', customType: 'notice', content: skillBlock('review'), display: true, timestamp: 1 },
    ];
    const entries = unclaimedRoles.map((message, index) => ({
      type: 'message',
      id: `c${index}`,
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message,
    }));

    expect(extractPiNamedInvocations(entries)).toEqual({
      skillInvocations: {},
      agentInvocations: {},
      commandInvocations: {},
    });
  });

  it('ignores non-subagent tools and malformed entries', () => {
    const result = extractPiNamedInvocations([
      null,
      'not an entry',
      { type: 'model_change', id: 'm1', modelId: 'gpt-5' },
      {
        type: 'message',
        id: 'a1',
        message: { role: 'assistant', timestamp: 1, content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }] },
      },
      subagentCall('a2', { agent: '   ' }),
    ]);

    expect(result).toEqual({ skillInvocations: {}, agentInvocations: {}, commandInvocations: {} });
  });
});
