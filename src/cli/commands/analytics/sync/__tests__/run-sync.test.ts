import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { ExportTooLargeError, SyncGitError, SyncIdentityMissingError } from '@/utils/errors.js';

import { runSync } from '../run-sync.js';
import { OtlpFolderSource } from '../otlp-file-builder.js';
import { ReportSource } from '../report-builder.js';
import { LocalExportSource } from '../../../shared/analytics-collection/local.js';
import type { RawSessionData } from '../../data-loader.js';
import { GitTarget } from '../targets/git-target.js';
import { WebhookTarget } from '../targets/webhook-target.js';
import type { SyncDeps, TargetId } from '../run-sync.js';
import type { GitSettings, SyncReport, SyncSettings } from '../types.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const NOW = new Date('2026-10-29T00:00:00.000Z');
const REPORT: SyncReport = {
  fileName: 'codemie-analytics-jane.doe-2026-10-29.report.json',
  bytes: Buffer.from('{"a":1}'),
  contentType: 'application/json',
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
    exportSource: { build: async () => [REPORT] },
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
    expect(deliver).toHaveBeenCalledWith('webhook', BASE_SETTINGS, 'Jane.Doe@x.com', [REPORT]);

    const expected = `ok sent ${REPORT.fileName} ${REPORT.bytes.length}`;
    expect(printed.some((line) => line.includes(expected) && line.endsWith(' target=webhook'))).toBe(true);
    expect(logged.some((line) => line.includes(expected) && line.endsWith(' target=webhook'))).toBe(true);
  });

  it('a null report skips delivery, leaves the marker unchanged, and exits 0', async () => {
    const writeMarker = vi.fn(async () => {});
    const deliver = vi.fn(async () => {});
    const buildReport = vi.fn(async () => null);

    const { deps, printed, logged } = makeDeps({ exportSource: { build: buildReport }, writeMarker, deliver });

    const code = await runSync(deps);

    expect(code).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(writeMarker).not.toHaveBeenCalled();
    expect(printed.some((line) => /\bskip\b/.test(line) && line.endsWith(' target=webhook'))).toBe(true);
    expect(logged.some((line) => /\bskip\b/.test(line) && line.endsWith(' target=webhook'))).toBe(true);
  });

  it('a source answering no file skips delivery and leaves the marker unchanged', async () => {
    const markers: Array<[TargetId, Date]> = [];
    const deliver = vi.fn(async () => {});
    const { deps, logged } = makeDeps({
      exportSource: { build: async () => [] },
      deliver,
      writeMarker: async (target, at) => {
        markers.push([target, at]);
      },
    });

    expect(await runSync(deps)).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(markers).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/ skip no sessions in window .* target=webhook$/);
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

    const { deps, printed, logged } = makeDeps({ exportSource: { build: buildReport }, deliver });

    const code = await runSync(deps);

    expect(code).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(printed.some((line) => /fail export/.test(line) && line.endsWith(' target=webhook'))).toBe(true);
    expect(logged.some((line) => /fail export/.test(line) && line.endsWith(' target=webhook'))).toBe(true);
  });

  it('no resolvable identity fails setup without building a report, and carries no target', async () => {
    const buildReport = vi.fn(async () => [REPORT]);

    const { deps, printed, logged } = makeDeps({
      resolveIdentity: async () => {
        throw new SyncIdentityMissingError();
      },
      exportSource: { build: buildReport },
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
    const buildReport = vi.fn(async () => [REPORT]);

    const { deps } = makeDeps({ readMarker, exportSource: { build: buildReport } });

    const code = await runSync(deps);

    expect(code).toBe(0);
    expect(readMarker).toHaveBeenCalledWith('webhook', NOW);

    const passedWindow = buildReport.mock.calls[0]?.[0]?.window;
    expect(passedWindow.to).toEqual(NOW);
    expect(NOW.getTime() - passedWindow.from.getTime()).toBeGreaterThanOrEqual(10 * DAY_MS);
  });

  it('uses the installed lookbackDays for the window when there is no marker', async () => {
    const buildReport = vi.fn(async () => [REPORT]);
    const { deps } = makeDeps({
      loadSettings: async () => ({ ...BASE_SETTINGS, lookbackDays: 14 }),
      exportSource: { build: buildReport },
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
    const buildReport = vi.fn(async () => [REPORT]);
    const { deps } = makeDeps({
      loadSettings: async () => ({ ...BASE_SETTINGS, includeExternal: policy }),
      platform,
      exportSource: { build: buildReport },
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
      expect(deliver).toHaveBeenCalledWith('git', GIT_ONLY_SETTINGS, 'Jane.Doe@x.com', [REPORT]);
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
        exportSource: { build: buildReport },
      });

      const code = await runSync(deps);

      expect(code).toBe(0);
      expect(deliver).not.toHaveBeenCalled();
      expect(printed.some((line) => /\bskip\b/.test(line) && line.endsWith(' target=git'))).toBe(true);
      expect(logged.some((line) => /\bskip\b/.test(line) && line.endsWith(' target=git'))).toBe(true);
    });
  });

  it('a multi-line git error is logged as exactly one line ending in target=git (CR-007)', async () => {
    const stderr = [
      'To git.example.invalid:team/analytics.git',
      ' ! [remote rejected] HEAD -> main (pre-receive hook declined)',
      "error: failed to push some refs to 'git.example.invalid:team/analytics.git'",
      'hint: see the remote output',
    ].join('\n');
    const { deps, printed, logged } = makeDeps({
      loadSettings: async () => GIT_ONLY_SETTINGS,
      deliver: async () => {
        throw new SyncGitError(stderr, 'protected');
      },
    });

    const code = await runSync(deps);

    expect(code).toBe(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toMatch(/[\r\n]/);
    expect(logged[0]).toMatch(/ fail send .*pre-receive hook declined.*failed to push/);
    expect(logged[0]).toMatch(/ target=git$/);
    expect(printed[0]).toBe(logged[0]);
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

    it('a webhook marker read failure fails that target in setup and still delivers to git (CR-006)', async () => {
      const deliver = vi.fn(async () => {});
      const writeMarker = vi.fn(async () => {});
      const readMarker = vi.fn(async (target: TargetId) => {
        if (target === 'webhook') {
          throw Object.assign(new Error('EACCES: permission denied, open analytics-last-sent'), { code: 'EACCES' });
        }
        return null;
      });

      const { deps, logged } = makeDeps({
        loadSettings: async () => BOTH_SETTINGS,
        deliver,
        writeMarker,
        readMarker,
      });

      const code = await runSync(deps);

      expect(code).toBe(1);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver).toHaveBeenCalledWith('git', BOTH_SETTINGS, 'Jane.Doe@x.com', [REPORT]);
      expect(writeMarker).toHaveBeenCalledWith('git', NOW);
      expect(logged).toHaveLength(2);
      expect(logged[0]).toMatch(/ fail setup .*EACCES.* target=webhook$/);
      expect(logged[1]).toMatch(/ ok sent .* target=git$/);
    });

    it('reads each target window from its own marker', async () => {
      // BOTH_SETTINGS has lookbackDays: 7 — the webhook marker is recent enough that the
      // 7-day lookback dominates its window, while the git marker is old enough (9 days)
      // that its window is instead anchored to that marker (plus the 1h safety margin).
      const webhookMarker = new Date(NOW.getTime() - 2 * DAY_MS);
      const gitMarker = new Date(NOW.getTime() - 9 * DAY_MS);
      const readMarker = vi.fn(async (target: TargetId) => (target === 'git' ? gitMarker : webhookMarker));
      const buildReport = vi.fn(async () => [REPORT]);

      const { deps } = makeDeps({
        loadSettings: async () => BOTH_SETTINGS,
        readMarker,
        exportSource: { build: buildReport },
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
  describe('the export source', () => {
    it('is built once per target with that target\'s window, and each marker moves after its delivery', async () => {
      const writeMarker = vi.fn(async () => {});
      const windows: Array<{ from: Date; to: Date }> = [];
      const exportSource = {
        build: async (input: { window: { from: Date; to: Date } }) => {
          windows.push(input.window);
          return [REPORT];
        },
      };

      const { deps } = makeDeps({ loadSettings: async () => BOTH_SETTINGS, exportSource, writeMarker });

      expect(await runSync(deps)).toBe(0);
      expect(windows).toEqual([
        { from: new Date(NOW.getTime() - 7 * DAY_MS), to: NOW, label: expect.any(String) },
        { from: new Date(NOW.getTime() - 7 * DAY_MS), to: NOW, label: expect.any(String) },
      ]);
      expect(writeMarker).toHaveBeenCalledWith('webhook', NOW);
      expect(writeMarker).toHaveBeenCalledWith('git', NOW);
    });

    it('with OtlpFolderSource, a second run over the same window delivers the same line ids', async () => {
      const home = mkdtempSync(join(tmpdir(), 'run-sync-otlp-'));
      vi.stubEnv('CODEMIE_HOME', home);
      try {
        const folder = join(home, 'analytics', 'sessions');
        mkdirSync(folder, { recursive: true });
        const line = (id: string) => JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: 'codemie.line_id', value: { stringValue: id } }] } }] });
        writeFileSync(join(folder, 's1.hooks.jsonl'), `${line('s1.hooks.jsonl:0')}\n${line('s1.hooks.jsonl:111')}\n`);
        const inWindow = new Date(NOW.getTime() - DAY_MS);
        utimesSync(join(folder, 's1.hooks.jsonl'), inWindow, inWindow);
        const delivered: SyncReport[] = [];
        const { deps } = makeDeps({
          exportSource: new OtlpFolderSource(),
          deliver: async (_target, _settings, _email, reports) => {
            delivered.push(...reports);
          },
        });

        await runSync(deps);
        await runSync(deps);

        const ids = delivered.map((report) =>
          gunzipSync(report.bytes).toString('utf-8').split('\n').filter(Boolean).map((text) => JSON.parse(text).resourceLogs[0].resource.attributes[0].value.stringValue)
        );
        expect(ids).toEqual([['s1.hooks.jsonl:0', 's1.hooks.jsonl:111'], ['s1.hooks.jsonl:0', 's1.hooks.jsonl:111']]);
      } finally {
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('with OtlpFolderSource, a run a week after the last one delivers each line of the seven days once, in files within the cap', async () => {
      const home = mkdtempSync(join(tmpdir(), 'run-sync-week-'));
      vi.stubEnv('CODEMIE_HOME', home);
      try {
        const folder = join(home, 'analytics', 'sessions');
        mkdirSync(folder, { recursive: true });
        const pad = (seed: string) => createHash('sha256').update(seed).digest('hex');
        const line = (id: string) =>
          JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: 'codemie.line_id', value: { stringValue: id } }] } }], pad: pad(id) + pad(`${id}+`) });
        const session = (name: string, written: Date): string[] => {
          const ids = [0, 1, 2].map((i) => `${name}:${i}`);
          writeFileSync(join(folder, name), ids.map((id) => `${line(id)}\n`).join(''));
          utimesSync(join(folder, name), written, written);
          return ids;
        };
        const expected = [0, 1, 2, 3, 4, 5, 6].flatMap((day) => session(`day${day}.hooks.jsonl`, new Date(NOW.getTime() - (day + 0.5) * DAY_MS)));
        session('old.hooks.jsonl', new Date(NOW.getTime() - 9 * DAY_MS));
        const cap = 400;
        const delivered: SyncReport[] = [];
        const markers: Array<[TargetId, Date]> = [];
        const { deps } = makeDeps({
          exportSource: new OtlpFolderSource(cap),
          readMarker: async () => new Date(NOW.getTime() - 7 * DAY_MS),
          deliver: async (_target, _settings, _email, reports) => {
            delivered.push(...reports);
          },
          writeMarker: async (target, at) => {
            markers.push([target, at]);
          },
        });

        expect(await runSync(deps)).toBe(0);

        expect(delivered.length).toBeGreaterThan(1);
        for (const report of delivered) expect(report.bytes.length).toBeLessThanOrEqual(cap);
        const ids = delivered.flatMap((report) =>
          gunzipSync(report.bytes).toString('utf-8').split('\n').filter(Boolean).map((text) => JSON.parse(text).resourceLogs[0].resource.attributes[0].value.stringValue)
        );
        expect(ids.sort()).toEqual(expected.sort());
        expect(markers).toEqual([['webhook', NOW]]);
      } finally {
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('with the local export source on a webhook, the OTLP file goes before the report in one ok line, the marker moves once', async () => {
      const home = mkdtempSync(join(tmpdir(), 'run-sync-local-'));
      vi.stubEnv('CODEMIE_HOME', home);
      try {
        const folder = join(home, 'analytics', 'sessions');
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 's1.hooks.jsonl'), `${JSON.stringify({ resourceLogs: [] })}\n`);
        const inWindow = new Date(NOW.getTime() - DAY_MS);
        utimesSync(join(folder, 's1.hooks.jsonl'), inWindow, inWindow);
        const rawSessions = [{
          sessionId: 'r1',
          startEvent: { recordId: 'r1', type: 'session_start', timestamp: 1000, codeMieSessionId: 'r1', agentName: 'claude', syncStatus: 'synced', data: { provider: 'native', workingDirectory: '/repo', startTime: 1000 } },
          endEvent: { recordId: 'r1-end', type: 'session_end', timestamp: 2000, codeMieSessionId: 'r1', agentName: 'claude', syncStatus: 'synced', data: { endTime: 2000, duration: 1000, totalTurns: 1 } },
          deltas: [],
        }] as unknown as RawSessionData[];
        const cost = {
          index: new Map([['r1', { sessionId: 'r1', tokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, total: 150 }, costUSD: 0.01, perModel: [], priced: true, hadLog: true }]]),
          summary: { totalCostUSD: 0.01, pricedSessions: 1, totalSessions: 1, unpricedModels: [], estimatedModels: [], localModels: [] },
        };
        const events: string[] = [];
        let total = 0;
        const fetchImpl = async (_url: string, init: { body: string }) => {
          const attachment = JSON.parse(init.body).attachments[0];
          events.push(`post ${attachment.name}`);
          total += Buffer.from(attachment.contentBytes, 'base64').length;
          return { ok: true, status: 200 };
        };
        const { deps, logged } = makeDeps({
          exportSource: new LocalExportSource(new OtlpFolderSource(), new ReportSource({ load: async () => ({ rawSessions, cost }) })),
          deliver: (_target, _settings, _email, reports) => new WebhookTarget('https://example.invalid/hook', fetchImpl as never).deliver(reports),
          writeMarker: async (target) => {
            events.push(`marker ${target}`);
          },
        });

        expect(await runSync(deps)).toBe(0);
        expect(events).toEqual([
          'post codemie-analytics-jane-doe-x-com-2026-10-29.otlp.jsonl.gz',
          'post codemie-analytics-jane-doe-x-com-2026-10-29.report.json',
          'marker webhook',
        ]);
        expect(logged).toEqual([`${NOW.toISOString()} ok sent 2 files ${total} target=webhook`]);
      } finally {
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('the local export source whose OTLP files fail to build delivers the report, warns in its ok line and leaves the marker; the next run delivers both and moves it', async () => {
      const OTLP: SyncReport = { fileName: 'codemie-analytics-jane-2026-10-29.otlp.jsonl.gz', bytes: Buffer.from('otlp'), contentType: 'application/gzip' };
      const lastSent = new Date(NOW.getTime() - 10 * DAY_MS);
      let marker = lastSent;
      let broken = true;
      const builtFrom: Date[] = [];
      const delivered: SyncReport[][] = [];
      const folder = {
        build: async (input: { window: { from: Date } }) => {
          builtFrom.push(input.window.from);
          if (broken) throw new Error('line above the cap in s1.hooks.jsonl');
          return [OTLP];
        },
      };
      const { deps, logged } = makeDeps({
        exportSource: new LocalExportSource(folder, { build: async () => [REPORT] }),
        readMarker: async () => marker,
        deliver: async (_target, _settings, _email, reports) => {
          delivered.push([...reports]);
        },
        writeMarker: async (_target, at) => {
          marker = at;
        },
      });

      expect(await runSync(deps)).toBe(0);
      expect(delivered).toEqual([[REPORT]]);
      expect(logged).toEqual([
        `${NOW.toISOString()} ok sent ${REPORT.fileName} ${REPORT.bytes.length} (warning: OTLP files not built, the marker stays and the next run tries them again: line above the cap in s1.hooks.jsonl) target=webhook`,
      ]);
      expect(marker).toBe(lastSent);

      broken = false;
      expect(await runSync(deps)).toBe(0);
      expect(delivered[1]).toEqual([OTLP, REPORT]);
      expect(builtFrom).toEqual([new Date(lastSent.getTime() - HOUR_MS), new Date(lastSent.getTime() - HOUR_MS)]);
      expect(marker).toBe(NOW);
    });

    it('the local export source whose OTLP files fail to build and with no report fails export, the marker stays', async () => {
      const writeMarker = vi.fn(async () => {});
      const failing = { build: async () => { throw new Error('line above the cap in s1.hooks.jsonl'); } };
      const { deps, logged } = makeDeps({ exportSource: new LocalExportSource(failing, { build: async () => null }), writeMarker });

      expect(await runSync(deps)).toBe(1);
      expect(logged).toEqual([`${NOW.toISOString()} fail export line above the cap in s1.hooks.jsonl target=webhook`]);
      expect(writeMarker).not.toHaveBeenCalled();
    });

    it('a source whose files leave sessions out: the ok line carries the warning and the marker moves', async () => {
      const writeMarker = vi.fn(async () => {});
      const { deps, logged } = makeDeps({ exportSource: { build: async () => Object.assign([REPORT], { leftOut: 'X' }) }, writeMarker });

      expect(await runSync(deps)).toBe(0);
      expect(logged).toEqual([`${NOW.toISOString()} ok sent ${REPORT.fileName} ${REPORT.bytes.length} (warning: X) target=webhook`]);
      expect(writeMarker).toHaveBeenCalledWith('webhook', NOW);
    });

    it('a source answering no file with sessions left out: the skip line carries the warning, nothing delivered, the marker untouched', async () => {
      const writeMarker = vi.fn(async () => {});
      const deliver = vi.fn(async () => {});
      const { deps, logged } = makeDeps({ exportSource: { build: async () => Object.assign([], { leftOut: 'X' }) }, writeMarker, deliver });

      expect(await runSync(deps)).toBe(0);
      expect(logged).toEqual([`${NOW.toISOString()} skip no sessions in window 2026-10-22-to-2026-10-29 (warning: X) target=webhook`]);
      expect(deliver).not.toHaveBeenCalled();
      expect(writeMarker).not.toHaveBeenCalled();
    });

    it('a source answering no file with a warning: the target fails export with it, nothing delivered, the marker untouched', async () => {
      const writeMarker = vi.fn(async () => {});
      const deliver = vi.fn(async () => {});
      const { deps, logged } = makeDeps({ exportSource: { build: async () => Object.assign([], { warning: 'W' }) }, writeMarker, deliver });

      expect(await runSync(deps)).toBe(1);
      expect(logged).toEqual([`${NOW.toISOString()} fail export W target=webhook`]);
      expect(deliver).not.toHaveBeenCalled();
      expect(writeMarker).not.toHaveBeenCalled();
    });

    it('a source answering no file with a warning and sessions left out: fail export with the warning, then the left-out note', async () => {
      const writeMarker = vi.fn(async () => {});
      const deliver = vi.fn(async () => {});
      const { deps, logged } = makeDeps({
        exportSource: { build: async () => Object.assign([], { warning: 'W', leftOut: 'L' }) },
        writeMarker,
        deliver,
      });

      expect(await runSync(deps)).toBe(1);
      expect(logged).toEqual([`${NOW.toISOString()} fail export W (warning: L) target=webhook`]);
      expect(deliver).not.toHaveBeenCalled();
      expect(writeMarker).not.toHaveBeenCalled();
    });

    it('edge: a source with both a warning and sessions left out: both on the ok line, the marker stays', async () => {
      const writeMarker = vi.fn(async () => {});
      const { deps, logged } = makeDeps({
        exportSource: { build: async () => Object.assign([REPORT], { warning: 'W', leftOut: 'X' }) },
        writeMarker,
      });

      expect(await runSync(deps)).toBe(0);
      expect(logged).toEqual([`${NOW.toISOString()} ok sent ${REPORT.fileName} ${REPORT.bytes.length} (warning: W) (warning: X) target=webhook`]);
      expect(writeMarker).not.toHaveBeenCalled();
    });

    it('edge: a gzip above 70,000,000 bytes fails export naming its size and the cap, and the marker stays', async () => {
      const writeMarker = vi.fn(async () => {});
      const fetchImpl = vi.fn();
      const big: SyncReport = { fileName: 'codemie-analytics-jane-2026-10-29.otlp.jsonl.gz', bytes: Buffer.alloc(70_000_001), contentType: 'application/gzip' };
      const { deps, printed } = makeDeps({
        exportSource: { build: async () => [big] },
        deliver: (_target, _settings, _email, reports) => new WebhookTarget('https://example.invalid/hook', fetchImpl as never).deliver(reports),
        writeMarker,
      });

      expect(await runSync(deps)).toBe(1);
      expect(printed.some((text) => /fail export/.test(text) && text.includes('70000001') && text.includes('70000000'))).toBe(true);
      expect(writeMarker).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    describe('a source of three files', () => {
      const PARTS: SyncReport[] = [1, 2, 3].map((k) => ({
        fileName: `codemie-analytics-jane-2026-10-29.part-0${k}-of-03.otlp.jsonl.gz`,
        bytes: Buffer.alloc(k * 10),
        contentType: 'application/gzip',
      }));

      function webhookHarness(failing?: string) {
        const events: string[] = [];
        const fetchImpl = async (_url: string, init: { body: string }) => {
          const name = JSON.parse(init.body).attachments[0].name as string;
          events.push(`post ${name}`);
          return { ok: name !== failing, status: name === failing ? 500 : 200 };
        };
        const harness = makeDeps({
          exportSource: { build: async () => PARTS },
          deliver: (_target, _settings, _email, reports) => new WebhookTarget('https://example.invalid/hook', fetchImpl as never).deliver(reports),
          writeMarker: async (target) => {
            events.push(`marker ${target}`);
          },
        });
        return { ...harness, events };
      }

      it('the webhook gets them in order, one ok line names the count and total bytes, the marker moves after the third', async () => {
        const { deps, logged, events } = webhookHarness();

        expect(await runSync(deps)).toBe(0);
        expect(events).toEqual([...PARTS.map((part) => `post ${part.fileName}`), 'marker webhook']);
        expect(logged).toEqual([`${NOW.toISOString()} ok sent 3 files 60 target=webhook`]);
      });

      it('the second request failing still makes the third, fails send and keeps the marker', async () => {
        const { deps, logged, events } = webhookHarness(PARTS[1].fileName);

        expect(await runSync(deps)).toBe(1);
        expect(events).toEqual(PARTS.map((part) => `post ${part.fileName}`));
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatch(/ fail send .* target=webhook$/);
      });

      it('git writes them in one commit', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'run-sync-git-'));
        try {
          const commits: string[][] = [];
          const run = async (args: string[]) => {
            let i = 0;
            while (args[i] === '-c') i += 2;
            const sub = args.slice(i);
            if (sub[0] === 'remote') throw new Error('not a repo');
            if (sub[0] === 'symbolic-ref') return 'main';
            if (sub[0] === 'diff') throw new SyncGitError('staged', 'other');
            if (sub[0] === 'commit') commits.push(sub);
            return '';
          };
          const { deps, logged } = makeDeps({
            loadSettings: async () => GIT_ONLY_SETTINGS,
            exportSource: { build: async () => PARTS },
            deliver: (_target, settings, email, reports) => new GitTarget(settings.git!, email, run, dir).deliver(reports),
          });

          expect(await runSync(deps)).toBe(0);
          expect(commits).toEqual([['commit', '--no-verify', '-m', 'analytics sync: jane-doe-x-com (3 files)']]);
          expect(readdirSync(join(dir, 'jane-doe-x-com')).sort()).toEqual(PARTS.map((part) => part.fileName));
          expect(logged).toEqual([`${NOW.toISOString()} ok sent 3 files 60 target=git`]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  });
});
