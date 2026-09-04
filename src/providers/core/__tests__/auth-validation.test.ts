import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthValidationResult, ProviderSetupSteps } from '../types.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';

vi.mock('../../../utils/interactive.js', () => ({
  isNonInteractiveEnvironment: vi.fn()
}));

const testConfig = {} as CodeMieConfigOptions;

describe('handleAuthValidationFailure', () => {
  let promptForReauthSpy: ReturnType<typeof vi.fn>;
  let isNonInteractiveEnvironmentMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    promptForReauthSpy = vi.fn().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call promptForReauth when a TTY is present and promptForReauth exists', async () => {
    const { isNonInteractiveEnvironment } = await import('../../../utils/interactive.js');
    isNonInteractiveEnvironmentMock = isNonInteractiveEnvironment as ReturnType<typeof vi.fn>;
    isNonInteractiveEnvironmentMock.mockReturnValue(false);

    const { handleAuthValidationFailure } = await import('../auth-validation.js');
    const setupSteps = { promptForReauth: promptForReauthSpy } as unknown as ProviderSetupSteps;
    const validationResult: AuthValidationResult = { valid: false, error: 'expired' };

    const result = await handleAuthValidationFailure(validationResult, setupSteps, testConfig);

    expect(promptForReauthSpy).toHaveBeenCalledWith(testConfig);
    expect(result).toBe(true);
  });

  it('should NOT call promptForReauth when non-interactive, and should return false', async () => {
    const { isNonInteractiveEnvironment } = await import('../../../utils/interactive.js');
    isNonInteractiveEnvironmentMock = isNonInteractiveEnvironment as ReturnType<typeof vi.fn>;
    isNonInteractiveEnvironmentMock.mockReturnValue(true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { handleAuthValidationFailure } = await import('../auth-validation.js');
    const setupSteps = { promptForReauth: promptForReauthSpy } as unknown as ProviderSetupSteps;
    const validationResult: AuthValidationResult = {
      valid: false,
      error: 'No valid SSO credentials found.'
    };

    const result = await handleAuthValidationFailure(validationResult, setupSteps, testConfig);

    expect(promptForReauthSpy).not.toHaveBeenCalled();
    expect(result).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('No valid SSO credentials found.')
    );
  });

  it('should print the clean failure message when non-interactive (no readline/inquirer path taken)', async () => {
    const { isNonInteractiveEnvironment } = await import('../../../utils/interactive.js');
    isNonInteractiveEnvironmentMock = isNonInteractiveEnvironment as ReturnType<typeof vi.fn>;
    isNonInteractiveEnvironmentMock.mockReturnValue(true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { handleAuthValidationFailure } = await import('../auth-validation.js');
    const setupSteps = { promptForReauth: promptForReauthSpy } as unknown as ProviderSetupSteps;
    const validationResult: AuthValidationResult = { valid: false, error: 'session expired' };

    await handleAuthValidationFailure(validationResult, setupSteps, testConfig);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('should keep existing behavior when setupSteps has no promptForReauth (JWT-style), regardless of TTY', async () => {
    const { isNonInteractiveEnvironment } = await import('../../../utils/interactive.js');
    isNonInteractiveEnvironmentMock = isNonInteractiveEnvironment as ReturnType<typeof vi.fn>;
    isNonInteractiveEnvironmentMock.mockReturnValue(false);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { handleAuthValidationFailure } = await import('../auth-validation.js');
    const setupSteps = {} as ProviderSetupSteps;
    const validationResult: AuthValidationResult = { valid: false, error: 'JWT token missing' };

    const result = await handleAuthValidationFailure(validationResult, setupSteps, testConfig);

    expect(result).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('JWT token missing'));
  });

  it('should return false when setupSteps is null, regardless of TTY', async () => {
    const { isNonInteractiveEnvironment } = await import('../../../utils/interactive.js');
    isNonInteractiveEnvironmentMock = isNonInteractiveEnvironment as ReturnType<typeof vi.fn>;
    isNonInteractiveEnvironmentMock.mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { handleAuthValidationFailure } = await import('../auth-validation.js');
    const validationResult: AuthValidationResult = { valid: false, error: 'no provider configured' };

    const result = await handleAuthValidationFailure(validationResult, null, testConfig);

    expect(result).toBe(false);
  });

  it('should write the failure diagnostic to stderr so piped stdout stays clean', async () => {
    const { isNonInteractiveEnvironment } = await import('../../../utils/interactive.js');
    isNonInteractiveEnvironmentMock = isNonInteractiveEnvironment as ReturnType<typeof vi.fn>;
    isNonInteractiveEnvironmentMock.mockReturnValue(true);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { handleAuthValidationFailure } = await import('../auth-validation.js');
    const setupSteps = { promptForReauth: promptForReauthSpy } as unknown as ProviderSetupSteps;
    const validationResult: AuthValidationResult = { valid: false, error: 'session expired' };

    await handleAuthValidationFailure(validationResult, setupSteps, testConfig);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('session expired'));
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
