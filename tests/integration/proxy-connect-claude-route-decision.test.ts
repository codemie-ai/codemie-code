/**
 * `codemie proxy connect --claude-otlp` route decision — real CLI, opt-in.
 *
 * `--claude-otlp` installs analytics for every Claude client, but moves the VS Code Claude Code extension to the
 * gateway only when the extension is not configured yet. This drives the built
 * `bin/codemie.js` in a scratch home and reads the VS Code settings.json back.
 *
 * It needs a CodeMie SSO login that already exists on this machine (the CLI only reads it; the test runs no login or
 * logout) and a running-daemon-capable environment, so it is skipped unless CODEMIE_IT_SSO_BASE_URL is set:
 *
 *   CODEMIE_IT_SSO_BASE_URL=https://<codemie-host>/code-assistant-api \
 *     npx vitest run tests/integration/proxy-connect-claude-route-decision.test.ts
 *
 * Optional: CODEMIE_IT_SSO_CODEMIE_URL (default: the origin of the base URL).
 *
 * Every case gets its own HOME and CODEMIE_HOME, with XDG_CONFIG_HOME under that HOME and `claude` removed from PATH,
 * so the `~/.claude.json` fallback decides whether a Claude login exists and no real VS Code, Claude Desktop or Claude
 * Code configuration is touched. Skipped on Windows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describeRun, realDir, runIsolatedCli, type IsolatedHomes } from '../helpers/isolated-cli.js';

const SSO_BASE_URL = process.env.CODEMIE_IT_SSO_BASE_URL;
const PROFILE = 'it-claude-route';
const SEED = '{\n\t"editor.fontSize": 13\n}\n';
const BILLING = `  Its model requests now go through the gateway, not your Claude login.`;
const EXTENSION_SKIP =
  '✓ VS Code Claude Code extension: analytics on (uses your Claude login; model routing unchanged)';

/** PATH without any directory that holds a `claude` executable, so `which claude` finds nothing. */
function pathWithoutClaude(): string {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '' && !existsSync(join(dir, 'claude')) && !existsSync(join(dir, 'claude.exe')))
    .join(delimiter);
}

describe.skipIf(!SSO_BASE_URL || process.platform === 'win32')('proxy connect --claude-otlp route decision', () => {
  let root = '';
  let homes: IsolatedHomes;
  let settingsPath = '';
  let cwd = '';

  const run = (args: string[]) =>
    runIsolatedCli(homes, args, {
      cwd,
      timeoutMs: 120_000,
      env: {
        XDG_CONFIG_HOME: join(homes.userHome, '.config'),
        PATH: pathWithoutClaude(),
        CODEMIE_HOME: homes.codemieHome,
      },
    });

  const lines = (stdout: string): string[] => stdout.split('\n').map((line) => line.trimEnd());

  beforeEach(() => {
    root = realDir(mkdtempSync(join(tmpdir(), 'codemie-it-claude-route-')));
    homes = { codemieHome: realDir(join(root, 'codemie')), userHome: realDir(join(root, 'home')) };
    cwd = realDir(join(root, 'cwd'));

    const codeMieUrl = process.env.CODEMIE_IT_SSO_CODEMIE_URL ?? new URL(SSO_BASE_URL as string).origin;
    writeFileSync(
      join(homes.codemieHome, 'codemie-cli.config.json'),
      JSON.stringify({
        version: 2,
        activeProfile: PROFILE,
        profiles: {
          [PROFILE]: { name: PROFILE, provider: 'ai-run-sso', baseUrl: SSO_BASE_URL, codeMieUrl, codeMieProject: 'it' },
        },
      }),
      'utf-8',
    );

    const productDir =
      process.platform === 'darwin'
        ? join(homes.userHome, 'Library', 'Application Support', 'Code')
        : join(homes.userHome, '.config', 'Code');
    settingsPath = join(productDir, 'User', 'settings.json');
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, SEED, 'utf-8');
  });

  afterEach(() => {
    run(['proxy', 'stop']);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('(a) a user with no Claude login: the extension is routed, billing is said, disconnect restores the file', () => {
    const connected = run(['proxy', 'connect', '--claude-otlp', '--yes']);
    const out = lines(connected.stdout);

    const written = readFileSync(settingsPath, 'utf-8');
    expect(written, describeRun(connected)).toMatch(/"ANTHROPIC_BASE_URL"[\s\S]*http:\/\/127\.0\.0\.1:\d+/);
    const configured = out.findIndex((line) => line.startsWith('✓ VS Code Claude Code extension configured'));
    expect(configured, describeRun(connected)).toBeGreaterThanOrEqual(0);
    expect(out[configured + 1]).toBe(BILLING);

    const disconnected = run(['proxy', 'disconnect', '--claude-otlp']);
    expect(readFileSync(settingsPath, 'utf-8'), describeRun(disconnected)).toBe(SEED);
  });

  it('(b) a user who is logged in to Claude: settings.json is untouched and no route is added', () => {
    writeFileSync(join(homes.userHome, '.claude.json'), JSON.stringify({ oauthAccount: {} }), 'utf-8');

    const connected = run(['proxy', 'connect', '--claude-otlp', '--yes']);
    const out = lines(connected.stdout);

    expect(out, describeRun(connected)).toContain(EXTENSION_SKIP);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(SEED);
    const skip = out.indexOf(EXTENSION_SKIP);
    expect(out[skip + 1]).not.toBe(BILLING);
    expect(out.some((line) => line.startsWith('✓ VS Code Claude Code extension configured'))).toBe(false);
  });
});
