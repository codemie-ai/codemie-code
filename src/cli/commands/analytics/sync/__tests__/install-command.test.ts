import { describe, expect, it } from 'vitest';

import { SyncConfigError } from '@/utils/errors.js';

import { buildInstallCommand } from '../install-command.js';

describe('buildInstallCommand', () => {
  it('builds a webhook-only install command', () => {
    const cmd = buildInstallCommand({ webhook: 'https://hooks.example.invalid/abc' });

    expect(cmd).toBe("codemie analytics sync install --webhook 'https://hooks.example.invalid/abc'");
  });

  it('builds a git-only install command', () => {
    const cmd = buildInstallCommand({ gitRepo: 'https://example.invalid/team/repo.git' });

    expect(cmd).toBe("codemie analytics sync install --git-repo 'https://example.invalid/team/repo.git'");
  });

  it('builds a command with both webhook and git-repo targets', () => {
    const cmd = buildInstallCommand({
      webhook: 'https://hooks.example.invalid/abc',
      gitRepo: 'https://example.invalid/team/repo.git'
    });

    expect(cmd).toBe(
      "codemie analytics sync install --webhook 'https://hooks.example.invalid/abc' " +
        "--git-repo 'https://example.invalid/team/repo.git'"
    );
  });

  it('includes git-branch and git-path when given', () => {
    const cmd = buildInstallCommand({
      gitRepo: 'https://example.invalid/team/repo.git',
      gitBranch: 'main',
      gitPath: 'reports/analytics'
    });

    expect(cmd).toBe(
      "codemie analytics sync install --git-repo 'https://example.invalid/team/repo.git' " +
        "--git-branch 'main' --git-path 'reports/analytics'"
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
      "codemie analytics sync install --webhook 'https://hooks.example.invalid/abc' " +
        "--at '03:00' --lookback-days '14' --include-external 'always'"
    );
  });

  it('omits flags whose value is undefined', () => {
    const cmd = buildInstallCommand({ webhook: 'https://hooks.example.invalid/abc' });

    expect(cmd).not.toContain('--git-repo');
    expect(cmd).not.toContain('--at');
    expect(cmd).not.toContain('--lookback-days');
    expect(cmd).not.toContain('--include-external');
  });

  it('POSIX-escapes a value containing a single quote', () => {
    const cmd = buildInstallCommand({ gitPath: "it's/here", gitRepo: 'https://example.invalid/team/repo.git' });

    expect(cmd).toContain("--git-path 'it'\\''s/here'");
  });

  it('POSIX-escapes a value containing a space', () => {
    const cmd = buildInstallCommand({
      gitRepo: 'https://example.invalid/team/repo.git',
      gitPath: 'my reports'
    });

    expect(cmd).toContain("--git-path 'my reports'");
  });

  it('throws SyncConfigError naming both flags when neither target is given', () => {
    expect(() => buildInstallCommand({})).toThrow(SyncConfigError);
    expect(() => buildInstallCommand({})).toThrow(/--webhook <url>/);
    expect(() => buildInstallCommand({})).toThrow(/--git-repo <url>/);
  });
});
