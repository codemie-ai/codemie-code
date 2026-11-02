/**
 * The persistent evidence index must give exactly the resolution a full read gives, in every
 * invalidation case, while an unchanged source file is only validated (EPMCDME-16391).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const io = vi.hoisted(() => ({ readFileBytes: 0, readBytes: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      const result = await original.readFile(...args);
      if (String(args[0]).includes('agent-')) io.readFileBytes += Buffer.byteLength(result as string);
      return result;
    },
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      const inner = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
      (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        const r = await inner(...a);
        if (String(args[0]).includes('agent-')) io.readBytes += r.bytesRead;
        return r;
      };
      return handle;
    },
  };
});

import { resolveForkSkills, type ForkCandidate } from '../fork-skill.js';
import { EvidenceCache } from '../evidence-index.js';

let dir: string;
let cache: EvidenceCache;
const main = (): string => join(dir, 'main.jsonl');
const j = (o: unknown): string => JSON.stringify(o);
const user = (promptId: string, content = 'go'): string => j({ type: 'user', promptId, message: { role: 'user', content } });
const call = (id: string, name: string, input: unknown = {}): string =>
  j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, agentId: string, isError = false): string =>
  j({
    type: 'user',
    toolUseResult: { agentId },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }] },
  });
const lines = (...l: string[]): string => l.map((x) => `${x}\n`).join('');

const norm = (r: Awaited<ReturnType<typeof resolveForkSkills>>): unknown => ({
  skills: [...r.skillByAgentId].sort(),
  pending: [...r.pendingAgentIds].sort(),
  slash: [...r.slashPromptIds].sort(),
  unproven: [...r.unprovenAgentIds].sort(),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evidence-'));
  cache = new EvidenceCache(join(dir, 'evidence.json'));
  io.readFileBytes = 0;
  io.readBytes = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Resolves with and without the index and requires the same answer. */
async function same(files: ForkCandidate[], opts: { final?: boolean } = {}): Promise<unknown> {
  const plain = norm(await resolveForkSkills(main(), files, undefined, opts));
  const indexed = norm(await resolveForkSkills(main(), files, undefined, { ...opts, evidence: cache }));
  await cache.save();
  expect(indexed).toEqual(plain);
  return indexed;
}

describe('evidence index == full read', () => {
  it('append, partial line, late result for an earlier call, replace, truncate and missing file', async () => {
    writeFileSync(main(), lines(user('p1', '/x'), call('tu-main', 'Agent'), result('tu-main', 'parent')));
    const parentPath = join(dir, 'agent-parent.jsonl');
    const kidPath = join(dir, 'agent-kid.jsonl');
    const kid2Path = join(dir, 'agent-kid2.jsonl');
    const filler = Array.from({ length: 400 }, (_, i) => j({ type: 'assistant', n: i, message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(150) }] } }));
    const parentHead = lines(user('p1'), call('tu-nest', 'Agent'), ...filler);
    writeFileSync(parentPath, parentHead);
    writeFileSync(kidPath, lines(user('p2'), 'x'));
    writeFileSync(kid2Path, lines(user('p3'), 'y'));
    const files: ForkCandidate[] = [
      { agentId: 'parent', filePath: parentPath, toolUseId: 'tu-main' },
      { agentId: 'kid', filePath: kidPath, toolUseId: 'tu-nest' }, // call only in the parent's file
      { agentId: 'kid2', filePath: kid2Path }, // no ids at all
    ];

    await same(files); // initial: kid is ordinary (call seen in the parent), kid2 depends on open calls

    // Unchanged parent (~80 KB): one head probe (<= 16 KiB) plus the validation ranges, not a full read.
    io.readFileBytes = io.readBytes = 0;
    await resolveForkSkills(main(), files, undefined, { evidence: cache });
    expect(parentHead.length).toBeGreaterThan(60_000);
    expect(io.readFileBytes).toBe(0);
    expect(io.readBytes).toBeLessThan(3 * 20_000); // three small files + one large: heads and ranges only
    // Appended bytes are read from the old complete-line boundary only.
    io.readFileBytes = io.readBytes = 0;

    // complete append: a Skill call without result in the parent
    appendFileSync(parentPath, lines(call('tu-skill', 'Skill', { skill: 'inner' })));
    await same(files);
    // partial line: the result of that call, cut before its newline
    const res = result('tu-skill', 'kid2');
    appendFileSync(parentPath, res.slice(0, 20));
    await same(files);
    appendFileSync(parentPath, res.slice(20));
    await same(files); // complete JSON without trailing newline is visible, as in a full read
    appendFileSync(parentPath, '\n');
    const withResult = await same(files); // result for a call indexed earlier now names kid2
    expect(JSON.stringify(withResult)).toContain('"kid2","inner"');

    // replace with different content of the same or larger size, same head
    writeFileSync(parentPath, lines(user('p1'), call('tu-other', 'Skill', { skill: 'other' }), result('tu-other', 'kid2')));
    expect(JSON.stringify(await same(files))).toContain('"kid2","other"');
    // truncate below the indexed offset
    truncateSync(parentPath, 10);
    await same(files);
    // missing and unreadable source
    unlinkSync(parentPath);
    await same(files);
  });

  it('a malformed or foreign cache file is ignored; an entry built for another start prompt is not reused', async () => {
    writeFileSync(main(), lines(user('p1', '/x')));
    const filePath = join(dir, 'agent-a.jsonl');
    writeFileSync(filePath, lines(user('p1'), call('tu', 'Skill', { skill: 's' }), result('tu', 'c')));
    const files: ForkCandidate[] = [{ agentId: 'c', filePath }];
    writeFileSync(join(dir, 'evidence.json'), '{not json');
    await same(files);
    // the same file seen again with a different known start prompt rebuilds the entry
    await same([{ agentId: 'c', filePath, settled: true, promptId: 'other-start', headDone: true }]);
  });

  it('a start prompt that is not final yet is never indexed (promptless head, still incomplete)', async () => {
    writeFileSync(main(), lines(user('p1', '/x')));
    const filePath = join(dir, 'agent-late.jsonl');
    writeFileSync(filePath, lines(call('tu', 'Skill', { skill: 's' })));
    const files: ForkCandidate[] = [{ agentId: 'c', filePath }];
    await same(files);
    expect(await cache.get(filePath)).toBeUndefined();
    writeFileSync(filePath, lines(user('p1'), call('tu', 'Skill', { skill: 's' }), result('tu', 'c')));
    await same(files);
    expect(await cache.get(filePath)).toBeDefined();
  });
});
