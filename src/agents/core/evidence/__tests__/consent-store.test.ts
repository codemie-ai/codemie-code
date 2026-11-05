import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { connectFolder, consentHolds, coveringEntries, consentStorePath, disconnectFolder, resolveConsent } from '../consent-store.js';

let home: string;
let work: string;
let prev: string | undefined;
const scope = { owner_hash: 'o'.repeat(64), api_identity: 'https://api.example.com', project: 'Proj-A' };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'consent-'));
  prev = process.env.CODEMIE_HOME;
  process.env.CODEMIE_HOME = join(home, '.codemie');
  work = join(home, 'repo');
  mkdirSync(join(work, 'sub', 'deep'), { recursive: true });
});
afterEach(() => {
  if (prev === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe('consent-store', () => {
  it('grants consent to the folder and its descendants only for the same owner, backend and project', async () => {
    await connectFolder(scope, work);
    expect(await resolveConsent(scope, join(work, 'sub', 'deep'))).toBeTruthy();
    expect(await resolveConsent({ ...scope, project: 'proj-a' }, work)).toBeTruthy(); // case-insensitive project
    expect(await resolveConsent({ ...scope, project: 'other' }, work)).toBeUndefined();
    expect(await resolveConsent({ ...scope, owner_hash: 'p'.repeat(64) }, work)).toBeUndefined();
    expect(await resolveConsent({ ...scope, api_identity: 'https://other.example.com' }, work)).toBeUndefined();
    expect(await resolveConsent(scope, join(home, 'moved'))).toBeUndefined();
    expect(await resolveConsent({ ...scope, project: ' ' }, work)).toBeUndefined();
  });

  it('a cloned .codemie workspace config grants nothing', async () => {
    mkdirSync(join(work, '.codemie'));
    writeFileSync(join(work, '.codemie', 'codemie-cli.config.json'), JSON.stringify({ codeMieProject: 'Proj-A', workConsent: true }));
    expect(await resolveConsent(scope, work)).toBeUndefined();
  });

  it('refuses a filesystem root, the home directory and its ancestors, but not a repo subfolder', async () => {
    await expect(connectFolder(scope, parse(work).root)).rejects.toThrow(/Refusing/);
    await expect(connectFolder(scope, homedir())).rejects.toThrow(/Refusing/);
    await expect(connectFolder(scope, dirname(homedir()))).rejects.toThrow(/Refusing/);
    await expect(connectFolder(scope, join(work, 'sub'))).resolves.toBeTruthy();
  });

  it('a corrupt or unknown-version store is no consent, and connect will not overwrite it', async () => {
    await connectFolder(scope, work);
    writeFileSync(consentStorePath(), '{"version":1,"entries":[{"x":1}]}');
    expect(await resolveConsent(scope, work)).toBeUndefined();
    writeFileSync(consentStorePath(), '{"version":2,"entries":[]}');
    expect(await resolveConsent(scope, work)).toBeUndefined();
    writeFileSync(consentStorePath(), 'garbage');
    expect(await resolveConsent(scope, work)).toBeUndefined();
    await expect(connectFolder(scope, work)).rejects.toThrow(/unreadable/);
  });

  it('disconnect removes consent, and a frozen reference stops holding', async () => {
    await connectFolder(scope, work);
    const ref = (await resolveConsent(scope, work))!;
    expect(await consentHolds(ref, scope, join(work, 'sub'))).toBe(true);
    expect(await consentHolds(ref, scope, join(home, 'elsewhere'))).toBe(false);
    expect(await disconnectFolder(scope, work)).toBe(1);
    expect(await resolveConsent(scope, work)).toBeUndefined();
    expect(await consentHolds(ref, scope)).toBe(false);
  });

  it('repeated connect keeps the reference; disconnect then reconnect issues a new one that the old reference never matches', async () => {
    await connectFolder(scope, work);
    const first = (await resolveConsent(scope, work))!;
    await connectFolder(scope, work);
    expect(await resolveConsent(scope, work)).toBe(first);
    await disconnectFolder(scope, work);
    await connectFolder(scope, work);
    const second = (await resolveConsent(scope, work))!;
    expect(second).not.toBe(first);
    expect(await consentHolds(first, scope)).toBe(false);
    expect(await consentHolds(second, scope)).toBe(true);
  });

  it('an older id-less entry keeps its reference and is not upgraded by connect; unrelated connections are untouched', async () => {
    const other = join(home, 'other');
    mkdirSync(other);
    await connectFolder(scope, other);
    const otherRef = (await resolveConsent(scope, other))!;
    const raw = JSON.parse(readFileSync(consentStorePath(), 'utf-8')) as { entries: Array<Record<string, unknown>> };
    delete raw.entries[0].id;
    writeFileSync(consentStorePath(), JSON.stringify(raw));
    const legacyRef = (await resolveConsent(scope, other))!;
    expect(legacyRef).not.toBe(otherRef); // the id was part of the new reference
    await connectFolder(scope, other); // idempotent: no upgrade
    expect(await resolveConsent(scope, other)).toBe(legacyRef);
    await connectFolder(scope, work);
    await disconnectFolder(scope, work);
    expect(await consentHolds(legacyRef, scope)).toBe(true);
    await disconnectFolder(scope, other);
    await connectFolder(scope, other);
    expect(await consentHolds(legacyRef, scope)).toBe(false);
  });

  it('a malformed entry id makes the store unreadable (no consent)', async () => {
    await connectFolder(scope, work);
    const raw = JSON.parse(readFileSync(consentStorePath(), 'utf-8')) as { entries: Array<Record<string, unknown>> };
    raw.entries[0].id = 7;
    writeFileSync(consentStorePath(), JSON.stringify(raw));
    expect(await resolveConsent(scope, work)).toBeUndefined();
  });

  it('the store lives under the CodeMie home, outside any repository', () => {
    expect(consentStorePath().startsWith(join(home, '.codemie'))).toBe(true);
    expect(consentStorePath().startsWith(work)).toBe(false);
  });

  it('concurrent connects of different folders and a disconnect never lose an update (serialized read-modify-save)', async () => {
    const folders = [1, 2, 3, 4, 5, 6].map((n) => { const f = join(work, `f${n}`); mkdirSync(f); return f; });
    await connectFolder(scope, work);
    await Promise.all([...folders.map((f) => connectFolder(scope, f)), disconnectFolder(scope, work)]);
    expect(await resolveConsent(scope, work)).toBeUndefined(); // the revoke is not restored by a racing connect
    for (const f of folders) expect(await resolveConsent(scope, f)).toBeTruthy();
  });

  it('a subfolder disconnect leaves the parent entry in force and names it via coveringEntries', async () => {
    await connectFolder(scope, work);
    const sub = join(work, 'sub');
    expect(await disconnectFolder(scope, sub)).toBe(0);
    const covering = await coveringEntries(scope, sub);
    expect(covering.map((e) => e.project)).toEqual([scope.project]);
    expect(await resolveConsent(scope, sub)).toBeTruthy();
    expect(await coveringEntries({ ...scope, owner_hash: 'p'.repeat(64) }, sub)).toEqual([]);
    expect(await disconnectFolder(scope, work)).toBe(1);
    expect(await coveringEntries(scope, sub)).toEqual([]);
  });
});
