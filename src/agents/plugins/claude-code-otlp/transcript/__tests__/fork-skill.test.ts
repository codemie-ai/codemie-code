/**
 * Marker-less skill-fork recognition (EPMCDME-16352) and the plain `/name` command line of a
 * forked skill (EPMCDME-16391): exact-id correlation, and every case that must NOT classify.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveForkSkills } from '../fork-skill.js';
import { findSubagentFiles } from '../subagent-usage.js';
import { extractOrderedNamedInvocations } from '../../../claude/session/claude-named-invocations.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fork-skill-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const j = (o: unknown): string => JSON.stringify(o);
const user = (promptId: string, content: unknown, extra: object = {}) =>
  j({ type: 'user', promptId, message: { role: 'user', content }, ...extra });
const toolUse = (id: string, name: string, input: object) =>
  j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string, toolUseResult: object | undefined, content = 'ok') =>
  j({
    type: 'user',
    ...(toolUseResult ? { toolUseResult } : {}),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });

/** Writes the main transcript and one subagent file per entry; returns discovery inputs. */
function session(
  main: string[],
  agents: { id: string; promptId?: string; meta?: object; marker?: string }[]
): { main: string } {
  const mainPath = join(dir, 's1.jsonl');
  writeFileSync(mainPath, main.map((l) => l + '\n').join(''));
  const sub = join(dir, 's1', 'subagents');
  rmSync(sub, { recursive: true, force: true });
  mkdirSync(sub, { recursive: true });
  for (const a of agents) {
    const first = j({ type: 'user', ...(a.promptId ? { promptId: a.promptId } : {}), agentId: a.id, message: { role: 'user', content: 'go' } });
    writeFileSync(join(sub, `agent-${a.id}.jsonl`), first + '\n');
    writeFileSync(join(sub, `agent-${a.id}.meta.json`), j(a.meta ?? { agentType: 'general-purpose' }));
    if (a.marker) writeFileSync(join(sub, `agent-${a.id}.forked-skill.marker.json`), j({ forkedSkill: true, skillName: a.marker }));
  }
  return { main: mainPath };
}

async function resolve(main: string) {
  const files = await findSubagentFiles(main);
  return Object.fromEntries(files.map((f) => [f.agentId, f.skillName ?? '']));
}

describe('Skill-tool forks', () => {
  it('names the fork from the Skill result agentId (object, and JSON text without toolUseResult)', async () => {
    const { main } = session(
      [
        toolUse('tu1', 'Skill', { skill: 'forkme' }),
        toolResult('tu1', { agentId: 'aaa', status: 'forked' }),
        toolUse('tu2', 'Skill', { skill: 'other' }),
        toolResult('tu2', undefined, '{"status":"forked","agentId":"bbb"}'),
      ],
      [{ id: 'aaa' }, { id: 'bbb' }]
    );
    expect(await resolve(main)).toEqual({ aaa: 'forkme', bbb: 'other' });
  });

  it('names the fork from meta.toolUseId when the result is not written yet', async () => {
    const { main } = session([toolUse('tu1', 'Skill', { skill: 'forkme' })], [{ id: 'aaa', meta: { toolUseId: 'tu1' } }]);
    expect(await resolve(main)).toEqual({ aaa: 'forkme' });
  });

  it('keeps repeated runs of one skill separate and leaves a nested Agent run alone', async () => {
    const { main } = session(
      [
        toolUse('tu1', 'Skill', { skill: 'forkme' }),
        toolResult('tu1', { agentId: 'a1' }),
        toolUse('tu2', 'Skill', { skill: 'forkme' }),
        toolResult('tu2', { agentId: 'a2' }),
        toolUse('tu3', 'Agent', { subagent_type: 'general-purpose' }),
        toolResult('tu3', { agentId: 'a3' }),
      ],
      [{ id: 'a1' }, { id: 'a2' }, { id: 'a3', promptId: 'p1' }]
    );
    expect(await resolve(main)).toEqual({ a1: 'forkme', a2: 'forkme', a3: '' });
  });
});

