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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCodexDesktopConfigPath,
  getCodexDesktopStatePath,
  writeCodexDesktopConfig,
  removeCodexDesktopConfig,
  BACKUP_SUFFIX,
} from '../codex-desktop.js';
import { moveCodexDesktopToNamedKey, readCodexDesktopGateway } from '../codex-desktop-named-key.js';

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
    expect(toml).toContain('Authorization = "Bearer codemie-proxy-roundtrip-test.codex-desktop"');

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

  it.skipIf(process.platform === 'win32')('connect on a config that is a symbolic link keeps the link and writes its target', async () => {
    const target = join(codexHome, 'dotfiles', 'config.toml');
    mkdirSync(join(codexHome, 'dotfiles'));
    writeFileSync(target, '');
    symlinkSync(target, getCodexDesktopConfigPath());

    await connect();

    expect(lstatSync(getCodexDesktopConfigPath()).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toContain('Authorization = "Bearer codemie-proxy-roundtrip-test.codex-desktop"');
  });

  it.skipIf(process.platform === 'win32')('connect on a link whose target cannot be written replaces the link with a file', async () => {
    if (process.getuid?.() === 0) return; // root bypasses file-mode permission checks; nothing to assert here.
    const targetDir = join(codexHome, 'read-only-dotfiles');
    const target = join(targetDir, 'config.toml');
    mkdirSync(targetDir);
    writeFileSync(target, '');
    symlinkSync(target, getCodexDesktopConfigPath());
    chmodSync(targetDir, 0o555);
    try {
      await connect();
    } finally {
      chmodSync(targetDir, 0o755);
    }

    expect(lstatSync(getCodexDesktopConfigPath()).isSymbolicLink()).toBe(false);
    expect(readFileSync(getCodexDesktopConfigPath(), 'utf-8')).toContain(
      'Authorization = "Bearer codemie-proxy-roundtrip-test.codex-desktop"'
    );
    expect(readFileSync(target, 'utf-8')).toBe('');
  });

  it('a second disconnect with no active connection is a clean no-op', async () => {
    const result = await removeCodexDesktopConfig();
    expect(result.removed).toBe(false);
  });
});

describe('readCodexDesktopGateway', () => {
  const managed = (baseUrl: string, authorization: string): string => [
    '# >>> codemie proxy connect (codex-desktop) provider - managed block, do not edit',
    '[model_providers.codemie]',
    `base_url = "${baseUrl}"`,
    '[model_providers.codemie.http_headers]',
    `Authorization = "${authorization}"`,
    '# <<< codemie proxy connect (codex-desktop) provider',
    '',
  ].join('\n');

  it('reads back the port and the named key its writer wrote, and nothing after the disconnect', async () => {
    await connect();

    await expect(readCodexDesktopGateway(DAEMON.gatewayKey)).resolves.toEqual({ port: 4001, key: 'codex-desktop' });

    await removeCodexDesktopConfig(statePath);
    await expect(readCodexDesktopGateway(DAEMON.gatewayKey)).resolves.toBeNull();
  });

  it('writes one named key on a second connect and rewrites a config holding the shared key', async () => {
    writeFileSync(getCodexDesktopConfigPath(), managed('http://127.0.0.1:4001/v1', `Bearer ${DAEMON.gatewayKey}`));
    await expect(readCodexDesktopGateway(DAEMON.gatewayKey)).resolves.toEqual({ port: 4001, key: 'shared' });

    await connect(true);
    await connect(true);

    const toml = readFileSync(getCodexDesktopConfigPath(), 'utf-8');
    expect(toml.match(/Authorization = /g)).toHaveLength(1);
    await expect(readCodexDesktopGateway(DAEMON.gatewayKey)).resolves.toEqual({ port: 4001, key: 'codex-desktop' });
  });

  it('reads another key as refused', async () => {
    writeFileSync(getCodexDesktopConfigPath(), managed('http://127.0.0.1:52311/v1', 'Bearer other.codex-desktop'));

    await expect(readCodexDesktopGateway(DAEMON.gatewayKey)).resolves.toEqual({ port: 52311, key: 'refused' });
  });

  it.each([
    ['no config file', () => undefined],
    ['an unparsable file', () => writeFileSync(getCodexDesktopConfigPath(), `${managed('http://127.0.0.1:4001/v1', 'Bearer k')}[[[`)],
    ['a non-loopback base_url', () => writeFileSync(getCodexDesktopConfigPath(), managed('https://codex.example.com:4001/v1', 'Bearer k'))],
    ['a managed block removed by hand', () => writeFileSync(
      getCodexDesktopConfigPath(),
      '[model_providers.codemie]\nbase_url = "http://127.0.0.1:4001/v1"\n'
    )],
  ])('returns null for %s', async (_case, arrange) => {
    arrange();

    await expect(readCodexDesktopGateway(DAEMON.gatewayKey)).resolves.toBeNull();
  });
});


