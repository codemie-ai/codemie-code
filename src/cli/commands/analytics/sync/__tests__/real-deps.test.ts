import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncReport, SyncSettings } from '../types.js';

const mocks = vi.hoisted(() => ({
  sendWebhook: vi.fn(async () => {}),
  gitDeliver: vi.fn(async () => {}),
  gitTargetCtor: vi.fn(),
}));

vi.mock('../targets/webhook-target.js', () => ({ sendWebhook: mocks.sendWebhook }));

vi.mock('../targets/git-target.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../targets/git-target.js')>();
  class FakeGitTarget {
    constructor(...args: unknown[]) {
      mocks.gitTargetCtor(...args);
    }
    deliver = mocks.gitDeliver;
  }
  return { ...actual, GitTarget: FakeGitTarget };
});

const { realSyncDeps } = await import('../run-sync.js');
const { createRealStatusDeps } = await import('../status.js');

const NOW = new Date('2026-11-03T12:00:00.000Z');
const SENT_AT = new Date('2026-11-03T03:00:00.000Z');
const REPORT: SyncReport = { fileName: 'r.report.json', bytes: Buffer.from('{}') };
const SETTINGS: SyncSettings = {
  webhookUrl: 'https://example.invalid/hook?sig=FAKE',
  git: { repoUrl: 'https://example.invalid/team/repo.git' },
  format: 'json',
  includeExternal: 'windows',
  at: '03:00',
};

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

describe('real sync/status deps: per-target marker routing and delivery dispatch (CR-008)', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'codemie-sync-real-deps-'));
    previousHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = home;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.CODEMIE_HOME;
    } else {
      process.env.CODEMIE_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  });

  it('writes the git marker to analytics-last-sent-git and leaves the webhook marker untouched', async () => {
    const deps = realSyncDeps();

    await deps.writeMarker('git', SENT_AT);

    expect(await readFile(join(home, 'analytics-last-sent-git'), 'utf-8')).toBe(SENT_AT.toISOString());
    expect(await exists(join(home, 'analytics-last-sent'))).toBe(false);
    await expect(deps.readMarker('git', NOW)).resolves.toEqual(SENT_AT);
    await expect(deps.readMarker('webhook', NOW)).resolves.toBeNull();
  });

  it('writes the webhook marker to the collector-compatible analytics-last-sent only', async () => {
    const deps = realSyncDeps();

    await deps.writeMarker('webhook', SENT_AT);

    expect(await readFile(join(home, 'analytics-last-sent'), 'utf-8')).toBe(SENT_AT.toISOString());
    expect(await exists(join(home, 'analytics-last-sent-git'))).toBe(false);
    await expect(deps.readMarker('webhook', NOW)).resolves.toEqual(SENT_AT);
    await expect(deps.readMarker('git', NOW)).resolves.toBeNull();
  });

  it('status reads each target from its own marker file', async () => {
    await realSyncDeps().writeMarker('git', SENT_AT);
    const statusDeps = createRealStatusDeps();

    await expect(statusDeps.readMarker('git', NOW)).resolves.toEqual(SENT_AT);
    await expect(statusDeps.readMarker('webhook', NOW)).resolves.toBeNull();
  });

  it('dispatches webhook delivery to sendWebhook and git delivery to GitTarget.deliver', async () => {
    const deps = realSyncDeps();

    await deps.deliver('webhook', SETTINGS, 'jane@example.com', REPORT);
    expect(mocks.sendWebhook).toHaveBeenCalledWith(SETTINGS.webhookUrl, REPORT);
    expect(mocks.gitDeliver).not.toHaveBeenCalled();

    await deps.deliver('git', SETTINGS, 'jane@example.com', REPORT);
    expect(mocks.gitDeliver).toHaveBeenCalledWith(REPORT);
    expect(mocks.gitTargetCtor.mock.calls[0]?.[0]).toEqual(SETTINGS.git);
    expect(mocks.gitTargetCtor.mock.calls[0]?.[1]).toBe('jane@example.com');
    expect(mocks.sendWebhook).toHaveBeenCalledTimes(1);
  });
});
