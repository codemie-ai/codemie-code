/**
 * Pure project resolution and the persisted binding/conflict fields.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('../spool-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../spool-paths.js')>();
  const { join: pathJoin } = await import('node:path');
  return {
    ...actual,
    spoolRoot: (): string => state.root,
    statusFile: (sessionId: string): string => pathJoin(state.root, sessionId + '.status'),
  };
});

import {
  applyProjectDecision,
  decideProject,
  evaluateProjectPolicy,
  hookEventProjectNames,
  hookRecordIsProject,
  isSendableProjectName,
  parseProjectSeal,
  projectGate,
} from '../session-project.js';
import { createStatus, type SessionStatus } from '../session-status.js';

const withProject = (project: string): SessionStatus => ({ ...createStatus(), project });

describe('decideProject', () => {
  it('is a noop without names', () => {
    expect(decideProject([], createStatus())).toEqual({ action: 'noop' });
  });

  it('binds a single name', () => {
    expect(decideProject(['A'], createStatus())).toEqual({ action: 'bind', project: 'A' });
  });

  it('treats the same name in another case as one project and keeps the first spelling', () => {
    expect(decideProject(['A', 'a'], createStatus())).toEqual({ action: 'bind', project: 'A' });
  });

  it('flags a conflict for two projects in one call, even though A is first', () => {
    expect(decideProject(['A', 'B'], createStatus())).toEqual({
      action: 'conflict',
      names: ['A', 'B'],
    });
  });

  it('flags a conflict for a stored binding plus a different name', () => {
    expect(decideProject(['B'], withProject('A'))).toEqual({
      action: 'conflict',
      names: ['A', 'B'],
    });
  });

  it('ignores blank names next to a stored binding', () => {
    expect(decideProject(['', '  '], withProject('A'))).toEqual({ action: 'noop' });
  });

  it('is a noop for the stored binding in another case', () => {
    expect(decideProject(['a'], withProject('A'))).toEqual({ action: 'noop' });
  });

  it('is a noop once a conflict is stored', () => {
    const status = { ...createStatus(), projectConflict: ['A', 'B'] };
    expect(decideProject(['C'], status)).toEqual({ action: 'noop' });
  });

  it.each([[' A'], ['A\n'], ['Проект']])('treats %j as a conflict on its own', (name) => {
    expect(decideProject([name], createStatus())).toEqual({ action: 'conflict', names: [name] });
  });

  it('ignores blank names when nothing is bound', () => {
    expect(decideProject(['', ' '], createStatus())).toEqual({ action: 'noop' });
  });
});

describe('applyProjectDecision / projectGate', () => {
  it('bind, conflict and unbound states', () => {
    const status = createStatus();
    expect(projectGate(status)).toEqual({ state: 'unbound' });

    applyProjectDecision(status, { action: 'bind', project: 'A' });
    expect(projectGate(status)).toEqual({ state: 'bound', project: 'A' });

    applyProjectDecision(status, { action: 'conflict', names: ['A', 'B'] });
    expect(projectGate(status)).toEqual({ state: 'conflict' });
    expect(status.project).toBe('A');
  });

  it('keeps a conflict set-once', () => {
    const status = createStatus();
    applyProjectDecision(status, { action: 'conflict', names: ['A', 'B'] });
    applyProjectDecision(status, { action: 'conflict', names: ['C', 'D'] });
    expect(status.projectConflict).toEqual(['A', 'B']);
  });
});

describe('isSendableProjectName / hookEventProjectNames', () => {
  it('accepts plain header-safe names only', () => {
    expect(isSendableProjectName('My Project-1')).toBe(true);
    expect(isSendableProjectName('')).toBe(false);
    expect(isSendableProjectName('  ')).toBe(false);
    expect(isSendableProjectName(' A')).toBe(false);
    expect(isSendableProjectName('A\u0000')).toBe(false);
    expect(isSendableProjectName('Проект')).toBe(false);
    // Latin-1 Supplement: a JS string with these code points is sent as raw Latin-1 bytes by
    // fetch/undici, not UTF-8, so a name like "Café" would arrive at the backend corrupted.
    expect(isSendableProjectName('Café')).toBe(false);
  });

  it('collects top-level and raw names', () => {
    expect(
      hookEventProjectNames({ codemie_project_name: 'A', raw: { codemie_project_name: 'B' } })
    ).toEqual(['A', 'B']);
    expect(hookEventProjectNames({ codemie_project_name: 5, raw: 'x' })).toEqual([]);
    expect(hookEventProjectNames(null)).toEqual([]);
  });
});

describe('status persistence', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-project-'));
  });
  afterEach(async () => {
    await rm(state.root, { recursive: true, force: true });
  });

  it('keeps all three fields across readStatus -> advanceCursor -> readStatus', async () => {
    const { readStatus, writeStatus, advanceCursor } = await import('../session-status.js');
    await writeStatus('s1', {
      ...createStatus(),
      project: 'A',
      projectConflict: ['A', 'B'],
      projectScanned: true,
    });

    await advanceCursor('s1', 'hooks', 7);

    const status = await readStatus('s1');
    expect(status).toMatchObject({
      project: 'A',
      projectConflict: ['A', 'B'],
      projectScanned: true,
    });
    expect(status?.cursors.hooks).toBe(7);
  });

  it('drops malformed project fields', async () => {
    const { readStatus } = await import('../session-status.js');
    await writeFile(
      join(state.root, 's2.status'),
      JSON.stringify({ cursors: {}, project: '', projectConflict: [1, 'A'], projectScanned: 'yes' })
    );
    const status = await readStatus('s2');
    expect(status?.project).toBeUndefined();
    expect(status?.projectConflict).toBeUndefined();
    expect(status?.projectScanned).toBeUndefined();
  });

  it('drops a stored project that is no longer a sendable header value', async () => {
    const { readStatus } = await import('../session-status.js');
    await writeFile(
      join(state.root, 's2b.status'),
      JSON.stringify({ cursors: {}, project: 'Café' })
    );
    expect((await readStatus('s2b'))?.project).toBeUndefined();
  });

  it('reads a status written before the seal existed, and keeps a seal across a cursor advance', async () => {
    const { readStatus, writeStatus, advanceCursor } = await import('../session-status.js');
    await writeFile(
      join(state.root, 's3.status'),
      JSON.stringify({ cursors: { hooks: 3 }, project: 'A', projectConflict: ['A', 'B'], projectScanned: true })
    );
    expect((await readStatus('s3'))?.projectSeal).toBeUndefined(); // old status: today's discard

    await writeStatus('s4', {
      ...createStatus(),
      project: 'A',
      projectConflict: ['A', 'B'],
      projectSeal: { v: 1, project: 'A', hooksEnd: 40 },
    });
    await advanceCursor('s4', 'hooks', 7);
    expect((await readStatus('s4'))?.projectSeal).toEqual({ v: 1, project: 'A', hooksEnd: 40 });
  });

  it('ignores a malformed seal on disk instead of trusting it', async () => {
    const { readStatus } = await import('../session-status.js');
    const base = { cursors: {}, project: 'A', projectConflict: ['A', 'B'] };
    const bad: unknown[] = [
      { v: 2, project: 'A', hooksEnd: 1 },
      { project: 'A', hooksEnd: 1 },
      { v: 1, project: '', hooksEnd: 1 },
      { v: 1, project: 'Проект', hooksEnd: 1 },
      { v: 1, project: 'A', hooksEnd: -1 },
      { v: 1, project: 'A', hooksEnd: 1.5 },
      { v: 1, project: 'A', hooksEnd: '9' },
      { v: 1, project: 'C', hooksEnd: 1 }, // not a project of the conflict
      'seal',
    ];
    for (const [index, seal] of bad.entries()) {
      await writeFile(join(state.root, `bad${index}.status`), JSON.stringify({ ...base, projectSeal: seal }));
      expect((await readStatus(`bad${index}`))?.projectSeal).toBeUndefined();
    }
    await writeFile(
      join(state.root, 'noconflict.status'),
      JSON.stringify({ cursors: {}, project: 'A', projectSeal: { v: 1, project: 'A', hooksEnd: 1 } })
    );
    expect((await readStatus('noconflict'))?.projectSeal).toBeUndefined(); // a seal needs a conflict
  });
});

describe('hooks seal: decision, validation and record proof', () => {
  it('seals only when a bound session turns into a conflict, at the size before the append', () => {
    const bound = withProject('A');
    applyProjectDecision(bound, { action: 'conflict', names: ['A', 'B'] }, 120);
    expect(bound.projectSeal).toEqual({ v: 1, project: 'A', hooksEnd: 120 });

    const unbound = createStatus();
    applyProjectDecision(unbound, { action: 'conflict', names: ['A', 'B'] }, 120);
    expect(unbound.projectSeal).toBeUndefined(); // nothing was bound: no provable prefix

    const legacy = withProject('A');
    applyProjectDecision(legacy, { action: 'conflict', names: ['A', 'B'] }); // legacy scan passes no size
    expect(legacy.projectSeal).toBeUndefined();

    const once = withProject('A');
    applyProjectDecision(once, { action: 'conflict', names: ['A', 'B'] }, 10);
    applyProjectDecision(once, { action: 'conflict', names: ['A', 'C'] }, 99);
    expect(once.projectSeal?.hooksEnd).toBe(10);
  });

  it('parseProjectSeal accepts exactly what applyProjectDecision writes', () => {
    expect(parseProjectSeal({ v: 1, project: 'a', hooksEnd: 0 }, ['A', 'B'])).toEqual({ v: 1, project: 'a', hooksEnd: 0 });
    expect(parseProjectSeal({ v: 1, project: 'A', hooksEnd: 5 }, undefined)).toBeUndefined();
    expect(parseProjectSeal(null, ['A'])).toBeUndefined();
  });

  const record = (event: Record<string, unknown>): string =>
    JSON.stringify({ agentName: 'x', hookEvent: JSON.stringify(event) });

  it('hookRecordIsProject proves A only when every name in the record is A', () => {
    expect(hookRecordIsProject(record({ codemie_project_name: 'A' }), 'a')).toBe(true);
    expect(hookRecordIsProject(record({ codemie_project_name: 'A', raw: { codemie_project_name: 'A' } }), 'A')).toBe(true);
    expect(hookRecordIsProject(record({ codemie_project_name: 'B' }), 'A')).toBe(false);
    expect(hookRecordIsProject(record({ codemie_project_name: '' }), 'A')).toBe(false);
    expect(hookRecordIsProject(record({ type: 'x' }), 'A')).toBe(false);
    expect(hookRecordIsProject(record({ codemie_project_name: 'A', raw: { codemie_project_name: 'B' } }), 'A')).toBe(false);
    expect(hookRecordIsProject('not json', 'A')).toBe(false);
  });
});

describe('evaluateProjectPolicy', () => {
  const sealed = (cursor = 0, hooksEnd = 50): SessionStatus => ({
    ...createStatus(),
    project: 'A',
    projectConflict: ['A', 'B'],
    projectSeal: { v: 1, project: 'A', hooksEnd },
    cursors: { hooks: cursor, logs: 0, metrics: 0, traces: 0 },
  });
  const input = { hooksSize: 80, hooksOnlyAllowed: true };

  it('bound: everything goes out under the project', () => {
    const policy = evaluateProjectPolicy(withProject('A'), input);
    expect(policy).toMatchObject({ state: 'bound', sealed: false });
    expect(policy.hooks).toEqual({ kind: 'send', project: 'A' });
    expect(policy.otel).toEqual({ kind: 'send', project: 'A' });
  });

  it('unbound: undecided while there are no hooks, discarded once hooks exist', () => {
    expect(evaluateProjectPolicy(createStatus(), { ...input, hooksSize: 0 })).toMatchObject({
      state: 'undecided',
      hooks: { kind: 'hold' },
      otel: { kind: 'hold' },
    });
    expect(evaluateProjectPolicy(createStatus(), input)).toMatchObject({
      state: 'unbound',
      hooks: { kind: 'discard' },
      otel: { kind: 'discard' },
    });
  });

  it('conflict with a live seal: only the hooks prefix, bounded by the seal and the file size', () => {
    expect(evaluateProjectPolicy(sealed(), input)).toEqual({
      state: 'conflict',
      sealed: true,
      hooks: { kind: 'send', project: 'A', limit: 50, onlyProject: 'A' },
      otel: { kind: 'discard' },
    });
    const clamped = evaluateProjectPolicy(sealed(0, 10_000), { ...input, hooksSize: 60 });
    expect(clamped.hooks).toMatchObject({ kind: 'send', limit: 60 });
  });

  it('conflict: everything is discarded without a seal, with the flag off, or once the prefix is done', () => {
    const noSeal = { ...sealed(), projectSeal: undefined };
    expect(evaluateProjectPolicy(noSeal, input)).toMatchObject({ hooks: { kind: 'discard' }, otel: { kind: 'discard' }, reason: 'no-seal' });
    expect(evaluateProjectPolicy(sealed(), { ...input, hooksOnlyAllowed: false })).toMatchObject({
      hooks: { kind: 'discard' },
      otel: { kind: 'discard' },
      reason: 'hooks-only-forwarding-disabled',
    });
    expect(evaluateProjectPolicy(sealed(50), input)).toMatchObject({ hooks: { kind: 'discard' }, reason: 'seal-flushed', sealed: false });
    expect(evaluateProjectPolicy(sealed(5, 50), { ...input, hooksSize: 5 })).toMatchObject({ reason: 'seal-flushed' });
  });
});