describe('moveCodexDesktopToNamedKey', () => {
  /** A Codex config as an older connect left it, with the user's own comment and table around the managed ones. */
  const olderConnectConfig = (authorization: string, port = 4001): string => [
    '# >>> codemie proxy connect (codex-desktop) header - managed block, do not edit',
    'model_provider = "codemie"',
    'model = "gpt-5.4"',
    '# <<< codemie proxy connect (codex-desktop) header',
    '',
    '# my codex settings',
    '[tui]',
    'theme = "dark"',
    '',
    '# >>> codemie proxy connect (codex-desktop) provider - managed block, do not edit',
    '[model_providers.codemie]',
    'name = "CodeMie"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    '[model_providers.codemie.http_headers]',
    `Authorization = "${authorization}"`,
    '# <<< codemie proxy connect (codex-desktop) provider',
    '',
  ].join('\n');

  beforeEach(() => {
    vi.stubEnv('CODEMIE_HOME', codexHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['the default key', 'codemie-proxy'],
    ['a daemon with its own key', 'k-7f3a'],
  ])('moves a config holding the shared key, %s, to the named key, and nothing else', async (_case, key) => {
    writeFileSync(getCodexDesktopConfigPath(), olderConnectConfig(`Bearer ${key}`));

    await expect(moveCodexDesktopToNamedKey(key, 4001)).resolves.toBe('moved');

    expect(readFileSync(getCodexDesktopConfigPath(), 'utf-8')).toBe(olderConnectConfig(`Bearer ${key}.codex-desktop`));
    await expect(readCodexDesktopGateway(key)).resolves.toEqual({ port: 4001, key: 'codex-desktop' });
    expect(existsSync(getCodexDesktopConfigPath() + BACKUP_SUFFIX)).toBe(false);
    expect(existsSync(getCodexDesktopStatePath())).toBe(false);
  });

  it.each([
    ['the named key', 'Bearer codemie-proxy.codex-desktop'],
    ['another daemon\'s key', 'Bearer other-key'],
  ])('leaves the bytes of a config holding %s', async (_case, authorization) => {
    writeFileSync(getCodexDesktopConfigPath(), olderConnectConfig(authorization));

    await expect(moveCodexDesktopToNamedKey('codemie-proxy', 4001)).resolves.toBe('unchanged');

    expect(readFileSync(getCodexDesktopConfigPath(), 'utf-8')).toBe(olderConnectConfig(authorization));
  });

  it('leaves the bytes of a config holding the shared key on another loopback port than the daemon\'s', async () => {
    writeFileSync(getCodexDesktopConfigPath(), olderConnectConfig('Bearer codemie-proxy', 4002));

    await expect(moveCodexDesktopToNamedKey('codemie-proxy', 4001)).resolves.toBe('unchanged');

    expect(readFileSync(getCodexDesktopConfigPath(), 'utf-8')).toBe(olderConnectConfig('Bearer codemie-proxy', 4002));
  });

  it('writes nothing when there is no config file', async () => {
    await expect(moveCodexDesktopToNamedKey('codemie-proxy', 4001)).resolves.toBe('unchanged');

    expect(existsSync(getCodexDesktopConfigPath())).toBe(false);
  });

  it('moves a config file that is a symbolic link through the link, and a second move leaves it', async () => {
    const target = join(codexHome, 'dotfiles-config.toml');
    writeFileSync(target, olderConnectConfig('Bearer codemie-proxy'));
    symlinkSync(target, getCodexDesktopConfigPath());

    await expect(moveCodexDesktopToNamedKey('codemie-proxy', 4001)).resolves.toBe('moved');
    await expect(moveCodexDesktopToNamedKey('codemie-proxy', 4001)).resolves.toBe('unchanged');

    expect(lstatSync(getCodexDesktopConfigPath()).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe(olderConnectConfig('Bearer codemie-proxy.codex-desktop'));
  });
});
