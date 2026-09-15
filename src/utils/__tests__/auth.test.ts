/**
 * Unit tests for auth utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigurationError } from '../errors.js';

// Mock dependencies
vi.mock('../sdk-client.js', () => ({
  getCodemieClient: vi.fn()
}));

vi.mock('../../providers/core/registry.js', () => ({
  ProviderRegistry: {
    getSetupSteps: vi.fn()
  }
}));

vi.mock('../../providers/core/auth-validation.js', () => ({
  handleAuthValidationFailure: vi.fn()
}));

describe('Auth Utilities', () => {
  let getCodemieClient: any;
  let ProviderRegistry: any;
  let handleAuthValidationFailure: any;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Import mocked modules
    const sdkClient = await import('../sdk-client.js');
    const registry = await import('../../providers/core/registry.js');
    const authValidation = await import('../../providers/core/auth-validation.js');

    getCodemieClient = sdkClient.getCodemieClient;
    ProviderRegistry = registry.ProviderRegistry;
    handleAuthValidationFailure = authValidation.handleAuthValidationFailure;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getAuthenticatedClient', () => {
    const mockConfig = {
      provider: 'sso',
      baseUrl: 'https://test.com'
    } as any;

    it('should return client when authentication succeeds', async () => {
      const mockClient = { assistants: { list: vi.fn() } } as any;
      getCodemieClient.mockResolvedValue(mockClient);

      const { getAuthenticatedClient } = await import('../auth.js');
      const result = await getAuthenticatedClient(mockConfig);

      expect(result).toBe(mockClient);
      expect(getCodemieClient).toHaveBeenCalledTimes(1);
    });

    it('should retry after successful re-authentication', async () => {
      const mockClient = { assistants: { list: vi.fn() } } as any;
      const authError = new ConfigurationError('SSO authentication required. Please run "codemie setup" with SSO provider first.');

      getCodemieClient
        .mockRejectedValueOnce(authError)
        .mockResolvedValueOnce(mockClient);

      const mockSetupSteps = {
        validateAuth: vi.fn().mockResolvedValue({ valid: false, error: 'Token expired' })
      };

      ProviderRegistry.getSetupSteps.mockReturnValue(mockSetupSteps);
      handleAuthValidationFailure.mockResolvedValue(true);

      const { getAuthenticatedClient } = await import('../auth.js');
      const result = await getAuthenticatedClient(mockConfig);

      expect(result).toBe(mockClient);
      expect(getCodemieClient).toHaveBeenCalledTimes(2);
      expect(handleAuthValidationFailure).toHaveBeenCalledWith(
        { valid: false, error: 'Token expired' },
        mockSetupSteps,
        mockConfig
      );
    });

    it('should throw error if re-authentication fails', async () => {
      const authError = new ConfigurationError('SSO authentication required. Please run "codemie setup" with SSO provider first.');

      getCodemieClient.mockRejectedValue(authError);

      const mockSetupSteps = {
        validateAuth: vi.fn().mockResolvedValue({ valid: false, error: 'Token expired' })
      };

      ProviderRegistry.getSetupSteps.mockReturnValue(mockSetupSteps);
      handleAuthValidationFailure.mockResolvedValue(false);

      const { getAuthenticatedClient } = await import('../auth.js');

      await expect(getAuthenticatedClient(mockConfig)).rejects.toThrow(ConfigurationError);
      expect(getCodemieClient).toHaveBeenCalledTimes(1);
    });

    it('should throw non-auth errors immediately', async () => {
      const networkError = new Error('Network timeout');
      getCodemieClient.mockRejectedValue(networkError);

      const { getAuthenticatedClient } = await import('../auth.js');

      await expect(getAuthenticatedClient(mockConfig)).rejects.toThrow('Network timeout');
      expect(getCodemieClient).toHaveBeenCalledTimes(1);
      expect(ProviderRegistry.getSetupSteps).not.toHaveBeenCalled();
    });
  });

  describe('promptReauthentication', () => {
    const mockConfig = {
      provider: 'sso',
      baseUrl: 'https://test.com'
    } as any;

    it('should return true when re-authentication succeeds', async () => {
      const mockSetupSteps = {
        validateAuth: vi.fn().mockResolvedValue({ valid: false, error: 'Token expired' })
      };

      ProviderRegistry.getSetupSteps.mockReturnValue(mockSetupSteps);
      handleAuthValidationFailure.mockResolvedValue(true);

      const { promptReauthentication } = await import('../auth.js');
      const result = await promptReauthentication(mockConfig);

      expect(result).toBe(true);
      expect(mockSetupSteps.validateAuth).toHaveBeenCalledWith(mockConfig);
      expect(handleAuthValidationFailure).toHaveBeenCalled();
    });

    it('should throw error when re-authentication fails', async () => {
      const mockSetupSteps = {
        validateAuth: vi.fn().mockResolvedValue({ valid: false, error: 'Token expired' })
      };

      ProviderRegistry.getSetupSteps.mockReturnValue(mockSetupSteps);
      handleAuthValidationFailure.mockResolvedValue(false);

      const { promptReauthentication } = await import('../auth.js');

      await expect(promptReauthentication(mockConfig)).rejects.toThrow(
        'Authentication expired. Please re-authenticate.'
      );
    });

    it('should throw error when setup steps not available', async () => {
      ProviderRegistry.getSetupSteps.mockReturnValue(null);

      const { promptReauthentication } = await import('../auth.js');

      await expect(promptReauthentication(mockConfig)).rejects.toThrow(ConfigurationError);
      expect(handleAuthValidationFailure).not.toHaveBeenCalled();
    });

    it('should throw error when validateAuth not available', async () => {
      const mockSetupSteps = {}; // No validateAuth method

      ProviderRegistry.getSetupSteps.mockReturnValue(mockSetupSteps);

      const { promptReauthentication } = await import('../auth.js');

      await expect(promptReauthentication(mockConfig)).rejects.toThrow(ConfigurationError);
      expect(handleAuthValidationFailure).not.toHaveBeenCalled();
    });
  });
});
