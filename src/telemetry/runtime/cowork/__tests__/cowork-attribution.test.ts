/**
 * The Cowork attribution pin and the funding gate built on it, over a temp CODEMIE_HOME (real files, no mocks).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coworkFundingSource, loadCoworkAttribution, saveCoworkAttribution } from '../cowork-attribution.js';
import { markCoworkSessionServed } from '../cowork-served-mark.js';
import { coworkFundingHeaders } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/evidence-send.js';

const ID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
let codemieHome: string;
const attributionFile = () => join(codemieHome, 'analytics', 'state', `${ID}.cowork-attribution.json`);
const markFile = () => join(codemieHome, 'analytics', 'state', `${ID}.cowork-served`);

beforeEach(() => {
  codemieHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'cowork-attribution-')));
  vi.stubEnv('CODEMIE_HOME', codemieHome);
  mkdirSync(join(codemieHome, 'analytics', 'state'), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(codemieHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the attribution pin', () => {
  it('reads back what was saved', async () => {
    await saveCoworkAttribution(ID, { project: 'p', projectSource: 'linked_folder' });

    expect(await loadCoworkAttribution(ID)).toEqual({ project: 'p', projectSource: 'linked_folder' });
  });

  it('is write-once: the first pin wins when two processings race, and no temp file is left behind', async () => {
    const [first, second] = await Promise.all([
      saveCoworkAttribution(ID, { project: 'first', projectSource: 'profile' }),
      saveCoworkAttribution(ID, { project: 'second', projectSource: 'linked_folder' }),
    ]);

    expect(second).toEqual(first);
    expect(await loadCoworkAttribution(ID)).toEqual(first);
    expect(readdirSync(join(codemieHome, 'analytics', 'state')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces an unreadable pin file', async () => {
    writeFileSync(attributionFile(), '{nope');

    expect(await saveCoworkAttribution(ID, { project: 'p', projectSource: 'profile' })).toEqual({ project: 'p', projectSource: 'profile' });
    expect(await loadCoworkAttribution(ID)).toEqual({ project: 'p', projectSource: 'profile' });
  });

  it('does not replace state it cannot read (an I/O error is not a corrupt pin) and leaves no temp file', async () => {
    mkdirSync(attributionFile()); // reading a directory fails with EISDIR, not ENOENT/parse

    await expect(saveCoworkAttribution(ID, { project: 'p', projectSource: 'profile' })).rejects.toMatchObject({ code: 'EISDIR' });
    expect(statSync(attributionFile()).isDirectory()).toBe(true);
    expect(readdirSync(join(codemieHome, 'analytics', 'state')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await loadCoworkAttribution(ID)).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['not JSON', '{nope'],
    ['of another shape', '{"project":1,"projectSource":"profile"}'],
    ['with an unknown source', '{"project":"p","projectSource":"elsewhere"}'],
  ])('is null when the file is %s', async (_case, content) => {
    if (content !== undefined) writeFileSync(attributionFile(), content);

    expect(await loadCoworkAttribution(ID)).toBeNull();
  });
});

describe('the funding headers (coworkFundingHeaders)', () => {
  it('declare funding with the Project header for a served, pinned session', async () => {
    await markCoworkSessionServed(ID);
    await saveCoworkAttribution(ID, { project: 'p', projectSource: 'profile' });

    const headers = await coworkFundingHeaders(ID, 'p');

    expect(headers).toMatchObject({ 'X-CodeMie-Routed-Via-CodeMie': 'true', 'X-CodeMie-Subscription-Type': 'codemie', 'X-CodeMie-Project': 'p' });
  });

  it('declare nothing when the project cannot travel as a raw header (never funding without a Project header)', async () => {
    await markCoworkSessionServed(ID);
    await saveCoworkAttribution(ID, { project: 'проект', projectSource: 'profile' });

    expect(await coworkFundingHeaders(ID, 'проект')).toBeUndefined();
  });
});

describe('the funding gate', () => {
  it('names the pinned source for the pinned project of a served session, case-insensitively', async () => {
    await markCoworkSessionServed(ID);
    await saveCoworkAttribution(ID, { project: 'My-Project', projectSource: 'profile' });

    expect(await coworkFundingSource(ID, 'my-project')).toBe('profile');
  });

  it('makes no claim without a served mark', async () => {
    await saveCoworkAttribution(ID, { project: 'p', projectSource: 'profile' });

    expect(await coworkFundingSource(ID, 'p')).toBeUndefined();
  });

  it('makes no claim without a pin, with another project than the pinned one, with a pin of no source, or with no project', async () => {
    writeFileSync(markFile(), '');
    expect(await coworkFundingSource(ID, 'p')).toBeUndefined();

    await saveCoworkAttribution(ID, { project: 'p', projectSource: 'profile' });
    expect(await coworkFundingSource(ID, 'q')).toBeUndefined();
    expect(await coworkFundingSource(ID, '')).toBeUndefined();

    rmSync(attributionFile());
    await saveCoworkAttribution(ID, { project: 'p', projectSource: 'none' });
    expect(await coworkFundingSource(ID, 'p')).toBeUndefined();
  });
});
