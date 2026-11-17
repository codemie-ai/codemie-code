import { describe, expect, it } from 'vitest';

import { SyncConfigError } from '@/utils/errors.js';

import { buildInstallCommand } from '../install-command.js';
import { encodeWebhook } from '../webhook-encoding.js';

const HOOK = 'https://hooks.example.invalid/abc';
const HOOK_B64 = encodeWebhook(HOOK);

describe('buildInstallCommand', () => {
  it('builds a webhook-only install command', () => {
    const cmd = buildInstallCommand({ webhook: HOOK });

    expect(cmd).toBe(`codemie analytics sync install --webhook-b64 ${HOOK_B64}`);
  });

  it('builds a git-only install command', () => {
    const cmd = buildInstallCommand({ gitRepo: 'https://example.invalid/team/repo.git' });

    expect(cmd).toBe('codemie analytics sync install --git-repo "https://example.invalid/team/repo.git"');
  });

  it('prints the webhook as shell-neutral base64url, so & and %XX never reach a shell', () => {
    const webhook = 'https://h/p?a=1&sig=x%2Ftriggers%2Fmanual';
    const cmd = buildInstallCommand({ webhook, includeExternal: 'windows' });

    expect(cmd).toBe(`codemie analytics sync install --webhook-b64 ${encodeWebhook(webhook)} --include-external "windows"`);
    expect(cmd.split(' ')[4]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cmd).not.toContain('&');
    expect(cmd).not.toContain('%');
  });

  it.each([
    ['a double quote', 'a"b'],
    ['a dollar sign', 'a$b'],
    ['a backtick', 'a`b'],
    ['a bang', 'a!b'],
    ['a backslash', 'a\\b'],
    ['a trailing backslash', 'ab\\'],
    ['a control character', 'a\x07b'],
    ['a typographic quote', 'a’b'],
    ['an invalid percent escape', 'a%zzb'],
    ['a trailing percent', 'ab%']
  ])('throws SyncConfigError naming the flag for a git value containing %s', (_label, gitPath) => {
    const opts = { gitRepo: 'https://example.invalid/team/repo.git', gitPath };
    expect(() => buildInstallCommand(opts)).toThrow(SyncConfigError);
    expect(() => buildInstallCommand(opts)).toThrow(/--git-path/);
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
      webhook: HOOK,
      gitRepo: 'https://example.invalid/team/repo.git'
    });

    expect(cmd).toBe(
      `codemie analytics sync install --webhook-b64 ${HOOK_B64} ` + '--git-repo "https://example.invalid/team/repo.git"'
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
      webhook: HOOK,
      at: '03:00',
      lookbackDays: 14,
      includeExternal: 'always'
    });

    expect(cmd).toBe(
      `codemie analytics sync install --webhook-b64 ${HOOK_B64} ` +
        '--at "03:00" --lookback-days "14" --include-external "always"'
    );
  });

  it('omits flags whose value is undefined', () => {
    const cmd = buildInstallCommand({ webhook: HOOK });

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
