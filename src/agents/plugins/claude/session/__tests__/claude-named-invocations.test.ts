/**
 * Unit tests for the shared named-invocation extractor.
 * This is the single source of truth used by both the live MetricsProcessor and the
 * session adapter's parse path (native/untracked sessions).
 */
import { describe, it, expect } from 'vitest';
import {
  collectFailedToolUseIds,
  extractNamedInvocations,
  extractOrderedNamedInvocations,
} from '../claude-named-invocations.js';

function toolUse(name: string, input: Record<string, unknown>) {
  return { message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } };
}

function userText(text: string) {
  return { message: { role: 'user', content: [{ type: 'text', text }] } };
}

/** Genuine Claude CLI slash-command wrapper (command-name + command-message + command-args). */
function commandWrapper(name: string, args = '') {
  return `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`;
}

function userStringContent(text: string) {
  return { message: { role: 'user', content: text } };
}

describe('extractNamedInvocations', () => {
  it('extracts skill names from Skill tool_use blocks', () => {
    const out = extractNamedInvocations([
      toolUse('Skill', { skill: 'codemie:msgraph', args: 'x' }),
      toolUse('Skill', { skill: 'codemie:msgraph' }),
      toolUse('Skill', { skill: 'tech-lead' }),
    ]);
    expect(out.skillInvocations).toEqual({ 'codemie:msgraph': 2, 'tech-lead': 1 });
  });

  it('extracts agent subtypes from Agent tool_use blocks (this CLI) and Task blocks (standard Claude Code)', () => {
    const out = extractNamedInvocations([
      // This CLI dispatches subagents via the "Agent" tool.
      toolUse('Agent', { subagent_type: 'sdlc-factory:tech-analyst', description: 'd' }),
      toolUse('Agent', { subagent_type: 'superpowers:code-reviewer' }),
      toolUse('Agent', { subagent_type: 'superpowers:code-reviewer' }),
      // Standard Claude Code uses the "Task" tool name — still supported.
      toolUse('Task', { subagent_type: 'Explore' }),
    ]);
    expect(out.agentInvocations).toEqual({
      'sdlc-factory:tech-analyst': 1,
      'superpowers:code-reviewer': 2,
      Explore: 1,
    });
  });

  it('ignores Agent dispatches that have no subagent_type (general-purpose)', () => {
    const out = extractNamedInvocations([
      toolUse('Agent', { description: 'no subtype' }),
      toolUse('Agent', { subagent_type: null as unknown as string }),
    ]);
    expect(out.agentInvocations).toEqual({});
  });

  it('extracts slash commands from genuine wrappers in array text blocks and strips the slash', () => {
    const out = extractNamedInvocations([
      userText(commandWrapper('tech-lead', 'do the thing')),
      userText(commandWrapper('analytics')),
      userText(commandWrapper('analytics')),
    ]);
    expect(out.commandInvocations).toEqual({ 'tech-lead': 1, analytics: 2 });
  });

  it('extracts slash commands from string-content user messages (the real CLI shape)', () => {
    const out = extractNamedInvocations([
      userStringContent(commandWrapper('model')),
      userStringContent(commandWrapper('clear')),
    ]);
    expect(out.commandInvocations).toEqual({ model: 1, clear: 1 });
  });

  it('ignores <command-name> mentions that lack the <command-message> sibling (documentation/prose)', () => {
    const out = extractNamedInvocations([
      userText('Slash commands appear as `<command-name>/cmd-name</command-name>` in text'),
      userStringContent('see <command-name>/foo</command-name> for an example'),
    ]);
    expect(out.commandInvocations).toEqual({});
  });

  it('ignores command tags in assistant messages (only user messages count)', () => {
    const out = extractNamedInvocations([
      { message: { role: 'assistant', content: [{ type: 'text', text: commandWrapper('foo') }] } },
      { message: { role: 'assistant', content: commandWrapper('foo') } },
    ]);
    expect(out.commandInvocations).toEqual({});
  });

  it('returns empty maps for messages with no named invocations', () => {
    const out = extractNamedInvocations([
      toolUse('Bash', { command: 'ls' }),
      userText('just a plain prompt'),
    ]);
    expect(out.skillInvocations).toEqual({});
    expect(out.agentInvocations).toEqual({});
    expect(out.commandInvocations).toEqual({});
  });

  it('handles missing/non-string input fields without throwing', () => {
    const out = extractNamedInvocations([
      toolUse('Skill', {}),
      toolUse('Skill', { skill: 42 as unknown as string }),
      toolUse('Task', {}),
      { message: { role: 'user', content: 'string-content-not-array' } },
      {},
    ]);
    expect(out.skillInvocations).toEqual({});
    expect(out.agentInvocations).toEqual({});
    expect(out.commandInvocations).toEqual({});
  });
});

