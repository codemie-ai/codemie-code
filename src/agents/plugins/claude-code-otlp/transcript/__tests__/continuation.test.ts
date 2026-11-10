import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInheritedUuids } from '../continuation.js';

// Records every read stream the module opens, so a test can check none is left open.
const openedStreams = vi.hoisted(() => [] as { destroyed: boolean }[]);
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: ((...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args);
      openedStreams.push(stream);
      return stream;
    }) as typeof actual.createReadStream,
  };
});

let dir: string;

const msg = (uuid: string, sessionId: string): string =>
  JSON.stringify({ type: 'assistant', uuid, sessionId, message: { role: 'assistant', content: [] } });
const continuedIn = (parent: string, child: string): string =>
  JSON.stringify({ type: 'continued-in', timestamp: '2026-11-01T19:43:28.390Z', sessionId: parent, continuedInSessionId: child });

beforeEach(() => {
  openedStreams.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'continuation-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveInheritedUuids', () => {
  it('returns the counted uuids of the sibling transcript that continued into the session', async () => {
    writeFileSync(join(dir, 'P.jsonl'), [msg('u1', 'P'), msg('u2', 'P'), continuedIn('P', 'C')].join('\n') + '\n');
    writeFileSync(join(dir, 'C.jsonl'), [msg('u1', 'C'), msg('u2', 'C'), msg('u3', 'C')].join('\n') + '\n');

    expect(await resolveInheritedUuids(join(dir, 'C.jsonl'), 'C')).toEqual(['u1', 'u2']);
  });

  it('ignores a transcript that continued into a different session', async () => {
    writeFileSync(join(dir, 'P.jsonl'), [msg('u1', 'P'), continuedIn('P', 'D')].join('\n') + '\n');
    writeFileSync(join(dir, 'C.jsonl'), msg('u1', 'C') + '\n');

    expect(await resolveInheritedUuids(join(dir, 'C.jsonl'), 'C')).toEqual([]);
  });

  it('returns an empty list when no parent exists', async () => {
    writeFileSync(join(dir, 'C.jsonl'), msg('u1', 'C') + '\n');

    expect(await resolveInheritedUuids(join(dir, 'C.jsonl'), 'C')).toEqual([]);
  });

  it('returns null when the transcript directory is unreadable', async () => {
    expect(await resolveInheritedUuids(join(dir, 'missing', 'C.jsonl'), 'C')).toBeNull();
  });
  it('returns null when an empty transcript path would make it scan the working directory', async () => {
    expect(await resolveInheritedUuids('', 'C')).toBeNull();
  });

  it('returns null, not "no parent", when more siblings exist than the scan covers', async () => {
    for (let i = 0; i < 205; i += 1) writeFileSync(join(dir, `other-${i}.jsonl`), msg(`o${i}`, `other-${i}`) + '\n');
    writeFileSync(join(dir, 'C.jsonl'), msg('u1', 'C') + '\n');

    expect(await resolveInheritedUuids(join(dir, 'C.jsonl'), 'C')).toBeNull();
  });

  it('finds a parent whose continued-in record is followed by more than the tail window', async () => {
    // ~600 KB appended after the record: the 256 KB tail misses it, the whole-file fallback must not.
    const filler = JSON.stringify({ type: 'attachment', sessionId: 'P', attachment: { content: 'y'.repeat(1000) } });
    const trailing = Array.from({ length: 600 }, () => filler);
    writeFileSync(
      join(dir, 'P.jsonl'),
      [msg('u1', 'P'), msg('u2', 'P'), continuedIn('P', 'C'), ...trailing].join('\n') + '\n'
    );
    writeFileSync(join(dir, 'C.jsonl'), [msg('u1', 'C'), msg('u2', 'C'), msg('u3', 'C')].join('\n') + '\n');

    expect(await resolveInheritedUuids(join(dir, 'C.jsonl'), 'C')).toEqual(['u1', 'u2']);
  });

  it('closes every read stream after an early match, so no file stays open', async () => {
    // The match is found with data still unread; an open handle would leave the directory behind on Windows (ENOTEMPTY).
    const filler = JSON.stringify({ type: 'attachment', sessionId: 'P', attachment: { content: 'y'.repeat(1000) } });
    writeFileSync(join(dir, 'P.jsonl'), [msg('u1', 'P'), continuedIn('P', 'C'), ...Array.from({ length: 600 }, () => filler)].join('\n') + '\n');
    writeFileSync(join(dir, 'C.jsonl'), msg('u1', 'C') + '\n');

    expect(await resolveInheritedUuids(join(dir, 'C.jsonl'), 'C')).toEqual(['u1']);
    expect(openedStreams.length).toBeGreaterThan(0);
    expect(openedStreams.every((stream) => stream.destroyed)).toBe(true);
  });

  it('returns no parent for a large sibling whose whole file never names the session', async () => {
    const filler = JSON.stringify({ type: 'attachment', sessionId: 'X', attachment: { content: 'y'.repeat(1000) } });
    writeFileSync(join(dir, 'X.jsonl'), Array.from({ length: 600 }, () => filler).join('\n') + '\n');
    writeFileSync(join(dir, 'C.jsonl'), msg('u1', 'C') + '\n');

    expect(await resolveInheritedUuids(join(dir, 'C.jsonl'), 'C')).toEqual([]);
  });

  it('returns null, not "no parent", when a sibling transcript cannot be read', async () => {
    mkdirSync(join(dir, 'unreadable.jsonl'));
    writeFileSync(join(dir, 'C.jsonl'), msg('u1', 'C') + '\n');

    expect(await resolveInheritedUuids(join(dir, 'C.jsonl'), 'C')).toBeNull();
  });
});
