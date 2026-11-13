import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordKey, evidenceDir } from '../record-store.js';
import { isStopped, stopFileName, takeNotice, writeNotice, writeStop } from '../stop-marker.js';

let home: string;
let prev: string | undefined;
const key = recordKey('https://api.example.com', 'a'.repeat(64), 's1');
const markerPath = () => join(evidenceDir(), stopFileName(key));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stop-marker-atomic-'));
  prev = process.env.CODEMIE_HOME;
  process.env.CODEMIE_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe('stop marker is create-once and never observable half-written', () => {
  it('concurrent notice and stop writes leave one whole, stopped marker and no temp file', async () => {
    await Promise.all([writeNotice(key, 'hold_expired', 's1'), writeStop(key, 'folder_changed', 's1'), writeNotice(key, 'hold_state_unknown', 's1')]);
    expect(await isStopped(key)).toBe(true);
    expect(readdirSync(evidenceDir()).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(readFileSync(markerPath(), 'utf-8')).schema).toBe(1);
  });

  it('a stop against an existing unreadable (empty) marker is written, not swallowed', async () => {
    mkdirSync(evidenceDir(), { recursive: true });
    writeFileSync(markerPath(), '');
    await writeStop(key, 'consent_revoked', 's1');
    expect(JSON.parse(readFileSync(markerPath(), 'utf-8'))).toMatchObject({ stop: true, reason: 'consent_revoked' });
  });

  it('overlapping upgrades of a notice keep exactly one accepted stop reason, which later stops never replace', async () => {
    await writeNotice(key, 'hold_contract_unavailable', 's1');
    await Promise.all([writeStop(key, 'hold_expired', 's1'), writeStop(key, 'folder_changed', 's1')]);
    const first = JSON.parse(readFileSync(markerPath(), 'utf-8'));
    expect(first.stop).toBe(true);
    expect(['hold_expired', 'folder_changed']).toContain(first.reason);
    await writeStop(key, 'consent_revoked', 's1');
    await writeNotice(key, 'hold_state_unknown', 's1');
    expect(JSON.parse(readFileSync(markerPath(), 'utf-8'))).toEqual(first);
  });

  it('a stop upgrades a whole notice marker; a later notice never relaxes it', async () => {
    await writeNotice(key, 'hold_contract_unavailable', 's1');
    expect(await isStopped(key)).toBe(false);
    await writeStop(key, 'hold_expired', 's1');
    await writeNotice(key, 'hold_state_unknown', 's1');
    expect(await isStopped(key)).toBe(true);
    expect(await takeNotice(key)).toBe('hold_expired');
  });
});
