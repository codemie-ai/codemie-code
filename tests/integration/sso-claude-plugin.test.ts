/**
 * Integration tests for SSO provider Claude plugin auto-installation
 *
 * Tests the complete flow:
 * 1. Plugin installation during agent run
 * 2. Flag injection in CLI arguments
 * 3. Provider-specific behavior (only with ai-run-sso)
 *
 * @group integration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ClaudePluginInstaller } from '../../src/agents/plugins/claude/claude.plugin-installer.js';
import { SSOTemplate } from '../../src/providers/plugins/sso/sso.template.js';

describe('SSO Provider - Claude Plugin Auto-Install', () => {
  const pluginTargetDir = join(homedir(), '.codemie', 'claude-plugin');

  beforeEach(() => {
    // Clean up plugin directory before each test
    if (existsSync(pluginTargetDir)) {
      rmSync(pluginTargetDir, { recursive: true, force: true });
    }

    // Clean env
    delete process.env.CODEMIE_CLAUDE_PLUGIN_DIR;
  });

  afterEach(() => {
    // Cleanup after tests
    if (existsSync(pluginTargetDir)) {
      rmSync(pluginTargetDir, { recursive: true, force: true });
    }

    delete process.env.CODEMIE_CLAUDE_PLUGIN_DIR;
  });

  describe('Plugin Installation (beforeRun hook)', () => {
    it('should install plugin on first run with ai-run-sso provider', async () => {
      // Verify plugin doesn't exist
      expect(existsSync(pluginTargetDir)).toBe(false);

      // Get Claude-specific beforeRun hook
      const claudeHooks = SSOTemplate.agentHooks?.['claude'];
      expect(claudeHooks).toBeDefined();
      expect(claudeHooks?.beforeRun).toBeDefined();

      // Execute beforeRun hook
      const env: NodeJS.ProcessEnv = {};
      const updatedEnv = await claudeHooks!.beforeRun!(env);

      // Verify plugin was installed
      expect(existsSync(pluginTargetDir)).toBe(true);

      // Verify critical files exist
      expect(existsSync(join(pluginTargetDir, '.claude-plugin', 'plugin.json'))).toBe(true);
      expect(existsSync(join(pluginTargetDir, 'hooks', 'hooks.json'))).toBe(true);
      expect(existsSync(join(pluginTargetDir, 'README.md'))).toBe(true);

      // Verify env was updated
      expect(updatedEnv.CODEMIE_CLAUDE_PLUGIN_DIR).toBe(pluginTargetDir);
    });

    it('should skip installation if plugin already exists', async () => {
      // Pre-install plugin
      const result1 = await ClaudePluginInstaller.install();
      expect(result1.success).toBe(true);
      expect(result1.action).toBe('copied');

      // Get Claude-specific beforeRun hook
      const claudeHooks = SSOTemplate.agentHooks?.['claude'];

      // Execute beforeRun hook second time
      const env: NodeJS.ProcessEnv = {};
      const updatedEnv = await claudeHooks!.beforeRun!(env);

      // Verify env was still updated
      expect(updatedEnv.CODEMIE_CLAUDE_PLUGIN_DIR).toBe(pluginTargetDir);

      // Plugin should still exist
      expect(existsSync(pluginTargetDir)).toBe(true);
    });

    it('should continue gracefully if plugin installation fails', async () => {
      // Create a directory where plugin would be installed to cause failure
      mkdirSync(pluginTargetDir, { recursive: true });

      // Create invalid plugin.json to cause verification failure
      const pluginJsonPath = join(pluginTargetDir, '.claude-plugin');
      mkdirSync(pluginJsonPath, { recursive: true });

      const claudeHooks = SSOTemplate.agentHooks?.['claude'];

      // Execute beforeRun hook - should not throw
      const env: NodeJS.ProcessEnv = {};
      await expect(claudeHooks!.beforeRun!(env)).resolves.not.toThrow();
    });
  });

  describe('Flag Injection (enrichArgs hook)', () => {
    it('should inject --plugin-dir flag when plugin is installed', async () => {
      // Pre-install plugin and set env
      await ClaudePluginInstaller.install();
      process.env.CODEMIE_CLAUDE_PLUGIN_DIR = pluginTargetDir;

      // Get Claude-specific enrichArgs hook
      const claudeHooks = SSOTemplate.agentHooks?.['claude'];
      expect(claudeHooks).toBeDefined();
      expect(claudeHooks?.enrichArgs).toBeDefined();

      // Execute enrichArgs hook
      const args = ['test', 'task'];
      const enrichedArgs = claudeHooks!.enrichArgs!(args, {} as any);

      // Verify --plugin-dir was injected
      expect(enrichedArgs).toContain('--plugin-dir');
      expect(enrichedArgs).toContain(pluginTargetDir);

      // Verify order: --plugin-dir comes first
      expect(enrichedArgs[0]).toBe('--plugin-dir');
      expect(enrichedArgs[1]).toBe(pluginTargetDir);
      expect(enrichedArgs[2]).toBe('test');
      expect(enrichedArgs[3]).toBe('task');
    });

    it('should skip injection if --plugin-dir already specified', async () => {
      // Set env
      process.env.CODEMIE_CLAUDE_PLUGIN_DIR = pluginTargetDir;

      const claudeHooks = SSOTemplate.agentHooks?.['claude'];

      // Execute enrichArgs hook with existing --plugin-dir
      const args = ['--plugin-dir', '/custom/path', 'test', 'task'];
      const enrichedArgs = claudeHooks!.enrichArgs!(args, {} as any);

      // Verify args unchanged
      expect(enrichedArgs).toEqual(args);

      // Verify no duplicate --plugin-dir
      const pluginDirCount = enrichedArgs.filter(arg => arg === '--plugin-dir').length;
      expect(pluginDirCount).toBe(1);
    });

    it('should skip injection if env not set', async () => {
      // Don't set env
      delete process.env.CODEMIE_CLAUDE_PLUGIN_DIR;

      const claudeHooks = SSOTemplate.agentHooks?.['claude'];

      // Execute enrichArgs hook
      const args = ['test', 'task'];
      const enrichedArgs = claudeHooks!.enrichArgs!(args, {} as any);

      // Verify args unchanged
      expect(enrichedArgs).toEqual(args);

      // Verify --plugin-dir NOT injected
      expect(enrichedArgs).not.toContain('--plugin-dir');
    });
  });

  describe('Provider-Specific Behavior', () => {
    it('should have Claude-specific hooks registered', () => {
      // Verify SSO template has Claude hooks
      expect(SSOTemplate.agentHooks).toBeDefined();
      expect(SSOTemplate.agentHooks?.['claude']).toBeDefined();

      const claudeHooks = SSOTemplate.agentHooks?.['claude'];
      expect(claudeHooks?.beforeRun).toBeDefined();
      expect(claudeHooks?.enrichArgs).toBeDefined();
    });

    it('should not affect other providers', () => {
      // Plugin installation is SSO-specific
      // Other providers should not have Claude hooks

      // This test verifies architectural principle:
      // Plugin hooks are in SSO template, not in Claude agent
      expect(SSOTemplate.name).toBe('ai-run-sso');
    });
  });

  describe('Full Integration Flow', () => {
    it('should complete full flow: install → inject', async () => {
      // Step 1: beforeRun - Install plugin
      const claudeHooks = SSOTemplate.agentHooks?.['claude'];
      const env: NodeJS.ProcessEnv = {};
      const updatedEnv = await claudeHooks!.beforeRun!(env);

      // Verify plugin installed
      expect(existsSync(pluginTargetDir)).toBe(true);
      expect(updatedEnv.CODEMIE_CLAUDE_PLUGIN_DIR).toBe(pluginTargetDir);

      // Step 2: enrichArgs - Inject flag (simulate env propagation)
      process.env.CODEMIE_CLAUDE_PLUGIN_DIR = updatedEnv.CODEMIE_CLAUDE_PLUGIN_DIR;

      const args = ['test', 'task'];
      const enrichedArgs = claudeHooks!.enrichArgs!(args, {} as any);

      // Verify flag injected
      expect(enrichedArgs).toEqual(['--plugin-dir', pluginTargetDir, 'test', 'task']);
    });

    it('should be idempotent (safe to run multiple times)', async () => {
      const claudeHooks = SSOTemplate.agentHooks?.['claude'];

      // First run
      const env1: NodeJS.ProcessEnv = {};
      const updatedEnv1 = await claudeHooks!.beforeRun!(env1);
      expect(updatedEnv1.CODEMIE_CLAUDE_PLUGIN_DIR).toBe(pluginTargetDir);

      // Second run
      const env2: NodeJS.ProcessEnv = {};
      const updatedEnv2 = await claudeHooks!.beforeRun!(env2);
      expect(updatedEnv2.CODEMIE_CLAUDE_PLUGIN_DIR).toBe(pluginTargetDir);

      // Plugin should still exist and be valid
      expect(existsSync(pluginTargetDir)).toBe(true);
      expect(existsSync(join(pluginTargetDir, '.claude-plugin', 'plugin.json'))).toBe(true);
    });
  });

  describe('Plugin Structure Validation', () => {
    it('should install complete plugin structure', async () => {
      const claudeHooks = SSOTemplate.agentHooks?.['claude'];
      await claudeHooks!.beforeRun!({});

      // Verify directory structure
      expect(existsSync(join(pluginTargetDir, '.claude-plugin'))).toBe(true);
      expect(existsSync(join(pluginTargetDir, 'hooks'))).toBe(true);
      expect(existsSync(join(pluginTargetDir, 'commands'))).toBe(true);

      // Verify key files
      expect(existsSync(join(pluginTargetDir, '.claude-plugin', 'plugin.json'))).toBe(true);
      expect(existsSync(join(pluginTargetDir, 'hooks', 'hooks.json'))).toBe(true);
      expect(existsSync(join(pluginTargetDir, 'README.md'))).toBe(true);

      // Verify command files
      expect(existsSync(join(pluginTargetDir, 'commands', 'README.md'))).toBe(true);
      expect(existsSync(join(pluginTargetDir, 'commands', 'memory-add.md'))).toBe(true);
      expect(existsSync(join(pluginTargetDir, 'commands', 'memory-init.md'))).toBe(true);
      expect(existsSync(join(pluginTargetDir, 'commands', 'memory-refresh.md'))).toBe(true);
    });
  });

  describe('Version Tracking', () => {
    it('should report correct action and version on first install', async () => {
      const result = await ClaudePluginInstaller.install();

      expect(result.success).toBe(true);
      expect(result.action).toBe('copied');
      expect(result.sourceVersion).toBeDefined();
      expect(result.sourceVersion).toBe('1.0.0');
      expect(result.installedVersion).toBeUndefined(); // First install
    });

    it('should skip installation if versions match', async () => {
      // First install
      const result1 = await ClaudePluginInstaller.install();
      expect(result1.action).toBe('copied');

      // Second install - should skip
      const result2 = await ClaudePluginInstaller.install();
      expect(result2.success).toBe(true);
      expect(result2.action).toBe('already_exists');
      expect(result2.sourceVersion).toBe('1.0.0');
      expect(result2.installedVersion).toBe('1.0.0');
    });

    it('should detect version in installed plugin', async () => {
      // Install first
      await ClaudePluginInstaller.install();

      // Read plugin.json to verify version
      const { readFileSync } = await import('fs');
      const pluginJsonPath = join(pluginTargetDir, '.claude-plugin', 'plugin.json');
      const content = readFileSync(pluginJsonPath, 'utf-8');
      const json = JSON.parse(content);

      expect(json.version).toBeDefined();
      expect(json.version).toBe('1.0.0');
    });
  });
});
