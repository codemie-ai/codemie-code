import { mkdtemp, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getCodemiePath } from '@/utils/paths.js';

import {
  checkReuse,
  firstUnansweredStep,
  getBootstrapStatePath,
  loadBootstrapState,
  saveBootstrapState,
  summarizeState,
  toInstallCommandOptions,
  type BootstrapState
} from '../state-store.js';

const FAKE_TRIGGER_URL = 'https://example.invalid/triggers/invoke?api-version=1&sig=FAKESECRET';

/** A fully-answered state (steps 1-7) that `checkReuse` should accept as-is. */
const COMPLETE_STATE: BootstrapState = {
  version: 1,
  teamId: '11111111-2222-3333-4444-555555555555',
  channelId: '19:abcDEF123@thread.tacv2',
  channelName: 'Analytics',
  siteUrl: 'https://contoso.sharepoint.com/sites/Analytics',
  folderPath: 'Shared Documents/exports',
  timeZone: 'UTC',
  flowImported: true,
  webhookUrl: FAKE_TRIGGER_URL,
  webhookTest: 'passed',
  includeExternal: 'windows',
  lookbackDays: 7
};

describe('getBootstrapStatePath', () => {
  it('points at analytics-sync-bootstrap.json under the CodeMie home', () => {
    expect(getBootstrapStatePath()).toBe(getCodemiePath('analytics-sync-bootstrap.json'));
  });
});

