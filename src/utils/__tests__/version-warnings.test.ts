import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import { setupTestIsolation } from '../../../tests/helpers/test-isolation.js';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('VersionWarningStore', () => {
  setupTestIsolation();

  beforeEach(async () => {
    const { getCodemiePath } = await import('../paths.js');
    try {
      await fs.unlink(getCodemiePath('version-warnings.json'));
    } catch {
      /* no marker file yet */
    }
  });

  it('returns an empty history when the file is missing', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    expect(await VersionWarningStore.loadHistory()).toEqual({ version: 1, warnings: [] });
  });

  it('acknowledges an agent version against the baseline it was recorded with', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.230', '2.1.218', '0.15.1');

    expect(await VersionWarningStore.hasWarned('claude', '2.1.230', '2.1.218')).toBe(true);
  });

  it('goes stale when CodeMie moves the recommended version', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.230', '2.1.218', '0.15.1');

    expect(await VersionWarningStore.hasWarned('claude', '2.1.230', '2.1.240')).toBe(false);
  });

  it('keeps markers distinct per agent and per agent version', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.230', '2.1.218', '0.15.1');

    expect(await VersionWarningStore.hasWarned('claude', '2.1.231', '2.1.218')).toBe(false);
    expect(await VersionWarningStore.hasWarned('codex', '2.1.230', '2.1.218')).toBe(false);
  });

  it('keeps a single record per (agent, version) when the baseline moves', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.230', '2.1.218', '0.15.1');
    await VersionWarningStore.recordWarning('claude', '2.1.230', '2.1.240', '0.16.0');

    const history = await VersionWarningStore.loadHistory();
    expect(history.warnings).toHaveLength(1);
    expect(history.warnings[0].supportedVersion).toBe('2.1.240');
  });

  it('clear() reports how many markers were removed', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.230', '2.1.218', '0.15.1');
    await VersionWarningStore.recordWarning('codex', '0.144.0', '0.143.0', '0.15.1');

    expect(await VersionWarningStore.clear()).toEqual({ removed: 2 });
    expect(await VersionWarningStore.hasWarned('claude', '2.1.230', '2.1.218')).toBe(false);
  });

  it('treats a corrupt file as empty instead of throwing', async () => {
    const { getCodemiePath } = await import('../paths.js');
    const { VersionWarningStore } = await import('../version-warnings.js');
    const file = getCodemiePath('version-warnings.json');
    await fs.mkdir(getCodemiePath(), { recursive: true });
    await fs.writeFile(file, '{ not json', 'utf-8');

    expect(await VersionWarningStore.loadHistory()).toEqual({ version: 1, warnings: [] });
  });
});
