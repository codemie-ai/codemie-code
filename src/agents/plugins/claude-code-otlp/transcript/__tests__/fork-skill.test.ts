/**
 * Marker-less skill-fork recognition (EPMCDME-16352) and the plain `/name` command line of a
 * forked skill (EPMCDME-16391): exact-id correlation, and every case that must NOT classify.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