describe('slash-command forks', () => {
  it('names the sole tool-less subagent of the prompt that typed /name, and reports the prompt', async () => {
    const { main } = session([user('p1', '/forkme')], [{ id: 'aaa', promptId: 'p1' }]);
    const files = await findSubagentFiles(main);
    expect(files[0]).toMatchObject({ skillName: 'forkme', description: '/forkme' });
    expect((await resolveForkSkills(main, files)).slashPromptIds).toEqual(new Set(['p1']));
  });

  it('accepts a lone text block and arguments', async () => {
    const { main } = session([user('p1', [{ type: 'text', text: '/forkme  do it' }])], [{ id: 'aaa', promptId: 'p1' }]);
    expect(await resolve(main)).toEqual({ aaa: 'forkme' });
  });

  it('does not name an Agent-tool subagent of the same prompt (result or toolUseId)', async () => {
    const { main } = session(
      [user('p1', '/forkme'), toolUse('tu1', 'Agent', {}), toolResult('tu1', { agentId: 'a1' })],
      [{ id: 'a1', promptId: 'p1' }, { id: 'a2', promptId: 'p1', meta: { toolUseId: 'tu9' } }]
    );
    expect(await resolve(main)).toEqual({ a1: '', a2: '' });
  });

  it('is ambiguous - names nothing - with two candidates, two /name lines, no promptId or a different prompt', async () => {
    expect(
      await resolve(session([user('p1', '/forkme')], [{ id: 'a1', promptId: 'p1' }, { id: 'a2', promptId: 'p1' }]).main)
    ).toEqual({ a1: '', a2: '' });
    expect(
      await resolve(session([user('p1', '/one'), user('p1', '/two')], [{ id: 'a1', promptId: 'p1' }]).main)
    ).toEqual({ a1: '' });
    expect(await resolve(session([user('p1', '/forkme')], [{ id: 'a1' }]).main)).toEqual({ a1: '' });
    expect(await resolve(session([user('p1', '/forkme')], [{ id: 'a1', promptId: 'p2' }]).main)).toEqual({ a1: '' });
  });

  it('ignores prose, paths, wrapper lines and meta lines', async () => {
    const lines = [
      user('p1', 'please run /forkme'),
      user('p2', '/etc/hosts is wrong'),
      user('p3', '<command-message>forkme</command-message><command-name>/forkme</command-name>'),
      user('p4', '/forkme', { isMeta: true }),
    ];
    const agents = ['p1', 'p2', 'p3', 'p4'].map((p, i) => ({ id: `a${i}`, promptId: p }));
    expect(await resolve(session(lines, agents).main)).toEqual({ a0: '', a1: '', a2: '', a3: '' });
  });

  it('confirms a marker fork for the summary without renaming it, only when the names agree', async () => {
    const ok = session([user('p1', '/forkme')], [{ id: 'aaa', promptId: 'p1', marker: 'forkme' }]);
    const files = await findSubagentFiles(ok.main);
    const res = await resolveForkSkills(ok.main, files);
    expect(res.slashPromptIds).toEqual(new Set(['p1']));
    expect(res.skillByAgentId.size).toBe(0);

    const bad = session([user('p1', '/other')], [{ id: 'aaa', promptId: 'p1', marker: 'forkme' }]);
    expect((await resolveForkSkills(bad.main, await findSubagentFiles(bad.main))).slashPromptIds.size).toBe(0);
  });
});

describe('pending evidence - a scope cannot be corrected once sent', () => {
  const pendingOf = async (main: string, final = false) => {
    const files = await findSubagentFiles(main, { final });
    return Object.fromEntries(files.map((f) => [f.agentId, f.pending ? 'pending' : f.skillName || 'agent']));
  };

  it('leaves an Agent child of an /inline prompt pending while its Agent call has no result, then an agent', async () => {
    const lines = [user('p1', '/inlineme'), toolUse('tu1', 'Agent', { subagent_type: 'general-purpose' })];
    const { main } = session(lines, [{ id: 'a', promptId: 'p1' }]);
    expect(await pendingOf(main)).toEqual({ a: 'pending' });
    const files = await findSubagentFiles(main);
    expect((await resolveForkSkills(main, files, undefined)).slashPromptIds.size).toBe(0);
    // Its result arrives and names it: definitively an agent.
    session([...lines, toolResult('tu1', { agentId: 'a' })], [{ id: 'a', promptId: 'p1' }]);
    expect(await pendingOf(main)).toEqual({ a: 'agent' });
  });

  it('holds a metadata-less subagent pending while any Skill call has no result, whatever the prompt', async () => {
    const { main } = session([toolUse('tu1', 'Skill', { skill: 'forkme' })], [{ id: 'a', meta: {} }]);
    expect(await pendingOf(main)).toEqual({ a: 'pending' });
    session([toolUse('tu1', 'Skill', { skill: 'forkme' }), toolResult('tu1', { agentId: 'a' })], [{ id: 'a', meta: {} }]);
    expect(await pendingOf(main)).toEqual({ a: 'forkme' });
  });

  it('resolves a fork next to a concurrent Agent child once the Agent result names the child', async () => {
    const agents = [{ id: 'fork', promptId: 'p1' }, { id: 'child', promptId: 'p1' }];
    const open = [user('p1', '/forkme'), toolUse('tu1', 'Agent', {})];
    expect(await pendingOf(session(open, agents).main)).toEqual({ fork: 'pending', child: 'pending' });
    const { main } = session([...open, toolResult('tu1', { agentId: 'child' })], agents);
    expect(await pendingOf(main)).toEqual({ fork: 'forkme', child: 'agent' });
  });

  it('ends the session with an unproven subagent as an agent (final)', async () => {
    const { main } = session([user('p1', '/inlineme'), toolUse('tu1', 'Agent', {})], [{ id: 'a', promptId: 'p1' }]);
    expect(await pendingOf(main, true)).toEqual({ a: 'agent' });
  });

  it('does not treat a nested Agent child (call only in a subagent transcript) as a slash fork', async () => {
    const { main } = session([user('p1', '/forkme')], [{ id: 'fork', promptId: 'p1' }, { id: 'nested', promptId: 'p1' }]);
    const sub = join(dir, 's1', 'subagents');
    appendFileSync(join(sub, 'agent-fork.jsonl'), [toolUse('n1', 'Agent', {}), toolResult('n1', { agentId: 'nested' })].map((l) => `${l}\n`).join(''));
    expect(await pendingOf(main)).toEqual({ fork: 'forkme', nested: 'agent' });
  });

  it('keeps a real foreground Agent child (shape from a recorded session: meta.toolUseId, result agentId, shared promptId) an agent', async () => {
    const { main } = session(
      [user('p1', '/greet'), toolUse('toolu_0115', 'Agent', { subagent_type: 'Explore' }), toolResult('toolu_0115', { status: 'completed', agentId: 'ab02' })],
      [{ id: 'ab02', promptId: 'p1', meta: { agentType: 'Explore', toolUseId: 'toolu_0115', spawnDepth: 1, requestShape: 'foreground' } }]
    );
    expect(await pendingOf(main)).toEqual({ ab02: 'agent' });
  });
});

