/**
 * Tests for MCP config detection.
 *
 * Covers the multi-candidate `path` support added for OpenCode (which accepts
 * both opencode.json and opencode.jsonc) and pins the single-path behaviour the
 * other agents rely on.
 *
 * @group unit
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMCPConfigSummary } from '../mcp-config.js';
import type { AgentMCPConfig } from '../../agents/core/types.js';

let root: string;

function writeJson(relativePath: string, value: unknown): void {
  const full = join(root, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'codemie-mcp-'));

  // Single-path, Claude-style project config.
  writeJson('claude/.mcp.json', { mcpServers: { github: {}, jira: {} } });

  // OpenCode keeps servers under a top-level `mcp` key.
  writeJson('oc-json/opencode.json', { mcp: { fetch: {}, sonar: {} } });

  // Only the .jsonc variant exists — the second candidate must be tried.
  writeJson('oc-jsonc/opencode.jsonc', { mcp: { fetch: {} } });

  // Both exist: the first candidate wins.
  writeJson('oc-both/opencode.json', { mcp: { fromJson: {} } });
  writeJson('oc-both/opencode.jsonc', { mcp: { fromJsonc: {} } });

  // A .jsonc carrying comments cannot be JSON.parse'd; it must be skipped
  // rather than throwing, and the next candidate should still be tried.
  writeJson('oc-comments/opencode.jsonc', '{ // a comment\n "mcp": { "x": {} } }');
  writeJson('oc-comments/opencode.json', { mcp: { recovered: {} } });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('getMCPConfigSummary', () => {
  it('returns an empty summary when the agent declares no MCP config', async () => {
    const summary = await getMCPConfigSummary(undefined, root);

    expect(summary.totalServers).toBe(0);
    expect(summary.serverNames).toEqual([]);
  });

  it('reads a single string path unchanged', async () => {
    const config: AgentMCPConfig = { project: { path: '.mcp.json', jsonPath: 'mcpServers' } };

    const summary = await getMCPConfigSummary(config, join(root, 'claude'));

    expect(summary.projectServers).toBe(2);
    expect(summary.totalServers).toBe(2);
    expect(summary.serverNames).toEqual(['github', 'jira']);
  });

  it('reads the first candidate when several paths are declared', async () => {
    const config: AgentMCPConfig = {
      project: { path: ['opencode.json', 'opencode.jsonc'], jsonPath: 'mcp' },
    };

    const summary = await getMCPConfigSummary(config, join(root, 'oc-json'));

    expect(summary.serverNames).toEqual(['fetch', 'sonar']);
  });

  it('falls through to a later candidate when the first is absent', async () => {
    const config: AgentMCPConfig = {
      project: { path: ['opencode.json', 'opencode.jsonc'], jsonPath: 'mcp' },
    };

    const summary = await getMCPConfigSummary(config, join(root, 'oc-jsonc'));

    expect(summary.serverNames).toEqual(['fetch']);
  });

  it('prefers the earlier candidate when both exist', async () => {
    const config: AgentMCPConfig = {
      project: { path: ['opencode.json', 'opencode.jsonc'], jsonPath: 'mcp' },
    };

    const summary = await getMCPConfigSummary(config, join(root, 'oc-both'));

    expect(summary.serverNames).toEqual(['fromJson']);
  });

  it('skips an unparseable candidate and keeps going', async () => {
    const config: AgentMCPConfig = {
      project: { path: ['opencode.jsonc', 'opencode.json'], jsonPath: 'mcp' },
    };

    const summary = await getMCPConfigSummary(config, join(root, 'oc-comments'));

    expect(summary.serverNames).toEqual(['recovered']);
  });

  it('counts scopes independently and de-duplicates the combined name list', async () => {
    const config: AgentMCPConfig = {
      project: { path: 'opencode.json', jsonPath: 'mcp' },
      user: { path: ['opencode.json'], jsonPath: 'mcp' },
    };

    const summary = await getMCPConfigSummary(config, join(root, 'oc-json'));

    expect(summary.projectServers).toBe(2);
    expect(summary.userServers).toBe(2);
    expect(summary.totalServers).toBe(4);
    // serverNames is the unique union across scopes.
    expect(summary.serverNames).toEqual(['fetch', 'sonar']);
  });
});
