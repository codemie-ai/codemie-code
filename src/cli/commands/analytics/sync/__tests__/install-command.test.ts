import { describe, expect, it } from 'vitest';

import { SyncConfigError } from '@/utils/errors.js';

import { buildInstallCommand } from '../install-command.js';

describe('buildInstallCommand', () => {
  it('builds a webhook-only install command', () => {
    const cmd = buildInstallCommand({ webhook: 'https://hooks.example.invalid/abc' });

    expect(cmd).toBe('codemie analytics sync install --webhook "https://hooks.example.invalid/abc"');
  });

  it('builds a git-only install command', () => {
    const cmd = buildInstallCommand({ gitRepo: 'https://example.invalid/team/repo.git' });

    expect(cmd).toBe('codemie analytics sync install --git-repo "https://example.invalid/team/repo.git"');
  });

  it('double-quotes a value and allows a valid %XX escape', () => {
    const cmd = buildInstallCommand({ webhook: 'https://h/p?a=1&sig=x%2F', includeExternal: 'windows' });

    expect(cmd).toBe('codemie analytics sync install --webhook "https://h/p?a=1&sig=x%2F" --include-external "windows"');
  });

  it.each([
    ['a double quote', 'https://h/p?sig="x"'],
    ['a dollar sign', 'https://h/p?sig=$x'],
    ['a backtick', 'https://h/p?sig=`x`'],
    ['a bang', 'https://h/p?sig=x!'],
    ['a backslash', 'https://h/p?sig=x\\y'],
    ['a trailing backslash', 'https://h/p?sig=x\\'],
    ['a control character', 'https://h/p?sig=x\x07'],
    ['a typographic quote', 'https://h/p?sig=x’'],
    ['an invalid percent escape', 'https://h/p?sig=x%zz'],
    ['a trailing percent', 'https://h/p?sig=x%']
  ])('throws SyncConfigError naming the flag for a webhook containing %s', (_label, webhook) => {
    expect(() => buildInstallCommand({ webhook })).toThrow(SyncConfigError);
    expect(() => buildInstallCommand({ webhook })).toThrow(/--webhook/);
  });

  it('throws SyncConfigError naming the flag for an unsafe git value', () => {
    expect(() => buildInstallCommand({ gitRepo: 'https://example.invalid/team/repo.git', gitPath: 'a"b' })).toThrow(
      SyncConfigError
    );
    expect(() => buildInstallCommand({ gitRepo: 'https://example.invalid/team/repo.git', gitPath: 'a"b' })).toThrow(
      /--git-path/
    );
  });

  it('builds a command with both webhook and git-repo targets', () => {
    const cmd = buildInstallCommand({
      webhook: 'https://hooks.example.invalid/abc',
      gitRepo: 'https://example.invalid/team/repo.git'
    });

    expect(cmd).toBe(
      'codemie analytics sync install --webhook "https://hooks.example.invalid/abc" ' +
        '--git-repo "https://example.invalid/team/repo.git"'
    );
  });

  it('includes git-branch and git-path when given', () => {
    const cmd = buildInstallCommand({
      gitRepo: 'https://example.invalid/team/repo.git',
      gitBranch: 'main',
      gitPath: 'reports/analytics'
    });

    expect(cmd).toBe(
      'codemie analytics sync install --git-repo "https://example.invalid/team/repo.git" ' +
        '--git-branch "main" --git-path "reports/analytics"'
    );
  });

  it('includes at, lookback-days and include-external when given', () => {
    const cmd = buildInstallCommand({
      webhook: 'https://hooks.example.invalid/abc',
      at: '03:00',
      lookbackDays: 14,
      includeExternal: 'always'
    });

    expect(cmd).toBe(
      'codemie analytics sync install --webhook "https://hooks.example.invalid/abc" ' +
        '--at "03:00" --lookback-days "14" --include-external "always"'
    );
  });

  it('omits flags whose value is undefined', () => {
    const cmd = buildInstallCommand({ webhook: 'https://hooks.example.invalid/abc' });

    expect(cmd).not.toContain('--git-repo');
    expect(cmd).not.toContain('--at');
    expect(cmd).not.toContain('--lookback-days');
    expect(cmd).not.toContain('--include-external');
  });

  it('double-quotes a value containing a single quote as-is', () => {
    const cmd = buildInstallCommand({ gitPath: "it's/here", gitRepo: 'https://example.invalid/team/repo.git' });

    expect(cmd).toContain('--git-path "it\'s/here"');
  });

  it('double-quotes a value containing a space', () => {
    const cmd = buildInstallCommand({
      gitRepo: 'https://example.invalid/team/repo.git',
      gitPath: 'my reports'
    });

    expect(cmd).toContain('--git-path "my reports"');
  });

  it('throws SyncConfigError naming both flags when neither target is given', () => {
    expect(() => buildInstallCommand({})).toThrow(SyncConfigError);
    expect(() => buildInstallCommand({})).toThrow(/--webhook <url>/);
    expect(() => buildInstallCommand({})).toThrow(/--git-repo <url>/);
  });
});