describe('closed calls and result shapes', () => {
  const failed = (id: string) =>
    j({ type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'launch failed' }] } });
  const kinds = async (main: string, final = true) =>
    Object.fromEntries((await findSubagentFiles(main, { final })).map((f) => [f.agentId, f.pending ? 'pending' : f.skillName || 'agent']));

  it('a failed, a completed-without-agent and an earlier-prompt Agent call do not block a later slash fork', async () => {
    const { main } = session(
      [
        user('p1', 'earlier'),
        toolUse('old1', 'Agent', {}),
        failed('old1'),
        toolUse('old2', 'Agent', {}),
        toolResult('old2', { status: 'completed' }, 'done'),
        user('p2', '/forkme'),
      ],
      [{ id: 'a', promptId: 'p2' }]
    );
    expect(await kinds(main)).toEqual({ a: 'forkme' });
    expect((await resolveForkSkills(main, await findSubagentFiles(main))).slashPromptIds).toEqual(new Set(['p2']));
  });

  it('a failed Skill call is closed too, and an open call of an unrelated prompt does not hold a fork pending', async () => {
    const { main } = session(
      [user('p1', 'x'), toolUse('s1', 'Skill', { skill: 'nope' }), failed('s1'), user('p2', '/forkme'), toolUse('other', 'Agent', {})],
      [{ id: 'a', promptId: 'p2' }]
    );
    // `other` was made in p2 (open): pending. Move it to an unrelated earlier prompt: not pending.
    expect(await kinds(main, false)).toEqual({ a: 'pending' });
    const { main: main2 } = session(
      [user('p0', 'y'), toolUse('other', 'Agent', {}), user('p1', 'x'), toolUse('s1', 'Skill', { skill: 'nope' }), failed('s1'), user('p2', '/forkme')],
      [{ id: 'a', promptId: 'p2' }]
    );
    expect(await kinds(main2, false)).toEqual({ a: 'forkme' });
  });

  it('still treats an unanswered Agent call of the same prompt as pending (original false-positive stays closed)', async () => {
    const { main } = session([user('p1', '/inlineme'), toolUse('t', 'Agent', {})], [{ id: 'a', promptId: 'p1' }]);
    expect(await kinds(main, false)).toEqual({ a: 'pending' });
    expect(await kinds(main, true)).toEqual({ a: 'agent' });
  });

  it('reads agentId from tool_result content given as an array of text blocks (Skill and Agent)', async () => {
    const textResult = (id: string, text: string) =>
      j({ type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
    const { main } = session(
      [
        toolUse('s', 'Skill', { skill: 'forkme' }),
        textResult('s', '{"status":"forked","agentId":"a"}'),
        user('p1', '/other'),
        toolUse('g', 'Agent', {}),
        textResult('g', '{"status":"async_launched","agentId":"b"}'),
      ],
      [{ id: 'a' }, { id: 'b', promptId: 'p1' }]
    );
    expect(await kinds(main, false)).toEqual({ a: 'forkme', b: 'agent' });
  });

  it('does not take an id from prose, from a non-Skill/Agent result, or over the typed field', async () => {
    const prose = j({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's', content: 'it said {"agentId":"a"} earlier' }] } });
    const { main } = session([toolUse('s', 'Skill', { skill: 'forkme' }), prose], [{ id: 'a' }]);
    expect(await kinds(main, true)).toEqual({ a: 'agent' });
    const { main: m2 } = session(
      [toolUse('s', 'Skill', { skill: 'forkme' }), toolResult('s', { agentId: 'typed' }, '{"agentId":"a"}')],
      [{ id: 'a' }, { id: 'typed' }]
    );
    expect(await kinds(m2, true)).toEqual({ a: 'agent', typed: 'forkme' });
  });
});

