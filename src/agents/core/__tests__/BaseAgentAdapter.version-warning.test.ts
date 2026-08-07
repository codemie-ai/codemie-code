/**
 * Behavioural tests for the new one-time untested-version warning path.
 *
 * The helper `warnOnceIfUntested()` is the seam every entry point (agent launch,
 * install, update, setup, doctor) calls. It never throws, never prompts, and
 * records the (agent, agent-version, codemie-version) marker after emitting
 * the notice — see EPMCDME-13734.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentMetadata } from '../types.js';

// Silence logger output but keep spies for assertions
vi.mock('../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Minimal ProviderRegistry stub so BaseAgentAdapter imports resolve
vi.mock('../../../providers/core/registry.js', () => ({
  ProviderRegistry: {
    registerProvider: vi.fn((t: any) => t),
    registerSetupSteps: vi.fn(),
    registerHealthCheck: vi.fn(),
    registerModelProxy: vi.fn(),
    getProvider: vi.fn(() => ({ authType: 'none' })),
    getProviderNames: vi.fn(() => []),
  },
}));

vi.mock('../../../utils/processes.js', () => ({
  detectGitBranch: vi.fn(() => Promise.resolve(null)),
  detectGitRemoteRepo: vi.fn(() => Promise.resolve(null)),
  exec: vi.fn(),
  installGlobal: vi.fn(),
  uninstallGlobal: vi.fn(),
  getCommandPath: vi.fn(() => Promise.resolve(null)),
  commandExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../../utils/version-warnings.js', () => ({
  VersionWarningStore: {
    hasWarned: vi.fn(),
    recordWarning: vi.fn(),
  },
}));

vi.mock('../../../utils/cli-updater.js', () => ({
  getCurrentCliVersion: vi.fn(async () => '0.11.0'),
}));

vi.mock('../../../utils/tty.js', () => ({
  isInteractive: vi.fn(() => true),
}));

const baseMeta = (overrides: Partial<AgentMetadata>): AgentMetadata =>
  ({
    name: 'claude',
    displayName: 'Claude Code',
    description: 'Test',
    npmPackage: null,
    cliCommand: 'claude',
    envMapping: {},
    supportedProviders: ['anthropic-subscription'],
    silentMode: false,
    // Reference point for the notice. Tests that want a mismatch use an
    // installedVersion different from this; tests that want silence match it.
    supportedVersion: '2.1.218',
    ...(overrides as any),
  }) as AgentMetadata;

describe('BaseAgentAdapter.warnOnceIfUntested', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('is a no-op when installed matches metadata.supportedVersion', async () => {
    const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    class Adapter extends BaseAgentAdapter {}
    const adapter = new Adapter(baseMeta({}));
    vi.spyOn(adapter as any, 'getVersion').mockResolvedValue('2.1.218'); // matches supportedVersion
    await adapter.warnOnceIfUntested();
    expect(VersionWarningStore.hasWarned).not.toHaveBeenCalled();
    expect(VersionWarningStore.recordWarning).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when metadata.supportedVersion is unset (no reference to compare)', async () => {
    const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    class Adapter extends BaseAgentAdapter {}
    const adapter = new Adapter(baseMeta({ supportedVersion: undefined }));
    vi.spyOn(adapter as any, 'getVersion').mockResolvedValue('2.1.219');
    await adapter.warnOnceIfUntested();
    expect(VersionWarningStore.hasWarned).not.toHaveBeenCalled();
    expect(VersionWarningStore.recordWarning).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when getVersion() returns null', async () => {
    const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    class Adapter extends BaseAgentAdapter {}
    const adapter = new Adapter(baseMeta({}));
    vi.spyOn(adapter as any, 'getVersion').mockResolvedValue(null);
    await adapter.warnOnceIfUntested();
    expect(VersionWarningStore.hasWarned).not.toHaveBeenCalled();
    expect(VersionWarningStore.recordWarning).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('is silent + does not record when marker already exists for the tuple', async () => {
    const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(true);
    class Adapter extends BaseAgentAdapter {}
    const adapter = new Adapter(baseMeta({}));
    vi.spyOn(adapter as any, 'getVersion').mockResolvedValue('2.1.219');
    await adapter.warnOnceIfUntested();
    expect(VersionWarningStore.recordWarning).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('emits chalk banner to stderr AND records marker when interactive + non-silent + no marker', async () => {
    const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(false);
    class Adapter extends BaseAgentAdapter {}
    const adapter = new Adapter(baseMeta({}));
    vi.spyOn(adapter as any, 'getVersion').mockResolvedValue('2.1.219');
    await adapter.warnOnceIfUntested();
    expect(VersionWarningStore.recordWarning).toHaveBeenCalledWith('claude', '2.1.219');
    expect(stderrSpy).toHaveBeenCalled();
    const anyCallHasHeader = stderrSpy.mock.calls.some((call) =>
      typeof call[0] === 'string' && (call[0] as string).includes('CodeMie has verified'),
    );
    expect(anyCallHasHeader).toBe(true);
  });

  it('logs warn only (no stderr banner) when silentMode is true', async () => {
    const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    const { logger } = await import('../../../utils/logger.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(false);
    class Adapter extends BaseAgentAdapter {}
    const adapter = new Adapter(baseMeta({ silentMode: true }));
    vi.spyOn(adapter as any, 'getVersion').mockResolvedValue('2.1.219');
    await adapter.warnOnceIfUntested();
    expect(logger.warn).toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(VersionWarningStore.recordWarning).toHaveBeenCalledWith('claude', '2.1.219');
  });

  it('logs warn only (no stderr banner) when non-interactive TTY', async () => {
    const { isInteractive } = await import('../../../utils/tty.js');
    vi.mocked(isInteractive).mockReturnValue(false);
    const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    const { logger } = await import('../../../utils/logger.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(false);
    class Adapter extends BaseAgentAdapter {}
    const adapter = new Adapter(baseMeta({}));
    vi.spyOn(adapter as any, 'getVersion').mockResolvedValue('2.1.219');
    await adapter.warnOnceIfUntested();
    expect(logger.warn).toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(VersionWarningStore.recordWarning).toHaveBeenCalledOnce();
  });

  it('never throws when VersionWarningStore.hasWarned rejects', async () => {
    const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockRejectedValue(new Error('disk full'));
    class Adapter extends BaseAgentAdapter {}
    const adapter = new Adapter(baseMeta({}));
    vi.spyOn(adapter as any, 'getVersion').mockResolvedValue('2.1.219');
    await expect(adapter.warnOnceIfUntested()).resolves.toBeUndefined();
  });

  it('still records marker when getCurrentCliVersion returns null (2-tuple key)', async () => {
    // codemieVersion is used only for the display line in the banner — it is
    // NOT part of the marker key. When getCurrentCliVersion returns null we
    // still fire the notice and record the (agent, agent-version) pair.
    const { isInteractive } = await import('../../../utils/tty.js');
    vi.mocked(isInteractive).mockReturnValue(true);
    const { getCurrentCliVersion } = await import('../../../utils/cli-updater.js');
    vi.mocked(getCurrentCliVersion).mockResolvedValueOnce(null as unknown as string);
    const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(false);
    class Adapter extends BaseAgentAdapter {}
    const adapter = new Adapter(baseMeta({}));
    vi.spyOn(adapter as any, 'getVersion').mockResolvedValue('2.1.219');
    await adapter.warnOnceIfUntested();
    expect(VersionWarningStore.recordWarning).toHaveBeenCalledWith('claude', '2.1.219');
    // Banner still fires — the display line falls back to "unknown" for the
    // running CodeMie version so the user is still notified.
    expect(stderrSpy).toHaveBeenCalled();
    const bannerText = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(bannerText).toContain('unknown');
  });

  it('never throws when VersionWarningStore.recordWarning rejects', async () => {
    const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(false);
    vi.mocked(VersionWarningStore.recordWarning).mockRejectedValue(new Error('disk full'));
    class Adapter extends BaseAgentAdapter {}
    const adapter = new Adapter(baseMeta({}));
    vi.spyOn(adapter as any, 'getVersion').mockResolvedValue('2.1.219');
    await expect(adapter.warnOnceIfUntested()).resolves.toBeUndefined();
  });
});

describe('BaseAgentAdapter.getVersionInfo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the installed version string from getVersion()', async () => {
    const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
    class Adapter extends BaseAgentAdapter {}
    const adapter = new Adapter(baseMeta({}));
    vi.spyOn(adapter as any, 'getVersion').mockResolvedValue('2.1.219');
    const info = await adapter.getVersionInfo();
    expect(info).toEqual({ installedVersion: '2.1.219' });
  });

  it('returns installedVersion: null when getVersion() returns null', async () => {
    const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
    class Adapter extends BaseAgentAdapter {}
    const adapter = new Adapter(baseMeta({}));
    vi.spyOn(adapter as any, 'getVersion').mockResolvedValue(null);
    const info = await adapter.getVersionInfo();
    expect(info).toEqual({ installedVersion: null });
  });
});
