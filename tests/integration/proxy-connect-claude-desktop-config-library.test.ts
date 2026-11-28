/**
 * `codemie proxy connect --claude-desktop` with several Claude Desktop configurations — CLI contract tests (EPMCDME-17708)
 *
 * Claude Desktop keeps its inference configurations in `configLibrary/`: `_meta.json` lists them and names the applied
 * one (`appliedId`), and each has its own `<id>.json`. Connect must find the "CodeMie Proxy" entry through `_meta.json`,
 * bring every field of its file up to date while keeping what the user changed in it, make it the applied entry if it
 * is not, and leave every other configuration alone. It used to write into whatever entry was applied: another
 * gateway's configuration got CodeMie's gateway, key and MCP servers under its own name, and the CodeMie entry stayed
 * stale and inactive.
 *
 * Runs the built `bin/codemie.js proxy connect --claude-desktop` in an isolated temp home, which starts the real
 * detached proxy daemon against a local mock backend, and reads the config library back. No Claude Desktop, no network,
 * no LLM.
 *
 * Requires dist/ built. Run: npx vitest run --project cli tests/integration/proxy-connect-claude-desktop-config-library.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAEMON_DIST,
  createCliHome,
  disposeCliHome,
  fileLog,
  runCli,
  startMockBackend,
  storeSsoLogin,
  writeGlobalConfig,
  type CliRun,
} from '../helpers/otlp-hook-session.js';

const PROFILE = 'sso-profile';
const PROJECT = 'desktop-project';
// Fixed fake cookie and keys (not real credentials).
const COOKIE = { _oauth2_proxy: 'desktop-session-cookie' };
const OWNER = {
  userId: 'owner-id',
  name: 'Session Owner',
  username: 'owner-login',
  email: 'owner@example.com',
  applications: [PROJECT],
  applications_admin: [],
};
const CODEMIE_ID = '15f50a6f-3c1e-4d2b-9a8f-0e1d2c3b4a59';
const OTHER_ID = '9b1f7e2a-5c3d-4e8f-a1b2-c3d4e5f60718';
const CODEMIE_NAME = 'CodeMie Proxy';
const OTHER_NAME = 'QA Other Gateway';
// The port of an earlier daemon: no daemon of this test listens there.
const STALE_GATEWAY_URL = 'http://127.0.0.1:61111';
const USER_MCP_SERVER = { name: 'my-user-mcp', url: 'https://tools.example.test/mcp', transport: 'http', oauth: false };
// Another gateway the user switched Desktop to: its file must stay byte for byte as it is.
const OTHER_CONFIG = `${JSON.stringify(
  {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: 'https://llm-gateway.qa-other.example.test',
    inferenceGatewayApiKey: 'qa-other-key',
    inferenceGatewayAuthScheme: 'bearer',
    managedMcpServers: JSON.stringify([
      { name: 'qa-other-mcp', url: 'https://qa-other.example.test/mcp', transport: 'http', oauth: false },
    ]),
    disableAutoUpdates: true,
  },
  null,
  2
)}\n`;
// Starts the daemon and checks the project's models, so it outlives the `cli` project's 30s default.
const CONNECT_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = CONNECT_TIMEOUT_MS + 30_000;

interface DesktopMeta {
  appliedId?: string;
  entries?: Array<{ id: string; name: string }>;
  [key: string]: unknown;
}

/** Claude Desktop's (3P) config directory under `home`, by platform (`getClaudeDesktopBaseDir`). */
function desktopBaseDir(home: string): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude-3p');
  if (process.platform === 'win32') return join(home, 'AppData', 'Local', 'Claude-3p');
  return join(home, '.config', 'Claude-3p');
}

