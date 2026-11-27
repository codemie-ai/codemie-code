/**
 * `codemie proxy clients` and `proxy disconnect` for clients on another tool's gateway — real CLI, no login needed.
 *
 * Claude Desktop and the VS Code Claude Code extension are pointed at local gateways that are not CodeMie's (a key
 * the daemon does not accept). `proxy clients` has to agree with `proxy disconnect`: the clients are not connected to
 * CodeMie, no row names a disconnect, and the disconnect commands find nothing to remove and leave the other tool's
 * settings byte for byte as they were.
 *
 * It drives the built `bin/codemie.js` (`npm run build` first) in a scratch HOME and CODEMIE_HOME, with no daemon
 * running, so no real VS Code, Claude Desktop or Claude Code configuration is read or touched. Skipped on platforms
 * whose Claude Desktop and VS Code directories this test does not lay out (macOS only).
 *
 *   npm run build && npx vitest run tests/integration/proxy-clients-other-gateway.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeRun, expectExit, realDir, runIsolatedCli, type IsolatedHomes } from '../helpers/isolated-cli.js';

interface ClientRow {
  id: string;
  connected: boolean;
  hint?: string;
  note?: string;
}

describe.skipIf(process.platform !== 'darwin')('proxy clients on another tool\'s gateway', () => {
  let root = '';
  let homes: IsolatedHomes;
  let cwd = '';
  let desktopEntryPath = '';
  let vscodeSettingsPath = '';

  const run = (args: string[], env: Record<string, string> = {}) =>
    runIsolatedCli(homes, args, {
      cwd,
      timeoutMs: 60_000,
      env: { XDG_CONFIG_HOME: join(homes.userHome, '.config'), CODEMIE_HOME: homes.codemieHome, ...env },
    });

  const clients = (env: Record<string, string> = {}): Map<string, ClientRow> => {
    const result = run(['proxy', 'clients', '--json'], env);
    expectExit(result, 0);
    const rows = (JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) as { clients: ClientRow[] }).clients;
    return new Map(rows.map((row) => [row.id, row]));
  };

  const write = (path: string, content: unknown): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(content), 'utf-8');
  };

  /** The Claude Code hooks `connect --claude-otlp` installs, so the extension row is shown on its analytics state. */
  const installHooks = (): void =>
    write(join(homes.userHome, '.claude', 'settings.json'), {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codemie hook --agent claude-code-otlp --event UserPromptSubmit' }] }] },
    });

  beforeEach(() => {
    root = realDir(mkdtempSync(join(tmpdir(), 'codemie-it-clients-other-gateway-')));
    homes = { codemieHome: realDir(join(root, 'codemie')), userHome: realDir(join(root, 'home')) };
    cwd = realDir(join(root, 'cwd'));

    const support = join(homes.userHome, 'Library', 'Application Support');
    const configLibrary = join(support, 'Claude-3p', 'configLibrary');
    desktopEntryPath = join(configLibrary, 'x.json');
    write(join(configLibrary, '_meta.json'), { appliedId: 'x' });
    write(desktopEntryPath, {
      inferenceProvider: 'gateway',
      inferenceGatewayBaseUrl: 'http://127.0.0.1:4999',
      inferenceGatewayApiKey: 'other-tool-key',
    });

    vscodeSettingsPath = join(support, 'Code', 'User', 'settings.json');
    write(vscodeSettingsPath, {
      'claudeCode.environmentVariables': [
        { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:8123' },
        { name: 'ANTHROPIC_AUTH_TOKEN', value: 'litellm-key' },
      ],
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads Claude Desktop and the extension as not connected, and names no disconnect', () => {
    installHooks();
    const rows = clients();
    const desktop = rows.get('claude-desktop');
    const extension = rows.get('vscode-claude-code');

    expect(desktop?.connected).toBe(false);
    expect(desktop?.hint).toBe('uses another gateway — run: codemie proxy connect --claude-desktop');
    expect(extension?.connected).toBe(false);
    expect(extension?.note).toBeUndefined();
    expect(extension?.hint).toContain('uses another gateway or key');
    expect(extension?.hint).toContain('codemie proxy connect --vscode-claude-code');
    for (const row of rows.values()) expect(`${row.hint ?? ''} ${row.note ?? ''}`).not.toContain('proxy disconnect');
  });

  it('disconnect finds nothing to remove for either client and leaves the other tool\'s settings alone', () => {
    const before = [readFileSync(desktopEntryPath, 'utf-8'), readFileSync(vscodeSettingsPath, 'utf-8')];

    const desktop = run(['proxy', 'disconnect', '--claude-desktop']);
    const extension = run(['proxy', 'disconnect', '--vscode-claude-code']);

    expect(desktop.stdout, describeRun(desktop)).toContain('nothing to disconnect');
    expect(extension.stdout, describeRun(extension)).toContain('nothing to disconnect');
    expect([readFileSync(desktopEntryPath, 'utf-8'), readFileSync(vscodeSettingsPath, 'utf-8')]).toEqual(before);
    expect(clients().get('claude-desktop')?.connected).toBe(false);
    expect(clients().get('vscode-claude-code')?.connected).toBe(false);
  });

  it('reads an extension holding an API key of its own as another gateway or key, not a Claude login', () => {
    installHooks();
    write(vscodeSettingsPath, { 'claudeCode.environmentVariables': [{ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-own' }] });

    const hint = clients().get('vscode-claude-code')?.hint;

    expect(hint).toContain('uses another gateway or key');
    expect(hint).not.toContain('uses your Claude login');
  });

  it('reads an extension with no credentials of its own as the Claude login, and a shell API key as another key', () => {
    installHooks();
    write(vscodeSettingsPath, {});

    expect(clients().get('vscode-claude-code')?.hint).toContain('uses your Claude login');
    expect(clients({ ANTHROPIC_API_KEY: 'sk-ant-own' }).get('vscode-claude-code')?.hint)
      .toContain('uses another gateway or key');
  });
});
