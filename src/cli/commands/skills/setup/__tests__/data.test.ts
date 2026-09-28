/**
 * Unit tests for skills data fetcher
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotFoundError, type CodeMieClient, type SkillListItem } from 'codemie-sdk';
import type { CodemieSkill } from '@/env/types.js';
import { RegistrationItemNotFoundError } from '@/utils/errors.js';
import { createSkillDataFetcher } from '../data.js';

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }
}));

describe('Skill Data Fetcher', () => {
  let mockClient: CodeMieClient;
  let registeredSkills: CodemieSkill[];

  beforeEach(() => {
    mockClient = {
      skills: {
        listPaginated: vi.fn(),
        get: vi.fn(),
      }
    } as any;

    registeredSkills = [
      {
        id: 'reg-1',
        name: 'Registered Skill 1',
        slug: 'registered-1',
        description: 'First registered skill',
        registeredAt: '2026-01-01T00:00:00Z'
      }
    ];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchSkills - registered scope', () => {
    it('returns registered skills without an API call', async () => {
      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });

      const result = await fetcher.fetchSkills({ scope: 'registered' });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockClient.skills.listPaginated).not.toHaveBeenCalled();
    });
  });

  describe('fetchSkills - project/marketplace scope', () => {
    it('fetches project skills from the API', async () => {
      const mockResponse = {
        skills: [{ id: 'proj-1', name: 'Project Skill 1' } as SkillListItem],
        page: 0,
        total: 1,
        pages: 1
      };
      vi.mocked(mockClient.skills.listPaginated).mockResolvedValue(mockResponse as any);

      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });
      const result = await fetcher.fetchSkills({ scope: 'project' });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.pages).toBe(1);
    });

    it('surfaces a clear re-auth error when a stale SSO session redirects to the Keycloak login page instead of JSON', async () => {
      const keycloakLoginHtml = '<!DOCTYPE html><html><head><title>Sign in</title></head><body>keycloak</body></html>';
      vi.mocked(mockClient.skills.listPaginated).mockResolvedValue(keycloakLoginHtml as any);

      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });

      await expect(
        fetcher.fetchSkills({ scope: 'project' })
      ).rejects.toThrow(/session has expired.*codemie profile login/i);
    });

    it('surfaces a clear error when the API response is missing skills/total/pages', async () => {
      vi.mocked(mockClient.skills.listPaginated).mockResolvedValue({} as any);

      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });

      await expect(
        fetcher.fetchSkills({ scope: 'marketplace' })
      ).rejects.toThrow(/unexpected response fetching marketplace skills/i);
    });
  });

  describe('fetchSkillsByIds', () => {
    it('returns an empty array without an API call when no IDs are requested', async () => {
      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });

      const result = await fetcher.fetchSkillsByIds([], []);

      expect(result).toHaveLength(0);
      expect(mockClient.skills.get).not.toHaveBeenCalled();
      expect(mockClient.skills.listPaginated).not.toHaveBeenCalled();
    });

    it('fetches each requested id directly instead of crawling the catalog', async () => {
      vi.mocked(mockClient.skills.get).mockImplementation(
        async (id: string) => ({ id, name: `Skill ${id}`, content: '# c' }) as any
      );

      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });
      const result = await fetcher.fetchSkillsByIds(['skill-2', 'skill-7'], []);

      expect(result.map(s => s.id)).toEqual(['skill-2', 'skill-7']);
      expect(mockClient.skills.get).toHaveBeenCalledTimes(2);
      expect(mockClient.skills.listPaginated).not.toHaveBeenCalled();
    });

    it('throws RegistrationItemNotFoundError for a requested id the API does not know', async () => {
      // Arrange: silently filtering an unavailable id out is reported as success,
      // which is exactly the partial-success behaviour the contract forbids.
      vi.mocked(mockClient.skills.get).mockImplementation(async (id: string) => {
        if (id === 'skill-missing') throw new NotFoundError('Resource', 'unknown');
        return { id, name: `Skill ${id}` } as any;
      });

      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });

      await expect(
        fetcher.fetchSkillsByIds(['skill-1', 'skill-missing'], [])
      ).rejects.toThrow(RegistrationItemNotFoundError);
      await expect(
        fetcher.fetchSkillsByIds(['skill-missing'], [])
      ).rejects.toThrow(/skill-missing/);
    });

    it('propagates non-404 API errors unchanged', async () => {
      const serverError = new Error('500 Internal Server Error');
      vi.mocked(mockClient.skills.get).mockRejectedValue(serverError);

      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });

      await expect(fetcher.fetchSkillsByIds(['skill-1'], [])).rejects.toBe(serverError);
    });

    it('surfaces a clear re-auth error on a stale session when fetching by IDs', async () => {
      const keycloakLoginHtml = '<!DOCTYPE html><html>keycloak</html>';
      vi.mocked(mockClient.skills.get).mockResolvedValue(keycloakLoginHtml as any);

      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });

      await expect(
        fetcher.fetchSkillsByIds(['skill-1'], [])
      ).rejects.toThrow(/session has expired.*codemie profile login/i);
    });
  });

  describe('fetchAllVisibleSkills', () => {
    it('pages through listPaginated until pages are exhausted and concatenates results', async () => {
      const page0Response = {
        skills: [{ id: 'skill-1', name: 'Skill 1' } as SkillListItem],
        page: 0,
        total: 2,
        pages: 2
      };
      const page1Response = {
        skills: [{ id: 'skill-2', name: 'Skill 2' } as SkillListItem],
        page: 1,
        total: 2,
        pages: 2
      };
      const emptyMarketplaceResponse = { skills: [], page: 0, total: 0, pages: 1 };
      vi.mocked(mockClient.skills.listPaginated)
        .mockResolvedValueOnce(page0Response as any)
        .mockResolvedValueOnce(page1Response as any)
        .mockResolvedValueOnce(emptyMarketplaceResponse as any);

      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });
      const result = await fetcher.fetchAllVisibleSkills();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('skill-1');
      expect(result[1].id).toBe('skill-2');
      expect(mockClient.skills.listPaginated).toHaveBeenNthCalledWith(1,
        expect.objectContaining({ page: 0 })
      );
      expect(mockClient.skills.listPaginated).toHaveBeenNthCalledWith(2,
        expect.objectContaining({ page: 1 })
      );
    });

    it('pages the same project and marketplace scopes the wizard shows, merged by id', async () => {
      // Arrange: an unfiltered listing is not provably the wizard's set, so the
      // headless crawl has to ask for exactly the two panels the wizard fetches.
      const projectResponse = {
        skills: [{ id: 'skill-1', name: 'Skill 1' } as SkillListItem],
        page: 0,
        total: 1,
        pages: 1
      };
      const marketplaceResponse = {
        skills: [
          { id: 'skill-1', name: 'Skill 1' } as SkillListItem,
          { id: 'market-1', name: 'Marketplace Skill' } as SkillListItem,
        ],
        page: 0,
        total: 2,
        pages: 1
      };
      vi.mocked(mockClient.skills.listPaginated)
        .mockResolvedValueOnce(projectResponse as any)
        .mockResolvedValueOnce(marketplaceResponse as any);

      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });
      const result = await fetcher.fetchAllVisibleSkills();

      expect(result.map(skill => skill.id)).toEqual(['skill-1', 'market-1']);
      expect(mockClient.skills.listPaginated).toHaveBeenNthCalledWith(1,
        expect.objectContaining({
          per_page: 100,
          filters: expect.objectContaining({ scope: 'project', visibility: null }),
        })
      );
      expect(mockClient.skills.listPaginated).toHaveBeenNthCalledWith(2,
        expect.objectContaining({
          filters: expect.objectContaining({ scope: 'marketplace', visibility: 'public' }),
        })
      );
    });

    it('stops after a single page per scope when pages is 1', async () => {
      const singlePageResponse = {
        skills: [{ id: 'skill-1', name: 'Skill 1' } as SkillListItem],
        page: 0,
        total: 1,
        pages: 1
      };
      vi.mocked(mockClient.skills.listPaginated).mockResolvedValue(singlePageResponse as any);

      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });
      const result = await fetcher.fetchAllVisibleSkills();

      expect(result).toHaveLength(1);
      expect(mockClient.skills.listPaginated).toHaveBeenCalledTimes(2);
    });

    it('surfaces a clear re-auth error when a stale SSO session redirects to Keycloak HTML', async () => {
      const keycloakLoginHtml = '<!DOCTYPE html><html>keycloak</html>';
      vi.mocked(mockClient.skills.listPaginated).mockResolvedValue(keycloakLoginHtml as any);

      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });

      await expect(
        fetcher.fetchAllVisibleSkills()
      ).rejects.toThrow(/session has expired.*codemie profile login/i);
    });
  });
});
