import { mkdtemp, readFile, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncConfigError } from '@/utils/errors.js';
import { getCodemiePath } from '@/utils/paths.js';

import {
  deleteSyncSettings,
  getSyncSettingsPath,
  loadSyncSettings,
  validateInstallOptions,
  writeSyncSettings
} from '../config-store.js';

const FAKE_URL = 'https://example.invalid/webhook?sig=FAKE';
const FAKE_GIT_REPO = 'https://example.invalid/team/analytics.git';

describe('getSyncSettingsPath', () => {
  it('points at the collector-compatible analytics-sync.json under the CodeMie home', () => {
    expect(getSyncSettingsPath()).toBe(getCodemiePath('analytics-sync.json'));
  });
});

describe('validateInstallOptions', () => {
  it('rejects neither --webhook nor --git-repo given, naming both flags', () => {
    expect(() => validateInstallOptions({})).toThrow(SyncConfigError);
    expect(() => validateInstallOptions({})).toThrow(/--webhook/);
    expect(() => validateInstallOptions({})).toThrow(/--git-repo/);
  });

  it('rejects an http: --webhook, naming the flag', () => {
    expect(() => validateInstallOptions({ webhook: 'http://example.invalid/x?sig=FAKE' })).toThrow(/--webhook/);
  });

  it('rejects a malformed --webhook URL, naming the flag', () => {
    expect(() => validateInstallOptions({ webhook: 'not a url' })).toThrow(/--webhook/);
  });

  it.each(['24:00', '3:7'])('rejects --at "%s", naming the flag', (at) => {
    expect(() => validateInstallOptions({ webhook: FAKE_URL, at })).toThrow(/--at/);
  });

  it.each(['0', '31', '2.5'])('rejects --lookback-days "%s", naming the flag', (lookbackDays) => {
    expect(() => validateInstallOptions({ webhook: FAKE_URL, lookbackDays })).toThrow(/--lookback-days/);
  });

  it('rejects an unknown --include-external value, naming the flag', () => {
    expect(() => validateInstallOptions({ webhook: FAKE_URL, includeExternal: 'sometimes' })).toThrow(
      /--include-external/
    );
  });

  it('rejects an unknown --format value, naming the flag', () => {
    expect(() => validateInstallOptions({ webhook: FAKE_URL, format: 'otel' })).toThrow(/--format/);
  });

  it('omitting --lookback-days yields no lookbackDays key, with defaults at 03:00 / windows / json', () => {
    const settings = validateInstallOptions({ webhook: FAKE_URL });
    expect(settings).toEqual({ webhookUrl: FAKE_URL, format: 'json', includeExternal: 'windows', at: '03:00' });
    expect('lookbackDays' in settings).toBe(false);
  });

  it('accepts a valid --webhook, --at, --lookback-days and --include-external', () => {
    const settings = validateInstallOptions({
      webhook: FAKE_URL,
      at: '14:30',
      lookbackDays: '14',
      includeExternal: 'always'
    });
    expect(settings).toEqual({
      webhookUrl: FAKE_URL,
      format: 'json',
      includeExternal: 'always',
      at: '14:30',
      lookbackDays: 14
    });
  });

  it.each(['/abs', 'C:\\x', 'a/../..'])('rejects --git-path "%s", naming the flag', (gitPath) => {
    expect(() => validateInstallOptions({ gitRepo: FAKE_GIT_REPO, gitPath })).toThrow(/--git-path/);
  });

  it('rejects a --git-repo URL with embedded credentials, naming the flag', () => {
    expect(() => validateInstallOptions({ gitRepo: 'https://u:t@host/r.git' })).toThrow(/--git-repo/);
  });

  it('accepts a plain scp-style ssh --git-repo URL with a username but no password', () => {
    const settings = validateInstallOptions({ gitRepo: 'git@host:org/r.git' });
    expect(settings.git).toEqual({ repoUrl: 'git@host:org/r.git' });
  });

  it('accepts an ssh:// --git-repo URL with a username but no password', () => {
    const settings = validateInstallOptions({ gitRepo: 'ssh://git@host/r.git' });
    expect(settings.git).toEqual({ repoUrl: 'ssh://git@host/r.git' });
  });

  it('git-only validates to { git: { repoUrl }, format: "json" } with no webhookUrl', () => {
    const settings = validateInstallOptions({ gitRepo: FAKE_GIT_REPO });
    expect(settings).toEqual({
      git: { repoUrl: FAKE_GIT_REPO },
      format: 'json',
      includeExternal: 'windows',
      at: '03:00'
    });
    expect('webhookUrl' in settings).toBe(false);
  });

  it('normalises a --git-path and keeps a trimmed --git-branch', () => {
    const settings = validateInstallOptions({
      gitRepo: FAKE_GIT_REPO,
      gitBranch: ' main ',
      gitPath: './reports/analytics/'
    });
    expect(settings.git).toEqual({ repoUrl: FAKE_GIT_REPO, branch: 'main', path: 'reports/analytics' });
  });
});

