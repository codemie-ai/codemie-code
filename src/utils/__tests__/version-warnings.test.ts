import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { setupTestIsolation } from '../../../tests/helpers/test-isolation.js';

// Silence logger noise during tests
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
    // Ensure a clean file state per test — setupTestIsolation is beforeAll scope
    const { getCodemiePath } = await import('../paths.js');
    const file = getCodemiePath('version-warnings.json');
    try { await fs.unlink(file); } catch { /* ignore */ }
  });

  it('returns empty history when file missing', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    const history = await VersionWarningStore.loadHistory();
    expect(history).toEqual({ version: 1, warnings: [] });
  });

  it('hasWarned returns false on empty history', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    expect(await VersionWarningStore.hasWarned('claude', '2.1.0')).toBe(false);
  });

  it('records a marker and hasWarned returns true for the exact pair', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.0');
    expect(await VersionWarningStore.hasWarned('claude', '2.1.0')).toBe(true);
  });

  it('hasWarned distinguishes pairs (different agent version)', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.0');
    expect(await VersionWarningStore.hasWarned('claude', '2.1.1')).toBe(false);
  });

  it('hasWarned distinguishes pairs (different agent)', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.0');
    expect(await VersionWarningStore.hasWarned('codex', '2.1.0')).toBe(false);
  });

  it('recordWarning is idempotent for the same pair', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.0');
    await VersionWarningStore.recordWarning('claude', '2.1.0');
    const history = await VersionWarningStore.loadHistory();
    expect(history.warnings.length).toBe(1);
  });

  it('stores warnedAt ISO timestamp for each record', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.0');
    const history = await VersionWarningStore.loadHistory();
    expect(history.warnings[0].warnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('does not store codemieVersion in the marker record', async () => {
    // Regression guard: the codemieVersion field was removed from the key
    // (EPMCDME-13734 review round 2) — a CodeMie release must not re-nag users.
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.0');
    const history = await VersionWarningStore.loadHistory();
    expect(history.warnings[0]).not.toHaveProperty('codemieVersion');
  });

  it('clear returns removed count and empties the store', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    await VersionWarningStore.recordWarning('claude', '2.1.0');
    await VersionWarningStore.recordWarning('codex', '0.143.0');
    const result = await VersionWarningStore.clear();
    expect(result.removed).toBe(2);
    const history = await VersionWarningStore.loadHistory();
    expect(history.warnings).toEqual([]);
  });

  it('clear on missing file returns removed: 0', async () => {
    const { VersionWarningStore } = await import('../version-warnings.js');
    const result = await VersionWarningStore.clear();
    expect(result.removed).toBe(0);
  });

  it('treats corrupt JSON as empty history', async () => {
    const { getCodemiePath } = await import('../paths.js');
    const file = getCodemiePath('version-warnings.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ not json', 'utf-8');
    const { VersionWarningStore } = await import('../version-warnings.js');
    const history = await VersionWarningStore.loadHistory();
    expect(history).toEqual({ version: 1, warnings: [] });
  });
});