/**
 * Desktop app (embedded Claude Code 2.1.309, recorded session, sanitized): the slash user line of the
 * latest prompt reaches the main transcript only AFTER SubagentStop and the immediate Stop. The fork's
 * own first line (isMeta skill body, shared promptId) and a meta without toolUseId are already there.
 */
describe('main transcript not yet flushed (desktop ordering)', () => {
  const earlier = [user('p0', '/forkme'), toolUse('tu1', 'Skill', { skill: 'forkme' }), toolResult('tu1', { agentId: 'old' })];
  const queued = j({ type: 'queue-operation', operation: 'enqueue', content: '/forkme' });
  const fork = { id: 'a', promptId: 'p1', meta: { agentType: 'general-purpose', requestShape: 'foreground', requestNonInteractive: true } };
  const kinds = async (main: string, final = false) =>
    Object.fromEntries((await findSubagentFiles(main, { final })).map((f) => [f.agentId, f.pending ? 'pending' : f.skillName || 'agent']));

  it('holds the fork pending while its prompt is unknown to the main transcript, then names it once flushed', async () => {
    const { main } = session([...earlier, queued], [{ id: 'old', promptId: 'p0' }, fork]);
    expect(await kinds(main)).toEqual({ old: 'forkme', a: 'pending' });
    const flushed = [...earlier, queued, user('p1', '/forkme')];
    expect(await kinds(session(flushed, [{ id: 'old', promptId: 'p0' }, fork]).main)).toEqual({ old: 'forkme', a: 'forkme' });
  });

  it('never counts the prompt before the fork is confirmed, and ends the session as an agent if it never flushes', async () => {
    const { main } = session([...earlier, queued], [fork]);
    expect((await resolveForkSkills(main, await findSubagentFiles(main))).slashPromptIds.size).toBe(0);
    expect(await kinds(main, true)).toEqual({ a: 'agent' });
  });

  it('does not delay a child that an exact id already proves to be an agent or a Skill fork', async () => {
    const { main } = session(
      [toolUse('tu9', 'Agent', {}), toolResult('tu9', { agentId: 'b' }), toolUse('tu8', 'Skill', { skill: 'other' }), toolResult('tu8', { agentId: 'c' })],
      [{ id: 'b', promptId: 'p1' }, { id: 'c', promptId: 'p1' }, { id: 'd', promptId: 'p1', meta: { toolUseId: 'tuX' } }]
    );
    expect(await kinds(main)).toEqual({ b: 'agent', c: 'other', d: 'agent' });
  });

  it('keeps a metadata-less child pending while its own file has no complete line yet', async () => {
    const { main } = session([user('p1', 'hello')], [{ id: 'a' }]);
    writeFileSync(join(dir, 's1', 'subagents', 'agent-a.jsonl'), '');
    expect(await kinds(main)).toEqual({ a: 'pending' });
  });

  it('a started Agent call whose result is not flushed yet still holds a flushed-prompt child pending', async () => {
    const { main } = session([user('p1', '/inlineme'), toolUse('t', 'Agent', {})], [{ id: 'a', promptId: 'p1' }]);
    expect(await kinds(main)).toEqual({ a: 'pending' });
  });
});

describe('plain slash commands in the summary', () => {
  const msgs = [
    { promptId: 'p1', message: { role: 'user', content: '/forkme' } },
    { promptId: 'p2', message: { role: 'user', content: '<command-message>inlineme</command-message>\n<command-name>/inlineme</command-name>' } },
    { promptId: 'p3', message: { role: 'user', content: '/forkme' } },
    { promptId: 'p1', message: { role: 'assistant', content: '/forkme' } },
  ];

  it('counts a plain line once, in order, only for prompts a fork vouches for', () => {
    const out = extractOrderedNamedInvocations(msgs, new Set(['p1']));
    expect(out.commandsInOrder).toEqual(['forkme', 'inlineme']);
    expect(out.commandInvocations).toEqual({ forkme: 1, inlineme: 1 });
  });

  it('is unchanged without the set (CLI behaviour)', () => {
    expect(extractOrderedNamedInvocations(msgs).commandsInOrder).toEqual(['inlineme']);
  });
});
