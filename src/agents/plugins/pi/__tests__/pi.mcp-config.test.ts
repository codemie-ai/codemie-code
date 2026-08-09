import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PiPluginMetadata } from '../pi.plugin.js';
import { getMCPConfigSummary } from '@/utils/mcp-config.js';
import { redirectHomeDir } from './home-redirect.js';

/**
 * MCP reaches Pi through the `pi-mcp-adapter` package, which reads six files that the
 * three CodeMie scopes have to approximate. Every way of getting that wrong — a stale
 * path, a mistyped `jsonPath`, a dropped scope — reports zero servers, which is
 * indistinguishable from a machine that has none. These tests write real config files
 * and assert the declared mapping finds them.
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
    // So '~/.pi/agent' resolves under the fixture rather than the real user profile.
    restoreHome = redirectHomeDir(home);
  });

  afterEach(() => {
    restoreHome();
    rmSync(root, { recursive: true, force: true });
  });

  const summarize = () => getMCPConfigSummary(PiPluginMetadata.mcpConfig, cwd);

  it('reads the redirected agent dir, which is the file a CodeMie run actually loads', async () => {
    // beforeRun always points PI_CODING_AGENT_DIR at <cwd>/.pi/codemie/agent, and the
    // adapter resolves <agentDir>/mcp.json through that variable.
    writeJson(join(cwd, '.pi/codemie/agent/mcp.json'), servers('context7', 'playwright'));

    const summary = await summarize();

    expect(summary.userServerNames).toEqual(['context7', 'playwright']);
    expect(summary.totalServers).toBe(2);
  });

  it("never reports the user's own Pi home, which a CodeMie run does not read", async () => {
    // preparePiAgentDir copies ~/.pi/agent once and returns early forever after, so a
    // project whose copy predates the user's MCP setup keeps an mcp.json-less agent dir
    // while the home file grows. Reporting the home file would name servers this run
    // cannot load — and because readMCPFromSource returns on the first candidate that
    // parses, it would also hide ~/.agents, which the adapter genuinely does merge.
    writeJson(join(home, '.pi/agent/mcp.json'), servers('never-loaded'));
    writeJson(join(home, '.agents/mcp.json'), servers('context7'));

    const summary = await summarize();

    expect(summary.userServerNames).toEqual(['context7']);
    expect(summary.serverNames).not.toContain('never-loaded');
  });

  it('separates the shared project file from the Pi-owned one', async () => {
    writeJson(join(cwd, '.mcp.json'), servers('team-search'));
    writeJson(join(cwd, '.pi/mcp.json'), servers('local-db'));

    const summary = await summarize();

    expect(summary.projectServerNames).toEqual(['team-search']);
    expect(summary.localServerNames).toEqual(['local-db']);
    expect(summary.totalServers).toBe(2);
  });

  it('falls back through the shared global locations the adapter also reads', async () => {
    writeJson(join(home, '.config/mcp/mcp.json'), servers('shared-global'));

    const summary = await summarize();

    expect(summary.userServerNames).toEqual(['shared-global']);
  });

  it('orders the global candidates by the adapter\'s own precedence, highest first', async () => {
    // The adapter merges these; CodeMie can only read one, so it must be the one that
    // would have won the merge.
    writeJson(join(home, '.config/mcp/mcp.json'), servers('lowest'));
    writeJson(join(home, '.agents/mcp.json'), servers('middle'));
    writeJson(join(home, '.agents/mcp/mcp.json'), servers('highest'));

    const summary = await summarize();

    expect(summary.userServerNames).toEqual(['highest']);
  });

  it('reports zeros rather than throwing when nothing is configured', async () => {
    const summary = await getMCPConfigSummary(PiPluginMetadata.mcpConfig, join(root, 'empty'));

    expect(summary.totalServers).toBe(0);
    expect(summary.serverNames).toEqual([]);
  });

  it('ignores a config file that parses but declares no servers', async () => {
    // The adapter also accepts an `imports`-only file; it must not be read as an error.
    writeJson(join(cwd, '.mcp.json'), { imports: ['claude-code'] });

    const summary = await summarize();

    expect(summary.projectServers).toBe(0);
  });
});
