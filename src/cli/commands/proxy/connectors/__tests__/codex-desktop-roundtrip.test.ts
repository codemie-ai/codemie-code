/**
 * Codex-desktop connector — CODEX_HOME connect→disconnect round-trip.
 *
 * codex-desktop.test.ts already covers writeCodexDesktopConfig / backup /
 * model discovery with EXPLICIT paths. What was untested is the composed flavour
 * as `codemie proxy connect --codex-desktop` actually runs it: the paths resolved
 * from CODEX_HOME / CODEMIE_HOME, a real write-then-remove cycle, and the promise
 * that a pre-existing user config is backed up on connect and restored on
 * disconnect. That is what this exercises — deterministically, with NO daemon,
 * NO SSO and NO network (a synthetic daemon URL/key stands in for a live proxy).
 *
 * SAFETY: CODEX_HOME and CODEMIE_HOME point at one throwaway temp per test, so the
 * developer's real ~/.codex/config.toml is never read or written. On macOS the
 * --vscode / --claude-desktop connectors write real user paths and are therefore
 * intentionally NOT round-tripped here; only codex-desktop honours CODEX_HOME.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCodexDesktopConfigPath,
  writeCodexDesktopConfig,
  removeCodexDesktopConfig,
  BACKUP_SUFFIX,
} from '../codex-desktop.js';

const DAEMON = {
  proxyUrl: 'http://127.0.0.1:4001',
  baseUrl: 'http://127.0.0.1:4001/v1',
  gatewayKey: 'codemie-proxy-roundtrip-test',
  model: 'gpt-5.4',
};

let codexHome: string;
let statePath: string;
let originalCodexHome: string | undefined;

// State path is kept inside the CODEX_HOME temp (rather than the default
// CODEMIE_HOME-derived path) so we never touch — nor delete out from under the
// file logger — the shared test CODEMIE_HOME.
function connect(force = false): Promise<unknown> {
  return writeCodexDesktopConfig({
    configPath: getCodexDesktopConfigPath(),
    statePath,
    ...DAEMON,
    force,
  });
}

beforeEach(() => {
  originalCodexHome = process.env.CODEX_HOME;
  codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
  statePath = join(codexHome, 'codex-desktop-state.json');
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (originalCodexHome !== undefined) process.env.CODEX_HOME = originalCodexHome;
  else delete process.env.CODEX_HOME;
  rmSync(codexHome, { recursive: true, force: true });
});

describe('codex-desktop connect/disconnect round-trip (CODEX_HOME)', () => {
  it('connect writes a CodeMie-managed block at $CODEX_HOME/config.toml targeting the daemon', async () => {
    await connect();

    const configPath = getCodexDesktopConfigPath();
    expect(configPath).toBe(join(codexHome, 'config.toml'));
    expect(existsSync(configPath)).toBe(true);

    const toml = readFileSync(configPath, 'utf-8');
    expect(toml).toContain('model_provider = "codemie"');
    expect(toml).toContain(DAEMON.baseUrl);
    expect(toml).toContain(DAEMON.model);

    // Ownership state recorded.
    expect(existsSync(statePath)).toBe(true);
  });

  it('disconnect removes the managed block and clears ownership state', async () => {
    await connect();
    const configPath = getCodexDesktopConfigPath();

    const result = await removeCodexDesktopConfig(statePath);
    expect(result.removed).toBe(true);

    const toml = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
    expect(toml).not.toContain('model_provider = "codemie"');
    // State file is emptied so a later disconnect is a clean no-op.
    const stateRaw = existsSync(statePath) ? readFileSync(statePath, 'utf-8') : '';
    expect(stateRaw.trim()).toBe('');
  });

  it('preserves a pre-existing user config on connect and restores it on disconnect', async () => {
    const configPath = getCodexDesktopConfigPath();
    // A benign user config with no model_provider (so no --force needed).
    writeFileSync(configPath, '[tui]\ntheme = "dark"\n', 'utf-8');

    await connect();
    let toml = readFileSync(configPath, 'utf-8');
    expect(toml).toContain('theme = "dark"');           // user key preserved
    expect(toml).toContain('model_provider = "codemie"'); // managed block added
    // A pre-connect backup snapshot was taken.
    expect(existsSync(configPath + BACKUP_SUFFIX)).toBe(true);

    await removeCodexDesktopConfig(statePath);
    toml = readFileSync(configPath, 'utf-8');
    expect(toml).toContain('theme = "dark"');            // user key still there
    expect(toml).not.toContain('model_provider = "codemie"'); // managed block gone
  });

  it('a second disconnect with no active connection is a clean no-op', async () => {
    const result = await removeCodexDesktopConfig();
    expect(result.removed).toBe(false);
  });
});
