import { describe, expect, it } from 'vitest';
import { parseClaudeAuthStatus } from '../anthropic-subscription.auth.js';
import { ConfigurationError } from '../../../../utils/errors.js';

describe('parseClaudeAuthStatus', () => {
  it('parses logged-in Claude auth status', () => {
    const status = parseClaudeAuthStatus(JSON.stringify({
      loggedIn: true,
      authMethod: 'oauth',
      apiProvider: 'firstParty'
    }));

    expect(status.loggedIn).toBe(true);
    expect(status.authMethod).toBe('oauth');
    expect(status.apiProvider).toBe('firstParty');
  });

  it('parses logged-out Claude auth status', () => {
    const status = parseClaudeAuthStatus(JSON.stringify({
      loggedIn: false,
      authMethod: 'none',
      apiProvider: 'firstParty'
    }));

    expect(status.loggedIn).toBe(false);
    expect(status.authMethod).toBe('none');
  });

  it('throws ConfigurationError for invalid JSON', () => {
    expect(() => parseClaudeAuthStatus('not-json')).toThrow(ConfigurationError);
    expect(() => parseClaudeAuthStatus('not-json')).toThrow(
      'Failed to parse Claude auth status output'
    );
  });

  it('throws ConfigurationError for empty string', () => {
    expect(() => parseClaudeAuthStatus('')).toThrow(ConfigurationError);
  });
});
