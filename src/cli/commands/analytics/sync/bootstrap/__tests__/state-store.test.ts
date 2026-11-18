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

/** A fully-answered webhook-only v2 state (every webhook step answered) that `checkReuse`
 * should accept as-is. */
const COMPLETE_STATE: BootstrapState = {
  version: 2,
  targets: { webhook: true, git: false },
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

/** A fully-answered git-only v2 state (every git step answered) that `checkReuse` should
 * accept as-is. */
const GIT_COMPLETE_STATE: BootstrapState = {
  version: 2,
  targets: { webhook: false, git: true },
  gitRepoUrl: 'https://github.com/example/analytics-exports.git',
  gitBranch: 'main',
  gitPath: 'exports',
  gitTest: 'passed',
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

  it('returns { state: null } and a notice naming the path when a v2 file has no targets object', async () => {
    await writeFile(path, JSON.stringify({ version: 2, teamId: 'x' }), 'utf-8');

    const result = await loadBootstrapState(path);
    expect(result.state).toBeNull();
    expect(result.notice).toContain(path);
  });

  it.each([
    ['empty targets', {}],
    ['both targets off', { webhook: false, git: false }],
    ['non-boolean flags', { webhook: 'yes', git: 1 }],
    ['one flag missing', { webhook: true }]
  ])('returns { state: null } and a notice when a v2 file has %s', async (_label, targets) => {
    await writeFile(path, JSON.stringify({ version: 2, targets }), 'utf-8');

    const result = await loadBootstrapState(path);
    expect(result.state).toBeNull();
    expect(result.notice).toContain(path);
  });

  it('returns { state: null } and a notice naming the path when the file cannot be read', async () => {
    // Windows chmod only toggles the read-only attribute (blocks writes, not reads), so
    // 0o000 never produces EACCES on a read there — unlike POSIX, where it reliably does.
    if (process.platform === 'win32') {
      return;
    }

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

  it('round-trips a saved v2 state and writes it mode 0600', async () => {
    await saveBootstrapState(COMPLETE_STATE, path);

    await expect(loadBootstrapState(path)).resolves.toEqual({ state: COMPLETE_STATE });

    if (process.platform !== 'win32') {
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('loads a v1 file (no targets field) as v2 with targets defaulted to webhook-only (AC16)', async () => {
    const v1Fixture = {
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
    await writeFile(path, JSON.stringify(v1Fixture), 'utf-8');

    const result = await loadBootstrapState(path);

    expect(result.notice).toBeUndefined();
    expect(result.state).toEqual({
      ...v1Fixture,
      version: 2,
      targets: { webhook: true, git: false }
    });
  });
});

describe('firstUnansweredStep', () => {
  it("returns 'channel' for a fresh webhook-only state", () => {
    expect(firstUnansweredStep({ version: 2, targets: { webhook: true, git: false } })).toBe('channel');
  });

  it("returns 'developers' once every webhook step is answered", () => {
    expect(firstUnansweredStep(COMPLETE_STATE)).toBe('developers');
  });

  it("returns 'folder' when the Teams step is answered but SharePoint is not", () => {
    expect(
      firstUnansweredStep({ version: 2, targets: { webhook: true, git: false }, teamId: 't', channelId: 'c' })
    ).toBe('folder');
  });

  it("returns 'trigger-url' when the webhook setup steps are answered but the webhook is not", () => {
    expect(
      firstUnansweredStep({
        version: 2,
        targets: { webhook: true, git: false },
        teamId: 't',
        channelId: 'c',
        siteUrl: 's',
        folderPath: 'f',
        timeZone: 'UTC',
        flowImported: true
      })
    ).toBe('trigger-url');
  });

  it("returns 'git-repo' for a fresh git-only state", () => {
    expect(firstUnansweredStep({ version: 2, targets: { webhook: false, git: true } })).toBe('git-repo');
  });

  it("returns 'external' once the git repo step is answered", () => {
    expect(
      firstUnansweredStep({
        version: 2,
        targets: { webhook: false, git: true },
        gitRepoUrl: 'https://github.com/example/repo.git',
        gitTest: 'passed'
      })
    ).toBe('external');
  });

  it("returns 'lookback' once external sessions is answered", () => {
    expect(
      firstUnansweredStep({
        version: 2,
        targets: { webhook: false, git: true },
        gitRepoUrl: 'https://github.com/example/repo.git',
        gitTest: 'passed',
        includeExternal: 'windows'
      })
    ).toBe('lookback');
  });

  it("returns 'developers' once every git step is answered", () => {
    expect(firstUnansweredStep(GIT_COMPLETE_STATE)).toBe('developers');
  });
});

describe('firstUnansweredStep — "already imported" shortcut', () => {
  it("starts from 'trigger-url' when the webhook setup steps were skipped via the shortcut", () => {
    expect(firstUnansweredStep({ version: 2, targets: { webhook: true, git: false }, skippedSetup: true })).toBe(
      'trigger-url'
    );
  });

  it('lets checkReuse accept a complete state created via the shortcut', () => {
    const result = checkReuse({
      version: 2,
      targets: { webhook: true, git: false },
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

  it("resumes at 'lookback' when lookbackDays is out of range", () => {
    expect(checkReuse({ ...COMPLETE_STATE, lookbackDays: 45 })).toEqual({ ok: false, resumeAt: 'lookback' });
  });

  it("resumes at 'external' when includeExternal is an unknown policy", () => {
    expect(
      checkReuse({ ...COMPLETE_STATE, includeExternal: 'bogus' as unknown as BootstrapState['includeExternal'] })
    ).toEqual({ ok: false, resumeAt: 'external' });
  });

  it("resumes at 'trigger-url' when webhookTest is missing", () => {
    const { webhookTest: _webhookTest, ...rest } = COMPLETE_STATE;
    expect(checkReuse(rest)).toEqual({ ok: false, resumeAt: 'trigger-url' });
  });

  it("resumes at 'trigger-url' when the saved webhook no longer passes the trigger-URL rule", () => {
    expect(checkReuse({ ...COMPLETE_STATE, webhookUrl: 'https://example.invalid/no-sig' })).toEqual({
      ok: false,
      resumeAt: 'trigger-url'
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
    ).toEqual({ ok: false, resumeAt: 'trigger-url' });
  });

  it("otherwise resumes at firstUnansweredStep for a fresh state", () => {
    expect(checkReuse({ version: 2, targets: { webhook: true, git: false } })).toEqual({
      ok: false,
      resumeAt: 'channel'
    });
  });

  it('is ok when a git-only state has every step answered and valid', () => {
    expect(checkReuse(GIT_COMPLETE_STATE)).toEqual({ ok: true, options: expect.anything() });
  });

  it(
    "resumes at 'git-repo' without throwing when a complete git-only state's gitRepoUrl embeds credentials",
    () => {
      expect(() =>
        checkReuse({ ...GIT_COMPLETE_STATE, gitRepoUrl: 'https://tok@github.com/example/repo.git' })
      ).not.toThrow();

      expect(checkReuse({ ...GIT_COMPLETE_STATE, gitRepoUrl: 'https://tok@github.com/example/repo.git' })).toEqual({
        ok: false,
        resumeAt: 'git-repo'
      });
    }
  );

  it("resumes at 'git-repo' when the saved gitRepoUrl starts with '-' (install's shared git URL rule)", () => {
    expect(checkReuse({ ...GIT_COMPLETE_STATE, gitRepoUrl: '--upload-pack=touch /tmp/x' })).toEqual({
      ok: false,
      resumeAt: 'git-repo'
    });
  });

  it("resumes at 'git-repo' on a both-targets state whose git URL embeds an scp-style user:password", () => {
    expect(
      checkReuse({
        ...COMPLETE_STATE,
        ...GIT_COMPLETE_STATE,
        targets: { webhook: true, git: true },
        gitRepoUrl: 'user:secret@github.com:example/repo.git'
      })
    ).toEqual({ ok: false, resumeAt: 'git-repo' });
  });

  it.each([
    ['a blank git URL', { gitRepoUrl: '   ' }],
    ['an option-like git branch', { gitBranch: '--upload-pack=x' }],
    ['an escaping git path', { gitPath: '../outside' }]
  ])("resumes at 'git-repo' on a complete git-only state with %s", (_label, patch) => {
    expect(checkReuse({ ...GIT_COMPLETE_STATE, ...patch })).toEqual({ ok: false, resumeAt: 'git-repo' });
  });

  it('ignores an off webhook target: a broken saved webhookUrl does not block a git-only reuse', () => {
    expect(
      checkReuse({ ...GIT_COMPLETE_STATE, webhookUrl: 'https://example.invalid/no-sig', webhookTest: 'passed' })
    ).toEqual({ ok: true, options: expect.anything() });
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
    expect(toInstallCommandOptions({ version: 2, targets: { webhook: true, git: false } }).includeExternal).toBe(
      'never'
    );
  });

  it('emits gitRepo/gitBranch/gitPath when targets.git is true', () => {
    expect(toInstallCommandOptions(GIT_COMPLETE_STATE)).toEqual({
      gitRepo: GIT_COMPLETE_STATE.gitRepoUrl,
      gitBranch: GIT_COMPLETE_STATE.gitBranch,
      gitPath: GIT_COMPLETE_STATE.gitPath,
      includeExternal: 'windows',
      lookbackDays: 7
    });
  });

  it('omits gitRepo/gitBranch/gitPath when targets.git is false, even if gitRepoUrl is present', () => {
    const options = toInstallCommandOptions({
      ...COMPLETE_STATE,
      gitRepoUrl: 'https://github.com/example/repo.git',
      gitBranch: 'main',
      gitPath: 'exports'
    });
    expect(options).not.toHaveProperty('gitRepo');
    expect(options).not.toHaveProperty('gitBranch');
    expect(options).not.toHaveProperty('gitPath');
  });

  it('omits webhook when targets.webhook is false, even if webhookUrl is still saved', () => {
    const options = toInstallCommandOptions({ ...GIT_COMPLETE_STATE, webhookUrl: FAKE_TRIGGER_URL });
    expect(options).not.toHaveProperty('webhook');
    expect(options.gitRepo).toBe(GIT_COMPLETE_STATE.gitRepoUrl);
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

  it('names the delivery targets, showing an off target as off', () => {
    expect(summarizeState(COMPLETE_STATE)).toContain('Delivery targets: webhook on, git off');
    expect(summarizeState(GIT_COMPLETE_STATE)).toContain('Delivery targets: webhook off, git on');
    expect(summarizeState({ ...COMPLETE_STATE, ...GIT_COMPLETE_STATE, targets: { webhook: true, git: true } })).toContain(
      'Delivery targets: webhook on, git on'
    );
  });

  it('masks the git repository URL to its host and shows branch, folder and test result', () => {
    const lines = summarizeState({ ...GIT_COMPLETE_STATE, gitRepoUrl: 'https://tok@github.com/example/secret-repo.git' });
    const text = lines.join('\n');
    expect(lines).toContain('Git repository: github.com/… (path hidden)');
    expect(text).not.toContain('secret-repo');
    expect(text).not.toContain('tok');
    expect(lines).toContain('Git branch: main');
    expect(lines).toContain('Git folder: exports');
    expect(lines).toContain('Git test: passed');
  });

  it('masks an scp-style git repository URL to its host, never its user:password', () => {
    const lines = summarizeState({ ...GIT_COMPLETE_STATE, gitRepoUrl: 'user:secret@github.com:example/repo.git' });
    expect(lines).toContain('Git repository: github.com/… (path hidden)');
    expect(lines.join('\n')).not.toContain('secret');
  });

  it('omits the details of an off target, while still naming it as off', () => {
    const webhookOff = summarizeState({ ...COMPLETE_STATE, ...GIT_COMPLETE_STATE, targets: { webhook: false, git: true } });
    expect(webhookOff.join('\n')).not.toMatch(/Trigger URL|Teams channel|Webhook test/);
    expect(webhookOff).toContain('Delivery targets: webhook off, git on');

    const gitOff = summarizeState({ ...GIT_COMPLETE_STATE, ...COMPLETE_STATE, targets: { webhook: true, git: false } });
    expect(gitOff.join('\n')).not.toMatch(/Git repository|Git branch|Git test/);
  });
});
