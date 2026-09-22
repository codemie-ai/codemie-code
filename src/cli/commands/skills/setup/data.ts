/**
 * Data Layer
 *
 * Handles all data fetching for skills setup
 */

import type { SkillListItem, SkillDetail, CodeMieClient } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';
import type { CodemieSkill } from '@/env/types.js';
import { RegistrationItemNotFoundError } from '@/utils/errors.js';
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

  async function fetchSkillsByIds(ids: string[], _registeredSkills: CodemieSkill[]): Promise<SkillListItem[]> {
    if (ids.length === 0) {
      return [];
    }

    logger.debug('[SkillSetup] Fetching skills by IDs', { ids });

    // No efficient bulk-by-id endpoint, so fetch every visible skill (paged) and
    // resolve each requested id against it. A requested id the catalog does not
    // contain aborts the run: filtering it out silently reports success for a
    // skill that was never registered.
    const allSkills = await fetchAllVisibleSkills();
    const byId = new Map(allSkills.map(skill => [skill.id, skill]));

    const skills = ids.map((id) => {
      const skill = byId.get(id);

      if (!skill) {
        throw new RegistrationItemNotFoundError('skill', id);
      }

      return skill;
    });

    logger.debug('[SkillSetup] Fetched skills by IDs', { count: skills.length });
    return skills;
  }

  return { fetchSkills, fetchSkillById, fetchSkillsByIds, fetchAllVisibleSkills };
}
