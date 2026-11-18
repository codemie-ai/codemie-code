/**
 * The Cowork attribution pin and the funding gate built on it, over a temp CODEMIE_HOME (real files, no mocks).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coworkFundingSource, loadCoworkAttribution, saveCoworkAttribution } from '../cowork-attribution.js';
import { markCoworkSessionServed } from '../cowork-served-mark.js';

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

    await saveCoworkAttribution(ID, { project: 'p', projectSource: 'none' });
    expect(await coworkFundingSource(ID, 'p')).toBeUndefined();
  });
});
