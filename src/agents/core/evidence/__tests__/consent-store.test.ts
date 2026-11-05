import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { connectFolder, consentHolds, consentStorePath, disconnectFolder, resolveConsent } from '../consent-store.js';

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

  it('the store lives under the CodeMie home, outside any repository', () => {
    expect(consentStorePath().startsWith(join(home, '.codemie'))).toBe(true);
    expect(consentStorePath().startsWith(work)).toBe(false);
  });
});
