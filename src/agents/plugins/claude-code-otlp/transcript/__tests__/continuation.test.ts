import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInheritedUuids } from '../continuation.js';

let dir: string;

const msg = (uuid: string, sessionId: string): string =>
  JSON.stringify({ type: 'assistant', uuid, sessionId, message: { role: 'assistant', content: [] } });
const continuedIn = (parent: string, child: string): string =>
  JSON.stringify({ type: 'continued-in', timestamp: '2026-11-01T19:43:28.390Z', sessionId: parent, continuedInSessionId: child });

beforeEach(() => {
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
});
