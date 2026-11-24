import { describe, expect, it } from 'vitest';

import { formatLogLine } from '../run-sync.js';
import { parseLastFailure, parseLastRun, runStatus } from '../status.js';
import type { StatusDeps } from '../status.js';
import type { SyncSettings } from '../types.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');

const BASE_SETTINGS: SyncSettings = {
  webhookUrl: 'https://hooks.example.invalid/abc?sig=SUPERSECRET123',
  format: 'json',
  includeExternal: 'windows',
  at: '03:00',
  lookbackDays: 7,
};

const GIT_SETTINGS: SyncSettings = {
  format: 'json',
  includeExternal: 'windows',
  at: '03:00',
  lookbackDays: 7,
  git: {
    repoUrl: 'https://git-user:SUPERSECRET123@git.example.invalid/team/analytics.git',
  },
};

interface Harness {
  deps: StatusDeps;
  printed: string[];
}

function makeDeps(overrides: Partial<StatusDeps> = {}): Harness {
  const printed: string[] = [];

  const deps: StatusDeps = {
    loadSettings: async () => BASE_SETTINGS,
    query: async () => 'enabled',
    readLog: async () => null,
    readMarker: async () => null,
    now: () => NOW,
    print: (line: string): void => {
      printed.push(line);
    },
    ...overrides,
  };

  return { deps, printed };
}

function lineStarting(printed: string[], label: string): string {
  const line = printed.find((l) => l.trim().startsWith(label));
  expect(line, `no "${label}" line`).toBeDefined();
  return line as string;
}

describe('parseLastRun', () => {
  it('returns null for an empty log', () => {
    expect(parseLastRun('', 'webhook')).toBeNull();
  });

  it('returns null when no line matches the run-log format', () => {
    const log = ['some legacy collector line', 'Error: boom\n    at Object.<anonymous>'].join('\n');
    expect(parseLastRun(log, 'webhook')).toBeNull();
  });

  it('parses an "ok sent" line as the webhook\'s when it carries no target suffix', () => {
    const log = '2026-10-29T03:00:05.000Z ok sent codemie-analytics-jane-2026-10-29.report.json 1234';
    expect(parseLastRun(log, 'webhook')).toEqual({
      at: '2026-10-29T03:00:05.000Z',
      outcome: 'ok sent codemie-analytics-jane-2026-10-29.report.json 1234',
    });
  });

  it('parses a "skip" line', () => {
    const log = '2026-10-29T03:00:05.000Z skip no sessions in window 2026-10-22..2026-10-29 target=webhook';
    expect(parseLastRun(log, 'webhook')).toEqual({
      at: '2026-10-29T03:00:05.000Z',
      outcome: 'skip no sessions in window 2026-10-22..2026-10-29',
    });
  });

  it('parses a "fail <category>" line', () => {
    const log = '2026-10-29T03:00:05.000Z fail send webhook returned 500 target=webhook';
    expect(parseLastRun(log, 'webhook')).toEqual({
      at: '2026-10-29T03:00:05.000Z',
      outcome: 'fail send webhook returned 500',
    });
  });

  it('ignores unrelated lines mixed in around a matching one', () => {
    const log = [
      'legacy collector: synced 3 sessions',
      '2026-10-29T03:00:05.000Z ok sent report.json 1234',
      'Error: stack trace noise',
      '    at somewhere.ts:12',
    ].join('\n');

    expect(parseLastRun(log, 'webhook')).toEqual({
      at: '2026-10-29T03:00:05.000Z',
      outcome: 'ok sent report.json 1234',
    });
  });

  it('takes the last matching line when several match', () => {
    const log = [
      '2026-10-28T03:00:05.000Z ok sent report-28.json 1000 target=webhook',
      '2026-10-29T03:00:05.000Z ok sent report-29.json 2000 target=webhook',
      '2026-10-29T03:00:05.000Z ok sent report-29.json 2000 target=webhook',
    ].join('\n');

    expect(parseLastRun(log, 'webhook')).toEqual({
      at: '2026-10-29T03:00:05.000Z',
      outcome: 'ok sent report-29.json 2000',
    });
  });

  it('strips the "target=" suffix from the outcome and does not leak it into display text', () => {
    const log = '2026-10-29T03:00:05.000Z ok sent report.json 1234 target=git';
    expect(parseLastRun(log, 'git')).toEqual({
      at: '2026-10-29T03:00:05.000Z',
      outcome: 'ok sent report.json 1234',
    });
  });

  it('ignores a line belonging to a different target', () => {
    const log = '2026-10-29T03:00:05.000Z ok sent report.json 1234 target=git';
    expect(parseLastRun(log, 'webhook')).toBeNull();
  });

  it('shows the webhook\'s last run as the legacy line, and the git\'s last failure as the second line', () => {
    const log = [
      '2026-10-28T03:00:05.000Z ok sent legacy-report.json 999',
      '2026-10-29T03:00:05.000Z fail send auth failed: invalid credentials target=git',
    ].join('\n');

    expect(parseLastRun(log, 'webhook')).toEqual({
      at: '2026-10-28T03:00:05.000Z',
      outcome: 'ok sent legacy-report.json 999',
    });
    expect(parseLastFailure(log, 'git')).toEqual({
      at: '2026-10-29T03:00:05.000Z',
      outcome: 'fail send auth failed: invalid credentials',
    });
  });
});

