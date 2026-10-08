/**
 * Data Layer
 *
 * Handles all data fetching for skills setup
 */

import { NotFoundError, type SkillListItem, type SkillDetail, type CodeMieClient } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';
import type { CodemieSkill } from '@/env/types.js';
import { assertApiListResponse } from '@/cli/commands/shared/api-response-guard.js';

type ApiSkillScope = 'project' | 'marketplace';

interface SkillListFilters extends Record<string, unknown> {
  search: string;
  project: string[];
  created_by: string;
  categories: string[];
  visibility: 'public' | null;
  scope: ApiSkillScope;
}

/**
 * Builds the filter payload the skills listing expects for a panel scope. Shared by
 * the wizard fetch and the headless catalog crawl so both see the same set.
 */
function buildScopeFilters(apiScope: ApiSkillScope, search: string): SkillListFilters {
  return {
    search: search.trim(),
    project: [],
    created_by: '',
    categories: [],
    visibility: apiScope === 'marketplace' ? 'public' : null,
    scope: apiScope,
  };
}

interface SkillListResponse {
  skills: SkillListItem[];
  total: number;
  pages: number;
}

function isSkillListResponse(response: unknown): response is SkillListResponse {
  const r = response as Partial<SkillListResponse> | null | undefined;
  return !!r && typeof r === 'object' && Array.isArray(r.skills)
    && typeof r.total === 'number' && typeof r.pages === 'number';
}

function isSkillDetailResponse(response: unknown): response is SkillDetail {
  const r = response as Partial<SkillDetail> | null | undefined;
  return !!r && typeof r === 'object' && typeof r.id === 'string';
}

export interface FetchSkillsByIdsResult {
  found: SkillDetail[];
  missing: string[];
}

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
  fetchSkillsByIds: (ids: string[], registeredSkills: CodemieSkill[]) => Promise<FetchSkillsByIdsResult>;
  fetchAllVisibleSkills: () => Promise<SkillListItem[]>;
}

export interface SkillDataFetcherConfig {
  client: CodeMieClient;
  registeredSkills: CodemieSkill[];
}

export function createSkillDataFetcher(config: SkillDataFetcherConfig): SkillDataFetcher {
  const { client, registeredSkills } = config;
  const PER_PAGE = 5;
  const ALL_VISIBLE_PER_PAGE = 100;

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
      filters: buildScopeFilters(apiScope, searchQuery)
    });

    assertApiListResponse(response, isSkillListResponse, `${apiScope} skills`);

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

  async function fetchAllPagesForScope(apiScope: ApiSkillScope): Promise<SkillListItem[]> {
    const skills: SkillListItem[] = [];
    let page = 0;
    let pages = 1;

    do {
      const response = await client.skills.listPaginated({
        page,
        per_page: ALL_VISIBLE_PER_PAGE,
        filters: buildScopeFilters(apiScope, ''),
      });
      assertApiListResponse(response, isSkillListResponse, `${apiScope} skills`);

      skills.push(...response.skills);
      pages = response.pages;
      page += 1;
    } while (page < pages);

    return skills;
  }

  async function fetchAllVisibleSkills(): Promise<SkillListItem[]> {
    logger.debug('[SkillSetup] Fetching all visible skills');

    // Page exactly the two scopes the wizard's panels fetch, with the wizard's
    // filters: an unfiltered listing relies on a server-side default that is not
    // observable here, so "not in the listing" would not be provably the same as
    // "not available to you".
    const byId = new Map<string, SkillListItem>();

    for (const apiScope of ['project', 'marketplace'] as const) {
      for (const skill of await fetchAllPagesForScope(apiScope)) {
        if (!byId.has(skill.id)) {
          byId.set(skill.id, skill);
        }
      }
    }

    const skills = Array.from(byId.values());
    logger.debug('[SkillSetup] Fetched all visible skills', { count: skills.length });
    return skills;
  }

  async function fetchSkillsByIds(ids: string[], _registeredSkills: CodemieSkill[]): Promise<FetchSkillsByIdsResult> {
    if (ids.length === 0) {
      return { found: [], missing: [] };
    }

    logger.debug('[SkillSetup] Fetching skills by IDs', { ids });

    // Fetch each requested id directly rather than crawling the whole catalog: the
    // visible catalog runs to thousands of skills, and paging through it took
    // longer than 30s with no output. An id the API does not know is reported in
    // `missing` for the caller to decide on; any other failure propagates.
    const results = await Promise.all(ids.map(async (id): Promise<SkillDetail | { missing: string }> => {
      try {
        const skill: unknown = await client.skills.get(id);
        assertApiListResponse(skill, isSkillDetailResponse, 'skill details');
        return skill;
      } catch (error) {
        if (error instanceof NotFoundError) {
          return { missing: id };
        }
        throw error;
      }
    }));

    const found: SkillDetail[] = [];
    const missing: string[] = [];
    for (const result of results) {
      if ('missing' in result) {
        missing.push(result.missing);
      } else {
        found.push(result);
      }
    }

    logger.debug('[SkillSetup] Fetched skills by IDs', { count: found.length, missing });
    return { found, missing };
  }

  return { fetchSkills, fetchSkillById, fetchSkillsByIds, fetchAllVisibleSkills };
}
