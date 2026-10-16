import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getCachedLatestVersion = vi.hoisted(() => vi.fn());
const loadLocal = vi.hoisted(() => vi.fn());
const loadGlobal = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/version-cache.js', () => ({ getCachedLatestVersion }));
vi.mock('../../../utils/config.js', () => ({
  ConfigLoader: { loadLocalMultiProviderConfig: loadLocal, loadMultiProviderConfig: loadGlobal },
}));
vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  isAheadOfLiveTracking,
  isLiveTrackedAgent,
  isVersionChecksEnabled,
  resolveSupportedInstallVersion,
  resolveSupportedVersionDetailed,
} from '../version-resolution.js';
import { AgentInstallationError } from '../../../utils/errors.js';

const input = {
  agentName: 'codex',
  npmPackage: '@openai/codex',
  fallbackSupportedVersion: '0.154.0',
};

const scope = (enabled?: unknown) => ({
  version: 2,
  profiles: {},
  workspace: enabled === undefined ? {} : { versionChecks: { enabled } },
});

function checksOff(): void {
  loadGlobal.mockResolvedValue(scope(false));
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CODEMIE_VERSION_CHECKS_ENABLED;
  loadLocal.mockResolvedValue({ version: 2, profiles: {} });
  loadGlobal.mockResolvedValue({ version: 2, profiles: {} });
});

afterEach(() => {
  delete process.env.CODEMIE_VERSION_CHECKS_ENABLED;
});

describe('isVersionChecksEnabled', () => {
  it('defaults to enabled when nothing is configured', async () => {
    await expect(isVersionChecksEnabled()).resolves.toBe(true);
  });

  it('honours a global false even when the project has its own workspace block', async () => {
    loadLocal.mockResolvedValue(scope(undefined));
    loadGlobal.mockResolvedValue(scope(false));

    await expect(isVersionChecksEnabled()).resolves.toBe(false);
  });

  it('lets the project setting override the global one', async () => {
    loadLocal.mockResolvedValue(scope(true));
    loadGlobal.mockResolvedValue(scope(false));

    await expect(isVersionChecksEnabled()).resolves.toBe(true);
  });

  it('honours the env var even when the config cannot be loaded (e.g. no active profile)', async () => {
    process.env.CODEMIE_VERSION_CHECKS_ENABLED = 'false';
    loadLocal.mockRejectedValue(new Error('No active profile set'));
    loadGlobal.mockRejectedValue(new Error('No active profile set'));

    await expect(isVersionChecksEnabled()).resolves.toBe(false);
  });

  it('treats an empty env var as unset, so a config false still applies', async () => {
    process.env.CODEMIE_VERSION_CHECKS_ENABLED = '';
    checksOff();

    await expect(isVersionChecksEnabled()).resolves.toBe(false);
  });

  it('lets the env var override the config', async () => {
    process.env.CODEMIE_VERSION_CHECKS_ENABLED = 'true';
    checksOff();

    await expect(isVersionChecksEnabled()).resolves.toBe(true);
  });

  it('treats an unrecognized value as enabled', async () => {
    loadGlobal.mockResolvedValue(scope('nope'));

    await expect(isVersionChecksEnabled()).resolves.toBe(true);
  });

  it('stays enabled when every config read fails', async () => {
    loadLocal.mockRejectedValue(new Error('corrupt'));
    loadGlobal.mockRejectedValue(new Error('corrupt'));

    await expect(isVersionChecksEnabled()).resolves.toBe(true);
  });
});

describe('isLiveTrackedAgent', () => {
  it('tracks the ticket agents and kimi-acp, but not copilot-cli', () => {
    expect(['claude', 'codex', 'gemini', 'kimi', 'kimi-acp'].every(isLiveTrackedAgent)).toBe(true);
    expect(isLiveTrackedAgent('copilot-cli')).toBe(false);
  });
});

describe('isAheadOfLiveTracking', () => {
  it('is true only for a live-tracked agent installed ahead of the tracked version', () => {
    expect(isAheadOfLiveTracking('claude', { isNewer: true })).toBe(true);
    expect(isAheadOfLiveTracking('claude', { isNewer: false })).toBe(false);
    expect(isAheadOfLiveTracking('claude', {})).toBe(false);
  });

  it('is false for an agent with a maintainer-pinned version, which keeps its notice', () => {
    expect(isAheadOfLiveTracking('copilot-cli', { isNewer: true })).toBe(false);
  });
});

