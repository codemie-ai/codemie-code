import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PiPluginMetadata } from '../pi.plugin.js';
import { getMCPConfigSummary } from '@/utils/mcp-config.js';
import { redirectHomeDir } from './home-redirect.js';

/**
 * Pi's built-in MCP support reads two files: `<agentDir>/mcp.json` and `<cwd>/.pi/mcp.json`.
 * Every way of getting the CodeMie mapping wrong — a stale path, a mistyped `jsonPath`, a
 * dropped scope — reports zero servers, which is indistinguishable from a machine that has
 * none. These tests write real config files and assert the declared mapping finds them, and
 * that a file Pi does not read is never reported.
 */
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function servers(...names: string[]): { mcpServers: Record<string, unknown> } {
  return { mcpServers: Object.fromEntries(names.map((name) => [name, { url: 'https://x' }])) };
}

describe('pi MCP config', () => {
  let root: string;
  let cwd: string;
  let home: string;
  let restoreHome: () => void;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-mcp-'));
    cwd = join(root, 'project');
    home = join(root, 'home');
    // So a `~/…` path in the mapping resolves under the fixture, never the real user profile.
    restoreHome = redirectHomeDir(home);
  });

  afterEach(() => {
    restoreHome();
    rmSync(root, { recursive: true, force: true });
  });

  const summarize = () => getMCPConfigSummary(PiPluginMetadata.mcpConfig, cwd);

  it('reads the redirected agent dir, which is the file a CodeMie run actually loads', async () => {
    // beforeRun always points PI_CODING_AGENT_DIR at <cwd>/.pi/codemie/agent, and Pi
    // resolves <agentDir>/mcp.json through that variable.
    writeJson(join(cwd, '.pi/codemie/agent/mcp.json'), servers('context7', 'playwright'));

    const summary = await summarize();

    expect(summary.userServerNames).toEqual(['context7', 'playwright']);
    expect(summary.totalServers).toBe(2);
  });

  it('reports the project file as the local scope, apart from the agent dir', async () => {
    writeJson(join(cwd, '.pi/codemie/agent/mcp.json'), servers('context7'));
    writeJson(join(cwd, '.pi/mcp.json'), servers('local-db'));

    const summary = await summarize();

    expect(summary.userServerNames).toEqual(['context7']);
    expect(summary.localServerNames).toEqual(['local-db']);
    expect(summary.totalServers).toBe(2);
  });

  it("never reports the user's own Pi home, which a CodeMie run does not read", async () => {
    // preparePiAgentDir copies ~/.pi/agent once and returns early forever after, so a
    // project whose copy predates the user's MCP setup keeps an mcp.json-less agent dir
    // while the home file grows. Reporting the home file would name servers this run
    // cannot load.
    writeJson(join(home, '.pi/agent/mcp.json'), servers('never-loaded'));

    const summary = await summarize();

    expect(summary.serverNames).toEqual([]);
    expect(summary.totalServers).toBe(0);
  });

  // The retired `pi-mcp-adapter` merged these in; built-in MCP reads none of them.
  it.each([
    ['the shared project file', () => join(cwd, '.mcp.json')],
    ['~/.agents/mcp/mcp.json', () => join(home, '.agents/mcp/mcp.json')],
    ['~/.agents/mcp.json', () => join(home, '.agents/mcp.json')],
    ['~/.config/mcp/mcp.json', () => join(home, '.config/mcp/mcp.json')],
  ])('ignores %s, which built-in MCP does not read', async (_label, configPath) => {
    writeJson(configPath(), servers('adapter-only'));

    const summary = await summarize();

    expect(summary.serverNames).toEqual([]);
    expect(summary.totalServers).toBe(0);
  });

  it('reports zeros rather than throwing when nothing is configured', async () => {
    const summary = await getMCPConfigSummary(PiPluginMetadata.mcpConfig, join(root, 'empty'));

    expect(summary.totalServers).toBe(0);
    expect(summary.serverNames).toEqual([]);
  });

  it('ignores a config file that parses but declares no servers', async () => {
    // Pi keeps settings such as `autoEnableCodemode` beside `mcpServers`; they are not servers.
    writeJson(join(cwd, '.pi/mcp.json'), { autoEnableCodemode: false });

    const summary = await summarize();

    expect(summary.localServers).toBe(0);
    expect(summary.totalServers).toBe(0);
  });
});