describe('extractOrderedNamedInvocations', () => {
  it('keeps slash commands in call order with repeats, and strips the slash', () => {
    const out = extractOrderedNamedInvocations([
      userStringContent(commandWrapper('plan')),
      userText('a prompt in between'),
      userText(commandWrapper('commit')),
      userStringContent(commandWrapper('plan')),
    ]);
    expect(out.commandsInOrder).toEqual(['plan', 'commit', 'plan']);
    expect(out.commandInvocations).toEqual({ plan: 2, commit: 1 });
  });

  it('counts a skill-backed slash command independently as both a command and a skill', () => {
    // A slash command that dispatches to a same-named skill is two distinct, independently
    // counted invocations here: the summary's own `commands`/`skills` counts are deliberately
    // not deduplicated against each other. A prior attempt at a lookahead dedup for this shape
    // (EPMCDME-17201) was reverted after review: three rounds each found a new transcript shape
    // it missed, real-session data showed the adjacency it assumed essentially never occurs, and
    // the ticket's actual reported symptom is backend-owned (`agent.skill.dispatch`/OTLP
    // `command_name`), unaffected by this file either way. This also keeps this extractor
    // consistent with `src/cli/commands/analytics/cost/dispatch-extractor.ts`'s independent
    // dispatch-timeline extraction of the same transcript shape.
    const out = extractOrderedNamedInvocations([
      userStringContent(commandWrapper('codemie-humanizer')),
      toolUse('Skill', { skill: 'codemie-humanizer' }),
    ]);
    expect(out.skillInvocations).toEqual({ 'codemie-humanizer': 1 });
    expect(out.commandInvocations).toEqual({ 'codemie-humanizer': 1 });
    expect(out.commandsInOrder).toEqual(['codemie-humanizer']);
  });

  it('still counts a command as a command when no Skill call follows it', () => {
    const out = extractOrderedNamedInvocations([
      userStringContent(commandWrapper('plan')),
      userText('a plain follow-up prompt, no skill'),
    ]);
    expect(out.commandInvocations).toEqual({ plan: 1 });
    expect(out.skillInvocations).toEqual({});
  });

  it('counts a command and an unrelated-name Skill call that happens to follow it, independently', () => {
    const out = extractOrderedNamedInvocations([
      userStringContent(commandWrapper('plan')),
      toolUse('Skill', { skill: 'unrelated-skill' }),
    ]);
    expect(out.commandInvocations).toEqual({ plan: 1 });
    expect(out.skillInvocations).toEqual({ 'unrelated-skill': 1 });
  });

  it('returns an empty list when there are no genuine commands', () => {
    const out = extractOrderedNamedInvocations([
      userText('docs mention <command-name>/plan</command-name> only'),
      userText('just a plain prompt'),
    ]);
    expect(out.commandsInOrder).toEqual([]);
  });

  it('returns the same counts as extractNamedInvocations', () => {
    const messages = [
      toolUse('Skill', { skill: 'codemie:msgraph' }),
      toolUse('Agent', { subagent_type: 'Explore' }),
      userStringContent(commandWrapper('init')),
    ];
    const { commandsInOrder: _ignored, ...ordered } = extractOrderedNamedInvocations(messages);
    expect(ordered).toEqual(extractNamedInvocations(messages));
  });

  it('keeps extractNamedInvocations free of the ordered list', () => {
    const out = extractNamedInvocations([userStringContent(commandWrapper('plan'))]);
    expect(Object.keys(out).sort()).toEqual(['agentInvocations', 'commandInvocations', 'skillInvocations']);
  });
});

