/**
 * Registry wiring tests.
 *
 * `native-loader.ts` resolves session adapters via
 * `AgentRegistry.getAgent(name)?.getSessionAdapter?.()`. If that call does not resolve,
 * Copilot sessions are never discovered and the whole integration is a no-op.
 */

import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '../../../registry.js';

describe('copilot-cli registration', () => {
  it('resolves through the exact call native-loader makes', () => {
    const adapter = AgentRegistry.getAgent('copilot-cli')?.getSessionAdapter?.();

    expect(adapter).toBeDefined();
    expect(typeof adapter!.discoverSessions).toBe('function');
    expect(adapter!.agentName).toBe('copilot-cli');
  });

  it('advertises the user-facing display label', () => {
    expect(AgentRegistry.getAgent('copilot-cli')!.metadata.displayName).toBe('GitHub Copilot CLI');
  });

  it('is managed by CodeMie and exposes npm metadata', () => {
    const metadata = AgentRegistry.getAgent('copilot-cli')!.metadata;
    expect(metadata.analyticsOnly).not.toBe(true);
    expect(metadata.npmPackage).toBe('@github/copilot');
  });

  it('advertises Copilot MCP, extension, and hook metadata', () => {
    const metadata = AgentRegistry.getAgent('copilot-cli')!.metadata;

    expect(metadata.extensionsConfig).toMatchObject({
      project: '.github',
      global: '~/.copilot',
      skillsEntryFile: 'SKILL.md',
    });
    expect(metadata.extensionsConfig?.dirNames).toMatchObject({
      agents: ['agents'],
      commands: [],
      skills: ['skills'],
      hooks: ['hooks'],
      rules: [],
    });
    expect(metadata.extensionsConfig?.extraProjectDirs).toEqual(['.github/copilot']);

    expect(metadata.mcpConfig).toMatchObject({
      project: {
        path: ['.mcp.json', '.github/mcp.json'],
        jsonPath: 'mcpServers',
      },
      user: {
        path: '~/.copilot/mcp-config.json',
        jsonPath: 'mcpServers',
      },
    });

    expect(metadata.hookConfig?.eventNameMapping).toMatchObject({
      SessionStart: 'SessionStart',
      SessionEnd: 'SessionEnd',
      UserPromptSubmit: 'UserPromptSubmit',
      PreToolUse: 'UserPromptSubmit',
      PostToolUse: 'Stop',
      Notification: 'PermissionRequest',
    });
  });

  it('does not disturb existing agents', () => {
    for (const name of ['claude', 'codex', 'gemini', 'kimi', 'opencode']) {
      expect(AgentRegistry.getAgent(name), `${name} should still resolve`).toBeDefined();
    }
  });
});

/**
 * Copilot now participates in the same management surfaces as other first-class agents
 * while still exposing its session adapter for analytics.
 */
describe('copilot-cli is included in agent-management surfaces', () => {
  it('is present in getManageableAgents()', () => {
    const names = AgentRegistry.getManageableAgents().map((a) => a.name);

    expect(names).toContain('copilot-cli');
    for (const name of ['claude', 'codex', 'gemini', 'kimi', 'opencode']) {
      expect(names, `${name} must stay manageable`).toContain(name);
    }
  });

  it('is still present in getAllAgents() so analytics can reach its adapter', () => {
    expect(AgentRegistry.getAllAgents().map((a) => a.name)).toContain('copilot-cli');
  });

  it('declares the npm package used for managed installation', () => {
    expect(AgentRegistry.getAgent('copilot-cli')!.metadata.npmPackage).toBe('@github/copilot');
  });
});
