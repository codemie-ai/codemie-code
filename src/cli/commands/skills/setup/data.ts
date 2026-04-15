/**
 * Data Layer
 *
 * Handles all data fetching for skills setup
 */

import type { SkillListItem, SkillDetail, CodeMieClient } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';
import type { CodemieSkill } from '@/env/types.js';

export interface FetchSkillsParams {
  scope: 'registered' | 'project' | 'marketplace';
  searchQuery?: string;
  page?: number;
}

export interface FetchSkillsResult {
  data: SkillListItem[];
  total: number;
  pages: number;
}

export interface SkillDataFetcher {
  fetchSkills: (params: FetchSkillsParams) => Promise<FetchSkillsResult>;
  fetchSkillById: (id: string) => Promise<SkillDetail>;
  fetchSkillsByIds: (ids: string[], registeredSkills: CodemieSkill[]) => Promise<SkillListItem[]>;
}

export interface SkillDataFetcherConfig {
  client: CodeMieClient;
  registeredSkills: CodemieSkill[];
}

export function createSkillDataFetcher(config: SkillDataFetcherConfig): SkillDataFetcher {
  const { client, registeredSkills } = config;
  const PER_PAGE = 5;

  async function fetchSkills(params: FetchSkillsParams): Promise<FetchSkillsResult> {
    const { scope, searchQuery = '', page = 0 } = params;

    logger.debug('[SkillSetup] Fetching skills', { scope, searchQuery, page });

    // Registered tab - return local registered skills
    if (scope === 'registered') {
      let filteredSkills = registeredSkills;

      // Apply search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        filteredSkills = registeredSkills.filter(skill =>
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query)
        );
      }

      // Calculate pagination
      const total = filteredSkills.length;
      const pages = Math.max(1, Math.ceil(total / PER_PAGE));
      const start = page * PER_PAGE;
      const end = start + PER_PAGE;
      const paginatedSkills = filteredSkills.slice(start, end);

      logger.debug('[SkillSetup] Fetched registered skills', { total, pages });
      return {
        data: paginatedSkills as unknown as SkillListItem[],
        total,
        pages
      };
    }

    // Project or Marketplace - fetch from API
    const apiScope = scope === 'project' ? 'project' : 'marketplace';

    const response = await client.skills.listPaginated({
      page,
      per_page: PER_PAGE,
      filters: {
        search: searchQuery.trim(),
        project: [],
        created_by: "",
        categories: [],
        visibility: apiScope === 'marketplace' ? 'public' : null,
        scope: apiScope
      }
    });

    logger.debug('[SkillSetup] Fetched skills from API', {
      scope: apiScope,
      count: response.skills.length,
      page: response.page,
      total: response.total,
      pages: response.pages
    });

    return {
      data: response.skills,
      total: response.total,
      pages: response.pages
    };
  }

  async function fetchSkillById(id: string): Promise<SkillDetail> {
    logger.debug('[SkillSetup] Fetching skill details', { id });
    return client.skills.get(id);
  }

  async function fetchSkillsByIds(ids: string[], _registeredSkills: CodemieSkill[]): Promise<SkillListItem[]> {
    if (ids.length === 0) {
      return [];
    }

    logger.debug('[SkillSetup] Fetching skills by IDs', { ids });

    // Fetch all skills (no efficient bulk endpoint, so fetch all and filter)
    const response = await client.skills.listPaginated({ per_page: 100 });
    const skills = response.skills.filter(skill => ids.includes(skill.id));

    logger.debug('[SkillSetup] Fetched skills by IDs', { count: skills.length });
    return skills;
  }

  return { fetchSkills, fetchSkillById, fetchSkillsByIds };
}