/** A tool_use carrying the `id` a later tool_result points back to. */
function toolUseWithId(id: string, name: string, input: Record<string, unknown>) {
  return { message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}

function toolResultMsg(id: string, flag: { is_error?: boolean; isError?: boolean }, content = 'ok') {
  return {
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...flag }] },
  };
}

describe('failed Agent/Task calls (EPMCDME-15557)', () => {
  const failedOf = (messages: unknown[]) => collectFailedToolUseIds(messages);

  it('collectFailedToolUseIds collects is_error and isError results across messages', () => {
    const ids = collectFailedToolUseIds([
      toolResultMsg('a', { is_error: true }),
      toolResultMsg('b', { isError: true }),
      toolResultMsg('c', { is_error: false }),
      toolResultMsg('d', {}),
      userStringContent('plain text'),
      { message: { role: 'user', content: [{ type: 'tool_result', content: 'no id', is_error: true }] } },
      null,
    ]);
    expect([...ids].sort()).toEqual(['a', 'b']);
  });

  it('skips a denied Agent call whose result arrives in a later message', () => {
    const messages = [
      toolUseWithId('t1', 'Agent', { subagent_type: 'Explore' }),
      toolResultMsg('t1', { is_error: true }, 'QA-15557 deny'),
    ];
    expect(extractNamedInvocations(messages, failedOf(messages)).agentInvocations).toEqual({});
  });

  it('skips a denied Task call the same way as Agent', () => {
    const messages = [
      toolUseWithId('t1', 'Task', { subagent_type: 'Explore' }),
      toolResultMsg('t1', { is_error: true }, 'QA-15557 deny'),
    ];
    expect(extractNamedInvocations(messages, failedOf(messages)).agentInvocations).toEqual({});
  });

  it('skips a call flagged with camelCase isError', () => {
    const messages = [
      toolUseWithId('t1', 'Agent', { subagent_type: 'Explore' }),
      toolResultMsg('t1', { isError: true }),
    ];
    expect(extractNamedInvocations(messages, failedOf(messages)).agentInvocations).toEqual({});
  });

  it('counts the same subtype once when one call is denied and one allowed', () => {
    const messages = [
      toolUseWithId('t1', 'Agent', { subagent_type: 'Explore' }),
      toolResultMsg('t1', { is_error: true }, 'denied'),
      toolUseWithId('t2', 'Agent', { subagent_type: 'Explore' }),
      toolResultMsg('t2', { is_error: false }),
    ];
    expect(extractNamedInvocations(messages, failedOf(messages)).agentInvocations).toEqual({ Explore: 1 });
  });

  it('counts a pending call (no result) and a call without an id', () => {
    const out = extractNamedInvocations(
      [
        toolUseWithId('t1', 'Agent', { subagent_type: 'Explore' }),
        toolUse('Agent', { subagent_type: 'Plan' }),
      ],
      new Set(['t9'])
    );
    expect(out.agentInvocations).toEqual({ Explore: 1, Plan: 1 });
  });

  it('does not change Skill counting', () => {
    const messages = [
      toolUseWithId('t1', 'Skill', { skill: 'codemie:msgraph' }),
      toolResultMsg('t1', { is_error: true }),
    ];
    expect(extractNamedInvocations(messages, failedOf(messages)).skillInvocations).toEqual({
      'codemie:msgraph': 1,
    });
  });

  it('ordered and unordered extractors agree when a failed set is passed', () => {
    const messages = [
      toolUseWithId('t1', 'Agent', { subagent_type: 'Explore' }),
      toolResultMsg('t1', { is_error: true }),
      toolUseWithId('t2', 'Task', { subagent_type: 'Plan' }),
      toolResultMsg('t2', {}),
    ];
    const failed = failedOf(messages);
    const { commandsInOrder: _ignored, ...ordered } = extractOrderedNamedInvocations(messages, undefined, failed);
    expect(ordered).toEqual(extractNamedInvocations(messages, failed));
    expect(ordered.agentInvocations).toEqual({ Plan: 1 });
  });
});
