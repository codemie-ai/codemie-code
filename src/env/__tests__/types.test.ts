/**
 * Configuration Types Unit Tests
 *
 * Tests type guards and type validation for configuration
 */

import { describe, it, expect } from 'vitest';
import {
  isMultiProviderConfig,
  isLegacyConfig,
  ProviderProfile,
} from '../types.js';

describe('Configuration Type Guards', () => {
  describe('isMultiProviderConfig', () => {
    it('should identify valid multi-provider config', () => {
      const config = {
        version: 2,
        activeProfile: 'default',
        profiles: {
          default: {
            provider: 'openai',
            model: 'gpt-4',
          },
        },
      };

      const result = isMultiProviderConfig(config);
      expect(result).toBe(true);
    });

    it('should reject config without version field', () => {
      const config = {
        activeProfile: 'default',
        profiles: {},
      };

      expect(isMultiProviderConfig(config)).toBe(false);
    });

    it('should reject config with wrong version', () => {
      const config = {
        version: 1,
        activeProfile: 'default',
        profiles: {},
      };

      expect(isMultiProviderConfig(config)).toBe(false);
    });

    it('should reject config without profiles', () => {
      const config = {
        version: 2,
        activeProfile: 'default',
      };

      const result = isMultiProviderConfig(config);
      expect(result).toBe(false);
    });

    it('should reject config without activeProfile', () => {
      const config = {
        version: 2,
        profiles: {},
      };

      const result = isMultiProviderConfig(config);
      expect(result).toBe(false);
    });

    it('should handle null and undefined', () => {
      const resultNull = isMultiProviderConfig(null);
      const resultUndefined = isMultiProviderConfig(undefined);
      expect(resultNull).toBe(false);
      expect(resultUndefined).toBe(false);
    });

    it('should handle empty object', () => {
      expect(isMultiProviderConfig({})).toBe(false);
    });
  });

  describe('isLegacyConfig', () => {
    it('should identify legacy config with provider', () => {
      const config = {
        provider: 'openai',
        model: 'gpt-3.5-turbo',
      };

      const result = isLegacyConfig(config);
      expect(result).toBe(true);
    });

    it('should identify legacy config with baseUrl', () => {
      const config = {
        baseUrl: 'https://api.openai.com',
      };

      const result = isLegacyConfig(config);
      expect(result).toBe(true);
    });

    it('should identify legacy config with apiKey', () => {
      const config = {
        apiKey: 'sk-test123',
      };

      const result = isLegacyConfig(config);
      expect(result).toBe(true);
    });

    it('should reject config with version field', () => {
      const config = {
        version: 2,
        provider: 'openai',
      };

      expect(isLegacyConfig(config)).toBe(false);
    });

    it('should reject multi-provider config', () => {
      const config = {
        version: 2,
        activeProfile: 'default',
        profiles: {},
      };

      const result = isLegacyConfig(config);
      expect(result).toBe(false);
    });

    it('should handle null and undefined', () => {
      const resultNull = isLegacyConfig(null);
      const resultUndefined = isLegacyConfig(undefined);
      expect(resultNull).toBe(false);
      expect(resultUndefined).toBe(false);
    });

    it('should handle empty object', () => {
      const result = isLegacyConfig({});
      expect(result).toBe(false);
    });
  });

  describe('Type Guard Mutual Exclusivity', () => {
    it('should not identify config as both multi-provider and legacy', () => {
      const legacyConfig = {
        provider: 'openai',
        model: 'gpt-4',
      };

      const multiConfig = {
        version: 2,
        activeProfile: 'default',
        profiles: {},
      };

      // Legacy config should not be multi-provider
      expect(isLegacyConfig(legacyConfig)).toBe(true);
      expect(isMultiProviderConfig(legacyConfig)).toBe(false);

      // Multi-provider config should not be legacy
      expect(isMultiProviderConfig(multiConfig)).toBe(true);
      expect(isLegacyConfig(multiConfig)).toBe(false);
    });
  });

  describe('ProviderProfile Structure', () => {
    it('should accept valid provider profile', () => {
      const profile: ProviderProfile = {
        name: 'work',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test123',
        model: 'gpt-4',
        timeout: 60000,
        debug: false,
      };

      expect(profile).toBeDefined();
      expect(profile.provider).toBe('openai');
      expect(profile.model).toBe('gpt-4');
    });

    it('should accept profile with SSO fields', () => {
      const profile: ProviderProfile = {
        name: 'sso-profile',
        provider: 'ai-run-sso',
        authMethod: 'sso',
        codeMieUrl: 'https://codemie.ai',
        codeMieIntegration: {
          id: 'integration-123',
          alias: 'my-integration',
        },
        ssoConfig: {
          apiUrl: 'https://api.codemie.ai',
          cookiesEncrypted: 'encrypted-cookies',
        },
      };

      expect(profile.authMethod).toBe('sso');
      expect(profile.codeMieIntegration?.id).toBe('integration-123');
    });

    it('should accept profile with allowed directories', () => {
      const profile: ProviderProfile = {
        allowedDirs: ['/home/user/projects', '/var/www'],
        ignorePatterns: ['node_modules', '.git'],
      };

      expect(profile.allowedDirs).toHaveLength(2);
      expect(profile.ignorePatterns).toContain('node_modules');
    });

    it('should accept minimal profile', () => {
      const profile: ProviderProfile = {};

      expect(profile).toBeDefined();
    });
  });
});
