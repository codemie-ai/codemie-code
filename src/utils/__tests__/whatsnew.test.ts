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

const RANGE_VERSIONS = ['0.16.2', '0.16.1', '0.16.0', '0.15.1', '0.15.0'];

function rangeFixture(versions: string[]): string {
  const lines = ['# Changelog', '', '## [Unreleased]', '', '### Added', '', '- Unreleased thing', ''];
  for (const version of versions) {
    lines.push(`## [${version}] - 2026-10-01`, '', '### Fixed', '', `- Fix in ${version}`, '');
  }
  return lines.join('\n');
}

describe('decideUpgradeNotice', () => {
  it('records silently when there is no usable marker', async () => {
    const { decideUpgradeNotice } = await import('../whatsnew.js');
    expect(decideUpgradeNotice('0.16.2', null)).toBe('record-silently');
    expect(decideUpgradeNotice('0.16.2', 'garbage')).toBe('record-silently');
    expect(decideUpgradeNotice('0.16.2', '0.17.0-beta.1')).toBe('record-silently');
  });

  it('shows the notice after an upgrade', async () => {
    const { decideUpgradeNotice } = await import('../whatsnew.js');
    expect(decideUpgradeNotice('0.16.2', '0.15.1')).toBe('show');
  });

  it('does nothing for the same or an older installed version', async () => {
    const { decideUpgradeNotice } = await import('../whatsnew.js');
    expect(decideUpgradeNotice('0.16.2', '0.16.2')).toBe('none');
    expect(decideUpgradeNotice('0.16.0', '0.16.2')).toBe('none');
  });

  it('does nothing when the installed version cannot be parsed', async () => {
    const { decideUpgradeNotice } = await import('../whatsnew.js');
    expect(decideUpgradeNotice('unknown', '0.15.1')).toBe('none');
    expect(decideUpgradeNotice('unknown', null)).toBe('none');
  });
});

describe('selectUpgradeEntries', () => {
  it('selects the versions after last-seen up to installed, newest first', async () => {
    const { parseChangelog, selectUpgradeEntries } = await import('../whatsnew.js');
    const entries = parseChangelog(rangeFixture(RANGE_VERSIONS));

    const result = selectUpgradeEntries(entries, '0.15.1', '0.16.2');

    expect(result.shown.map(entry => entry.version)).toEqual(['0.16.2', '0.16.1', '0.16.0']);
    expect(result.hasMore).toBe(false);
  });

  it('caps the range at three versions and reports the rest', async () => {
    const { parseChangelog, selectUpgradeEntries } = await import('../whatsnew.js');
    const entries = parseChangelog(rangeFixture(RANGE_VERSIONS));

    const result = selectUpgradeEntries(entries, '0.15.0', '0.16.2');

    expect(result.shown.map(entry => entry.version)).toEqual(['0.16.2', '0.16.1', '0.16.0']);
    expect(result.hasMore).toBe(true);
  });

  it('never selects Unreleased or non-semver headings', async () => {
    const { parseChangelog, selectUpgradeEntries } = await import('../whatsnew.js');
    const entries = parseChangelog(rangeFixture(['0.16.2', 'next', '0.16.1']));

    const result = selectUpgradeEntries(entries, '0.16.0', '0.16.2');

    expect(result.shown.map(entry => entry.version)).toEqual(['0.16.2', '0.16.1']);
  });

  it('shows nothing when the installed version has no section', async () => {
    const { parseChangelog, selectUpgradeEntries } = await import('../whatsnew.js');
    const entries = parseChangelog(rangeFixture(RANGE_VERSIONS.filter(version => version !== '0.16.2')));

    const result = selectUpgradeEntries(entries, '0.15.1', '0.16.2');

    expect(result.shown).toEqual([]);
    expect(result.hasMore).toBe(true);
  });
});

