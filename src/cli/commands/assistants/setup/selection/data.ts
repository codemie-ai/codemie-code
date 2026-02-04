/**
 * Data Layer
 *
 * Handles all data fetching for assistant selection
 */

import type { Assistant, AssistantBase, AssistantListParams, CodeMieClient } from 'codemie-sdk';
import type { ProviderProfile } from '@/env/types.js';
import type { SetupCommandOptions } from '../index.js';
import { PANEL_ID, API_SCOPE, type PanelId } from './constants.js';

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

export interface DataFetcher {
  fetchAssistants: (params: FetchAssistantsParams) => Promise<(Assistant | AssistantBase)[]>;
}

export function createDataFetcher(deps: DataFetcherDependencies): DataFetcher {
  async function fetchAssistants(params: FetchAssistantsParams): Promise<(Assistant | AssistantBase)[]> {
    const { scope, searchQuery = '', page = 0 } = params;

    if (scope === PANEL_ID.REGISTERED) return fetchRegisteredFromConfig(searchQuery);

    try {
      const projectFilter = deps.options.project || deps.config.codeMieProject;

      if (scope === PANEL_ID.PROJECT && !projectFilter) {
        throw new Error('No project configured. Ensure codemie is configured properly');
      }

      const filters: Record<string, unknown> = {};

      if (scope === PANEL_ID.PROJECT && projectFilter) {
        filters.project = [projectFilter];
      }

      if (searchQuery.trim()) {
        filters.search = searchQuery.trim();
      }

      const apiParams: AssistantListParams = {
        page,
        minimal_response: false,
        ...(scope === PANEL_ID.MARKETPLACE && { scope: API_SCOPE.MARKETPLACE }),
        ...(Object.keys(filters).length > 0 && { filters })
      };

      const assistants = await deps.client.assistants.list(apiParams);

      return assistants;
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

  return {
    fetchAssistants
  };
}
