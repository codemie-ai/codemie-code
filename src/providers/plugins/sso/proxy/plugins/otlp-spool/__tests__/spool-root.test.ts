/**
 * The spool root: the proxy's until an analytics plugin names its own, then the named one for every path helper.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = join(tmpdir(), 'spool-root-test-home');
const named = join(tmpdir(), 'spool-root-test-named');

describe('spool root', () => {
  beforeEach(() => {
    vi.stubEnv('CODEMIE_HOME', home);
    // The named root is the module's own state: each case starts from a fresh module.
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is the proxy spool under CODEMIE_HOME when no root is named', async () => {
    const { proxySpoolRoot, spoolRoot } = await import('../spool-paths.js');

    expect(proxySpoolRoot()).toBe(join(home, 'proxy', 'otlp-spool'));
    expect(spoolRoot()).toBe(join(home, 'proxy', 'otlp-spool'));
  });

  it('is the named directory after useSpoolRoot, for every path helper', async () => {
    const { proxySpoolRoot, spoolRoot, statusFile, streamFile, useSpoolRoot } = await import('../spool-paths.js');

    useSpoolRoot(named);

    expect(spoolRoot()).toBe(named);
    expect(streamFile('s1', 'hooks')).toBe(join(named, 's1.hooks.ndjson'));
    expect(statusFile('s1')).toBe(join(named, 's1.status'));
    expect(proxySpoolRoot()).toBe(join(home, 'proxy', 'otlp-spool'));
  });
});