describe('run-log attribution', () => {
  it('attributes the last failure to git for a multi-line git error formatted by run-sync (CR-007)', () => {
    const line = formatLogLine(
      new Date('2026-10-29T03:00:05.000Z'),
      'fail',
      "send remote: denied\n ! [remote rejected] HEAD -> main\nerror: failed to push some refs",
      'git'
    );
    const log = ['2026-10-28T03:00:05.000Z ok sent legacy.json 9', line].join('\n');

    expect(parseLastFailure(log, 'git')).toEqual({
      at: '2026-10-29T03:00:05.000Z',
      outcome: 'fail send remote: denied | ! [remote rejected] HEAD -> main | error: failed to push some refs',
    });
    expect(parseLastRun(log, 'webhook')?.outcome).toBe('ok sent legacy.json 9');
  });

  it('counts an untargeted run-wide setup failure for every target (CR-009)', () => {
    const log = '2026-10-29T03:00:05.000Z fail setup No sync identity could be resolved';

    expect(parseLastFailure(log, 'git')).toEqual({
      at: '2026-10-29T03:00:05.000Z',
      outcome: 'fail setup No sync identity could be resolved',
    });
    expect(parseLastRun(log, 'webhook')?.outcome).toBe('fail setup No sync identity could be resolved');
  });

  it('keeps an untargeted legacy send failure as the webhook\'s only', () => {
    const log = '2026-10-29T03:00:05.000Z fail send HTTP 500';

    expect(parseLastFailure(log, 'git')).toBeNull();
    expect(parseLastFailure(log, 'webhook')?.outcome).toBe('fail send HTTP 500');
  });
});

describe('parseLastFailure', () => {
  it('returns null when the target has no failure line', () => {
    const log = '2026-10-29T03:00:05.000Z ok sent report.json 1234 target=git';
    expect(parseLastFailure(log, 'git')).toBeNull();
  });

  it('takes the last matching failure when several match', () => {
    const log = [
      '2026-10-28T03:00:05.000Z fail send first failure target=git',
      '2026-10-29T03:00:05.000Z fail send second failure target=git',
    ].join('\n');

    expect(parseLastFailure(log, 'git')).toEqual({
      at: '2026-10-29T03:00:05.000Z',
      outcome: 'fail send second failure',
    });
  });
});