describe('shouldRunUpgradeNotice', () => {
  it('skips hook invocations, including after global options', async () => {
    const { shouldRunUpgradeNotice } = await import('../whatsnew.js');
    expect(shouldRunUpgradeNotice(['hook', '--agent', 'x'], true)).toBe(false);
    expect(shouldRunUpgradeNotice(['--debug', 'hook'], true)).toBe(false);
  });

  it('skips when stdout is not known to be a TTY', async () => {
    const { shouldRunUpgradeNotice } = await import('../whatsnew.js');
    expect(shouldRunUpgradeNotice(['proxy', 'start'], undefined)).toBe(false);
    expect(shouldRunUpgradeNotice(['proxy', 'start'], false)).toBe(false);
  });

  it('skips invocations with their own output contract', async () => {
    const { shouldRunUpgradeNotice } = await import('../whatsnew.js');
    expect(shouldRunUpgradeNotice(['--version'], true)).toBe(false);
    expect(shouldRunUpgradeNotice(['-V'], true)).toBe(false);
    expect(shouldRunUpgradeNotice(['claude', '--task', 'x'], true)).toBe(false);
    expect(shouldRunUpgradeNotice(['--help'], true)).toBe(false);
  });

  it('runs for an interactive command', async () => {
    const { shouldRunUpgradeNotice } = await import('../whatsnew.js');
    expect(shouldRunUpgradeNotice(['proxy', 'start'], true)).toBe(true);
  });
});

describe('showUpgradeNotice', () => {
  // eslint-disable-next-line no-control-regex
  const ANSI = /\u001b\[[0-9;]*m/g;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let home: string;
  const originalHome = process.env.CODEMIE_HOME;
  const originalTips = process.env.CODEMIE_TIPS;

  const lines = (): string[] =>
    consoleLogSpy.mock.calls.map((call: unknown[]) => call.join(' ').replace(ANSI, ''));

  beforeEach(async () => {
    vi.resetModules();
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    home = mkdtempSync(join(tmpdir(), 'codemie-whatsnew-'));
    process.env.CODEMIE_HOME = home;
    delete process.env.CODEMIE_TIPS;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    changelog.content = null;
    const { rmSync } = await import('fs');
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = originalHome;
    if (originalTips === undefined) delete process.env.CODEMIE_TIPS;
    else process.env.CODEMIE_TIPS = originalTips;
  });

  const writeMarker = async (version: string): Promise<void> => {
    const { writeFileSync } = await import('fs');
    const { join } = await import('path');
    writeFileSync(join(home, '.last-seen-version'), version, 'utf-8');
  };

  const readMarker = async (): Promise<string> => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    return readFileSync(join(home, '.last-seen-version'), 'utf-8');
  };

  it('prints nothing and keeps the marker for an older installed version', async () => {
    changelog.content = rangeFixture(RANGE_VERSIONS);
    await writeMarker('0.16.2');
    const { showUpgradeNotice } = await import('../whatsnew.js');

    showUpgradeNotice('0.16.0');

    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(await readMarker()).toBe('0.16.2');
  });

  it('shows only the header and the pointer when the installed version has no section', async () => {
    changelog.content = rangeFixture(RANGE_VERSIONS.filter(version => version !== '0.16.2'));
    await writeMarker('0.15.0');
    const { showUpgradeNotice } = await import('../whatsnew.js');

    showUpgradeNotice('0.16.2');

    const output = lines();
    expect(output).toContain('✨ Updated to 0.16.2');
    expect(output.some(line => line.includes('codemie whatsnew --all'))).toBe(true);
    expect(output.join('\n')).not.toContain("What's new in 0.15.1");
    expect(await readMarker()).toBe('0.16.2');
  });

  it('renders the range of versions since the last one seen and records the new version', async () => {
    changelog.content = rangeFixture(RANGE_VERSIONS);
    await writeMarker('0.15.1');
    const { showUpgradeNotice } = await import('../whatsnew.js');

    showUpgradeNotice('0.16.2');

    const output = lines().join('\n');
    expect(output).toContain('✨ Updated to 0.16.2');
    expect(output).toContain("What's new in 0.16.2");
    expect(output).toContain("What's new in 0.16.0");
    expect(output).not.toContain("What's new in 0.15.1");
    expect(output).not.toContain('codemie whatsnew --all');
    expect(await readMarker()).toBe('0.16.2');
  });

  it('prints nothing and keeps the marker when CODEMIE_TIPS is off', async () => {
    changelog.content = rangeFixture(RANGE_VERSIONS);
    await writeMarker('0.15.1');
    process.env.CODEMIE_TIPS = 'false';
    const { showUpgradeNotice } = await import('../whatsnew.js');

    showUpgradeNotice('0.16.2');

    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(await readMarker()).toBe('0.15.1');
  });

  it('records an unparseable marker silently', async () => {
    changelog.content = rangeFixture(RANGE_VERSIONS);
    await writeMarker('garbage');
    const { showUpgradeNotice } = await import('../whatsnew.js');

    showUpgradeNotice('0.16.2');

    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(await readMarker()).toBe('0.16.2');
  });
});
