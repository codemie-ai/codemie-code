import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishProducerAttribution } from '../producer-attribution.js';
import { createStatus, readStatus, writeStatus } from '../session-status.js';
import { statusFile } from '../spool-paths.js';
import { producerAttributionHeaders } from '../evidence-send.js';

const ID = 'producer-session';
const attribution = { project: 'p1', projectSource: 'profile', routedViaCodemie: true } as const;
let home: string;
beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'producer-attribution-')));
  vi.stubEnv('CODEMIE_HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('producer metadata spool boundary', () => {
  it('keeps the first producer binding even before its first event append', async () => {
    await publishProducerAttribution(ID, attribution);
    await expect(publishProducerAttribution(ID, { ...attribution, project: 'p2' })).rejects.toThrow('differs');
    expect((await readStatus(ID))?.producerAttribution).toEqual(attribution);
  });
  it('persists and reloads metadata without losing delivery progress or the project binding', async () => {
    const status = createStatus();
    status.project = 'p1'; status.cursors.hooks = 123;
    await writeStatus(ID, status);
    await publishProducerAttribution(ID, attribution);
    expect(await readStatus(ID)).toMatchObject({ project: 'p1', cursors: { hooks: 123 }, producerAttribution: attribution });
    expect(await producerAttributionHeaders(ID, 'P1')).toMatchObject({ 'X-CodeMie-Subscription-Type': 'codemie' });
    expect(await producerAttributionHeaders(ID, 'p2')).toBeUndefined();
    await expect(publishProducerAttribution(ID, { ...attribution, project: 'p2' })).rejects.toThrow('differs');
  });

  it('retries an unreadable legacy status without overwriting it', async () => {
    mkdirSync(join(home, 'proxy', 'otlp-spool'), { recursive: true });
    writeFileSync(statusFile(ID), '{broken');
    await expect(publishProducerAttribution(ID, attribution)).rejects.toThrow('unreadable');
    expect(readFileSync(statusFile(ID), 'utf-8')).toBe('{broken');
    await writeStatus(ID, createStatus());
    await publishProducerAttribution(ID, attribution);
    expect((await readStatus(ID))?.producerAttribution).toEqual(attribution);
  });

  it('keeps old statuses legacy and rejects malformed producer evidence', async () => {
    await writeStatus(ID, createStatus());
    expect(await producerAttributionHeaders(ID, 'p1')).toBeUndefined();
    for (const invalid of [{ ...attribution, routedViaCodemie: false }, { ...attribution, projectSource: 'none' }]) {
      writeFileSync(statusFile(ID), JSON.stringify({ ...createStatus(), producerAttribution: invalid }));
      expect((await readStatus(ID))?.producerAttribution).toBeUndefined();
      expect(await producerAttributionHeaders(ID, 'p1')).toBeUndefined();
    }
  });
});
