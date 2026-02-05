/**
 * Data Layer
 *
 * Handles all data fetching for assistant selection
 */

import type { Assistant, AssistantBase, AssistantListParams, CodeMieClient } from 'codemie-sdk';
import type { ProviderProfile } from '@/env/types.js';
import type { SetupCommandOptions } from './index.js';
import { PANEL_ID, API_SCOPE, CONFIG, type PanelId } from './selection/constants.js';
import { logger } from '@/utils/logger.js';

export interface DataFetcherDependencies {
  config: ProviderProfile;
  client: CodeMieClient;
  options: SetupCommandOptions;
}

export interface FetchAssistantsParams {
  scope: PanelId;
  searchQuery?: string;
  page?: number;
}

export interface FetchAssistantsResult {
  data: (Assistant | AssistantBase)[];
  total: number;
  pages: number;
}

export interface DataFetcher {
  fetchAssistants: (params: FetchAssistantsParams) => Promise<FetchAssistantsResult>;
  fetchAssistantsByIds: (
    selectedIds: string[],
    existingAssistants: (Assistant | AssistantBase)[]
  ) => Promise<(Assistant | AssistantBase)[]>;
}

export function createDataFetcher(deps: DataFetcherDependencies): DataFetcher {
  async function fetchAssistants(params: FetchAssistantsParams): Promise<FetchAssistantsResult> {
    const { scope, searchQuery = '', page = 0 } = params;

    logger.debug('[AssistantSelection] Fetching assistants', { scope, searchQuery, page });

    if (scope === PANEL_ID.REGISTERED) {
      const allData = fetchRegisteredFromConfig(searchQuery);
      const total = allData.length;
      const pages = Math.ceil(total / CONFIG.ITEMS_PER_PAGE);

      const startIndex = page * CONFIG.ITEMS_PER_PAGE;
      const endIndex = startIndex + CONFIG.ITEMS_PER_PAGE;
      const data = allData.slice(startIndex, endIndex);

      logger.debug('[AssistantSelection] Fetched registered assistants', { count: data.length, total, pages });
      return { data, total, pages };
    }

    try {
      const filters: Record<string, unknown> = {
        search: searchQuery.trim(),
      };

      if (scope === PANEL_ID.MARKETPLACE) {
        filters.marketplace = null;
      }

      const apiParams: AssistantListParams = {
        page,
        per_page: CONFIG.ITEMS_PER_PAGE,
        minimal_response: false,
        ...(scope === PANEL_ID.PROJECT && { scope: API_SCOPE.VISIBLE_TO_USER }),
        ...(scope === PANEL_ID.MARKETPLACE && { scope: API_SCOPE.MARKETPLACE }),
        filters
      };

      logger.debug('[AssistantSelection] Full API request params', {
        scope,
        apiParams: JSON.stringify(apiParams, null, 2)
      });

      const response = await deps.client.assistants.listPaginated(apiParams);

      logger.debug('[AssistantSelection] Full raw API response', {
        scope,
        response: JSON.stringify(response, null, 2)
      });

      logger.debug('[AssistantSelection] Processed response', {
        dataCount: response.data.length,
        paginationTotal: response.pagination.total,
        paginationPages: response.pagination.pages,
        scope
      });

      return {
        data: response.data,
        total: response.pagination.total,
        pages: response.pagination.pages
      };
    } catch (error) {
      throw error instanceof Error ? error : new Error(`Failed to fetch ${scope} assistants: ${error}`);
    }
  }

  function fetchRegisteredFromConfig(searchQuery: string): (Assistant | AssistantBase)[] {
    const registered = deps.config.codemieAssistants || [];

    let assistants = registered.map(asst => ({
      id: asst.id,
      name: asst.name,
      description: asst.description || '',
      slug: asst.slug,
      project: asst.project || ''
    } as AssistantBase));

    if (searchQuery.trim()) {
      const lowerQuery = searchQuery.toLowerCase();
      assistants = assistants.filter(assistant => {
        const project = ('project' in assistant ? assistant.project : '') as string;
        const slug = ('slug' in assistant ? assistant.slug : '') as string;
        return (
          assistant.name.toLowerCase().includes(lowerQuery) ||
          assistant.description?.toLowerCase().includes(lowerQuery) ||
          project.toLowerCase().includes(lowerQuery) ||
          slug.toLowerCase().includes(lowerQuery)
        );
      });
    }

    return assistants;
  }

  async function fetchAssistantsByIds(
    selectedIds: string[],
    existingAssistants: (Assistant | AssistantBase)[]
  ): Promise<(Assistant | AssistantBase)[]> {
    const existingMap = new Map(existingAssistants.map(a => [a.id, a]));
    const idsToFetch: string[] = [];

    // Identify which IDs need to be fetched
    for (const id of selectedIds) {
      if (!existingMap.has(id)) {
        idsToFetch.push(id);
      }
    }

    // Fetch missing assistants
    if (idsToFetch.length > 0) {
      logger.debug('[AssistantSetup] Fetching missing assistant details', {
        count: idsToFetch.length,
        ids: idsToFetch
      });

      for (const id of idsToFetch) {
        try {
          const assistant = await deps.client.assistants.get(id);
          existingMap.set(id, assistant);
          logger.debug('[AssistantSetup] Fetched assistant', { id, name: assistant.name });
        } catch (error) {
          logger.error('[AssistantSetup] Failed to fetch assistant', { id, error });
        }
      }
    }

    // Build result in requested order
    const result: (Assistant | AssistantBase)[] = [];
    for (const id of selectedIds) {
      const assistant = existingMap.get(id);
      if (assistant) {
        result.push(assistant);
      }
    }

    return result;
  }

  return {
    fetchAssistants,
    fetchAssistantsByIds
  };
}
