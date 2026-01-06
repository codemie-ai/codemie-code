/**
 * Integration Tests: SSO Per-URL Credential Management
 *
 * Tests the complete flow of storing, retrieving, and validating
 * SSO credentials per base URL without hitting actual APIs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { setupTestIsolation } from '../helpers/test-isolation.js';

// Mock SSO HTTP client to avoid real API calls
vi.mock('../../src/providers/plugins/sso/sso.http-client.js', () => ({
  fetchCodeMieModels: vi.fn().mockResolvedValue(['test-model-1', 'test-model-2']),
  fetchCodeMieUserInfo: vi.fn().mockResolvedValue({
    userId: 'test-user',
    applications: ['test-app']
  }),
  CODEMIE_ENDPOINTS: {
    MODELS: '/v1/llm_models?include_all=true',
    USER_SETTINGS: '/v1/settings/user',
    USER: '/v1/user',
    ADMIN_APPLICATIONS: '/v1/admin/applications',
    METRICS: '/v1/metrics',
    AUTH_LOGIN: '/v1/auth/login'
  }
}));

import { CredentialStore } from '../../src/utils/security.js';
import { CodeMieSSO } from '../../src/providers/plugins/sso/sso.auth.js';
import { SSOSetupSteps } from '../../src/providers/plugins/sso/sso.setup-steps.js';
import { CODEMIE_ENDPOINTS } from '../../src/providers/plugins/sso/sso.http-client.js';
import type { SSOCredentials } from '../../src/providers/core/types.js';
import type { CodeMieConfigOptions } from '../../src/env/types.js';

// Test fixtures
const TEST_BASE_URL_1 = 'https://codemie-test1.example.com';
const TEST_BASE_URL_2 = 'https://codemie-test2.example.com';
const TEST_API_URL_1 = `${TEST_BASE_URL_1}/code-assistant-api`;
const TEST_API_URL_2 = `${TEST_BASE_URL_2}/code-assistant-api`;

const VALID_CREDENTIALS_1: SSOCredentials = {
  cookies: { session: 'test-session-1' },
  apiUrl: TEST_API_URL_1,
  expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24 hours from now
};

const VALID_CREDENTIALS_2: SSOCredentials = {
  cookies: { session: 'test-session-2' },
  apiUrl: TEST_API_URL_2,
  expiresAt: Date.now() + 24 * 60 * 60 * 1000
};

const EXPIRED_CREDENTIALS: SSOCredentials = {
  cookies: { session: 'expired-session' },
  apiUrl: TEST_API_URL_1,
  expiresAt: Date.now() - 60 * 60 * 1000 // 1 hour ago
};

const GLOBAL_CREDENTIALS: SSOCredentials = {
  cookies: { session: 'global-session' },
  apiUrl: TEST_API_URL_1,
  expiresAt: Date.now() + 12 * 60 * 60 * 1000 // 12 hours from now
};

describe('SSO Per-URL Credential Management', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

  describe('API Endpoints', () => {
    it('should include include_all=true parameter in MODELS endpoint', () => {
      expect(CODEMIE_ENDPOINTS.MODELS).toBe('/v1/llm_models?include_all=true');
    });

    it('should have correct endpoint paths for all API endpoints', () => {
      expect(CODEMIE_ENDPOINTS.USER_SETTINGS).toBe('/v1/settings/user');
      expect(CODEMIE_ENDPOINTS.USER).toBe('/v1/user');
      expect(CODEMIE_ENDPOINTS.ADMIN_APPLICATIONS).toBe('/v1/admin/applications');
      expect(CODEMIE_ENDPOINTS.METRICS).toBe('/v1/metrics');
      expect(CODEMIE_ENDPOINTS.AUTH_LOGIN).toBe('/v1/auth/login');
    });
  });

  beforeEach(async () => {
    // Ensure credentials directory exists
    const credentialsDir = join(homedir(), '.codemie', 'credentials');
    await mkdir(credentialsDir, { recursive: true });

    // Clean up any test credentials from previous test run
    const store = CredentialStore.getInstance();
    await store.clearSSOCredentials(); // Clear global
    await store.clearSSOCredentials(TEST_BASE_URL_1);
    await store.clearSSOCredentials(TEST_BASE_URL_2);
  });

  afterEach(async () => {
    // Clean up test credentials
    const store = CredentialStore.getInstance();
    try {
      await store.clearSSOCredentials(); // Clear global
      await store.clearSSOCredentials(TEST_BASE_URL_1);
      await store.clearSSOCredentials(TEST_BASE_URL_2);
    } catch {
      // Ignore cleanup errors
    }

    // Clear all mocks
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('CredentialStore - Per-URL Storage', () => {
    it('should store and retrieve credentials for specific URL', async () => {
      const store = CredentialStore.getInstance();

      // Store credentials for URL 1
      await store.storeSSOCredentials(VALID_CREDENTIALS_1, TEST_BASE_URL_1);

      // Retrieve credentials for URL 1
      const retrieved = await store.retrieveSSOCredentials(TEST_BASE_URL_1);

      expect(retrieved).toMatchObject({
        apiUrl: TEST_API_URL_1,
        cookies: { session: 'test-session-1' }
      });
      expect(retrieved?.expiresAt).toBeGreaterThan(Date.now());
    });

    it('should store credentials for multiple URLs independently', async () => {
      const store = CredentialStore.getInstance();

      // Store credentials for two different URLs
      await store.storeSSOCredentials(VALID_CREDENTIALS_1, TEST_BASE_URL_1);
      await store.storeSSOCredentials(VALID_CREDENTIALS_2, TEST_BASE_URL_2);

      // Retrieve and verify each one independently
      const creds1 = await store.retrieveSSOCredentials(TEST_BASE_URL_1);
      const creds2 = await store.retrieveSSOCredentials(TEST_BASE_URL_2);

      expect(creds1?.cookies.session).toBe('test-session-1');
      expect(creds2?.cookies.session).toBe('test-session-2');
      expect(creds1?.apiUrl).toBe(TEST_API_URL_1);
      expect(creds2?.apiUrl).toBe(TEST_API_URL_2);
    });

    it('should fallback to global credentials when URL-specific not found', async () => {
      const store = CredentialStore.getInstance();
      const sso = new CodeMieSSO();

      // Store only global credentials
      await store.storeSSOCredentials(GLOBAL_CREDENTIALS);

      // Try to retrieve for specific URL (should fallback to global via SSO)
      const retrieved = await sso.getStoredCredentials(TEST_BASE_URL_1);

      expect(retrieved).toMatchObject({
        apiUrl: TEST_API_URL_1,
        cookies: { session: 'global-session' }
      });
    });

    it('should not fallback if URLs do not match', async () => {
      const store = CredentialStore.getInstance();

      // Store global credentials for URL 1
      await store.storeSSOCredentials(VALID_CREDENTIALS_1);

      // Try to retrieve for URL 2 (should not fallback - URL mismatch)
      const retrieved = await store.retrieveSSOCredentials(TEST_BASE_URL_2);

      expect(retrieved).toBeNull();
    });

    it('should clear credentials for specific URL', async () => {
      const store = CredentialStore.getInstance();

      // Store credentials for two URLs
      await store.storeSSOCredentials(VALID_CREDENTIALS_1, TEST_BASE_URL_1);
      await store.storeSSOCredentials(VALID_CREDENTIALS_2, TEST_BASE_URL_2);

      // Clear credentials for URL 1
      await store.clearSSOCredentials(TEST_BASE_URL_1);

      // URL 1 should be cleared
      const creds1 = await store.retrieveSSOCredentials(TEST_BASE_URL_1);
      expect(creds1).toBeNull();

      // URL 2 should still exist
      const creds2 = await store.retrieveSSOCredentials(TEST_BASE_URL_2);
      expect(creds2).not.toBeNull();
    });
  });

  describe('CodeMieSSO - URL Normalization', () => {
    it('should normalize API URL to base URL when retrieving credentials', async () => {
      const store = CredentialStore.getInstance();
      const sso = new CodeMieSSO();

      // Store credentials with base URL
      await store.storeSSOCredentials(VALID_CREDENTIALS_1, TEST_BASE_URL_1);

      // Retrieve using full API URL (should normalize to base)
      const retrieved = await sso.getStoredCredentials(TEST_API_URL_1);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.apiUrl).toBe(TEST_API_URL_1);
    });

    it('should handle URLs with trailing slashes', async () => {
      const store = CredentialStore.getInstance();
      const sso = new CodeMieSSO();

      // Store with base URL
      await store.storeSSOCredentials(VALID_CREDENTIALS_1, TEST_BASE_URL_1);

      // Retrieve with trailing slash
      const retrieved = await sso.getStoredCredentials(`${TEST_BASE_URL_1}/`);

      expect(retrieved).not.toBeNull();
    });

    it('should handle URLs with different paths', async () => {
      const store = CredentialStore.getInstance();
      const sso = new CodeMieSSO();

      // Store with base URL
      await store.storeSSOCredentials(VALID_CREDENTIALS_1, TEST_BASE_URL_1);

      // Retrieve with different path
      const retrieved = await sso.getStoredCredentials(`${TEST_BASE_URL_1}/some/path`);

      expect(retrieved).not.toBeNull();
    });
  });

  describe('SSOSetupSteps - Validation', () => {

    it('should validate credentials successfully when stored', async () => {
      const store = CredentialStore.getInstance();
      await store.storeSSOCredentials(VALID_CREDENTIALS_1, TEST_BASE_URL_1);

      const config: CodeMieConfigOptions = {
        provider: 'ai-run-sso',
        codeMieUrl: TEST_BASE_URL_1,
        baseUrl: TEST_API_URL_1,
        apiKey: 'sso-provided',
        model: 'test-model'
      };

      const result = await SSOSetupSteps.validateAuth!(config);

      expect(result.valid).toBe(true);
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it('should fail validation when credentials not found', async () => {
      const config: CodeMieConfigOptions = {
        provider: 'ai-run-sso',
        codeMieUrl: TEST_BASE_URL_1,
        baseUrl: TEST_API_URL_1,
        apiKey: 'sso-provided',
        model: 'test-model'
      };

      const result = await SSOSetupSteps.validateAuth!(config);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('No SSO credentials found');
    });

    it('should fail validation when credentials are expired', async () => {
      const store = CredentialStore.getInstance();
      await store.storeSSOCredentials(EXPIRED_CREDENTIALS, TEST_BASE_URL_1);

      const config: CodeMieConfigOptions = {
        provider: 'ai-run-sso',
        codeMieUrl: TEST_BASE_URL_1,
        baseUrl: TEST_API_URL_1,
        apiKey: 'sso-provided',
        model: 'test-model'
      };

      const result = await SSOSetupSteps.validateAuth!(config);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('No SSO credentials found');
    });

    it('should return correct auth status for valid credentials', async () => {
      const store = CredentialStore.getInstance();
      await store.storeSSOCredentials(VALID_CREDENTIALS_1, TEST_BASE_URL_1);

      const config: CodeMieConfigOptions = {
        provider: 'ai-run-sso',
        codeMieUrl: TEST_BASE_URL_1,
        baseUrl: TEST_API_URL_1,
        apiKey: 'sso-provided',
        model: 'test-model'
      };

      const status = await SSOSetupSteps.getAuthStatus!(config);

      expect(status.authenticated).toBe(true);
      expect(status.expiresAt).toBeGreaterThan(Date.now());
      expect(status.apiUrl).toBe(TEST_API_URL_1);
    });

    it('should return unauthenticated status when no credentials', async () => {
      const config: CodeMieConfigOptions = {
        provider: 'ai-run-sso',
        codeMieUrl: TEST_BASE_URL_1,
        baseUrl: TEST_API_URL_1,
        apiKey: 'sso-provided',
        model: 'test-model'
      };

      const status = await SSOSetupSteps.getAuthStatus!(config);

      expect(status.authenticated).toBe(false);
      expect(status.expiresAt).toBeUndefined();
      expect(status.apiUrl).toBeUndefined();
    });
  });

  describe('Multi-URL Profile Scenarios', () => {
    it('should handle multiple profiles with different URLs', async () => {
      const store = CredentialStore.getInstance();

      // Setup: Store credentials for two different instances
      await store.storeSSOCredentials(VALID_CREDENTIALS_1, TEST_BASE_URL_1);
      await store.storeSSOCredentials(VALID_CREDENTIALS_2, TEST_BASE_URL_2);

      const config1: CodeMieConfigOptions = {
        provider: 'ai-run-sso',
        codeMieUrl: TEST_BASE_URL_1,
        baseUrl: TEST_API_URL_1,
        apiKey: 'sso-provided',
        model: 'test-model'
      };

      const config2: CodeMieConfigOptions = {
        provider: 'ai-run-sso',
        codeMieUrl: TEST_BASE_URL_2,
        baseUrl: TEST_API_URL_2,
        apiKey: 'sso-provided',
        model: 'test-model'
      };

      // Both profiles should have valid auth status
      const status1 = await SSOSetupSteps.getAuthStatus!(config1);
      const status2 = await SSOSetupSteps.getAuthStatus!(config2);

      expect(status1.authenticated).toBe(true);
      expect(status1.apiUrl).toBe(TEST_API_URL_1);

      expect(status2.authenticated).toBe(true);
      expect(status2.apiUrl).toBe(TEST_API_URL_2);
    });

    it('should not mix credentials between different URLs', async () => {
      const store = CredentialStore.getInstance();

      // Store credentials for URL 1 only
      await store.storeSSOCredentials(VALID_CREDENTIALS_1, TEST_BASE_URL_1);

      const config2: CodeMieConfigOptions = {
        provider: 'ai-run-sso',
        codeMieUrl: TEST_BASE_URL_2,
        baseUrl: TEST_API_URL_2,
        apiKey: 'sso-provided',
        model: 'test-model'
      };

      // URL 2 should not have credentials
      const status2 = await SSOSetupSteps.getAuthStatus!(config2);
      expect(status2.authenticated).toBe(false);
    });
  });

  describe('Credential Expiration Handling', () => {
    it('should automatically clear expired credentials on retrieval', async () => {
      const store = CredentialStore.getInstance();
      const sso = new CodeMieSSO();

      // Store expired credentials
      await store.storeSSOCredentials(EXPIRED_CREDENTIALS, TEST_BASE_URL_1);

      // Retrieve should return null and clear the expired credentials
      const retrieved = await sso.getStoredCredentials(TEST_BASE_URL_1);
      expect(retrieved).toBeNull();

      // Verify credentials were actually cleared
      const retrievedAgain = await store.retrieveSSOCredentials(TEST_BASE_URL_1);
      expect(retrievedAgain).toBeNull();
    });

    it('should calculate remaining time correctly', async () => {
      const store = CredentialStore.getInstance();

      // Create credentials expiring in 1 hour
      const oneHourFromNow = Date.now() + 60 * 60 * 1000;
      const credentials: SSOCredentials = {
        cookies: { session: 'test' },
        apiUrl: TEST_API_URL_1,
        expiresAt: oneHourFromNow
      };

      await store.storeSSOCredentials(credentials, TEST_BASE_URL_1);

      const config: CodeMieConfigOptions = {
        provider: 'ai-run-sso',
        codeMieUrl: TEST_BASE_URL_1,
        baseUrl: TEST_API_URL_1,
        apiKey: 'sso-provided',
        model: 'test-model'
      };

      const status = await SSOSetupSteps.getAuthStatus!(config);

      expect(status.authenticated).toBe(true);
      expect(status.expiresAt).toBe(oneHourFromNow);

      // Verify it's approximately 1 hour (allow 1 second margin for test execution)
      const remainingMs = status.expiresAt! - Date.now();
      expect(remainingMs).toBeGreaterThan(59 * 60 * 1000); // At least 59 minutes
      expect(remainingMs).toBeLessThan(61 * 60 * 1000); // At most 61 minutes
    });
  });

  describe('Backward Compatibility - Global Credentials', () => {
    it('should still support global credentials when no URL specified', async () => {
      const store = CredentialStore.getInstance();

      // Store global credentials (no URL)
      await store.storeSSOCredentials(GLOBAL_CREDENTIALS);

      // Retrieve without URL
      const retrieved = await store.retrieveSSOCredentials();

      expect(retrieved).toMatchObject({
        apiUrl: TEST_API_URL_1,
        cookies: { session: 'global-session' }
      });
    });

    it('should prefer URL-specific over global when both exist', async () => {
      const store = CredentialStore.getInstance();
      const sso = new CodeMieSSO();

      // Store both global and URL-specific credentials
      await store.storeSSOCredentials(GLOBAL_CREDENTIALS);
      await store.storeSSOCredentials(VALID_CREDENTIALS_1, TEST_BASE_URL_1);

      // Should get URL-specific credentials
      const retrieved = await sso.getStoredCredentials(TEST_BASE_URL_1);

      expect(retrieved?.cookies.session).toBe('test-session-1');
    });

    it('should fallback to global if URL-specific not found and URLs match', async () => {
      const store = CredentialStore.getInstance();
      const sso = new CodeMieSSO();

      // Store only global credentials for URL 1
      await store.storeSSOCredentials(VALID_CREDENTIALS_1);

      // Retrieve for URL 1 (should fallback to global)
      const retrieved = await sso.getStoredCredentials(TEST_BASE_URL_1, true);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.cookies.session).toBe('test-session-1');
    });

    it('should not fallback to global if allowFallback is false', async () => {
      const store = CredentialStore.getInstance();
      const sso = new CodeMieSSO();

      // Store only global credentials
      await store.storeSSOCredentials(VALID_CREDENTIALS_1);

      // Retrieve with allowFallback=false
      const retrieved = await sso.getStoredCredentials(TEST_BASE_URL_1, false);

      expect(retrieved).toBeNull();
    });
  });
});
