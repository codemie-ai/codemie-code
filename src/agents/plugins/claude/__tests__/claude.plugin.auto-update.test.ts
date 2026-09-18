/**
 * Tests for the Claude plugin's auto-updater environment setup.
 *
 * `beforeRun` sets DISABLE_AUTOUPDATER=1 to pin the Claude Code binary to
 * CLAUDE_SUPPORTED_VERSION, which CodeMie manages explicitly. That variable is
 * broader than the intent: upstream gates plugin auto-update on the same
 * predicate,
 *
 *   Pmt() = autoUpdaterDisabled() && !FORCE_AUTOUPDATE_PLUGINS
 *
 * and uses it both to skip the background plugin update pass ("Plugin
 * autoupdate: skipped (auto-updater disabled)") and to decide whether the
 * per-marketplace "Enable auto-update" item is pushed onto the /plugin
 * Marketplaces menu at all. So pinning the binary silently left every CodeMie
 * user without plugin auto-updates *and* without the control to turn them on.
 *
 * Setting FORCE_AUTOUPDATE_PLUGINS=1 alongside restores plugin auto-update
 * while leaving the binary pinned.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudePluginMetadata } from '../claude.plugin.js';

vi.mock('fs/promises');
vi.mock('fs');

describe('ClaudePluginMetadata.lifecycle.beforeRun — auto-updater env', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runBeforeRun(
    env: Record<string, string> = {}
  ): Promise<Record<string, string>> {
    await ClaudePluginMetadata.lifecycle?.beforeRun?.(env as never);
    return env;
  }

  it('pins the binary by disabling the auto-updater', async () => {
    const env = await runBeforeRun();
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('keeps plugin auto-updates working alongside the pinned binary', async () => {
    const env = await runBeforeRun();
    expect(env.FORCE_AUTOUPDATE_PLUGINS).toBe('1');
  });

  it('does not override an explicit FORCE_AUTOUPDATE_PLUGINS opt-out', async () => {
    const env = await runBeforeRun({ FORCE_AUTOUPDATE_PLUGINS: '0' });
    expect(env.FORCE_AUTOUPDATE_PLUGINS).toBe('0');
  });

  it('does not override an explicit DISABLE_AUTOUPDATER value', async () => {
    const env = await runBeforeRun({ DISABLE_AUTOUPDATER: '0' });
    expect(env.DISABLE_AUTOUPDATER).toBe('0');
  });
});
