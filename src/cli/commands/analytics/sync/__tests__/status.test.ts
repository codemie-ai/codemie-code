import { describe, expect, it } from 'vitest';

import { parseLastRun, runStatus } from '../status.js';
import type { StatusDeps } from '../status.js';
import type { SyncSettings } from '../types.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');

const BASE_SETTINGS: SyncSettings = {
  webhookUrl: 'https://hooks.example.invalid/abc?sig=SUPERSECRET123',
  includeExternal: 'windows',
  at: '03:00',
  lookbackDays: 7,
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
    expect(parseLastRun('')).toBeNull();
  });

  it('returns null when no line matches the run-log format', () => {
    const log = ['some legacy collector line', 'Error: boom\n    at Object.<anonymous>'].join('\n');
    expect(parseLastRun(log)).toBeNull();
  });

  it('parses an "ok sent" line', () => {
    const log = '2026-10-29T03:00:05.000Z ok sent codemie-analytics-jane-2026-10-29.report.json 1234';
    expect(parseLastRun(log)).toEqual({
      at: '2026-10-29T03:00:05.000Z',
      outcome: 'ok sent codemie-analytics-jane-2026-10-29.report.json 1234',
    });
  });

  it('parses a "skip" line', () => {
    const log = '2026-10-29T03:00:05.000Z skip no sessions in window 2026-10-22..2026-10-29';
    expect(parseLastRun(log)).toEqual({
      at: '2026-10-29T03:00:05.000Z',
      outcome: 'skip no sessions in window 2026-10-22..2026-10-29',
    });
  });

  it('parses a "fail <category>" line', () => {
    const log = '2026-10-29T03:00:05.000Z fail send webhook returned 500';
    expect(parseLastRun(log)).toEqual({
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

    expect(parseLastRun(log)).toEqual({ at: '2026-10-29T03:00:05.000Z', outcome: 'ok sent report.json 1234' });
  });

  it('takes the last matching line when several match', () => {
    const log = [
      '2026-10-28T03:00:05.000Z ok sent report-28.json 1000',
      '2026-10-29T03:00:05.000Z ok sent report-29.json 2000',
      '2026-10-29T03:00:05.000Z ok sent report-29.json 2000',
    ].join('\n');

    expect(parseLastRun(log)).toEqual({ at: '2026-10-29T03:00:05.000Z', outcome: 'ok sent report-29.json 2000' });
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
    const { webhookUrl, includeExternal, at } = BASE_SETTINGS;
    const { deps, printed } = makeDeps({
      loadSettings: async () => ({ webhookUrl, includeExternal, at }),
    });

    await runStatus(deps);

    expect(printed.join('\n')).toContain('7 days (default)');
  });
});
