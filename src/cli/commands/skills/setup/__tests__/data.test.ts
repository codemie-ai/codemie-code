/**
 * Unit tests for skills data fetcher
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CodeMieClient, SkillListItem } from 'codemie-sdk';
import type { CodemieSkill } from '@/env/types.js';
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
      expect(mockClient.skills.listPaginated).not.toHaveBeenCalled();
    });

    it('filters the bulk-fetched skills by the requested IDs', async () => {
      const mockResponse = {
        skills: [
          { id: 'skill-1', name: 'Skill 1' } as SkillListItem,
          { id: 'skill-2', name: 'Skill 2' } as SkillListItem,
        ],
        page: 0,
        total: 2,
        pages: 1
      };
      vi.mocked(mockClient.skills.listPaginated).mockResolvedValue(mockResponse as any);

      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });
      const result = await fetcher.fetchSkillsByIds(['skill-2'], []);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('skill-2');
    });

    it('surfaces a clear re-auth error on a stale session when fetching by IDs', async () => {
      const keycloakLoginHtml = '<!DOCTYPE html><html>keycloak</html>';
      vi.mocked(mockClient.skills.listPaginated).mockResolvedValue(keycloakLoginHtml as any);

      const fetcher = createSkillDataFetcher({ client: mockClient, registeredSkills });

      await expect(
        fetcher.fetchSkillsByIds(['skill-1'], [])
      ).rejects.toThrow(/session has expired.*codemie profile login/i);
    });
  });
});
