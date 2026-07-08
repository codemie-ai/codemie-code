/**
 * Tests for fetchCodeMieModels — model ID deduplication (EPMCDME-12779)
 * @group unit
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const { mockGetRaw } = vi.hoisted(() => ({ mockGetRaw: vi.fn() }));

vi.mock('../../../core/base/http-client.js', () => ({
  HTTPClient: class {
    getRaw = mockGetRaw;
  },
}));

vi.mock('../../../core/codemie-auth-helpers.js', () => ({
  buildAuthHeaders: vi.fn().mockReturnValue({}),
  fetchCodeMieUserInfo: vi.fn(),
}));

describe('fetchCodeMieModels — deduplication', () => {
  beforeEach(() => {
    mockGetRaw.mockReset();
  });

  it('should deduplicate model IDs when backend returns same deployment_name twice', async () => {
    mockGetRaw.mockResolvedValue({
      statusCode: 200,
      data: JSON.stringify([
        { deployment_name: 'claude-opus-4-6-20260205', label: 'Custom Opus model', enabled: true },
        { deployment_name: 'claude-opus-4-6-20260205', label: 'Custom Sonnet model', enabled: true },
      ]),
    });

    const { fetchCodeMieModels } = await import('../sso.http-client.js');
    const result = await fetchCodeMieModels('https://api.example.com', 'fake-jwt');

    expect(result).toHaveLength(1);
    expect(result).toEqual(['claude-opus-4-6-20260205']);
  });

  it('should return unique model IDs when all are distinct', async () => {
    mockGetRaw.mockResolvedValue({
      statusCode: 200,
      data: JSON.stringify([
        { deployment_name: 'claude-haiku-4-5-20251001', label: 'Haiku', enabled: true },
        { deployment_name: 'claude-sonnet-4-6', label: 'Sonnet', enabled: true },
        { deployment_name: 'claude-opus-4-6-20260205', label: 'Opus', enabled: true },
      ]),
    });

    const { fetchCodeMieModels } = await import('../sso.http-client.js');
    const result = await fetchCodeMieModels('https://api.example.com', 'fake-jwt');

    expect(result).toHaveLength(3);
  });
});
