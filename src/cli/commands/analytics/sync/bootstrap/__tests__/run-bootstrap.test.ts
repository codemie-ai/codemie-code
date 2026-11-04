/**
 * Tests for the `codemie analytics sync bootstrap` runner (EPMCDME-16487 Task 6):
 * `runBootstrap`'s dispatch (`--webhook` vs. guided vs. no-TTY failure), the `--webhook`
 * non-interactive mode's validate-then-send path, and `setupCheckReport`.
 *
 * Guided mode itself (`./guided.ts`) is a Task 7 placeholder here and is mocked out; this
 * file only asserts that `runBootstrap` hands off to it correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SyncDeliveryError } from '@/utils/errors.js';

import type { BootstrapDeps } from '../types.js';

const loadBootstrapStateMock = vi.fn();
const saveBootstrapStateMock = vi.fn();
vi.mock('../state-store.js', () => ({
  getBootstrapStatePath: () => '/fake/.codemie/analytics-sync-bootstrap.json',
  loadBootstrapState: (...a: unknown[]) => loadBootstrapStateMock(...a),
  saveBootstrapState: (...a: unknown[]) => saveBootstrapStateMock(...a),
}));

const runGuidedMock = vi.fn();
vi.mock('../guided.js', () => ({
  runGuided: (...a: unknown[]) => runGuidedMock(...a),
}));

import { runBootstrap, setupCheckReport, UPDATE_HINT } from '../run-bootstrap.js';

const VALID_WEBHOOK = 'https://contoso.example/trigger?sig=FAKESIG';

function createDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    isTTY: true,
    cwd: '/work',
    now: () => new Date('2026-11-04T21:33:07.123Z'),
    out: vi.fn(),
    err: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    openUrl: vi.fn().mockResolvedValue(undefined),
    prompt: {
      input: vi.fn(),
      confirm: vi.fn(),
      select: vi.fn(),
    },
    statePath: '/fake/.codemie/analytics-sync-bootstrap.json',
    ...overrides,
  };
}

function errLines(deps: BootstrapDeps): string[] {
  return (deps.err as ReturnType<typeof vi.fn>).mock.calls.map(([line]: [string]) => line);
}

describe('runBootstrap — --webhook mode validation (before any send)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an invalid webhook URL, naming --webhook, without sending', async () => {
    const deps = createDeps();

    const exit = await runBootstrap({ webhook: 'not a url' }, deps);

    expect(exit).not.toBe(0);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.out).not.toHaveBeenCalled();
    expect(errLines(deps).some((l) => l.includes('--webhook'))).toBe(true);
  });

  it('rejects a lookback of 31, naming --lookback-days, without sending', async () => {
    const deps = createDeps();

    const exit = await runBootstrap({ webhook: VALID_WEBHOOK, lookbackDays: '31' }, deps);

    expect(exit).not.toBe(0);
    expect(deps.send).not.toHaveBeenCalled();
    expect(errLines(deps).some((l) => l.includes('--lookback-days'))).toBe(true);
  });

  it('rejects a lookback of 0 the same way', async () => {
    const deps = createDeps();

    const exit = await runBootstrap({ webhook: VALID_WEBHOOK, lookbackDays: '0' }, deps);

    expect(exit).not.toBe(0);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('rejects an unknown --include-external policy, naming the option, without sending', async () => {
    const deps = createDeps();

    const exit = await runBootstrap({ webhook: VALID_WEBHOOK, includeExternal: 'sometimes' }, deps);

    expect(exit).not.toBe(0);
    expect(deps.send).not.toHaveBeenCalled();
    expect(errLines(deps).some((l) => l.includes('--include-external'))).toBe(true);
  });
});

describe('runBootstrap — --webhook mode, success and failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('on success: sends once, prints exactly the install command to out, the check/cleanup/UPDATE_HINT lines to err with no sig, exit 0, and never reads or writes the state file', async () => {
    const deps = createDeps();

    const exit = await runBootstrap({ webhook: VALID_WEBHOOK, includeExternal: 'always' }, deps);

    expect(exit).toBe(0);
    expect(deps.send).toHaveBeenCalledTimes(1);

    expect(deps.out).toHaveBeenCalledTimes(1);
    expect(deps.out).toHaveBeenCalledWith(
      `codemie analytics sync install --webhook "${VALID_WEBHOOK}" --include-external "always"`
    );

    const lines = errLines(deps);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => l.includes(UPDATE_HINT))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain('FAKESIG');
      expect(line).not.toContain('sig=');
    }

    expect(loadBootstrapStateMock).not.toHaveBeenCalled();
    expect(saveBootstrapStateMock).not.toHaveBeenCalled();
  });

  it('omits --lookback-days from the printed command when no fixed value was chosen', async () => {
    const deps = createDeps();

    await runBootstrap({ webhook: VALID_WEBHOOK }, deps);

    expect(deps.out).toHaveBeenCalledWith(expect.not.stringContaining('--lookback-days'));
  });

  it('includes a fixed --lookback-days in the printed command when one was chosen', async () => {
    const deps = createDeps();

    await runBootstrap({ webhook: VALID_WEBHOOK, lookbackDays: '14' }, deps);

    expect(deps.out).toHaveBeenCalledWith(expect.stringContaining('--lookback-days "14"'));
  });

  it('a 403 SyncDeliveryError gives no out call, a 4xx-specific err hint, and a non-zero exit', async () => {
    const deps = createDeps({
      send: vi.fn().mockRejectedValue(new SyncDeliveryError('Webhook delivery failed with status 403', 403)),
    });

    const exit = await runBootstrap({ webhook: VALID_WEBHOOK }, deps);

    expect(exit).not.toBe(0);
    expect(deps.out).not.toHaveBeenCalled();
    expect(errLines(deps).some((l) => /turned on/i.test(l) && /Anyone/.test(l))).toBe(true);
  });

  it('a network error gives no out call, a non-zero exit, and no 4xx hint', async () => {
    const deps = createDeps({ send: vi.fn().mockRejectedValue(new Error('fetch failed: getaddrinfo ENOTFOUND')) });

    const exit = await runBootstrap({ webhook: VALID_WEBHOOK }, deps);

    expect(exit).not.toBe(0);
    expect(deps.out).not.toHaveBeenCalled();
    expect(errLines(deps).some((l) => /turned on/i.test(l) && /Anyone/.test(l))).toBe(false);
  });
});

describe('runBootstrap — dispatch without --webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hands off to runGuided when a terminal is attached', async () => {
    runGuidedMock.mockResolvedValue(0);
    const deps = createDeps({ isTTY: true });

    const exit = await runBootstrap({}, deps);

    expect(runGuidedMock).toHaveBeenCalledWith(deps);
    expect(exit).toBe(0);
  });

  it('fails at once, naming both --webhook and a terminal, when there is no TTY', async () => {
    const deps = createDeps({ isTTY: false });

    const exit = await runBootstrap({}, deps);

    expect(exit).not.toBe(0);
    expect(runGuidedMock).not.toHaveBeenCalled();
    expect(deps.out).not.toHaveBeenCalled();
    expect(errLines(deps).some((l) => l.includes('--webhook'))).toBe(true);
    expect(errLines(deps).some((l) => /terminal/i.test(l))).toBe(true);
  });
});

describe('setupCheckReport', () => {
  it('names the file setup-check-<stamp>.json and carries no webhook URL or analytics data', () => {
    const now = new Date('2026-11-04T21:33:07.123Z');

    const report = setupCheckReport(now);

    expect(report.fileName).toBe('setup-check-20261104T213307Z.json');
    const parsed = JSON.parse(report.bytes.toString('utf-8'));
    expect(parsed).toEqual({
      setupCheck: true,
      sentAt: now.toISOString(),
      note: expect.any(String),
    });
  });
});
