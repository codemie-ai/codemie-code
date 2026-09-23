/**
 * Project-Level Configuration Tests
 *
 * Tests for project-level configuration overrides and priority system
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ConfigLoader } from '../config.js';
import type { MultiProviderConfig, CodeMieIntegrationInfo } from '../../env/types.js';
import * as paths from '../paths.js';

// Test utilities
const TEST_DIR = path.join(process.cwd(), 'tmp-test-config');
const GLOBAL_CONFIG_DIR = path.join(TEST_DIR, '.codemie');
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, 'codemie-cli.config.json');
const LOCAL_CONFIG_PATH = path.join(TEST_DIR, 'project', '.codemie', 'codemie-cli.config.json');

describe('ConfigLoader - Project-Level Configuration', () => {
  beforeEach(async () => {
    // Create test directories
    await fs.mkdir(path.join(TEST_DIR, '.codemie'), { recursive: true });
    await fs.mkdir(path.join(TEST_DIR, 'project', '.codemie'), { recursive: true });

    // Mock getCodemieHome and getCodemiePath to use TEST_DIR
    vi.spyOn(paths, 'getCodemieHome').mockReturnValue(GLOBAL_CONFIG_DIR);
    vi.spyOn(paths, 'getCodemiePath').mockImplementation((subpath: string) => {
      return path.join(GLOBAL_CONFIG_DIR, subpath);
    });

    // Clear any environment variables that might pollute tests
    delete process.env.CODEMIE_PROVIDER;
    delete process.env.CODEMIE_MODEL;
    delete process.env.CODEMIE_BASE_URL;
    delete process.env.CODEMIE_API_KEY;
    delete process.env.CODEMIE_TIMEOUT;
    delete process.env.CODEMIE_DEBUG;
    delete process.env.CODEMIE_PROFILE_CONFIG;
    delete process.env.CODEMIE_INTEGRATION_ID;
    delete process.env.CODEMIE_PROJECT;
    delete process.env.CODEMIE_URL;
  });

  afterEach(async () => {
    // Clean up test directories
    await fs.rm(TEST_DIR, { recursive: true, force: true });

    // Restore mocks
    vi.restoreAllMocks();
  });

  describe('initProjectConfig', () => {
    it('should create local config directory and file', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.initProjectConfig(workingDir);

      // Check that directory and file exist
      const configExists = await fs.access(LOCAL_CONFIG_PATH)
        .then(() => true)
        .catch(() => false);

      expect(configExists).toBe(true);
    });

    it('should create multi-provider config structure', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.initProjectConfig(workingDir);

      const content = await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8');
      const config: MultiProviderConfig = JSON.parse(content);

      expect(config.version).toBe(2);
      expect(config.activeProfile).toBe('default');
      expect(config.profiles).toBeDefined();
      expect(config.profiles.default).toBeDefined();
    });

    it('should apply codeMieProject override to both the profile and the workspace', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.initProjectConfig(workingDir, {
        codeMieProject: 'frontend-app'
      });

      const content = await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8');
      const config: MultiProviderConfig = JSON.parse(content);

      expect(config.profiles.default.codeMieProject).toBe('frontend-app');
      expect(config.workspace?.codeMieProject).toBe('frontend-app');
    });

    it('should apply codeMieIntegration override to both the profile and the workspace', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      const integration: CodeMieIntegrationInfo = {
        id: 'integration-123',
        alias: 'frontend-team'
      };

      await ConfigLoader.initProjectConfig(workingDir, {
        codeMieIntegration: integration
      });

      const content = await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8');
      const config: MultiProviderConfig = JSON.parse(content);

      expect(config.profiles.default.codeMieIntegration).toEqual(integration);
      expect(config.workspace?.codeMieIntegration).toEqual(integration);
    });

    it('should apply custom profile name', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.initProjectConfig(workingDir, {
        profileName: 'custom'
      });

      const content = await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8');
      const config: MultiProviderConfig = JSON.parse(content);

      expect(config.activeProfile).toBe('custom');
      expect(config.profiles.custom).toBeDefined();
    });

    it('should apply multiple overrides', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.initProjectConfig(workingDir, {
        profileName: 'work',
        codeMieProject: 'backend-service',
        codeMieIntegration: { id: 'backend-123', alias: 'backend-team' },
        model: 'claude-3-5-sonnet'
      });

      const content = await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8');
      const config: MultiProviderConfig = JSON.parse(content);

      expect(config.activeProfile).toBe('work');
      expect(config.profiles.work.codeMieProject).toBe('backend-service');
      expect(config.profiles.work.codeMieIntegration).toEqual({
        id: 'backend-123',
        alias: 'backend-team'
      });
      expect(config.workspace?.codeMieProject).toBe('backend-service');
      expect(config.workspace?.codeMieIntegration).toEqual({
        id: 'backend-123',
        alias: 'backend-team'
      });
      expect(config.profiles.work.model).toBe('claude-3-5-sonnet');
    });
  });

  describe('hasLocalConfig / hasProjectConfig', () => {
    it('should return true when local config exists', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.initProjectConfig(workingDir);

      const hasLocal = await ConfigLoader.hasLocalConfig(workingDir);
      const hasProject = await ConfigLoader.hasProjectConfig(workingDir);

      expect(hasLocal).toBe(true);
      expect(hasProject).toBe(true);
    });

    it('should return false when local config does not exist', async () => {
      const workingDir = path.join(TEST_DIR, 'project');

      const hasLocal = await ConfigLoader.hasLocalConfig(workingDir);
      const hasProject = await ConfigLoader.hasProjectConfig(workingDir);

      expect(hasLocal).toBe(false);
      expect(hasProject).toBe(false);
    });
  });

  describe('loadWithSources', () => {
    it('should return ConfigWithSources structure', async () => {
      const workingDir = path.join(TEST_DIR, 'project');

      const result = await ConfigLoader.loadWithSources(workingDir);

      expect(result.config).toBeDefined();
      expect(result.hasLocalConfig).toBeDefined();
      expect(result.sources).toBeDefined();
      expect(typeof result.hasLocalConfig).toBe('boolean');
    });

    it('should track sources correctly for default values', async () => {
      const workingDir = path.join(TEST_DIR, 'project');

      const result = await ConfigLoader.loadWithSources(workingDir);

      // Should have sources tracked
      expect(result.sources).toBeDefined();
      expect(typeof result.sources).toBe('object');

      // Timeout and debug should have some source
      if (result.sources.timeout) {
        expect(['default', 'global', 'env']).toContain(result.sources.timeout.source);
      }
      if (result.sources.debug !== undefined) {
        expect(['default', 'global', 'env']).toContain(result.sources.debug.source);
      }
    });

    it('should detect local config existence', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.initProjectConfig(workingDir, {
        codeMieProject: 'test-project'
      });

      const result = await ConfigLoader.loadWithSources(workingDir);

      expect(result.hasLocalConfig).toBe(true);
    });

    it('should track project-level overrides', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.initProjectConfig(workingDir, {
        codeMieProject: 'frontend-app',
        model: 'claude-3-5-sonnet'
      });

      const result = await ConfigLoader.loadWithSources(workingDir);

      // codeMieProject should be from project config (no env var for this)
      expect(result.sources.codeMieProject?.source).toBe('project');
      expect(result.sources.codeMieProject?.value).toBe('frontend-app');

      // Model might be overridden by env var, but should at least be tracked
      expect(result.sources.model).toBeDefined();
      if (result.sources.model?.source === 'project') {
        expect(result.sources.model?.value).toBe('claude-3-5-sonnet');
      }
    });

    it('should prioritize CLI overrides over project config', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.initProjectConfig(workingDir, {
        model: 'claude-3-5-sonnet'
      });

      const result = await ConfigLoader.loadWithSources(workingDir, {
        model: 'claude-opus-4'
      });

      expect(result.sources.model?.source).toBe('cli');
      expect(result.sources.model?.value).toBe('claude-opus-4');
    });
  });

  describe('Priority System', () => {
    it('should follow priority: cli > env > project > global > default', async () => {
      const workingDir = path.join(TEST_DIR, 'project');

      // Create global config with default profile
      const globalConfig: MultiProviderConfig = {
        version: 2,
        activeProfile: 'default',
        profiles: {
          default: {
            provider: 'openai',
            model: 'gpt-4',
            timeout: 60000
          }
        }
      };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalConfig, null, 2));

      // Create local config with project override
      await ConfigLoader.initProjectConfig(workingDir, {
        model: 'claude-3-5-sonnet',
        codeMieProject: 'frontend-app'
      });

      // Load with CLI override
      const result = await ConfigLoader.loadWithSources(workingDir, {
        model: 'claude-opus-4'
      });

      // Verify priorities
      expect(result.sources.model?.value).toBe('claude-opus-4'); // CLI wins
      expect(result.sources.model?.source).toBe('cli');

      expect(result.sources.codeMieProject?.value).toBe('frontend-app'); // Project
      expect(result.sources.codeMieProject?.source).toBe('project');

      // Verify timeout source (value may vary based on actual global config)
      expect(['default', 'global', 'env']).toContain(result.sources.timeout?.source || 'default');
    });
  });

  describe('Field Override Behavior', () => {
    it('should override codeMieProject field from global config', async () => {
      const workingDir = path.join(TEST_DIR, 'project');

      // Global config
      const globalConfig: MultiProviderConfig = {
        version: 2,
        activeProfile: 'default',
        profiles: {
          default: {
            provider: 'bedrock',
            model: 'claude-3-5-sonnet',
            codeMieProject: 'global-project'
          }
        }
      };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalConfig, null, 2));

      // Local config overrides codeMieProject
      await ConfigLoader.initProjectConfig(workingDir, {
        codeMieProject: 'frontend-app'
      });

      const result = await ConfigLoader.loadWithSources(workingDir);

      // codeMieProject should be overridden
      expect(result.sources.codeMieProject?.value).toBe('frontend-app');
      expect(result.sources.codeMieProject?.source).toBe('project');

      // Verify result has config (even if some sources might be undefined in clean CI)
      expect(result.config).toBeDefined();
      expect(result.hasLocalConfig).toBe(true);
    });

    it('should override codeMieIntegration field', async () => {
      const workingDir = path.join(TEST_DIR, 'project');

      // Global config
      const globalConfig: MultiProviderConfig = {
        version: 2,
        activeProfile: 'default',
        profiles: {
          default: {
            codeMieIntegration: {
              id: 'global-integration-123',
              alias: 'company-wide'
            }
          }
        }
      };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalConfig, null, 2));

      // Local config overrides integration
      const localIntegration: CodeMieIntegrationInfo = {
        id: 'frontend-integration-456',
        alias: 'frontend-team'
      };
      await ConfigLoader.initProjectConfig(workingDir, {
        codeMieIntegration: localIntegration
      });

      const result = await ConfigLoader.loadWithSources(workingDir);

      expect(result.sources.codeMieIntegration?.value).toEqual(localIntegration);
      expect(result.sources.codeMieIntegration?.source).toBe('project');
    });

    it('should allow partial overrides (only some fields)', async () => {
      const workingDir = path.join(TEST_DIR, 'project');

      // Global config with multiple fields
      const globalConfig: MultiProviderConfig = {
        version: 2,
        activeProfile: 'default',
        profiles: {
          default: {
            provider: 'bedrock',
            model: 'claude-3-5-sonnet',
            codeMieProject: 'global-project',
            codeMieIntegration: {
              id: 'global-123',
              alias: 'global'
            },
            timeout: 60000
          }
        }
      };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalConfig, null, 2));

      // Local config overrides only codeMieProject
      await ConfigLoader.initProjectConfig(workingDir, {
        codeMieProject: 'frontend-app'
      });

      const result = await ConfigLoader.loadWithSources(workingDir);

      // Only codeMieProject should be from project
      expect(result.sources.codeMieProject?.source).toBe('project');
      expect(result.sources.codeMieProject?.value).toBe('frontend-app');

      // Verify result structure (sources may vary in clean CI environment)
      expect(result.config).toBeDefined();
      expect(result.hasLocalConfig).toBe(true);
      expect(result.sources).toBeDefined();
    });
  });

  describe('saveProfile / initProjectConfig — workspace split', () => {
    it('saveProfile stores identity on profiles[name] and seeds an empty global workspace', async () => {
      await ConfigLoader.saveProfile('p1', {
        provider: 'ai-run-sso',
        codeMieUrl: 'https://x',
        codeMieProject: 'proj'
      } as any);

      const config: MultiProviderConfig = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));

      expect(config.profiles.p1.codeMieUrl).toBe('https://x');
      expect(config.profiles.p1.codeMieProject).toBe('proj');
      expect(config.workspace?.codeMieUrl).toBe('https://x');
      expect(config.workspace?.codeMieProject).toBe('proj');
    });

    it('saving a second profile on another server leaves the first profile and the workspace identity untouched', async () => {
      await ConfigLoader.saveProfile('p1', { provider: 'ai-run-sso', codeMieUrl: 'https://a', codeMieProject: 'proj-a' } as any);
      await ConfigLoader.saveProfile('p2', { provider: 'ai-run-sso', codeMieUrl: 'https://b', codeMieProject: 'proj-b' } as any);

      const config: MultiProviderConfig = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));

      expect(config.profiles.p1.codeMieUrl).toBe('https://a');
      expect(config.profiles.p1.codeMieProject).toBe('proj-a');
      expect(config.profiles.p2.codeMieUrl).toBe('https://b');
      expect(config.workspace?.codeMieUrl).toBe('https://a');
      expect(config.workspace?.codeMieProject).toBe('proj-a');
    });

    it('updating one profile does not change another profile or the workspace identity', async () => {
      await ConfigLoader.saveProfile('p1', { provider: 'ai-run-sso', codeMieUrl: 'https://a', codeMieProject: 'proj-a' } as any);
      await ConfigLoader.saveProfile('p2', { provider: 'ai-run-sso', codeMieUrl: 'https://a', codeMieProject: 'proj-a2' } as any);
      await ConfigLoader.saveProfile('p1', { provider: 'ai-run-sso', codeMieUrl: 'https://b', codeMieProject: 'proj-b' } as any);

      const config: MultiProviderConfig = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));

      expect(config.profiles.p1.codeMieUrl).toBe('https://b');
      expect(config.profiles.p2.codeMieUrl).toBe('https://a');
      expect(config.profiles.p2.codeMieProject).toBe('proj-a2');
      expect(config.workspace?.codeMieUrl).toBe('https://a');
    });

    it('re-saving a profile without an integration drops its previous integration', async () => {
      const integration = { id: 'int-1', alias: 'old' } as unknown as CodeMieIntegrationInfo;
      await ConfigLoader.saveProfile('p1', { provider: 'ai-run-sso', codeMieUrl: 'https://a', codeMieProject: 'proj', codeMieIntegration: integration } as any);
      await ConfigLoader.saveProfile('p1', { provider: 'ai-run-sso', codeMieUrl: 'https://b', codeMieProject: 'proj-b' } as any);

      const config: MultiProviderConfig = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));

      expect(config.profiles.p1.codeMieIntegration).toBeUndefined();
    });

    it('saveProfile still routes tooling fields into the global workspace', async () => {
      await ConfigLoader.saveProfile('p1', { provider: 'ai-run-sso', skillsSearchUrl: 'https://skills' } as any);

      const config: MultiProviderConfig = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));

      expect((config.profiles.p1 as any).skillsSearchUrl).toBeUndefined();
      expect(config.workspace?.skillsSearchUrl).toBe('https://skills');
    });

    it('initProjectConfig stores identity on the local profile and in the local workspace', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.initProjectConfig(workingDir, {
        profileName: 'p1',
        codeMieProject: 'proj'
      });

      const config: MultiProviderConfig = JSON.parse(await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8'));

      expect(config.profiles.p1.codeMieProject).toBe('proj');
      expect(config.workspace?.codeMieProject).toBe('proj');
    });
  });
});

describe('ConfigLoader - workspace resolution and project-only composition', () => {
  describe('load with selected global and local team profiles', () => {
    // ConfigLoader.GLOBAL_CONFIG and .GLOBAL_CONFIG_DIR are static class fields
    // evaluated at module load time, so vi.spyOn(paths, ...) in beforeEach is
    // too late to redirect them. Save the originals and override the statics
    // directly per-test to point at the temp dir.
    const ORIGINAL_GLOBAL_CONFIG = (ConfigLoader as unknown as { GLOBAL_CONFIG: string }).GLOBAL_CONFIG;
    const ORIGINAL_GLOBAL_CONFIG_DIR = (ConfigLoader as unknown as { GLOBAL_CONFIG_DIR: string }).GLOBAL_CONFIG_DIR;

    beforeEach(async () => {
      await fs.mkdir(path.join(TEST_DIR, '.codemie'), { recursive: true });
      await fs.mkdir(path.join(TEST_DIR, 'project', '.codemie'), { recursive: true });

      vi.spyOn(paths, 'getCodemieHome').mockReturnValue(GLOBAL_CONFIG_DIR);
      vi.spyOn(paths, 'getCodemiePath').mockImplementation((subpath: string) => {
        return path.join(GLOBAL_CONFIG_DIR, subpath);
      });
      (ConfigLoader as unknown as { GLOBAL_CONFIG: string }).GLOBAL_CONFIG = GLOBAL_CONFIG_PATH;
      (ConfigLoader as unknown as { GLOBAL_CONFIG_DIR: string }).GLOBAL_CONFIG_DIR = GLOBAL_CONFIG_DIR;

      delete process.env.CODEMIE_PROVIDER;
      delete process.env.CODEMIE_MODEL;
      delete process.env.CODEMIE_BASE_URL;
      delete process.env.CODEMIE_API_KEY;
      delete process.env.CODEMIE_TIMEOUT;
      delete process.env.CODEMIE_DEBUG;
      delete process.env.CODEMIE_PROFILE_CONFIG;
      delete process.env.CODEMIE_INTEGRATION_ID;
      delete process.env.CODEMIE_PROJECT;
      delete process.env.CODEMIE_URL;
    });

    afterEach(async () => {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
      vi.restoreAllMocks();
      (ConfigLoader as unknown as { GLOBAL_CONFIG: string }).GLOBAL_CONFIG = ORIGINAL_GLOBAL_CONFIG;
      (ConfigLoader as unknown as { GLOBAL_CONFIG_DIR: string }).GLOBAL_CONFIG_DIR = ORIGINAL_GLOBAL_CONFIG_DIR;
    });

    async function writeGlobal(
      activeProfile: string,
      profiles: Record<string, Partial<MultiProviderConfig['profiles'][string]>>
    ) {
      const config: MultiProviderConfig = {
        version: 2,
        activeProfile,
        profiles: profiles as MultiProviderConfig['profiles']
      };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
    }

    async function writeLocal(
      activeProfile: string,
      profiles: Record<string, Partial<MultiProviderConfig['profiles'][string]>>
    ) {
      const config: MultiProviderConfig = {
        version: 2,
        activeProfile,
        profiles: profiles as MultiProviderConfig['profiles']
      };
      await fs.writeFile(LOCAL_CONFIG_PATH, JSON.stringify(config, null, 2));
    }

    async function setWorkspace(configPath: string, workspace: Record<string, unknown>) {
      const raw = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      raw.workspace = workspace;
      await fs.writeFile(configPath, JSON.stringify(raw, null, 2));
    }

    it('keeps a globally defined profile selected by local activeProfile when --profile is omitted', async () => {
      await writeGlobal('global-default', {
        'global-default': {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://prod.example.com',
          codeMieProject: 'global-default-project',
          baseUrl: 'https://prod.example.com/code-assistant-api',
          model: 'global-default-model',
          name: 'global-default'
        },
        'selected-profile': {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://prod.example.com',
          codeMieProject: 'selected-project',
          baseUrl: 'https://prod.example.com/code-assistant-api',
          model: 'selected-model',
          name: 'selected-profile'
        }
      });
      await writeLocal('selected-profile', {
        'local-team-profile': {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://prod.example.com',
          codeMieProject: 'local-team-project',
          baseUrl: 'https://prod.example.com/code-assistant-api',
          model: 'local-team-model',
          name: 'local-team-profile'
        }
      });

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'));

      expect(cfg.name).toBe('selected-profile');
      expect(cfg.model).toBe('selected-model');
      expect(cfg.codeMieProject).toBe('selected-project');
    });

    it('drops project context when --profile targets a different CodeMie URL', async () => {
      await writeGlobal('preview', {
        preview: {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://preview.example.com',
          baseUrl: 'https://preview.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'preview'
        }
      });
      await writeLocal('team-prod', {
        'team-prod': {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://prod.example.com',
          codeMieProject: 'prod-proj',
          codeMieIntegration: 'prod-int' as unknown as CodeMieIntegrationInfo,
          baseUrl: 'https://prod.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'team-prod'
        }
      });

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'preview' });

      expect(cfg.codeMieUrl).toBe('https://preview.example.com');
      expect(cfg.codeMieProject).toBeUndefined();
      expect(cfg.codeMieIntegration).toBeUndefined();
    });

    it('resolves workspace from the local scope, overriding the global scope entirely (whole-object override)', async () => {
      await writeGlobal('personal-anthropic', {
        'personal-anthropic': {
          provider: 'anthropic-subscription',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          name: 'personal-anthropic'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieProject: 'global-proj', codeMieUrl: 'https://global.example.com' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      await writeLocal('personal-anthropic', {
        'personal-anthropic': {
          provider: 'anthropic-subscription',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          name: 'personal-anthropic'
        }
      });
      const localRaw = JSON.parse(await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8'));
      localRaw.workspace = { codeMieProject: 'local-proj' };
      await fs.writeFile(LOCAL_CONFIG_PATH, JSON.stringify(localRaw, null, 2));

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'));

      // Whole-object override: the local workspace object wins outright — the
      // global workspace's codeMieUrl must NOT leak in alongside it.
      expect(cfg.codeMieProject).toBe('local-proj');
      expect(cfg.codeMieUrl).toBeUndefined();
    });

    it('falls back to the global scope workspace entirely when the local scope has no workspace defined', async () => {
      await writeGlobal('personal-anthropic', {
        'personal-anthropic': {
          provider: 'anthropic-subscription',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          name: 'personal-anthropic'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieProject: 'global-proj', codeMieUrl: 'https://global.example.com' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      await writeLocal('personal-anthropic', {
        'personal-anthropic': {
          provider: 'anthropic-subscription',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          name: 'personal-anthropic'
        }
      });

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'));

      expect(cfg.codeMieProject).toBe('global-proj');
      expect(cfg.codeMieUrl).toBe('https://global.example.com');
    });

    it('does not crash and falls back to the global workspace when the local config has an explicit "workspace": null', async () => {
      await writeGlobal('personal-anthropic', {
        'personal-anthropic': {
          provider: 'anthropic-subscription',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          name: 'personal-anthropic'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieProject: 'global-proj', codeMieUrl: 'https://global.example.com' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      await writeLocal('personal-anthropic', {
        'personal-anthropic': {
          provider: 'anthropic-subscription',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          name: 'personal-anthropic'
        }
      });
      // A hand-edited or externally-written local config with a literal `null`
      // workspace: null !== undefined, so a naive `!== undefined` check would treat
      // it as "defined" and return it as-is, crashing removeUndefined()'s
      // Object.entries(null) downstream.
      const localRaw = JSON.parse(await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8'));
      localRaw.workspace = null;
      await fs.writeFile(LOCAL_CONFIG_PATH, JSON.stringify(localRaw, null, 2));

      await expect(ConfigLoader.load(path.join(TEST_DIR, 'project'))).resolves.toMatchObject({
        codeMieProject: 'global-proj',
        codeMieUrl: 'https://global.example.com'
      });
    });

    it('switching the selected global profile does not drop workspace context', async () => {
      await writeGlobal('codemie-sso', {
        'codemie-sso': {
          provider: 'ai-run-sso',
          baseUrl: 'https://prod.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'codemie-sso'
        },
        anthropic: {
          provider: 'anthropic-subscription',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          name: 'anthropic'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieProject: 'shared-proj' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      const ssoCfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'codemie-sso' });
      const anthropicCfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'anthropic' });

      expect(ssoCfg.codeMieProject).toBe('shared-proj');
      expect(anthropicCfg.codeMieProject).toBe('shared-proj');
    });

    it('loadWithSources reports a global-only workspace value with source "global", not "project"', async () => {
      await writeGlobal('preview', {
        preview: {
          provider: 'ai-run-sso',
          baseUrl: 'https://preview.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'preview'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://global-workspace.example.com' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      // No local .codemie/ config written — the resolved workspace can only have
      // come from the global scope, so --show-sources must label it 'global'.
      const { config: merged, sources } = await ConfigLoader.loadWithSources(
        path.join(TEST_DIR, 'project'),
        { name: 'preview' }
      );

      expect(merged.codeMieUrl).toBe('https://global-workspace.example.com');
      expect(sources['codeMieUrl']?.source).toBe('global');
    });

    it('loadWithSources reports a local-scope workspace value with source "project"', async () => {
      await writeGlobal('preview', {
        preview: {
          provider: 'ai-run-sso',
          baseUrl: 'https://preview.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'preview'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://global-workspace.example.com' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      await writeLocal('preview', {
        preview: {
          provider: 'ai-run-sso',
          baseUrl: 'https://preview.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'preview'
        }
      });
      const localRaw = JSON.parse(await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8'));
      localRaw.workspace = { codeMieUrl: 'https://local-workspace.example.com' };
      await fs.writeFile(LOCAL_CONFIG_PATH, JSON.stringify(localRaw, null, 2));

      const { config: merged, sources } = await ConfigLoader.loadWithSources(
        path.join(TEST_DIR, 'project'),
        { name: 'preview' }
      );

      expect(merged.codeMieUrl).toBe('https://local-workspace.example.com');
      expect(sources['codeMieUrl']?.source).toBe('project');
    });

    describe('identity resolution', () => {
      const LAB = 'https://lab.example.com';
      const PREVIEW = 'https://preview.example.com';
      const PROJECT_DIR = path.join(TEST_DIR, 'project');
      const ELSEWHERE_DIR = path.join(TEST_DIR, 'elsewhere');

      /**
       * Global workspace: lab / proj-g. Repo workspace: lab / team-x. The repo's
       * activeProfile is a local-only `team` profile with no identity, so a
       * selected global profile composes through applyProjectOnly.
       */
      async function writeFixture(
        profileName: string,
        profile: Record<string, unknown>,
        options: { repo: boolean }
      ) {
        await writeGlobal(profileName, { [profileName]: { ...profile, name: profileName } as never });
        await setWorkspace(GLOBAL_CONFIG_PATH, { codeMieUrl: LAB, codeMieProject: 'proj-g' });

        if (options.repo) {
          await writeLocal('team', { team: { provider: 'ai-run-sso', name: 'team' } });
          await setWorkspace(LOCAL_CONFIG_PATH, { codeMieUrl: LAB, codeMieProject: 'team-x' });
        } else {
          await fs.mkdir(ELSEWHERE_DIR, { recursive: true });
        }
      }

      it('row 1: a profile URL and project on another server win over both workspaces', async () => {
        await writeFixture('own', { provider: 'ai-run-sso', codeMieUrl: PREVIEW, codeMieProject: 'my-proj' }, { repo: true });

        const cfg = await ConfigLoader.load(PROJECT_DIR, { name: 'own' });

        expect(cfg.codeMieUrl).toBe(PREVIEW);
        expect(cfg.codeMieProject).toBe('my-proj');
        expect(cfg.codeMieIntegration).toBeUndefined();
      });

      it('row 2: a profile URL and project on the same server still win over both workspaces', async () => {
        await writeFixture('own', { provider: 'ai-run-sso', codeMieUrl: LAB, codeMieProject: 'my-proj' }, { repo: true });

        const cfg = await ConfigLoader.load(PROJECT_DIR, { name: 'own' });

        expect(cfg.codeMieUrl).toBe(LAB);
        expect(cfg.codeMieProject).toBe('my-proj');
        expect(cfg.codeMieIntegration).toBeUndefined();
      });

      it('row 3: a profile without identity outside a repo takes the global workspace identity', async () => {
        await writeFixture('sso', { provider: 'ai-run-sso' }, { repo: false });

        const cfg = await ConfigLoader.load(ELSEWHERE_DIR, { name: 'sso' });

        expect(cfg.codeMieUrl).toBe(LAB);
        expect(cfg.codeMieProject).toBe('proj-g');
        expect(cfg.codeMieIntegration).toBeUndefined();
      });

      it('row 4: a profile without identity inside a repo takes the repo workspace identity', async () => {
        await writeFixture('sso', { provider: 'ai-run-sso' }, { repo: true });

        const cfg = await ConfigLoader.load(PROJECT_DIR, { name: 'sso' });

        expect(cfg.codeMieUrl).toBe(LAB);
        expect(cfg.codeMieProject).toBe('team-x');
        expect(cfg.codeMieIntegration).toBeUndefined();
      });

      it('row 5: a non-CodeMie provider without identity outside a repo takes the global workspace identity', async () => {
        await writeFixture('bedrock', { provider: 'bedrock' }, { repo: false });

        const cfg = await ConfigLoader.load(ELSEWHERE_DIR, { name: 'bedrock' });

        expect(cfg.codeMieUrl).toBe(LAB);
        expect(cfg.codeMieProject).toBe('proj-g');
        expect(cfg.codeMieIntegration).toBeUndefined();
      });

      it('row 6: a non-CodeMie provider without identity inside a repo takes the repo workspace identity', async () => {
        await writeFixture('bedrock', { provider: 'bedrock' }, { repo: true });

        const cfg = await ConfigLoader.load(PROJECT_DIR, { name: 'bedrock' });

        expect(cfg.codeMieUrl).toBe(LAB);
        expect(cfg.codeMieProject).toBe('team-x');
        expect(cfg.codeMieIntegration).toBeUndefined();
      });

      it('row 7: a profile URL on the same server as the repo workspace gains the repo project', async () => {
        await writeFixture('sso', { provider: 'ai-run-sso', codeMieUrl: LAB }, { repo: true });

        const cfg = await ConfigLoader.load(PROJECT_DIR, { name: 'sso' });

        expect(cfg.codeMieUrl).toBe(LAB);
        expect(cfg.codeMieProject).toBe('team-x');
        expect(cfg.codeMieIntegration).toBeUndefined();
      });

      it('row 8: a profile URL no workspace matches resolves with no project and no integration', async () => {
        await writeFixture('sso', { provider: 'ai-run-sso', codeMieUrl: PREVIEW }, { repo: true });

        const cfg = await ConfigLoader.load(PROJECT_DIR, { name: 'sso' });

        expect(cfg.codeMieUrl).toBe(PREVIEW);
        expect(cfg.codeMieProject).toBeUndefined();
        expect(cfg.codeMieIntegration).toBeUndefined();
      });

      it('a same-name local profile with its own identity wins over the global profile identity', async () => {
        await writeGlobal('epm', {
          epm: { provider: 'ai-run-sso', codeMieUrl: 'https://lab.example.com', codeMieProject: 'old-proj', name: 'epm' }
        });
        await ConfigLoader.initProjectConfig(path.join(TEST_DIR, 'project'), {
          profileName: 'epm',
          provider: 'ai-run-sso',
          codeMieUrl: 'https://preview.example.com',
          codeMieProject: 'new-proj'
        });

        const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'epm' });

        expect(cfg.codeMieUrl).toBe('https://preview.example.com');
        expect(cfg.codeMieProject).toBe('new-proj');
      });

      it('does not combine a local profile identity with the global profile integration', async () => {
        await writeGlobal('epm', {
          epm: {
            provider: 'ai-run-sso',
            codeMieUrl: 'https://lab.example.com',
            codeMieProject: 'lab-proj',
            codeMieIntegration: { id: 'lab-int' } as unknown as CodeMieIntegrationInfo,
            name: 'epm'
          }
        });
        await writeLocal('epm', {
          epm: { provider: 'ai-run-sso', codeMieUrl: 'https://preview.example.com', codeMieProject: 'preview-proj', name: 'epm' }
        });

        const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'epm' });

        expect(cfg.codeMieUrl).toBe('https://preview.example.com');
        expect(cfg.codeMieProject).toBe('preview-proj');
        expect(cfg.codeMieIntegration).toBeUndefined();
      });

      it('takes identity from one workspace only — no repo project with a global integration', async () => {
        await writeGlobal('anthropic', { anthropic: { provider: 'anthropic-subscription', name: 'anthropic' } });
        await setWorkspace(GLOBAL_CONFIG_PATH, {
          codeMieUrl: 'https://lab.example.com',
          codeMieProject: 'proj-g',
          codeMieIntegration: { id: 'g-int' }
        });
        await writeLocal('team', { team: { provider: 'ai-run-sso', name: 'team' } });
        await setWorkspace(LOCAL_CONFIG_PATH, { codeMieUrl: 'https://lab.example.com', codeMieProject: 'team-x' });

        const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'anthropic' });

        expect(cfg.codeMieProject).toBe('team-x');
        expect(cfg.codeMieIntegration).toBeUndefined();
      });

      it('a repo workspace holding only tooling fields falls through to the global workspace identity', async () => {
        await writeGlobal('anthropic', { anthropic: { provider: 'anthropic-subscription', name: 'anthropic' } });
        await setWorkspace(GLOBAL_CONFIG_PATH, { codeMieUrl: 'https://lab.example.com', codeMieProject: 'proj-g' });
        await writeLocal('team', { team: { provider: 'ai-run-sso', name: 'team' } });
        await setWorkspace(LOCAL_CONFIG_PATH, { skillsSearchUrl: 'https://skills' });

        const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'anthropic' });

        expect(cfg.codeMieUrl).toBe('https://lab.example.com');
        expect(cfg.codeMieProject).toBe('proj-g');
        expect(cfg.skillsSearchUrl).toBe('https://skills');
      });

      it('treats URLs differing only by trailing slash or case as the same server', async () => {
        await writeGlobal('jwt', { jwt: { provider: 'ai-run-jwt', codeMieUrl: 'HTTPS://LAB.example.com/', name: 'jwt' } });
        await writeLocal('team', { team: { provider: 'ai-run-sso', name: 'team' } });
        await setWorkspace(LOCAL_CONFIG_PATH, { codeMieUrl: 'https://lab.example.com', codeMieProject: 'team-x' });

        const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'jwt' });

        expect(cfg.codeMieUrl).toBe('HTTPS://LAB.example.com/');
        expect(cfg.codeMieProject).toBe('team-x');
      });

      it('CODEMIE_URL overrides the resolved identity when no profile is explicitly selected', async () => {
        await writeGlobal('jwt', { jwt: { provider: 'ai-run-jwt', codeMieUrl: 'https://lab.example.com', name: 'jwt' } });
        const elsewhere = path.join(TEST_DIR, 'elsewhere');
        await fs.mkdir(elsewhere, { recursive: true });
        process.env.CODEMIE_URL = 'https://env.example.com';
        try {
          const cfg = await ConfigLoader.load(elsewhere);
          expect(cfg.codeMieUrl).toBe('https://env.example.com');
        } finally {
          delete process.env.CODEMIE_URL;
        }
      });

      it('an explicitly selected profile keeps its own URL over CODEMIE_URL (profile protection)', async () => {
        await writeGlobal('jwt', { jwt: { provider: 'ai-run-jwt', codeMieUrl: 'https://lab.example.com', name: 'jwt' } });
        const elsewhere = path.join(TEST_DIR, 'elsewhere');
        await fs.mkdir(elsewhere, { recursive: true });
        process.env.CODEMIE_URL = 'https://env.example.com';
        try {
          const cfg = await ConfigLoader.load(elsewhere, { name: 'jwt' });
          expect(cfg.codeMieUrl).toBe('https://lab.example.com');
        } finally {
          delete process.env.CODEMIE_URL;
        }
      });
    });
  });
});
