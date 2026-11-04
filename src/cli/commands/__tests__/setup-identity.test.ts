import { describe, it, expect } from 'vitest';
import { globalProfileFromSetup } from '../setup.js';

describe('globalProfileFromSetup (EPMCDME-15411)', () => {
  it('stores a subscription profile that declined CodeMie analytics as off CodeMie', () => {
    const profile = globalProfileFromSetup('anthropic-subscription', { provider: 'anthropic-subscription', model: 'sonnet' });
    expect(profile.codeMieProject).toBeNull();
    expect(globalProfileFromSetup('moonshot-subscription', { provider: 'moonshot-subscription' }).codeMieProject).toBeNull();
  });

  it('keeps the picked project when analytics was enabled', () => {
    const profile = globalProfileFromSetup('anthropic-subscription', {
      provider: 'anthropic-subscription', codeMieUrl: 'https://c.example.com', codeMieProject: 'p',
    });
    expect(profile.codeMieProject).toBe('p');
  });

  it('never marks an SSO or JWT profile off CodeMie', () => {
    expect(globalProfileFromSetup('ai-run-sso', { provider: 'ai-run-sso' }).codeMieProject).toBeUndefined();
    expect(globalProfileFromSetup('bearer-auth', { provider: 'bearer-auth' }).codeMieProject).toBeUndefined();
  });
});