describe('runStatus', () => {
  it('reports "not installed" with the install command and exits 0 when there are no settings', async () => {
    const { deps, printed } = makeDeps({ loadSettings: async () => null });

    const code = await runStatus(deps);

    expect(code).toBe(0);
    const output = printed.join('\n');
    expect(output).toMatch(/not installed/i);
    expect(output).toContain('codemie analytics sync install --webhook <url>');
  });

  it('fails with a redacted message and a non-zero exit when settings are invalid', async () => {
    const { deps, printed } = makeDeps({
      loadSettings: async () => {
        throw new Error('Sync settings is not valid JSON. sig=SUPERSECRET123');
      },
    });

    const code = await runStatus(deps);

    expect(code).toBe(1);
    const output = printed.join('\n');
    expect(output).not.toContain('SUPERSECRET123');
  });

  it('reports "disabled" and tells the user to run install again when the OS job is not enabled', async () => {
    const { deps, printed } = makeDeps({ query: async () => 'disabled' });

    const code = await runStatus(deps);

    expect(code).toBe(0);
    const output = printed.join('\n');
    expect(output).toMatch(/disabled/i);
    expect(output).toMatch(/install again/i);
    expect(output).toContain('--webhook <url>');
    expect(output).toContain('--git-repo <url>');
  });

  it('shows run time, lookback, policy, webhook host only, last run and last send when enabled', async () => {
    const { deps, printed } = makeDeps({
      readLog: async () => '2026-10-29T03:00:05.000Z ok sent report.json 1234',
      readMarker: async () => new Date('2026-10-28T03:00:07.000Z'),
    });

    const code = await runStatus(deps);

    expect(code).toBe(0);
    const output = printed.join('\n');
    expect(output).toMatch(/enabled/i);
    expect(output).toContain('03:00');
    expect(output).toContain('7 days');
    expect(output).toContain('windows');
    expect(output).toContain('hooks.example.invalid');
    expect(output).not.toContain('sig=');
    expect(output).not.toContain('SUPERSECRET123');
    expect(lineStarting(printed, 'Last run:')).toMatch(/2026-10-29T03:00:05\.000Z — sent \(report\.json 1234\)/);
    expect(lineStarting(printed, 'Last successful send:')).toMatch(/2026-10-28T03:00:07\.000Z$/);
  });

  it('shows "never" for the last run when the log is missing', async () => {
    const { deps, printed } = makeDeps({
      readLog: async () => null,
      readMarker: async () => new Date('2026-10-28T03:00:07.000Z'),
    });

    const code = await runStatus(deps);

    expect(code).toBe(0);
    expect(lineStarting(printed, 'Last run:')).toMatch(/never$/);
    expect(lineStarting(printed, 'Last successful send:')).not.toMatch(/never/);
  });

  it('shows "never" for the last run when the log has no matching line', async () => {
    const { deps, printed } = makeDeps({
      readLog: async () => 'garbage, not a run log line',
      readMarker: async () => new Date('2026-10-28T03:00:07.000Z'),
    });

    const code = await runStatus(deps);

    expect(code).toBe(0);
    expect(lineStarting(printed, 'Last run:')).toMatch(/never$/);
  });

  it('shows "never" for the last successful send when the marker is absent', async () => {
    const { deps, printed } = makeDeps({
      readLog: async () => '2026-10-29T03:00:05.000Z skip no sessions in window x',
      readMarker: async () => null,
    });

    const code = await runStatus(deps);

    expect(code).toBe(0);
    expect(lineStarting(printed, 'Last successful send:')).toMatch(/never$/);
    expect(lineStarting(printed, 'Last run:')).not.toMatch(/never/);
  });

  it('reports an unreadable marker instead of rejecting', async () => {
    const { deps, printed } = makeDeps({
      readMarker: async () => {
        throw Object.assign(new Error('EACCES: analytics-last-sent'), { code: 'EACCES' });
      },
    });

    await expect(runStatus(deps)).resolves.toBe(0);
    expect(lineStarting(printed, 'Last successful send:')).toMatch(/unknown \(EACCES: analytics-last-sent\)/);
  });

  it('shows the explicit lookback (not "default") when it was set', async () => {
    const { deps, printed } = makeDeps({
      loadSettings: async () => ({ ...BASE_SETTINGS, lookbackDays: 14 }),
    });

    await runStatus(deps);

    expect(printed.join('\n')).toContain('14 days');
  });

  it('shows the default lookback label when lookbackDays is omitted', async () => {
    const { webhookUrl, format, includeExternal, at } = BASE_SETTINGS;
    const { deps, printed } = makeDeps({
      loadSettings: async () => ({ webhookUrl, format, includeExternal, at }),
    });

    await runStatus(deps);

    expect(printed.join('\n')).toContain('7 days (default)');
  });

  it('shows the git target\'s repository (redacted), branch, path, last successful push and last failure', async () => {
    const { deps, printed } = makeDeps({
      loadSettings: async () => GIT_SETTINGS,
      readLog: async () => '2026-10-29T03:00:05.000Z fail send auth failed target=git',
      readMarker: async (target) =>
        target === 'git' ? new Date('2026-10-28T03:00:07.000Z') : null,
    });

    const code = await runStatus(deps);

    expect(code).toBe(0);
    const output = printed.join('\n');
    expect(output).not.toContain('SUPERSECRET123');
    expect(lineStarting(printed, 'Repository:')).toContain('git.example.invalid/team/analytics.git');
    expect(lineStarting(printed, 'Repository:')).not.toContain('git-user');
    expect(lineStarting(printed, 'Branch:')).toContain('default');
    expect(lineStarting(printed, 'Path:')).toBeDefined();
    expect(lineStarting(printed, 'Last successful push:')).toMatch(/2026-10-28T03:00:07\.000Z$/);
    expect(lineStarting(printed, 'Last failure:')).toMatch(/fail.*auth failed/i);
  });

  it('shows the configured git branch and path instead of the defaults', async () => {
    const { deps, printed } = makeDeps({
      loadSettings: async () => ({
        ...GIT_SETTINGS,
        git: { ...GIT_SETTINGS.git!, branch: 'release', path: 'team/analytics' },
      }),
    });

    await runStatus(deps);

    expect(lineStarting(printed, 'Branch:')).toContain('release');
    expect(lineStarting(printed, 'Path:')).toContain('team/analytics');
  });

  it('shows "never" for the git last failure when the log has none', async () => {
    const { deps, printed } = makeDeps({
      loadSettings: async () => GIT_SETTINGS,
      readLog: async () => '2026-10-29T03:00:05.000Z ok sent report.json 1234 target=git',
    });

    await runStatus(deps);

    expect(lineStarting(printed, 'Last failure:')).toMatch(/never$/);
  });

  it('shows an untargeted setup failure as the git last failure on a git-only install (CR-009)', async () => {
    const { deps, printed } = makeDeps({
      loadSettings: async () => GIT_SETTINGS,
      readLog: async () => '2026-10-29T03:00:05.000Z fail setup No sync identity could be resolved',
    });

    await runStatus(deps);

    expect(lineStarting(printed, 'Last failure:')).not.toMatch(/never$/);
    expect(lineStarting(printed, 'Last failure:')).toMatch(/2026-10-29T03:00:05\.000Z.*setup/);
  });

  it('omits the webhook lines when only the git target is configured', async () => {
    const { deps, printed } = makeDeps({ loadSettings: async () => GIT_SETTINGS });

    await runStatus(deps);

    const output = printed.join('\n');
    expect(output).not.toContain('Webhook:');
    expect(output).not.toContain('Last run:');
    expect(output).not.toContain('Last successful send:');
  });
});
