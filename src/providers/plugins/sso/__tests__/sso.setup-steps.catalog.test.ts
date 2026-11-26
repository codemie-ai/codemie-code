/**
 * SSOSetupSteps.fetchModels / fetchRouterModels share one catalog request per setup run
 * (same credentials object); a failed request is not cached.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchModelsMock = vi.hoisted(() => vi.fn());
vi.mock('../sso.models.js', () => ({
  SSOModelProxy: class {
    fetchModels = fetchModelsMock;
  },
}));

import { SSOSetupSteps } from '../sso.setup-steps.js';
import type { ProviderCredentials } from '../../../core/types.js';

const credentials = (): ProviderCredentials => ({ baseUrl: 'https://codemie.example/api', additionalConfig: {} });

describe('SSOSetupSteps catalog', () => {
  beforeEach(() => {
    fetchModelsMock.mockReset();
  });

  it('fetches the catalog once for models and routers', async () => {
    fetchModelsMock.mockResolvedValue([
      { id: 'claude-x', name: 'claude-x' },
      { id: 'sy-alias', name: 'sy-alias', metadata: { isRouter: true } },
    ]);
    const creds = credentials();

    expect(await SSOSetupSteps.fetchModels(creds)).toEqual(['claude-x', 'sy-alias']);
    expect(await SSOSetupSteps.fetchRouterModels!(creds)).toEqual(['sy-alias']);
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);
  });

  it('fetches again after a failed request', async () => {
    fetchModelsMock.mockRejectedValueOnce(new Error('down')).mockResolvedValue([{ id: 'a', name: 'a' }]);
    const creds = credentials();

    await expect(SSOSetupSteps.fetchModels(creds)).rejects.toThrow('down');
    expect(await SSOSetupSteps.fetchModels(creds)).toEqual(['a']);
    expect(fetchModelsMock).toHaveBeenCalledTimes(2);
  });
});
