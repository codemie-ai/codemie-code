import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrRead, recordKey, sweepRecords, evidenceDir, type EvidenceFields } from '../record-store.js';
import { isStopped, stopFileName, takeNotice, writeNotice, writeStop } from '../stop-marker.js';

const DAY = 86_400_000;
let home: string;
let prev: string | undefined;
const fields: EvidenceFields = {
  session_id: 's1', launch_mode: 'native', routed_via_codemie: false, routing_proof: 'proven',
  project_source: 'none', api_identity: 'https://api.example.com', owner_hash: 'a'.repeat(64),
};
const key = recordKey(fields.api_identity, fields.owner_hash, fields.session_id);
const markerPath = () => join(evidenceDir(), stopFileName(key));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stop-marker-'));
  prev = process.env.CODEMIE_HOME;
  process.env.CODEMIE_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe('stop-marker', () => {
  it('is not stopped until written, then sticky and survives record eviction', async () => {
    expect(await isStopped(key)).toBe(false);
    await createOrRead(key, fields);
    await writeStop(key, 'folder_changed', 's1');
    const rec = join(evidenceDir(), `${key}.json`);
    rmSync(rec);
    expect(await isStopped(key)).toBe(true);
    await writeStop(key, 'consent_revoked', 's1'); // first reason wins
    expect(await takeNotice(key)).toBe('folder_changed');
  });

  it('takeNotice returns the reason once', async () => {
    await writeStop(key, 'response_unverified', 's1');
    expect(await takeNotice(key)).toBe('response_unverified');
    expect(await takeNotice(key)).toBeUndefined();
    expect(await isStopped(key)).toBe(true);
  });

  it('a corrupt marker reads as stopped and yields no notice', async () => {
    await writeStop(key, 'resume_unknown', 's1');
    writeFileSync(markerPath(), '{not json');
    expect(await isStopped(key)).toBe(true);
    expect(await takeNotice(key)).toBeUndefined();
  });

  it('an unknown reason is stored as a bounded code', async () => {
    await writeStop(key, 'C:\\secret\\path' as never, 's1');
    expect(await takeNotice(key)).toBe('unspecified');
  });

  it('sweep keeps the marker while queued data exists, drops it only when everything is absent and old', async () => {
    await writeStop(key, 'folder_changed', 's1');
    const old = new Date(Date.now() - 400 * DAY);
    utimesSync(markerPath(), old, old);
    await sweepRecords({ pendingKeys: new Set(), pendingSessionIds: new Set(['s1']) });
    expect(existsSync(markerPath())).toBe(true);
    await sweepRecords({ pendingKeys: new Set(), pendingSessionIds: new Set() });
    expect(existsSync(markerPath())).toBe(false);
  });

  it('sweep keeps the marker while its record exists', async () => {
    await createOrRead(key, fields);
    await writeStop(key, 'folder_changed', 's1');
    const old = new Date(Date.now() - 400 * DAY);
    utimesSync(markerPath(), old, old);
    await sweepRecords({ pendingKeys: new Set() });
    expect(existsSync(markerPath())).toBe(true);
  });

  it('a notice-only marker does not stop publication, shows once, and is upgraded by a later stop', async () => {
    await writeNotice(key, 'hold_contract_unavailable', 's1');
    expect(await isStopped(key)).toBe(false);
    expect(await takeNotice(key)).toBe('hold_contract_unavailable');
    await writeStop(key, 'hold_expired', 's1');
    expect(await isStopped(key)).toBe(true);
    expect(await takeNotice(key)).toBe('hold_expired');
    await writeNotice(key, 'folder_changed', 's1'); // never downgrades a stop
    expect(await isStopped(key)).toBe(true);
  });
});
