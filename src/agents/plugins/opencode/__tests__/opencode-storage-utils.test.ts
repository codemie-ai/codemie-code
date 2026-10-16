/** SQLite parts retain backend order while legacy files retain their ID order. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPartsForMessage } from '../opencode.storage-utils.js';

interface Part { id: string; messageID: string; sessionID: string }
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'opencode-parts-order-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('loadPartsForMessage', () => {
  it('preserves numeric content order across multi-digit IDs without mutating the source', async () => {
    const parts = Array.from({ length: 12 }, (_, index) => ({ id: `message:${index}`, messageID: 'message', sessionID: 'ses_source' }));
    const original = [...parts];
    expect((await loadPartsForMessage(root, 'message', 'ses_source', { message: parts })).map(part => part.id))
      .toEqual(Array.from({ length: 12 }, (_, index) => `message:${index}`));
    expect(parts).toEqual(original);
  });

  it('filters orphaned parts without reordering the remaining backend sequence', async () => {
    const parts: Part[] = [
      { id: 'message:2', messageID: 'message', sessionID: 'ses_source' },
      { id: 'message:1', messageID: 'wrong-message', sessionID: 'ses_source' },
      { id: 'message:3', messageID: 'message', sessionID: 'wrong-session' },
      { id: 'message:10', messageID: 'message', sessionID: 'ses_source' },
    ];
    expect((await loadPartsForMessage(root, 'message', 'ses_source', { message: parts })).map(part => part.id))
      .toEqual(['message:2', 'message:10']);
  });

  it('does not revive stale file parts when a preloaded map has an empty message entry', async () => {
    const dir = join(root, 'part', 'message');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stale.json'), JSON.stringify({ id: 'stale', messageID: 'message', sessionID: 'ses_source' }));
    expect(await loadPartsForMessage(root, 'message', 'ses_source', { message: [] })).toEqual([]);
  });

  it('keeps sorting legacy file-backed parts by ID', async () => {
    const dir = join(root, 'part', 'message');
    mkdirSync(dir, { recursive: true });
    for (const id of ['part-z', 'part-a']) {
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, messageID: 'message', sessionID: 'ses_source' }));
    }
    expect((await loadPartsForMessage(root, 'message', 'ses_source')).map(part => part.id)).toEqual(['part-a', 'part-z']);
  });
});
