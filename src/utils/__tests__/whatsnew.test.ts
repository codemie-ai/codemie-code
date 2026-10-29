/**
 * What's New helper tests
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const changelog = vi.hoisted(() => ({ content: null as string | null }));

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  const readFileSync = ((file: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
    if (changelog.content !== null && String(file).endsWith('CHANGELOG.md')) {
      return changelog.content;
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const BASIC_FIXTURE = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- Unreleased thing',
  '',
  '## [0.16.2] - 2026-10-20',
  '',
  '### Fixed',
  '',
  '- Fix in 0.16.2',
  '',
  '## [0.15.1] - 2026-09-08',
  '',
  '### Fixed',
  '',
  '- Fix in 0.15.1',
  ''
].join('\n');

describe('getReleaseNotes', () => {
  beforeEach(() => {
    vi.resetModules();
    changelog.content = BASIC_FIXTURE;
  });

  afterEach(() => {
    changelog.content = null;
  });

  it('returns no entries for a version without a changelog section', async () => {
    const { getReleaseNotes } = await import('../whatsnew.js');
    expect(getReleaseNotes('9.9.9')).toEqual([]);
  });

  it('returns the exact entry for a version with a section', async () => {
    const { getReleaseNotes } = await import('../whatsnew.js');
    const entries = getReleaseNotes('0.16.2');
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe('0.16.2');
  });

  it('returns every entry when no version is given', async () => {
    const { getReleaseNotes } = await import('../whatsnew.js');
    expect(getReleaseNotes().map(entry => entry.version)).toEqual(['Unreleased', '0.16.2', '0.15.1']);
  });
});
