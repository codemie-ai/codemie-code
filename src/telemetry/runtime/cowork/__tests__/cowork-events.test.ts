/**
 * The Cowork event builders: inner-transcript lines of the synthetic fixture session in, wire events out.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildCoworkEvents,
  emptyCoworkEventState,
  stampCoworkEvent,
  type CoworkEnvelope,
} from '../cowork-events.js';
import { coworkFixtureFile } from './cowork-fixture.js';

const CLI = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const AGENT = 'a11111111111111111';
function fixtureLines(name: 'main.jsonl' | 'subagent.jsonl'): string[] {
  return readFileSync(coworkFixtureFile(name), 'utf-8').split('\n').filter((line) => line.length > 0);
}

const MAIN = fixtureLines('main.jsonl');
const SUBAGENT = fixtureLines('subagent.jsonl');
/** The fixture's subagent lines carry no `gitBranch`; here each one does. */
const SUBAGENT_ON_BRANCH = SUBAGENT.map((line) => JSON.stringify({ ...(JSON.parse(line) as object), gitBranch: 'synthetic-branch' }));

const ENVELOPE: CoworkEnvelope = {
  sessionId: CLI,
  project: 'synthetic-project',
  repository: 'Cowork',
  cliVersion: '0.0.0-test',
  title: 'Synthetic notes task',
  entrypoint: 'local-agent',
  clientVersion: '2.1.317',
};

function userLine(uuid: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'user', uuid, sessionId: CLI, timestamp: '2026-11-10T11:00:00.000Z', message: { role: 'user', content }, ...extra });
}

function build(main: string[]): Record<string, unknown>[] {
  return buildCoworkEvents({ sessionId: CLI, main, subagents: [], windowStartMs: Number.NEGATIVE_INFINITY, end: false }, emptyCoworkEventState());
}