describe.skipIf(!existsSync(DAEMON_DIST))('proxy connect --claude-desktop with several Claude Desktop configurations', () => {
  const homes: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const home of homes.splice(0)) disposeCliHome(home);
    for (const close of closers.splice(0)) await close();
  });

  /**
   * A signed-in home whose Claude Desktop library holds a stale "CodeMie Proxy" entry, from an earlier connect, with an
   * MCP server and a setting the user added, and another gateway's configuration. `_meta.json` applies `appliedId` and
   * carries a field the CLI does not know. The files are written by hand in Claude Desktop's formats.
   */
  async function homeWithTwoConfigs(appliedId: string): Promise<{ home: string; libDir: string; metaText: string }> {
    const backend = await startMockBackend(OWNER);
    closers.push(backend.close);
    const home = createCliHome(homes);
    writeGlobalConfig(home, PROFILE, {
      [PROFILE]: { baseUrl: backend.url, codeMieUrl: backend.url, codeMieProject: PROJECT },
    });
    storeSsoLogin(home, backend.url, COOKIE);

    const libDir = join(desktopBaseDir(home), 'configLibrary');
    mkdirSync(libDir, { recursive: true });
    const metaText = `${JSON.stringify(
      {
        appliedId,
        entries: [
          { id: CODEMIE_ID, name: CODEMIE_NAME },
          { id: OTHER_ID, name: OTHER_NAME },
        ],
        someUnknown: 'kept',
      },
      null,
      2
    )}\n`;
    writeFileSync(join(libDir, '_meta.json'), metaText, 'utf-8');
    writeFileSync(
      join(libDir, `${CODEMIE_ID}.json`),
      JSON.stringify({
        inferenceProvider: 'gateway',
        inferenceGatewayBaseUrl: STALE_GATEWAY_URL,
        inferenceGatewayApiKey: 'codemie-proxy.claude-desktop',
        inferenceGatewayAuthScheme: 'bearer',
        managedMcpServers: JSON.stringify([USER_MCP_SERVER]),
        disableAutoUpdates: true,
      }),
      'utf-8'
    );
    writeFileSync(join(libDir, `${OTHER_ID}.json`), OTHER_CONFIG, 'utf-8');
    return { home, libDir, metaText };
  }

  async function connectDesktop(home: string): Promise<CliRun> {
    // XDG_CONFIG_HOME: on Linux, Claude Desktop's directory follows it; keep it in the temp home.
    const run = await runCli(home, ['proxy', 'connect', '--claude-desktop', '--yes'], '', {
      timeoutMs: CONNECT_TIMEOUT_MS,
      env: { XDG_CONFIG_HOME: join(home, '.config') },
    });
    const output = `${run.stdout}\n${run.stderr}\nCLI log:\n${fileLog(home).slice(-4000)}`;
    expect(run.code, output).toBe(0);
    expect(run.stdout, output).toContain('Claude Desktop configured');
    return run;
  }

  /** The gateway URL of the daemon connect started. */
  function daemonUrl(home: string): string {
    const { port } = JSON.parse(readFileSync(join(home, 'proxy-daemon.json'), 'utf-8')) as { port: number };
    return `http://127.0.0.1:${port}`;
  }

  /** The CodeMie entry's file is brought up to date, and what the user added to it is kept. */
  function expectCodeMieEntryUpToDate(home: string, libDir: string): void {
    const config = JSON.parse(readFileSync(join(libDir, `${CODEMIE_ID}.json`), 'utf-8')) as Record<string, unknown>;
    expect(config, 'the CodeMie Proxy entry after connect').toMatchObject({
      inferenceProvider: 'gateway',
      inferenceGatewayBaseUrl: daemonUrl(home),
      inferenceGatewayAuthScheme: 'bearer',
      inferenceCredentialKind: 'static',
      modelDiscoveryEnabled: true,
      disableAutoUpdates: true,
    });
    expect(config.inferenceGatewayApiKey).toEqual(expect.any(String));
    expect(config.coworkEgressAllowedHosts).toEqual(expect.any(String));
    const servers = JSON.parse(String(config.managedMcpServers)) as Array<{ name: string }>;
    expect(servers, 'the MCP server the user added').toContainEqual(USER_MCP_SERVER);
    expect(servers.length, 'CodeMie MCP servers written next to the user one').toBeGreaterThan(1);
  }

  // The bug of EPMCDME-17708: connect wrote CodeMie's gateway, key and MCP servers into "QA Other Gateway", left the
  // CodeMie entry on its old port and did not switch Desktop to it.
  it(
    'while another configuration is applied, updates and applies the CodeMie Proxy entry and leaves the other one untouched',
    async () => {
      const { home, libDir } = await homeWithTwoConfigs(OTHER_ID);

      const run = await connectDesktop(home);

      expect(readFileSync(join(libDir, `${OTHER_ID}.json`), 'utf-8'), `"${OTHER_NAME}" after connect`).toBe(OTHER_CONFIG);
      expectCodeMieEntryUpToDate(home, libDir);
      const meta = JSON.parse(readFileSync(join(libDir, '_meta.json'), 'utf-8')) as DesktopMeta;
      expect(meta, '_meta.json after connect').toEqual({
        appliedId: CODEMIE_ID,
        entries: [
          { id: CODEMIE_ID, name: CODEMIE_NAME },
          { id: OTHER_ID, name: OTHER_NAME },
        ],
        someUnknown: 'kept',
      });
      expect(run.stdout).toContain(`Switched Claude Desktop's active configuration from "${OTHER_NAME}" to "${CODEMIE_NAME}".`);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'while the CodeMie Proxy entry is applied, updates it and leaves _meta.json and the other configuration untouched',
    async () => {
      const { home, libDir, metaText } = await homeWithTwoConfigs(CODEMIE_ID);

      const run = await connectDesktop(home);

      expect(readFileSync(join(libDir, `${OTHER_ID}.json`), 'utf-8'), `"${OTHER_NAME}" after connect`).toBe(OTHER_CONFIG);
      expectCodeMieEntryUpToDate(home, libDir);
      // Not re-applied: Desktop's own file stays as it was.
      expect(readFileSync(join(libDir, '_meta.json'), 'utf-8'), '_meta.json after connect').toBe(metaText);
      expect(run.stdout).not.toContain('Switched Claude Desktop');
    },
    TEST_TIMEOUT_MS
  );
});
