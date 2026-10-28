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
import { IsolateGlobalProfileIdentityMigration } from '../../migrations/008-isolate-global-profile-identity.migration.js';

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

    it('should apply codeMieProject override into workspace, not the profile', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.initProjectConfig(workingDir, {
        codeMieProject: 'frontend-app'
      });

      const content = await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8');
      const config: MultiProviderConfig = JSON.parse(content);

      expect((config.profiles.default as any).codeMieProject).toBeUndefined();
      expect(config.workspace?.codeMieProject).toBe('frontend-app');
    });

    it('should apply codeMieIntegration override into workspace, not the profile', async () => {
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

      expect((config.profiles.default as any).codeMieIntegration).toBeUndefined();
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
      expect((config.profiles.work as any).codeMieProject).toBeUndefined();
      expect((config.profiles.work as any).codeMieIntegration).toBeUndefined();
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
    it('saveProfile keeps identity fields on profiles[name], routes only non-identity fields into the global workspace', async () => {
      await ConfigLoader.saveProfile('p1', {
        provider: 'ai-run-sso',
        codeMieUrl: 'https://x',
        codeMieProject: 'proj',
        claudeAutocompactPct: 85
      } as any);

      const content = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8');
      const config: MultiProviderConfig = JSON.parse(content);

      expect((config.profiles.p1 as any).codeMieUrl).toBe('https://x');
      expect((config.profiles.p1 as any).codeMieProject).toBe('proj');
      expect(config.profiles.p1.provider).toBe('ai-run-sso');
      expect(config.workspace?.codeMieUrl).toBeUndefined();
      expect(config.workspace?.codeMieProject).toBeUndefined();
      expect(config.workspace?.claudeAutocompactPct).toBe(85);
    });

    it('saveProfile merges onto the existing profile instead of replacing it, so an update that omits identity does not wipe previously saved identity', async () => {
      await ConfigLoader.saveProfile('p1', {
        provider: 'ai-run-sso',
        codeMieUrl: 'https://x',
        codeMieProject: 'proj',
        baseUrl: 'https://x/code-assistant-api',
        model: 'claude-sonnet-4-6'
      } as any);

      // A later update (e.g. changing just the model) naturally omits identity.
      await ConfigLoader.saveProfile('p1', {
        provider: 'ai-run-sso',
        baseUrl: 'https://x/code-assistant-api',
        model: 'claude-opus-5-5'
      } as any);

      const content = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8');
      const config: MultiProviderConfig = JSON.parse(content);

      expect((config.profiles.p1 as any).codeMieUrl).toBe('https://x');
      expect((config.profiles.p1 as any).codeMieProject).toBe('proj');
      expect(config.profiles.p1.model).toBe('claude-opus-5-5');
    });

    it('saveProfile does not leak stale provider-specific fields across a provider switch — only the identity trio carries forward', async () => {
      // jwt provider's buildConfig() sets authMethod/jwtConfig; sso's does not.
      await ConfigLoader.saveProfile('work', {
        provider: 'bearer-auth',
        codeMieUrl: 'https://x',
        baseUrl: 'https://x/code-assistant-api',
        model: 'claude-sonnet-4-6',
        authMethod: 'jwt',
        jwtConfig: { tokenEnvVar: 'MY_TOKEN' }
      } as any);

      // Switching provider must not let authMethod/jwtConfig survive.
      await ConfigLoader.saveProfile('work', {
        provider: 'ai-run-sso',
        codeMieUrl: 'https://y',
        apiKey: 'sso-provided',
        baseUrl: 'https://y/code-assistant-api',
        model: 'claude-sonnet-4-6'
      } as any);

      const content = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8');
      const config: MultiProviderConfig = JSON.parse(content);

      expect(config.profiles.work.provider).toBe('ai-run-sso');
      expect((config.profiles.work as any).authMethod).toBeUndefined();
      expect((config.profiles.work as any).jwtConfig).toBeUndefined();
      expect((config.profiles.work as any).codeMieUrl).toBe('https://y');
    });

    it('saveProfile preserves identity when the update sets it to an explicit undefined, not just when the key is omitted', async () => {
      await ConfigLoader.saveProfile('p1', {
        provider: 'anthropic-subscription',
        codeMieUrl: 'https://x',
        codeMieProject: 'proj',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6'
      } as any);

      // anthropic-subscription's buildConfig() always sets these keys, as
      // `... as string | undefined` — an explicit own property with value
      // `undefined` when the user declines the analytics login, not an
      // omitted key.
      await ConfigLoader.saveProfile('p1', {
        provider: 'anthropic-subscription',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-opus-5-5',
        codeMieUrl: undefined,
        codeMieProject: undefined
      } as any);

      const content = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8');
      const config: MultiProviderConfig = JSON.parse(content);

      expect((config.profiles.p1 as any).codeMieUrl).toBe('https://x');
      expect((config.profiles.p1 as any).codeMieProject).toBe('proj');
      expect(config.profiles.p1.model).toBe('claude-opus-5-5');
    });

    it('saveProfile treats the identity trio as a unit: supplying a new codeMieUrl does not pair it with an old codeMieProject/codeMieIntegration left over from a different environment', async () => {
      await ConfigLoader.saveProfile('work', {
        provider: 'ai-run-sso',
        codeMieUrl: 'https://old-env.example.com',
        codeMieProject: 'old-env-proj',
        codeMieIntegration: { id: 'old-env-integration' },
        baseUrl: 'https://old-env.example.com/code-assistant-api',
        model: 'claude-sonnet-4-6'
      } as any);

      // Re-saved under a NEW environment's codeMieUrl, with no project/integration
      // supplied yet — the old ones must not be carried forward next to the new URL.
      await ConfigLoader.saveProfile('work', {
        provider: 'ai-run-sso',
        codeMieUrl: 'https://new-env.example.com',
        baseUrl: 'https://new-env.example.com/code-assistant-api',
        model: 'claude-sonnet-4-6'
      } as any);

      const content = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8');
      const config: MultiProviderConfig = JSON.parse(content);

      expect((config.profiles.work as any).codeMieUrl).toBe('https://new-env.example.com');
      expect((config.profiles.work as any).codeMieProject).toBeUndefined();
      expect((config.profiles.work as any).codeMieIntegration).toBeUndefined();
    });

    it('initProjectConfig routes workspace fields into the local scope workspace, not into profiles[name]', async () => {
      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.initProjectConfig(workingDir, {
        profileName: 'p1',
        codeMieProject: 'proj'
      });

      const content = await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8');
      const config: MultiProviderConfig = JSON.parse(content);

      expect((config.profiles.p1 as any).codeMieProject).toBeUndefined();
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

    it('falls back to the matching global profile\'s own identity when the global workspace no longer carries it (post migration 008)', async () => {
      // Identity lives on the global profile itself, not the shared workspace.
      // A local profile with no local workspace of its own must still resolve it.
      await writeGlobal('personal-anthropic', {
        'personal-anthropic': {
          provider: 'anthropic-subscription',
          codeMieUrl: 'https://global.example.com',
          codeMieProject: 'global-proj',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          name: 'personal-anthropic'
        }
      });

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

    it('resolves no identity (not a crash, not a stale leaked value) for a purely local-only profile name with no global counterpart and no own identity', async () => {
      // 'local-only-profile' has no matching key in global `profiles` and defines
      // no identity of its own. The correct outcome is no identity at all — not
      // a crash, and not another profile's leaked value.
      await writeGlobal('unrelated-global', {
        'unrelated-global': {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://unrelated.example.com',
          codeMieProject: 'unrelated-proj',
          baseUrl: 'https://unrelated.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'unrelated-global'
        }
      });
      await writeLocal('local-only-profile', {
        'local-only-profile': {
          provider: 'anthropic-subscription',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          name: 'local-only-profile'
        }
      });

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'));

      expect(cfg.codeMieUrl).toBeUndefined();
      expect(cfg.codeMieProject).toBeUndefined();
    });

    it('falls back to the shared global workspace identity for a local-only profile with no global counterpart, even after migration 008 has actually run (AC5: existing local profile behavior is not regressed)', async () => {
      // No same-named global profile exists for 'local-only-profile' to borrow identity
      // from by name — the ONLY possible source is the shared global workspace object.
      // Migration 008 keeps that value in place rather than stripping it, specifically so
      // this historical ambient-inheritance contract for local profiles keeps working —
      // run the real migration (not just hand-write the post-migration shape) so this
      // test actually exercises migrate()'s decision not to strip, not just load()'s
      // ability to read a value that happens to already be there.
      await writeGlobal('unrelated-global', {
        'unrelated-global': {
          provider: 'ai-run-sso',
          baseUrl: 'https://unrelated.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'unrelated-global'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://unrelated.example.com', codeMieProject: 'shared-proj' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      const migration = new IsolateGlobalProfileIdentityMigration();
      await migration.up();

      await writeLocal('local-only-profile', {
        'local-only-profile': {
          provider: 'anthropic-subscription',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          name: 'local-only-profile'
        }
      });

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'));

      expect(cfg.codeMieUrl).toBe('https://unrelated.example.com');
      expect(cfg.codeMieProject).toBe('shared-proj');
    });

    it('refuses the shared-workspace fallback for a purely local-only profile when a sibling GLOBAL profile provably owns that shared origin (canUseSharedIdentity must see the LOCAL profile\'s own baseUrl, not an empty stand-in)', async () => {
      // 'env-b' is a global profile that legitimately claims the shared origin:
      // its own baseUrl IS on that origin. The shared workspace is the permanent,
      // never-stripped leftover identity for that same origin.
      await writeGlobal('env-b', {
        'env-b': {
          provider: 'ai-run-sso',
          baseUrl: 'https://b.example.com/code-assistant-api',
          codeMieUrl: 'https://b.example.com',
          model: 'claude-sonnet-4-6',
          name: 'env-b'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://b.example.com', codeMieProject: 'env-b-proj' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      // 'team-local' is a PURELY LOCAL-ONLY profile (no same-named global profile
      // exists at all) whose own baseUrl is on a DIFFERENT CodeMie environment.
      await writeLocal('team-local', {
        'team-local': {
          provider: 'ai-run-sso',
          baseUrl: 'https://a.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'team-local'
        }
      });

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'));

      // Must NOT inherit env-b's codeMieUrl: canUseSharedIdentity() must be evaluated
      // against team-local's own provider/baseUrl (ai-run-sso, a.example.com), not an
      // empty stand-in from a nonexistent same-named global profile — env-b's sibling
      // claim on b.example.com must refuse the fallback for team-local.
      expect(cfg.codeMieUrl).toBeUndefined();
      expect(cfg.codeMieProject).toBeUndefined();
    });

    it('does not mix identities across environments: a global profile that already owns part of its identity does not inherit the rest from the shared workspace', async () => {
      // 'newprofile' already owns its own codeMieUrl (matching its own baseUrl's origin),
      // but has not yet been assigned a project/integration. The shared workspace still
      // carries a STALE project left over from a different environment/profile. Filling
      // the missing project from it would attribute usage to the wrong project.
      await writeGlobal('newprofile', {
        newprofile: {
          provider: 'ai-run-sso',
          baseUrl: 'https://epam.example.com/code-assistant-api',
          codeMieUrl: 'https://epam.example.com',
          model: 'claude-sonnet-4-6',
          name: 'newprofile'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = {
        codeMieUrl: 'https://epam.example.com',
        codeMieProject: 'OTHER-TEAMS-PROJECT',
        codeMieIntegration: { id: 'other-teams-integration' }
      };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'newprofile' });

      expect(cfg.codeMieUrl).toBe('https://epam.example.com');
      expect(cfg.codeMieProject).toBeUndefined();
      expect(cfg.codeMieIntegration).toBeUndefined();
    });

    it('a same-named local profile with no identity of its own does not let the permanent shared workspace fallback overwrite the matching global profile\'s own identity', async () => {
      // 'team' is a GLOBAL profile that already owns its own identity. The repo also
      // defines a LOCAL profile named 'team' (no identity, no local workspace of its
      // own) — a legitimate pattern for sharing provider/model defaults in a repo
      // without duplicating CodeMie identity. The repo has no own workspace either, so
      // resolveWorkspace() falls through to the GLOBAL workspace, which still carries a
      // stale/leftover shared identity (migration 008 never strips it). That leftover
      // must never clobber 'team' global profile's own, already-correct identity.
      await writeGlobal('team', {
        team: {
          provider: 'ai-run-sso',
          baseUrl: 'https://team.example.com/code-assistant-api',
          codeMieUrl: 'https://team.example.com',
          codeMieProject: 'team-own-proj',
          model: 'claude-sonnet-4-6',
          name: 'team'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://stale-leftover.example.com', codeMieProject: 'stale-leftover-proj' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      await writeLocal('team', {
        team: {
          provider: 'ai-run-sso',
          baseUrl: 'https://team.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'team'
        }
      });

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'));

      expect(cfg.codeMieUrl).toBe('https://team.example.com');
      expect(cfg.codeMieProject).toBe('team-own-proj');
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

    it('a global profile with no identity of its own still resolves it from the shared workspace before migration 008 has run', async () => {
      // Pre-008 shape: identity lives only on the shared workspace, not yet
      // copied onto the profile. A non-`codemie` launcher (e.g. `codemie-claude`)
      // never runs pending migrations, so this state must still resolve
      // identity rather than going empty until some other command migrates it.
      await writeGlobal('work', {
        work: {
          provider: 'ai-run-sso',
          baseUrl: 'https://work.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'work'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://work.example.com', codeMieProject: 'work-proj' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'work' });

      expect(cfg.codeMieUrl).toBe('https://work.example.com');
      expect(cfg.codeMieProject).toBe('work-proj');
    });

    it('does not fall back to the shared workspace identity before migration 008 when another CodeMie-platform profile is provably pinned to it', async () => {
      // Pre-008 shape, but the shared workspace was last saved for a *different*
      // profile's backend — exactly the pre-fix bug's own symptom. 'epam' proves
      // the shared value belongs to it (same origin), so 'medecision' (a
      // different origin) must not inherit it.
      await writeGlobal('medecision', {
        medecision: {
          provider: 'ai-run-sso',
          baseUrl: 'https://codemie.gcp.medecision.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'medecision'
        },
        epam: {
          provider: 'ai-run-sso',
          baseUrl: 'https://codemie.lab.epam.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'epam'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://codemie.lab.epam.com', codeMieProject: 'epam-proj' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'medecision' });

      expect(cfg.codeMieUrl).toBeUndefined();
      expect(cfg.codeMieProject).toBeUndefined();
    });

    it('falls back to the shared workspace identity for a lone CodeMie-platform profile whose baseUrl origin differs, when no sibling profile is provably pinned to it (split-host SSO)', async () => {
      // ai-run-sso can have a split host: baseUrl's origin need not match
      // codeMieUrl's origin by design (see sso.auth.ts's VITE_API_URL
      // resolution). With no other profile claiming the shared origin, there
      // is no positive evidence it belongs to someone else, so it must still
      // resolve rather than silently losing identity.
      await writeGlobal('split-host', {
        'split-host': {
          provider: 'ai-run-sso',
          baseUrl: 'https://api.split-host.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'split-host'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://split-host.example.com', codeMieProject: 'split-host-proj' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'split-host' });

      expect(cfg.codeMieUrl).toBe('https://split-host.example.com');
      expect(cfg.codeMieProject).toBe('split-host-proj');
    });

    it('falls back to the shared workspace identity for a vendor-subscription profile regardless of baseUrl origin', async () => {
      // anthropic-subscription/moonshot-subscription's baseUrl is always the
      // vendor's API, never the CodeMie backend — origin never matches
      // codeMieUrl by design, so the origin guard must not apply to them at all.
      await writeGlobal('anthropic-sub', {
        'anthropic-sub': {
          provider: 'anthropic-subscription',
          baseUrl: 'https://api.anthropic.com',
          apiKey: '',
          model: 'claude-sonnet-4-6',
          authMethod: 'manual',
          name: 'anthropic-sub'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://codemie.lab.epam.com', codeMieProject: 'epm-cdme' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'anthropic-sub' });

      expect(cfg.codeMieUrl).toBe('https://codemie.lab.epam.com');
      expect(cfg.codeMieProject).toBe('epm-cdme');
    });

    it('the pre-migration-008 fallback uses the global shared workspace, never a repo-local workspace meant for a different profile', async () => {
      // A repo's local .codemie/ workspace is an unrelated project-context
      // overlay (its own compatibility rules live elsewhere); it must never
      // supply the pre-008 identity fallback for a selected GLOBAL profile.
      await writeGlobal('work', {
        work: {
          provider: 'ai-run-sso',
          baseUrl: 'https://global.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'work'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://global.example.com', codeMieProject: 'global-proj' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      const localDir = path.join(TEST_DIR, 'project', '.codemie');
      await fs.mkdir(localDir, { recursive: true });
      await fs.writeFile(path.join(localDir, 'codemie-cli.config.json'), JSON.stringify({
        version: 2,
        activeProfile: 'none',
        profiles: {},
        workspace: { codeMieUrl: 'https://global.example.com', codeMieProject: 'repo-proj' }
      }, null, 2));

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'work' });

      expect(cfg.codeMieProject).toBe('global-proj');
    });

    it('resolveProfileWorkspace() never substitutes a stale shared value for a profile that already owns its own identity, even when the caller omits profileIdentity', async () => {
      // listProfiles() (profile/index.ts) calls resolveProfileWorkspace(workingDir, false, {}, name)
      // with an EMPTY profileIdentity for every row — it relies on the function itself to notice
      // the named profile already has its own identity, not on the caller re-deriving it. A stale
      // leftover shared value with no sibling claiming its origin is otherwise still "allowed" by
      // canUseSharedIdentity (no positive conflict evidence), so without this guard it would
      // silently clobber a profile's own already-correct identity.
      await writeGlobal('pa', {
        pa: {
          provider: 'ai-run-sso',
          baseUrl: 'https://a.example.com/code-assistant-api',
          codeMieUrl: 'https://a.example.com',
          codeMieProject: 'proj-a',
          model: 'claude-sonnet-4-6',
          name: 'pa'
        }
      });
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://stale.example.com', codeMieProject: 'stale-proj' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      const ws = await ConfigLoader.resolveProfileWorkspace(path.join(TEST_DIR, 'project'), false, {}, 'pa');

      expect(ws.codeMieUrl).toBeUndefined();
      expect(ws.codeMieProject).toBeUndefined();
    });

    it('a global profile\'s own identity always wins over a stale shared workspace value, migrated or not', async () => {
      await writeGlobal('work', {
        work: {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://work.example.com',
          codeMieProject: 'work-proj',
          baseUrl: 'https://work.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'work'
        }
      });
      // Stale leftover from another profile, as the pre-fix bug would have left.
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://stale.example.com', codeMieProject: 'stale-proj' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'work' });

      expect(cfg.codeMieUrl).toBe('https://work.example.com');
      expect(cfg.codeMieProject).toBe('work-proj');
    });

    it('two global profiles targeting different CodeMie environments resolve their own identity independently (AC7)', async () => {
      await writeGlobal('env-a', {
        'env-a': {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://a.example.com',
          codeMieProject: 'proj-a',
          codeMieIntegration: { id: 'int-a', alias: 'alias-a' } as CodeMieIntegrationInfo,
          baseUrl: 'https://a.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'env-a'
        },
        'env-b': {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://b.example.com',
          codeMieProject: 'proj-b',
          codeMieIntegration: { id: 'int-b', alias: 'alias-b' } as CodeMieIntegrationInfo,
          baseUrl: 'https://b.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'env-b'
        }
      });
      // A stale shared workspace value, as a pre-fix saveProfile() would have left
      // behind. The fix must prefer each profile's own identity over this leftover.
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://stale-shared.example.com', codeMieProject: 'stale-shared-proj' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      const cfgA = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'env-a' });
      const cfgB = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'env-b' });

      expect(cfgA.codeMieUrl).toBe('https://a.example.com');
      expect(cfgA.codeMieProject).toBe('proj-a');
      expect((cfgA as any).codeMieIntegration?.id).toBe('int-a');
      expect(cfgB.codeMieUrl).toBe('https://b.example.com');
      expect(cfgB.codeMieProject).toBe('proj-b');
      expect((cfgB as any).codeMieIntegration?.id).toBe('int-b');

      const envA = ConfigLoader.exportProviderEnvVars(cfgA);
      const envB = ConfigLoader.exportProviderEnvVars(cfgB);
      expect(envA.CODEMIE_URL).toBe('https://a.example.com');
      expect(envA.CODEMIE_PROJECT).toBe('proj-a');
      expect(envA.CODEMIE_INTEGRATION_ID).toBe('int-a');
      expect(envB.CODEMIE_URL).toBe('https://b.example.com');
      expect(envB.CODEMIE_PROJECT).toBe('proj-b');
      expect(envB.CODEMIE_INTEGRATION_ID).toBe('int-b');
    });

    it('switching back to the first global profile restores its own identity (AC8)', async () => {
      await writeGlobal('env-a', {
        'env-a': {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://a.example.com',
          codeMieProject: 'proj-a',
          codeMieIntegration: { id: 'int-a', alias: 'alias-a' } as CodeMieIntegrationInfo,
          baseUrl: 'https://a.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'env-a'
        },
        'env-b': {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://b.example.com',
          codeMieProject: 'proj-b',
          codeMieIntegration: { id: 'int-b', alias: 'alias-b' } as CodeMieIntegrationInfo,
          baseUrl: 'https://b.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'env-b'
        }
      });
      // A stale shared workspace value left over from switching profiles pre-fix.
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://b.example.com', codeMieProject: 'proj-b' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      const workingDir = path.join(TEST_DIR, 'project');
      await ConfigLoader.switchProfile('env-a', workingDir);
      await ConfigLoader.switchProfile('env-b', workingDir);
      await ConfigLoader.switchProfile('env-a', workingDir);
      const backToA = await ConfigLoader.load(workingDir);

      expect(backToA.codeMieUrl).toBe('https://a.example.com');
      expect(backToA.codeMieProject).toBe('proj-a');
      expect((backToA as any).codeMieIntegration?.id).toBe('int-a');

      const envBackToA = ConfigLoader.exportProviderEnvVars(backToA);
      expect(envBackToA.CODEMIE_URL).toBe('https://a.example.com');
      expect(envBackToA.CODEMIE_PROJECT).toBe('proj-a');
      expect(envBackToA.CODEMIE_INTEGRATION_ID).toBe('int-a');
    });

    it('loadWithSources reports a global profile\'s own identity with source "global", not "project"', async () => {
      await writeGlobal('preview', {
        preview: {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://preview-own.example.com',
          baseUrl: 'https://preview.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'preview'
        }
      });
      // A stale shared workspace value that must NOT override the profile's own identity.
      const globalRaw = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));
      globalRaw.workspace = { codeMieUrl: 'https://stale-shared.example.com' };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalRaw, null, 2));

      // No local .codemie/ config written — the resolved identity can only have
      // come from the global scope, so --show-sources must label it 'global'.
      const { config: merged, sources } = await ConfigLoader.loadWithSources(
        path.join(TEST_DIR, 'project'),
        { name: 'preview' }
      );

      expect(merged.codeMieUrl).toBe('https://preview-own.example.com');
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
  });
});