describe('buildCoworkEvents', () => {
  it('builds the session, prompt, tool and subagent events of the fixture with literal ids', () => {
    const events = buildCoworkEvents({
      sessionId: CLI,
      main: MAIN,
      subagents: [{ agentId: AGENT, agentType: 'general-purpose', toolUseId: 'toolu_synthetic_agent', lines: SUBAGENT_ON_BRANCH }],
      windowStartMs: Number.NEGATIVE_INFINITY,
      end: false,
    }, emptyCoworkEventState());

    expect(events.map((event) => event['event_id'])).toEqual([
      `agent.session.start:${CLI}:start`,
      `agent.prompt.submit:${CLI}:00000000-0000-4000-8000-0000000000a1`,
      `agent.tool.start:${CLI}:toolu_synthetic_write`,
      `agent.tool.end:${CLI}:toolu_synthetic_write`,
      `agent.tool.start:${CLI}:toolu_synthetic_agent`,
      `agent.tool.end:${CLI}:toolu_synthetic_agent`,
      `agent.prompt.submit:${CLI}:00000000-0000-4000-8000-0000000000a9`,
      `agent.subagent.start:${CLI}:${AGENT}`,
      `agent.tool.start:${CLI}:toolu_synthetic_read`,
      `agent.tool.end:${CLI}:toolu_synthetic_read`,
      `agent.subagent.stop:${CLI}:${AGENT}`,
    ]);
    const byId = new Map(events.map((event) => [event['event_id'], event]));
    expect(byId.get(`agent.tool.end:${CLI}:toolu_synthetic_write`)).toMatchObject({ tool_name: 'Write', lines_added: 3, lines_removed: 0 });
    expect(byId.get(`agent.tool.start:${CLI}:toolu_synthetic_write`)).toMatchObject({ file_path: '/sessions/synthetic-cowork/notes.md' });
    expect(byId.get(`agent.tool.end:${CLI}:toolu_synthetic_agent`)).toMatchObject({ tool_name: 'Agent', tool_response: `{"agentId":"${AGENT}"}` });
    expect(byId.get(`agent.tool.start:${CLI}:toolu_synthetic_read`)).toMatchObject({
      tool_name: 'Read', agent_id: AGENT, agent_type: 'general-purpose', git_branch: 'synthetic-branch',
    });
    expect(byId.get(`agent.subagent.start:${CLI}:${AGENT}`)).toMatchObject({
      agent_id: AGENT, agent_type: 'general-purpose', tool_use_id: 'toolu_synthetic_agent', timestamp: '2026-11-10T10:00:08.000Z',
    });
    expect(byId.get(`agent.subagent.stop:${CLI}:${AGENT}`)).toMatchObject({ timestamp: '2026-11-10T10:00:14.000Z' });
    expect(byId.get(`agent.session.start:${CLI}:start`)).toMatchObject({ timestamp: '2026-11-10T10:00:00.000Z', git_branch: 'HEAD' });
  });

  it('submits a command, a task notification and an agent message, and no line Claude Code writes itself', () => {
    const events = build([
      userLine('u-interrupt', '[Request interrupted by user]'),
      userLine('u-interrupt-tool', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
      userLine('u-stdout', '<local-command-stdout>synthetic output</local-command-stdout>'),
      userLine('u-stderr', [{ type: 'text', text: '<local-command-stderr>synthetic error</local-command-stderr>' }]),
      userLine('u-caveat', '  <local-command-caveat>Caveat: synthetic</local-command-caveat>'),
      userLine('u-bash-stdout', '<bash-stdout>synthetic</bash-stdout>'),
      userLine('u-bash-stderr', '<bash-stderr>synthetic</bash-stderr>'),
      userLine('u-bash-input', '<bash-input>ls</bash-input>'),
      userLine('u-command', '<command-name>/synthetic</command-name>'),
      userLine('u-notification', '<task-notification><task-id>t1</task-id></task-notification>'),
      userLine('u-agent-message', '<agent-message from="synthetic">Report</agent-message>'),
    ]);

    expect(events.filter((event) => event['type'] === 'agent.prompt.submit').map((event) => event['event_id'])).toEqual([
      `agent.prompt.submit:${CLI}:u-command`,
      `agent.prompt.submit:${CLI}:u-notification`,
      `agent.prompt.submit:${CLI}:u-agent-message`,
    ]);
  });

  it('gives agent.tool.error, not agent.tool.end, for a result marked as an error', () => {
    const events = build([
      JSON.stringify({
        type: 'assistant', uuid: 'a-bash', timestamp: '2026-11-10T11:00:00.000Z',
        message: { id: 'msg-bash', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'false' } }] },
      }),
      userLine('u-bash', [{ type: 'tool_result', tool_use_id: 'toolu_bash', is_error: true, content: 'exit code 1' }]),
    ]);

    expect(events.filter((event) => String(event['type']).startsWith('agent.tool.')).map((event) => event['type']))
      .toEqual(['agent.tool.start', 'agent.tool.error']);
    expect(events.at(-1)).toEqual({
      type: 'agent.tool.error', timestamp: '2026-11-10T11:00:00.000Z', tool_name: 'Bash', tool_use_id: 'toolu_bash',
      event_id: `agent.tool.error:${CLI}:toolu_bash`,
    });
  });

  it('carries the fork id and the agent id alone on the end of a Skill call that forked', () => {
    const events = build([
      JSON.stringify({
        type: 'assistant', uuid: 'a-skill', timestamp: '2026-11-10T11:00:00.000Z',
        message: { id: 'msg-skill', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_skill', name: 'Skill', input: { skill: 'synthetic-review' } }] },
      }),
      userLine('u-skill', [{ type: 'tool_result', tool_use_id: 'toolu_skill', content: 'Launched synthetic-review with a long text' }], {
        toolUseResult: { success: true, commandName: 'synthetic-review', agentId: 'afork0000000000001', status: 'forked' },
      }),
    ]);

    expect(events.find((event) => event['type'] === 'agent.tool.start')).toMatchObject({ skill_name: 'synthetic-review' });
    expect(events.find((event) => event['type'] === 'agent.tool.end')).toEqual({
      type: 'agent.tool.end', timestamp: '2026-11-10T11:00:00.000Z', tool_name: 'Skill', tool_use_id: 'toolu_skill',
      fork_agent_id: 'afork0000000000001', tool_response: '{"agentId":"afork0000000000001"}',
      event_id: `agent.tool.end:${CLI}:toolu_skill`,
    });
  });

  it('ends the session at the latest line of any file, a subagent line later than the main transcript included', () => {
    const late = JSON.stringify({
      type: 'assistant', uuid: 'a-late', sessionId: CLI, timestamp: '2026-11-10T10:04:00.000Z',
      message: { id: 'msg-late', role: 'assistant', content: [{ type: 'text', text: 'Still working.' }] },
    });

    const events = buildCoworkEvents({
      sessionId: CLI,
      main: MAIN,
      subagents: [
        { agentId: 'along000000000001', agentType: 'general-purpose', lines: [late] },
        { agentId: AGENT, agentType: 'general-purpose', toolUseId: 'toolu_synthetic_agent', lines: SUBAGENT },
      ],
      windowStartMs: Number.NEGATIVE_INFINITY,
      end: true,
    }, emptyCoworkEventState());

    expect(events.at(-1)).toEqual({
      type: 'agent.session.end',
      timestamp: '2026-11-10T10:04:00.000Z',
      event_id: `agent.session.end:${CLI}:2026-11-10T10:04:00.000Z`,
    });
  });
});

describe('stampCoworkEvent', () => {
  it('masks a secret-shaped token in a prompt and cuts the prompt to 200 characters', () => {
    const secret = `sk-ant-${'a1B2'.repeat(10)}`;
    const masked = stampCoworkEvent({ type: 'agent.prompt.submit', timestamp: '2026-11-10T11:00:00.000Z', prompt_body: `use ${secret} now`, event_id: 'agent.prompt.submit:x:1' }, ENVELOPE, '');
    const long = stampCoworkEvent({ type: 'agent.prompt.submit', timestamp: '2026-11-10T11:00:00.000Z', prompt_body: 'x'.repeat(500), event_id: 'agent.prompt.submit:x:2' }, ENVELOPE, '');

    expect(masked['prompt_body']).toBe('use [REDACTED] now');
    expect(long['prompt_body']).toBe('x'.repeat(200));
    expect(long).toMatchObject({ session_title: 'Synthetic notes task', platform: 'claude-code', schema_version: 2, codemie_project_name: 'synthetic-project' });
  });

  it('gives a summary without its own time the fallback time and the hook path\'s summary id', () => {
    const stamped = stampCoworkEvent({ type: 'agent.session.summary', session_id: CLI, timestamp: undefined, is_final: true, started_at: '2026-11-10T10:00:00.000Z' }, ENVELOPE, '2026-11-10T10:00:30.000Z');

    expect(stamped['timestamp']).toBe('2026-11-10T10:00:30.000Z');
    expect(stamped['event_id']).toBe(`agent.session.summary:${CLI}:summary:final:2026-11-10T10:00:00.000Z`);
    expect(stamped).not.toHaveProperty('session_title');
  });
});
