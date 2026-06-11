/**
 * Unit tests for the shared named-invocation extractor.
 * This is the single source of truth used by both the live MetricsProcessor and the
 * session adapter's parse path (native/untracked sessions).
 */
import { describe, it, expect } from 'vitest';
import { extractNamedInvocations } from '../claude-named-invocations.js';

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
