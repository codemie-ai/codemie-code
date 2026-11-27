import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import {
  connectAllFolders,
  connectFolder,
  consentHolds,
  coveringEntries,
  consentStorePath,
  disconnectAllFolders,
  disconnectFolder,
  listConsents,
  lookupConsent,
  resolveConsent,
} from '../consent-store.js';

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

  it('without a known folder only the all-folders entry grants consent', async () => {
    await connectFolder(scope, work);
    expect(await lookupConsent(scope, undefined)).toEqual({ kind: 'none' });
    await connectAllFolders(scope);
    const any = await lookupConsent(scope, undefined);
    expect(any).toMatchObject({ kind: 'found', ref: expect.stringMatching(/^[0-9a-f]{16}$/) });
    // A known folder still prefers its folder-bound entry.
    const inFolder = await lookupConsent(scope, join(work, 'sub', 'deep'));
    expect(inFolder).toMatchObject({ kind: 'found' });
    expect(inFolder).not.toEqual(any);
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

  it('an entry without an incarnation is rejected and cannot authorize its old frozen reference', async () => {
    const other = join(home, 'other');
    mkdirSync(other);
    await connectFolder(scope, other);
    const otherRef = (await resolveConsent(scope, other))!;
    const raw = JSON.parse(readFileSync(consentStorePath(), 'utf-8')) as { entries: Array<Record<string, unknown>> };
    delete raw.entries[0].id;
    writeFileSync(consentStorePath(), JSON.stringify(raw));
    expect(await resolveConsent(scope, other)).toBeUndefined();
    expect(await consentHolds(otherRef, scope)).toBe(false);
    await expect(connectFolder(scope, other)).rejects.toThrow(/unreadable/);
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
  it('lists only the signed-in owner and backend entries, and keeps an unreadable store apart from none', async () => {
    await connectFolder(scope, work);
    await connectFolder({ ...scope, owner_hash: 'p'.repeat(64) }, join(work, 'sub'));
    await connectFolder({ ...scope, api_identity: 'https://other.example.com' }, join(work, 'sub', 'deep'));
    const owner = { owner_hash: scope.owner_hash, api_identity: scope.api_identity };

    const listed = await listConsents(owner);
    expect(listed.kind === 'ok' ? listed.entries.map((e) => e.project) : listed).toEqual(['Proj-A']);
    expect(listed.kind === 'ok' && listed.entries[0].owner_hash).toBe(scope.owner_hash);

    writeFileSync(consentStorePath(), '{ not json');
    expect(await listConsents(owner)).toEqual({ kind: 'unreadable' });
  });
});

describe('consent-store: all-folders entry', () => {
  const owner = { owner_hash: scope.owner_hash, api_identity: scope.api_identity };
  type Raw = { version: number; entries: Array<Record<string, unknown>> };
  const readRaw = (): Raw => JSON.parse(readFileSync(consentStorePath(), 'utf-8')) as Raw;

  it('covers two unrelated folders and any project of the same owner and backend', async () => {
    const other = join(home, 'elsewhere');
    mkdirSync(other);
    await connectAllFolders(owner);
    const a = await resolveConsent(scope, work);
    const b = await resolveConsent({ ...scope, project: 'Another-Project' }, other);
    expect(a).toBeTruthy();
    expect(b).toBe(a);
    expect(await resolveConsent({ ...scope, owner_hash: 'p'.repeat(64) }, work)).toBeUndefined();
    expect(await resolveConsent({ ...scope, api_identity: 'https://other.example.com' }, work)).toBeUndefined();
    expect(await resolveConsent({ ...scope, project: ' ' }, work)).toBeUndefined();
  });

  it('does not cover a project whose name is not Latin-1, and still covers a Latin-1 one', async () => {
    await connectAllFolders(owner);
    expect(await resolveConsent({ ...scope, project: 'Проект' }, work)).toBeUndefined();
    expect(await resolveConsent({ ...scope, project: 'Projekt-é' }, work)).toBeTruthy();
  });

  it('a frozen reference keeps holding in another cwd', async () => {
    await connectAllFolders(owner);
    const ref = (await resolveConsent(scope, work))!;
    expect(await consentHolds(ref, scope, join(home, 'moved'))).toBe(true);
    expect(await consentHolds(ref, scope)).toBe(true);
    expect(await disconnectAllFolders(owner)).toBe(1);
    expect(await consentHolds(ref, scope, work)).toBe(false);
  });

  it('a folder-bound match wins over the all-folders entry', async () => {
    await connectAllFolders(owner);
    const allRef = (await resolveConsent(scope, work))!;
    await connectFolder(scope, work);
    const folderRef = await resolveConsent(scope, join(work, 'sub'));
    expect(folderRef).toBeTruthy();
    expect(folderRef).not.toBe(allRef);
    expect(await resolveConsent(scope, join(home, 'unrelated'))).toBe(allRef);
  });

  it('is idempotent: a repeated connect keeps the reference', async () => {
    await connectAllFolders(owner);
    const first = (await resolveConsent(scope, work))!;
    await connectAllFolders(owner);
    expect(await resolveConsent(scope, work)).toBe(first);
    expect(readRaw().entries).toHaveLength(1);
  });

  it('disconnectFolder never removes it, disconnectAllFolders removes only it', async () => {
    await connectAllFolders(owner);
    await connectFolder(scope, work);
    expect(await disconnectFolder(owner, work)).toBe(1);
    expect(readRaw().entries.map((e) => e.all_folders)).toEqual([true]);
    await connectFolder(scope, work);
    expect(await disconnectAllFolders(owner)).toBe(1);
    expect(readRaw().entries.every((e) => e.all_folders !== true)).toBe(true);
    expect(readRaw().entries).toHaveLength(1);
    expect(await disconnectAllFolders(owner)).toBe(0);
  });

  it('is listed and covers any folder in coveringEntries', async () => {
    await connectAllFolders(owner);
    const listed = await listConsents(owner);
    expect(listed.kind === 'ok' ? listed.entries.map((e) => e.all_folders) : listed).toEqual([true]);
    const covering = await coveringEntries(owner, join(home, 'anywhere'));
    expect(covering.map((e) => e.all_folders)).toEqual([true]);
    expect(await coveringEntries({ ...owner, owner_hash: 'p'.repeat(64) }, work)).toEqual([]);
  });

  it('an all_folders entry without both sentinels makes the store unreadable', async () => {
    await connectAllFolders(owner);
    const raw = readRaw();
    raw.entries[0].folder = '/some/folder';
    writeFileSync(consentStorePath(), JSON.stringify(raw));
    expect(await resolveConsent(scope, work)).toBeUndefined();
  });

  it('refuses to overwrite an unreadable store', async () => {
    mkdirSync(dirname(consentStorePath()), { recursive: true });
    writeFileSync(consentStorePath(), '{ not json');
    await expect(connectAllFolders(owner)).rejects.toThrow(/unreadable/);
  });

  it('compat (a): an older build still loads the store, never matches the entry, and keeps it', async () => {
    await connectAllFolders(owner);
    const raw = readRaw();
    // Verbatim copy of the previous validEntry and project match.
    const oldValid = (v: unknown): boolean => {
      if (!v || typeof v !== 'object') return false;
      const e = v as Record<string, unknown>;
      if (typeof e.id !== 'string' || !/^[0-9a-f]{16}$/.test(e.id)) return false;
      return ['owner_hash', 'api_identity', 'project', 'folder'].every((k) => typeof e[k] === 'string' && (e[k] as string).length > 0);
    };
    expect(raw.version).toBe(1);
    expect(raw.entries.every(oldValid)).toBe(true);
    const oldMatches = (e: Record<string, unknown>, s: typeof scope): boolean =>
      e.owner_hash === s.owner_hash && e.api_identity === s.api_identity && String(e.project).trim().toLowerCase() === s.project.trim().toLowerCase();
    expect(raw.entries.some((e) => oldMatches(e, scope))).toBe(false);
    // An old-style connect (folder entry written beside it) keeps the all-folders entry, extra field included.
    await connectFolder(scope, work);
    expect(readRaw().entries.filter((e) => e.all_folders === true)).toHaveLength(1);
  });

  it('compat (b): a store written by an older build loads and behaves unchanged', async () => {
    const canonical = await connectFolder(scope, work);
    // The oldest shape: no connected_at, no all_folders.
    writeFileSync(
      consentStorePath(),
      JSON.stringify({
        version: 1,
        entries: [{ owner_hash: scope.owner_hash, api_identity: scope.api_identity, project: scope.project, folder: canonical, id: '0123456789abcdef' }],
      })
    );
    expect(await resolveConsent(scope, join(work, 'sub'))).toBeTruthy();
    expect(await resolveConsent(scope, join(home, 'elsewhere'))).toBeUndefined();
    expect(await disconnectFolder(owner, work)).toBe(1);
    expect(await disconnectAllFolders(owner)).toBe(0);
  });
});
