import { describe, expect, it, vi } from 'vitest';

import { ExportTooLargeError, SyncGitError, SyncIdentityMissingError } from '@/utils/errors.js';

import { runSync } from '../run-sync.js';
import type { SyncDeps, TargetId } from '../run-sync.js';
import type { GitSettings, SyncReport, SyncSettings } from '../types.js';
import type { AnalyticsSource } from '../../sources/types.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const NOW = new Date('2026-10-29T00:00:00.000Z');
const REPORT: SyncReport = {
  fileName: 'codemie-analytics-jane.doe-2026-10-29.report.json',
  bytes: Buffer.from('{"a":1}'),
};

const GIT_SETTINGS: GitSettings = { repoUrl: 'https://git.example.invalid/team/analytics.git' };

const BASE_SETTINGS: SyncSettings = {
  webhookUrl: 'https://example.invalid/hook?sig=FAKE',
  format: 'json',
  includeExternal: 'windows',
  at: '03:00',
  lookbackDays: 7,
};

const GIT_ONLY_SETTINGS: SyncSettings = {
  git: GIT_SETTINGS,
  format: 'json',
  includeExternal: 'windows',
  at: '03:00',
  lookbackDays: 7,
};

const BOTH_SETTINGS: SyncSettings = { ...BASE_SETTINGS, git: GIT_SETTINGS };

interface Harness {
  deps: SyncDeps;
  printed: string[];
  logged: string[];
}

function makeDeps(overrides: Partial<SyncDeps> = {}): Harness {
  const printed: string[] = [];
  const logged: string[] = [];

  const deps: SyncDeps = {
    now: () => NOW,
    loadSettings: async () => BASE_SETTINGS,
    resolveIdentity: async () => 'Jane.Doe@x.com',
    buildReport: async () => REPORT,
    deliver: async () => {},
    readMarker: async () => null,
    writeMarker: async () => {},
    appendLog: async (line: string): Promise<void> => {
      logged.push(line);
    },
    print: (line: string): void => {
      printed.push(line);
    },
    platform: 'linux',
    source: {} as AnalyticsSource,
    ...overrides,
  };

  return { deps, printed, logged };
}

