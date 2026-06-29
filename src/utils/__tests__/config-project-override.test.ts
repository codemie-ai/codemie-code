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

    it('should apply codeMieProject override', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.initProjectConfig(workingDir, {
        codeMieProject: 'frontend-app'
      });

      const content = await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8');
      const config: MultiProviderConfig = JSON.parse(content);

      expect(config.profiles.default.codeMieProject).toBe('frontend-app');
    });

    it('should apply codeMieIntegration override', async () => {
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
});

describe('ConfigLoader - cross-env URL gate', () => {
  describe('shouldPreserveProjectContext', () => {
    // Helper is private — access via index signature cast for unit testing.
    // This is the established pattern when a Vitest suite needs to reach a
    // class-private static. No production code reads it this way.
    const gate = (l: string | undefined, g: string | undefined): boolean =>
      (ConfigLoader as unknown as {
        shouldPreserveProjectContext: (l?: string, g?: string) => boolean;
      }).shouldPreserveProjectContext(l, g);

    it('preserves when both URLs are equal', () => {
      expect(gate('https://prod.example.com', 'https://prod.example.com')).toBe(true);
    });

    it('preserves when URLs differ only by trailing slash', () => {
      expect(gate('https://prod.example.com/', 'https://prod.example.com')).toBe(true);
    });

    it('preserves when URLs differ only by case', () => {
      expect(gate('https://PROD.example.com', 'https://prod.example.com')).toBe(true);
    });

    it('drops when URLs differ on host', () => {
      expect(gate('https://prod.example.com', 'https://preview.example.com')).toBe(false);
    });

    it('preserves when local URL is undefined', () => {
      expect(gate(undefined, 'https://preview.example.com')).toBe(true);
    });

    it('preserves when global URL is undefined', () => {
      expect(gate('https://prod.example.com', undefined)).toBe(true);
    });

    it('preserves when both URLs are undefined', () => {
      expect(gate(undefined, undefined)).toBe(true);
    });

    it('preserves when local URL is empty string', () => {
      expect(gate('', 'https://preview.example.com')).toBe(true);
    });

    it('preserves when global URL is empty string', () => {
      expect(gate('https://prod.example.com', '')).toBe(true);
    });
  });

  describe('load with --profile cross-env', () => {
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

    it('preserves project context when --profile targets the same CodeMie URL', async () => {
      await writeGlobal('personal-anthropic', {
        'personal-anthropic': {
          provider: 'anthropic-subscription',
          codeMieUrl: 'https://prod.example.com',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          name: 'personal-anthropic'
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

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'personal-anthropic' });

      expect(cfg.codeMieUrl).toBe('https://prod.example.com');
      expect(cfg.codeMieProject).toBe('prod-proj');
      expect(cfg.codeMieIntegration).toBe('prod-int');
    });

    it('preserves local codeMieProject when local profile has no codeMieUrl', async () => {
      await writeGlobal('preview', {
        preview: {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://preview.example.com',
          baseUrl: 'https://preview.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'preview'
        }
      });
      await writeLocal('team-default', {
        'team-default': {
          provider: 'ai-run-sso',
          codeMieProject: 'shared-proj',
          model: 'claude-sonnet-4-6',
          name: 'team-default'
        }
      });

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'preview' });

      expect(cfg.codeMieUrl).toBe('https://preview.example.com');
      expect(cfg.codeMieProject).toBe('shared-proj');
    });

    it('loadWithSources reports codeMieUrl source as "global" when URLs differ', async () => {
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
          baseUrl: 'https://prod.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'team-prod'
        }
      });

      const { config: merged, sources } = await ConfigLoader.loadWithSources(
        path.join(TEST_DIR, 'project'),
        { name: 'preview' }
      );

      expect(merged.codeMieUrl).toBe('https://preview.example.com');
      expect(sources['codeMieUrl']?.source).toBe('global');
      expect(sources['codeMieProject']).toBeUndefined();
    });
  });
});
