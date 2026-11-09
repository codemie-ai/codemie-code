/**
 * whatsnew command tests
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

const FIXTURE = [
  '## [Unreleased]',
  '### Added',
  '- Unreleased thing',
  '## [0.16.2] - 2026-10-20',
  '### Fixed',
  '- Fix in 0.16.2',
  '## [0.15.1] - 2026-09-08',
  '### Fixed',
  '- Fix in 0.15.1',
  ''
].join('\n');

describe('codemie whatsnew', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    changelog.content = FIXTURE;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    changelog.content = null;
    consoleLogSpy.mockRestore();
  });

  const output = (): string => consoleLogSpy.mock.calls.map(call => call.join(' ')).join('\n');

  it('reports a version that has no release notes instead of showing another version', async () => {
    const { createWhatsnewCommand } = await import('../whatsnew.js');
    await createWhatsnewCommand().parseAsync(['9.9.9'], { from: 'user' });

    expect(output().toLowerCase()).toContain('no release notes for 9.9.9');
    expect(output()).not.toContain("What's new in 0.16.2");
  });

  it('renders every entry with --all', async () => {
    const { createWhatsnewCommand } = await import('../whatsnew.js');
    await createWhatsnewCommand().parseAsync(['--all'], { from: 'user' });

    expect(output()).toContain("What's new in Unreleased");
    expect(output()).toContain("What's new in 0.16.2");
    expect(output()).toContain("What's new in 0.15.1");
  });
});