describe('runSync', () => {
  it('no installed settings fails setup naming the install command, never sends, and exits 1', async () => {
    const deliver = vi.fn(async () => {});
    const { deps, printed, logged } = makeDeps({
      loadSettings: async () => null,
      deliver,
    });

    const code = await runSync(deps);

    expect(code).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(printed.some((line) => /fail setup/.test(line) && line.includes('codemie analytics sync install'))).toBe(
      true
    );
    expect(logged.some((line) => /fail setup/.test(line) && line.includes('codemie analytics sync install'))).toBe(
      true
    );
    expect(printed.some((line) => / target=/.test(line))).toBe(false);
  });

  it('a 2xx deliver writes the webhook marker at now() and logs ok sent <name> <bytes> target=webhook', async () => {
    const writeMarker = vi.fn(async () => {});
    const deliver = vi.fn(async () => {});

    const { deps, printed, logged } = makeDeps({ writeMarker, deliver });

    const code = await runSync(deps);

    expect(code).toBe(0);
    expect(writeMarker).toHaveBeenCalledWith('webhook', NOW);
    expect(deliver).toHaveBeenCalledWith('webhook', BASE_SETTINGS, 'Jane.Doe@x.com', REPORT);

    const expected = `ok sent ${REPORT.fileName} ${REPORT.bytes.length}`;
    expect(printed.some((line) => line.includes(expected) && line.endsWith(' target=webhook'))).toBe(true);
    expect(logged.some((line) => line.includes(expected) && line.endsWith(' target=webhook'))).toBe(true);
  });

  it('a null report skips delivery, leaves the marker unchanged, and exits 0', async () => {
    const writeMarker = vi.fn(async () => {});
    const deliver = vi.fn(async () => {});
    const buildReport = vi.fn(async () => null);

    const { deps, printed, logged } = makeDeps({ buildReport, writeMarker, deliver });

    const code = await runSync(deps);

    expect(code).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(writeMarker).not.toHaveBeenCalled();
    expect(printed.some((line) => /\bskip\b/.test(line) && line.endsWith(' target=webhook'))).toBe(true);
    expect(logged.some((line) => /\bskip\b/.test(line) && line.endsWith(' target=webhook'))).toBe(true);
  });

  it('a deliver rejection whose cause carries a signed URL fails send without leaking the signature', async () => {
    const writeMarker = vi.fn(async () => {});
    const deliver = vi.fn(async () => {
      throw new Error('delivery failed', {
        cause: new Error('network error for https://example.invalid/hook?sig=abc'),
      });
    });

    const { deps, printed, logged } = makeDeps({ deliver, writeMarker });

    const code = await runSync(deps);

    expect(code).toBe(1);
    expect(writeMarker).not.toHaveBeenCalled();
    expect(printed.some((line) => /fail send/.test(line) && line.endsWith(' target=webhook'))).toBe(true);
    expect(printed.some((line) => line.includes('abc'))).toBe(false);
    expect(logged.some((line) => line.includes('abc'))).toBe(false);
  });

  it('an ExportTooLargeError from deliver fails export and names the size', async () => {
    const writeMarker = vi.fn(async () => {});
    const deliver = vi.fn(async () => {
      throw new ExportTooLargeError(71_000_000, 70_000_000);
    });

    const { deps, printed, logged } = makeDeps({ deliver, writeMarker });

    const code = await runSync(deps);

    expect(code).toBe(1);
    expect(writeMarker).not.toHaveBeenCalled();
    expect(
      printed.some((line) => /fail export/.test(line) && line.includes('71000000') && line.endsWith(' target=webhook'))
    ).toBe(true);
    expect(
      logged.some((line) => /fail export/.test(line) && line.includes('71000000') && line.endsWith(' target=webhook'))
    ).toBe(true);
  });

  it('a report-build error fails export', async () => {
    const buildReport = vi.fn(async () => {
      throw new Error('aggregate failed');
    });
    const deliver = vi.fn(async () => {});

    const { deps, printed, logged } = makeDeps({ buildReport, deliver });

    const code = await runSync(deps);

    expect(code).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(printed.some((line) => /fail export/.test(line) && line.endsWith(' target=webhook'))).toBe(true);
    expect(logged.some((line) => /fail export/.test(line) && line.endsWith(' target=webhook'))).toBe(true);
  });

  it('no resolvable identity fails setup without building a report, and carries no target', async () => {
    const buildReport = vi.fn(async () => REPORT);

    const { deps, printed, logged } = makeDeps({
      resolveIdentity: async () => {
        throw new SyncIdentityMissingError();
      },
      buildReport,
    });

    const code = await runSync(deps);

    expect(code).toBe(1);
    expect(buildReport).not.toHaveBeenCalled();
    expect(printed.some((line) => /fail setup/.test(line))).toBe(true);
    expect(logged.some((line) => /fail setup/.test(line))).toBe(true);
    expect(printed.some((line) => / target=/.test(line))).toBe(false);
  });

  it('builds the daily window from the webhook marker, starting at least 10 days back for a 10-day-old marker with a 7 day lookback', async () => {
    const lastSent = new Date(NOW.getTime() - 10 * DAY_MS);
    const readMarker = vi.fn(async () => lastSent);
    const buildReport = vi.fn(async () => REPORT);

    const { deps } = makeDeps({ readMarker, buildReport });

    const code = await runSync(deps);

    expect(code).toBe(0);
    expect(readMarker).toHaveBeenCalledWith('webhook', NOW);

    const passedWindow = buildReport.mock.calls[0]?.[0]?.window;
    expect(passedWindow.to).toEqual(NOW);
    expect(NOW.getTime() - passedWindow.from.getTime()).toBeGreaterThanOrEqual(10 * DAY_MS);
  });

  it('uses the installed lookbackDays for the window when there is no marker', async () => {
    const buildReport = vi.fn(async () => REPORT);
    const { deps } = makeDeps({
      loadSettings: async () => ({ ...BASE_SETTINGS, lookbackDays: 14 }),
      buildReport,
    });

    await runSync(deps);

    const passedWindow = buildReport.mock.calls[0]?.[0]?.window;
    expect(passedWindow.from).toEqual(new Date(NOW.getTime() - 14 * DAY_MS));
  });

  it.each([
    ['always', 'linux', true],
    ['windows', 'linux', false],
    ['windows', 'win32', true],
    ['never', 'win32', false],
  ] as const)('passes includeExternal for policy %s on %s as %s', async (policy, platform, expected) => {
    const buildReport = vi.fn(async () => REPORT);
    const { deps } = makeDeps({
      loadSettings: async () => ({ ...BASE_SETTINGS, includeExternal: policy }),
      platform,
      buildReport,
    });

    await runSync(deps);

    expect(buildReport.mock.calls[0]?.[0]?.includeExternal).toBe(expected);
  });

  it('still resolves to an exit code when the run log cannot be written', async () => {
    const { deps, printed } = makeDeps({
      appendLog: async () => {
        throw new Error('EACCES: analytics-sync.log');
      },
    });

    await expect(runSync(deps)).resolves.toBe(0);
    expect(printed.some((line) => /ok sent/.test(line))).toBe(true);
  });

  it('still resolves to 1 when the run log cannot be written on a failure', async () => {
    const { deps } = makeDeps({
      loadSettings: async () => null,
      appendLog: async () => {
        throw new Error('ENOSPC');
      },
    });

    await expect(runSync(deps)).resolves.toBe(1);
  });

  it('a marker write failure after a 2xx deliver logs one ok sent line with a warning, not fail setup', async () => {
    const { deps, printed, logged } = makeDeps({
      writeMarker: async () => {
        throw new Error('EACCES: analytics-last-sent');
      },
    });

    const code = await runSync(deps);

    expect(code).toBe(0);
    expect(logged).toHaveLength(1);
    expect(printed).toHaveLength(1);
    expect(logged[0]).toMatch(/ ok sent /);
    expect(logged[0]).toMatch(/marker/);
    expect(logged[0]).not.toMatch(/fail/);
    expect(logged[0]).toMatch(/ target=webhook$/);
  });

  it('never throws, even when an unexpected error occurs reading settings', async () => {
    const { deps } = makeDeps({
      loadSettings: async () => {
        throw new Error('disk on fire');
      },
    });

    await expect(runSync(deps)).resolves.toBe(1);
  });

  describe('git-only target', () => {
    it('delivers to git, moves the git marker, and logs target=git', async () => {
      const writeMarker = vi.fn(async () => {});
      const deliver = vi.fn(async () => {});

      const { deps, printed, logged } = makeDeps({
        loadSettings: async () => GIT_ONLY_SETTINGS,
        deliver,
        writeMarker,
      });

      const code = await runSync(deps);

      expect(code).toBe(0);
      expect(deliver).toHaveBeenCalledWith('git', GIT_ONLY_SETTINGS, 'Jane.Doe@x.com', REPORT);
      expect(writeMarker).toHaveBeenCalledWith('git', NOW);
      expect(printed.some((line) => line.includes('ok sent') && line.endsWith(' target=git'))).toBe(true);
      expect(logged.some((line) => line.includes('ok sent') && line.endsWith(' target=git'))).toBe(true);
    });

    it('a git delivery failure fails send with the gitHint, and never touches the webhook marker', async () => {
      const writeMarker = vi.fn(async () => {});
      const deliver = vi.fn(async () => {
        throw new SyncGitError('redacted git failure', 'auth');
      });

      const { deps, printed } = makeDeps({
        loadSettings: async () => GIT_ONLY_SETTINGS,
        deliver,
        writeMarker,
      });

      const code = await runSync(deps);

      expect(code).toBe(1);
      expect(writeMarker).not.toHaveBeenCalled();
      expect(printed.some((line) => /fail send/.test(line) && line.endsWith(' target=git'))).toBe(true);
      expect(printed.some((line) => line.includes('redacted git failure'))).toBe(true);
      expect(printed.some((line) => /SSH key|credentials/.test(line))).toBe(true);
    });

    it('an empty window for git skips delivery and logs skip ... target=git, no deliver call (AC9)', async () => {
      const deliver = vi.fn(async () => {});
      const buildReport = vi.fn(async () => null);

      const { deps, printed, logged } = makeDeps({
        loadSettings: async () => GIT_ONLY_SETTINGS,
        deliver,
        buildReport,
      });

      const code = await runSync(deps);

      expect(code).toBe(0);
      expect(deliver).not.toHaveBeenCalled();
      expect(printed.some((line) => /\bskip\b/.test(line) && line.endsWith(' target=git'))).toBe(true);
      expect(logged.some((line) => /\bskip\b/.test(line) && line.endsWith(' target=git'))).toBe(true);
    });
  });

  describe('both targets configured', () => {
    it('delivers to both, each marker moving only after its own successful delivery (AC7)', async () => {
      const writeMarker = vi.fn(async () => {});
      const deliver = vi.fn(async (target: TargetId) => {
        if (target === 'git') {
          throw new SyncGitError('push failed', 'unreachable');
        }
      });

      const { deps, logged } = makeDeps({
        loadSettings: async () => BOTH_SETTINGS,
        deliver,
        writeMarker,
      });

      const code = await runSync(deps);

      expect(code).toBe(1);
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(writeMarker).toHaveBeenCalledTimes(1);
      expect(writeMarker).toHaveBeenCalledWith('webhook', NOW);

      expect(logged).toHaveLength(2);
      expect(logged.some((line) => /ok sent/.test(line) && line.endsWith(' target=webhook'))).toBe(true);
      expect(logged.some((line) => /fail send/.test(line) && line.endsWith(' target=git'))).toBe(true);
    });

    it('reads each target window from its own marker', async () => {
      // BOTH_SETTINGS has lookbackDays: 7 — the webhook marker is recent enough that the
      // 7-day lookback dominates its window, while the git marker is old enough (9 days)
      // that its window is instead anchored to that marker (plus the 1h safety margin).
      const webhookMarker = new Date(NOW.getTime() - 2 * DAY_MS);
      const gitMarker = new Date(NOW.getTime() - 9 * DAY_MS);
      const readMarker = vi.fn(async (target: TargetId) => (target === 'git' ? gitMarker : webhookMarker));
      const buildReport = vi.fn(async () => REPORT);

      const { deps } = makeDeps({
        loadSettings: async () => BOTH_SETTINGS,
        readMarker,
        buildReport,
      });

      await runSync(deps);

      expect(readMarker).toHaveBeenCalledWith('webhook', NOW);
      expect(readMarker).toHaveBeenCalledWith('git', NOW);

      const webhookWindow = buildReport.mock.calls[0]?.[0]?.window;
      const gitWindow = buildReport.mock.calls[1]?.[0]?.window;
      expect(webhookWindow.from).toEqual(new Date(NOW.getTime() - 7 * DAY_MS));
      expect(gitWindow.from).toEqual(new Date(gitMarker.getTime() - HOUR_MS));
    });
  });
});