describe('loadBootstrapState / saveBootstrapState', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bootstrap-state-test-'));
    path = join(dir, 'analytics-sync-bootstrap.json');
  });

  afterEach(async () => {
    const { rm } = await import('fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('returns { state: null } with no notice when the file is missing', async () => {
    await expect(loadBootstrapState(path)).resolves.toEqual({ state: null });
  });

  it('returns { state: null } and a notice naming the path when the file is not valid JSON', async () => {
    await writeFile(path, 'not json', 'utf-8');

    const result = await loadBootstrapState(path);
    expect(result.state).toBeNull();
    expect(result.notice).toContain(path);
  });

  it('returns { state: null } and a notice naming the path when the JSON has the wrong shape', async () => {
    await writeFile(path, JSON.stringify({ teamId: 'x' }), 'utf-8');

    const result = await loadBootstrapState(path);
    expect(result.state).toBeNull();
    expect(result.notice).toContain(path);
  });

  it('returns { state: null } and a notice naming the path when the file cannot be read', async () => {
    await writeFile(path, JSON.stringify({ version: 1 }), 'utf-8');
    const { chmod } = await import('fs/promises');
    await chmod(path, 0o000);

    try {
      if (process.getuid?.() === 0) {
        return; // root bypasses file-mode permission checks; nothing to assert here.
      }
      const result = await loadBootstrapState(path);
      expect(result.state).toBeNull();
      expect(result.notice).toContain(path);
    } finally {
      await chmod(path, 0o600);
    }
  });

  it('round-trips a saved state and writes it mode 0600', async () => {
    await saveBootstrapState(COMPLETE_STATE, path);

    await expect(loadBootstrapState(path)).resolves.toEqual({ state: COMPLETE_STATE });

    if (process.platform !== 'win32') {
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

describe('firstUnansweredStep', () => {
  it('returns 1 for a fresh state', () => {
    expect(firstUnansweredStep({ version: 1 })).toBe(1);
  });

  it('returns 8 once every step is answered', () => {
    expect(firstUnansweredStep(COMPLETE_STATE)).toBe(8);
  });

  it('returns 2 when the Teams step is answered but SharePoint is not', () => {
    expect(firstUnansweredStep({ version: 1, teamId: 't', channelId: 'c' })).toBe(2);
  });

  it('returns 5 when steps 1-4 are answered but the webhook is not', () => {
    expect(
      firstUnansweredStep({
        version: 1,
        teamId: 't',
        channelId: 'c',
        siteUrl: 's',
        folderPath: 'f',
        timeZone: 'UTC',
        flowImported: true
      })
    ).toBe(5);
  });
});

describe('firstUnansweredStep — "already imported" shortcut', () => {
  it('starts from step 5 when steps 1-4 were skipped via the shortcut', () => {
    expect(firstUnansweredStep({ version: 1, skippedSetup: true })).toBe(5);
  });

  it('lets checkReuse accept a complete state created via the shortcut', () => {
    const result = checkReuse({
      version: 1,
      skippedSetup: true,
      webhookUrl: FAKE_TRIGGER_URL,
      webhookTest: 'passed',
      includeExternal: 'windows',
      lookbackDays: 'default'
    });
    expect(result.ok).toBe(true);
  });
});

describe('checkReuse', () => {
  it('is ok when webhookUrl, webhookTest, includeExternal and lookbackDays are all present and valid', () => {
    const result = checkReuse(COMPLETE_STATE);
    expect(result.ok).toBe(true);
  });

  it('accepts a saved lookbackDays of "default"', () => {
    const result = checkReuse({ ...COMPLETE_STATE, lookbackDays: 'default' });
    expect(result.ok).toBe(true);
  });

  it('resumes at step 7 when lookbackDays is out of range', () => {
    expect(checkReuse({ ...COMPLETE_STATE, lookbackDays: 45 })).toEqual({ ok: false, resumeAt: 7 });
  });

  it('resumes at step 6 when includeExternal is an unknown policy', () => {
    expect(
      checkReuse({ ...COMPLETE_STATE, includeExternal: 'bogus' as unknown as BootstrapState['includeExternal'] })
    ).toEqual({ ok: false, resumeAt: 6 });
  });

  it('resumes at step 5 when webhookTest is missing', () => {
    const { webhookTest: _webhookTest, ...rest } = COMPLETE_STATE;
    expect(checkReuse(rest)).toEqual({ ok: false, resumeAt: 5 });
  });

  it('resumes at step 5 when the saved webhook no longer passes the trigger-URL rule', () => {
    expect(checkReuse({ ...COMPLETE_STATE, webhookUrl: 'https://example.invalid/no-sig' })).toEqual({
      ok: false,
      resumeAt: 5
    });
  });

  it('resumes at the earliest bad step when several fields are bad', () => {
    expect(
      checkReuse({
        ...COMPLETE_STATE,
        webhookUrl: 'https://example.invalid/no-sig',
        includeExternal: 'bogus' as unknown as BootstrapState['includeExternal'],
        lookbackDays: 45
      })
    ).toEqual({ ok: false, resumeAt: 5 });
  });

  it('otherwise resumes at firstUnansweredStep for a fresh state', () => {
    expect(checkReuse({ version: 1 })).toEqual({ ok: false, resumeAt: 1 });
  });
});

describe('toInstallCommandOptions', () => {
  it('always sets includeExternal, sets lookbackDays only when it is a number, and never sets at', () => {
    expect(toInstallCommandOptions(COMPLETE_STATE)).toEqual({
      webhook: FAKE_TRIGGER_URL,
      includeExternal: 'windows',
      lookbackDays: 7
    });
  });

  it('omits lookbackDays when the saved value is "default"', () => {
    const options = toInstallCommandOptions({ ...COMPLETE_STATE, lookbackDays: 'default' });
    expect(options).not.toHaveProperty('lookbackDays');
    expect(options).not.toHaveProperty('at');
  });

  it('defaults includeExternal when the saved state has none', () => {
    expect(toInstallCommandOptions({ version: 1 }).includeExternal).toBe('windows');
  });
});

describe('summarizeState', () => {
  it('never contains the webhook sig value', () => {
    const lines = summarizeState(COMPLETE_STATE);
    expect(lines.join('\n')).not.toContain('FAKESECRET');
  });

  it('shows the webhook test result', () => {
    const lines = summarizeState(COMPLETE_STATE);
    expect(lines.some((line) => line.includes('passed'))).toBe(true);
  });
});