describe('sync settings file', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codemie-sync-settings-'));
    settingsPath = join(dir, 'analytics-sync.json');
  });

  afterEach(() => {
    delete process.env.ANALYTICS_WEBHOOK_URL;
  });

  describe('loadSyncSettings', () => {
    it('returns null when the file is missing', async () => {
      await expect(loadSyncSettings(settingsPath)).resolves.toBeNull();
    });

    it('throws SyncConfigError on malformed JSON', async () => {
      await writeFile(settingsPath, '{not valid json', 'utf-8');
      await expect(loadSyncSettings(settingsPath)).rejects.toThrow(SyncConfigError);
    });

    it('never reads ANALYTICS_WEBHOOK_URL: a missing file still resolves to null', async () => {
      process.env.ANALYTICS_WEBHOOK_URL = FAKE_URL;
      await expect(loadSyncSettings(settingsPath)).resolves.toBeNull();
    });

    it('round-trips a previously written settings file', async () => {
      const settings = validateInstallOptions({ webhook: FAKE_URL, lookbackDays: '14' });
      await writeSyncSettings(settings, settingsPath);

      await expect(loadSyncSettings(settingsPath)).resolves.toEqual(settings);
    });

    it('loads a legacy webhook-only file (no format/git) with format defaulted to json', async () => {
      await writeFile(settingsPath, JSON.stringify({ webhookUrl: FAKE_URL, includeExternal: 'windows', at: '03:00' }), 'utf-8');

      await expect(loadSyncSettings(settingsPath)).resolves.toEqual({
        webhookUrl: FAKE_URL,
        format: 'json',
        includeExternal: 'windows',
        at: '03:00'
      });
    });

    it('returns null when the file has neither a usable webhookUrl nor a usable git.repoUrl', async () => {
      await writeFile(settingsPath, JSON.stringify({ includeExternal: 'windows', at: '03:00' }), 'utf-8');

      await expect(loadSyncSettings(settingsPath)).resolves.toBeNull();
    });
  });

  describe('writeSyncSettings', () => {
    it('writes the settings file with mode 0600', async () => {
      const settings = validateInstallOptions({ webhook: FAKE_URL });
      await writeSyncSettings(settings, settingsPath);

      if (process.platform !== 'win32') {
        const mode = (await stat(settingsPath)).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });

    it('replaces a pre-existing collector-shaped JSON file wholesale', async () => {
      await writeFile(
        settingsPath,
        JSON.stringify({ targets: { webhook: { url: 'https://old.invalid/webhook?sig=OLD' } } }),
        'utf-8'
      );

      const settings = validateInstallOptions({ webhook: FAKE_URL, lookbackDays: '5' });
      await writeSyncSettings(settings, settingsPath);

      await expect(loadSyncSettings(settingsPath)).resolves.toEqual(settings);
    });

    it('fixes permissions on a pre-existing 0644 file after a write', async () => {
      await writeFile(settingsPath, JSON.stringify({ webhookUrl: FAKE_URL, includeExternal: 'windows', at: '03:00' }), 'utf-8');
      const { chmod } = await import('fs/promises');
      await chmod(settingsPath, 0o644);

      await writeSyncSettings(validateInstallOptions({ webhook: FAKE_URL }), settingsPath);

      if (process.platform !== 'win32') {
        const mode = (await stat(settingsPath)).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });
  });

  describe('deleteSyncSettings', () => {
    it('returns false when the file does not exist', async () => {
      await expect(deleteSyncSettings(settingsPath)).resolves.toBe(false);
    });

    it('deletes an existing file and returns true', async () => {
      await writeSyncSettings(validateInstallOptions({ webhook: FAKE_URL }), settingsPath);

      await expect(deleteSyncSettings(settingsPath)).resolves.toBe(true);
      await expect(readFile(settingsPath, 'utf-8')).rejects.toThrow();
    });
  });
});
