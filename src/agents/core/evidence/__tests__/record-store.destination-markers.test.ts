/**
 * The record sweep and the destination markers (EPMCDME-17054): an evicted record takes every accepted marker of its key
 * before its ended marker, and a sweep that cannot list the markers evicts nothing.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The first directory listing of a sweep (the destination markers') fails while set. */
const faults = vi.hoisted(() => ({ failFirstReaddir: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
      if (faults.failFirstReaddir) {
        faults.failFirstReaddir = false;
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      return actual.readdir(...args);
    }),
  };
});

const { createOrRead, endedFileName, evidenceDir, recordKey, sweepRecords } = await import('../record-store.js');
const { writeAccepted, writeDestinationMarker } = await import('../accepted-marker.js');

const DAY = 86_400_000;
const FIELDS = {
  session_id: 'native-1', launch_mode: 'native', routed_via_codemie: false, routing_proof: 'proven', project: 'proj',
  project_source: 'profile', api_identity: 'https://api.example.com', owner_hash: 'a'.repeat(64),
} as const;
const KEY = recordKey(FIELDS.api_identity, FIELDS.owner_hash, FIELDS.session_id);

let home: string;
const savedHome = process.env.CODEMIE_HOME;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'rec-markers-'));
  process.env.CODEMIE_HOME = home;
  faults.failFirstReaddir = false;
  await createOrRead(KEY, { ...FIELDS });
  // An idle record: evicted by the sweep unless something keeps it
  const path = join(evidenceDir(), `${KEY}.json`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf-8')), last_used: Date.now() - 91 * DAY }));
  await writeAccepted(KEY, FIELDS.session_id, 'Project A');
  await writeAccepted(KEY, FIELDS.session_id, 'Project B');
  await writeDestinationMarker({ marker: 'ended' }, KEY, FIELDS.session_id);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const markers = (): string[] => readdirSync(evidenceDir()).filter((n) => n.startsWith(KEY) && n !== `${KEY}.json`).sort();

describe('record sweep and destination markers', () => {
  it('an evicted record takes every accepted marker of its key, and then its ended marker', async () => {
    expect(markers().filter((n) => n.endsWith('.accepted.json'))).toHaveLength(2);
    const res = await sweepRecords({ pendingKeys: new Set() });
    expect(res.evicted).toBe(1);
    expect(markers()).toEqual([]);
  });

  it('a sweep that cannot list the destination markers evicts nothing, so an ended marker never goes alone', async () => {
    faults.failFirstReaddir = true;
    const res = await sweepRecords({ pendingKeys: new Set() });
    expect(res).toEqual({ evicted: 0, capacityBlocked: true });
    expect(readdirSync(evidenceDir())).toContain(`${KEY}.json`);
    expect(markers()).toContain(endedFileName(KEY));
    expect(markers().filter((n) => n.endsWith('.accepted.json'))).toHaveLength(2);
  });
});