describe('resolveSupportedVersionDetailed', () => {
  it('reports a successful npm lookup as live', async () => {
    getCachedLatestVersion.mockResolvedValue('0.160.0');

    await expect(resolveSupportedVersionDetailed(input)).resolves.toEqual({
      version: '0.160.0',
      isCurrent: true,
    });
  });

  it('is not live when the registry reports a latest below the minimum (lagging mirror)', async () => {
    getCachedLatestVersion.mockResolvedValue('0.140.0');

    await expect(
      resolveSupportedVersionDetailed({ ...input, minimumSupportedVersion: '0.143.0' })
    ).resolves.toEqual({
      version: '0.154.0',
      isCurrent: false,
      liveBelowMinimum: true,
      registryLatestVersion: '0.140.0',
    });
  });

  it('is live when the registry latest equals the minimum', async () => {
    getCachedLatestVersion.mockResolvedValue('0.143.0');

    await expect(
      resolveSupportedVersionDetailed({ ...input, minimumSupportedVersion: '0.143.0' })
    ).resolves.toEqual({ version: '0.143.0', isCurrent: true });
  });

  it('is not live when version checks are disabled, and skips the lookup', async () => {
    checksOff();

    await expect(resolveSupportedVersionDetailed(input)).resolves.toEqual({
      version: '0.154.0',
      isCurrent: false,
    });
    expect(getCachedLatestVersion).not.toHaveBeenCalled();
  });

  it('is not live when the lookup fails', async () => {
    getCachedLatestVersion.mockRejectedValue(new Error('offline'));

    await expect(resolveSupportedVersionDetailed(input)).resolves.toEqual({
      version: '0.154.0',
      isCurrent: false,
    });
  });

  it('is not live when the lookup returns nothing', async () => {
    getCachedLatestVersion.mockResolvedValue(null);

    await expect(resolveSupportedVersionDetailed(input)).resolves.toMatchObject({ isCurrent: false });
  });

  it('is not live when npm reports a prerelease', async () => {
    getCachedLatestVersion.mockResolvedValue('0.161.0-beta.1');

    await expect(resolveSupportedVersionDetailed(input)).resolves.toEqual({
      version: '0.154.0',
      isCurrent: false,
    });
  });

  it('keeps the maintainer-pinned version current for agents outside the live-tracked list', async () => {
    await expect(
      resolveSupportedVersionDetailed({ ...input, agentName: 'copilot-cli', npmPackage: '@github/copilot' })
    ).resolves.toEqual({ version: '0.154.0', isCurrent: true });
    expect(getCachedLatestVersion).not.toHaveBeenCalled();
  });

  it('reports nothing current for an untracked agent with no pinned version', async () => {
    await expect(
      resolveSupportedVersionDetailed({ agentName: 'opencode', npmPackage: 'opencode-ai' })
    ).resolves.toEqual({ version: undefined, isCurrent: false });
  });

  it('treats an untracked agent as unknown too when checks are disabled', async () => {
    checksOff();

    await expect(
      resolveSupportedVersionDetailed({ ...input, agentName: 'copilot-cli' })
    ).resolves.toMatchObject({ isCurrent: false });
  });
});

describe('resolveSupportedInstallVersion', () => {
  it('installs the live tracked version when known', async () => {
    getCachedLatestVersion.mockResolvedValue('0.160.0');

    await expect(resolveSupportedInstallVersion(input)).resolves.toBe('0.160.0');
  });

  it('installs the latest channel, not the stale fallback, when the tracked version is unknown', async () => {
    getCachedLatestVersion.mockResolvedValue(null);

    await expect(resolveSupportedInstallVersion(input)).resolves.toBe('latest');
  });

  it('stops with a specific error, not the latest channel, when the registry latest is below the minimum', async () => {
    // `latest` would resolve to the same lagging release the minimum gate then refuses to launch.
    getCachedLatestVersion.mockResolvedValue('0.140.0');

    const result = resolveSupportedInstallVersion({ ...input, minimumSupportedVersion: '0.143.0' });

    await expect(result).rejects.toBeInstanceOf(AgentInstallationError);
    await expect(result).rejects.toThrow(
      "the registry's latest release v0.140.0 is below the minimum supported v0.143.0 (a lagging mirror?). " +
        'Install a specific version: codemie install codex <version>'
    );
  });
});
