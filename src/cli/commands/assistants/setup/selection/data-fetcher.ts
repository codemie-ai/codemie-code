import type { Assistant, AssistantBase, CodeMieClient } from 'codemie-sdk';
import type { ProviderProfile } from '@/env/types.js';
import type { SetupCommandOptions } from '../index.js';

export interface DataFetcherDependencies {
  config: ProviderProfile;
  client: CodeMieClient;
  options: SetupCommandOptions;
}

export class DataFetcher {
  constructor(private deps: DataFetcherDependencies) {}

  /**
   * Registered Tab: Filter from config (instant, no API call)
   */
  async fetchRegistered(_registeredIds: Set<string>): Promise<(Assistant | AssistantBase)[]> {
    // No API call - use config data
    const registered = this.deps.config.codemieAssistants || [];

    // Convert CodemieAssistant to AssistantBase format
    return registered.map(asst => ({
      id: asst.id,
      name: asst.name,
      description: asst.description || '',
      slug: asst.slug,
      project: asst.project || ''
    } as AssistantBase));
  }

  /**
   * Project Tab: API call with project filter
   * SILENT - no spinner to avoid conflict with raw mode
   */
  async fetchProjectAssistants(): Promise<(Assistant | AssistantBase)[]> {
    const projectFilter = this.deps.options.project || this.deps.config.codeMieProject;

    if (!projectFilter) {
      return []; // Show empty state with helpful message
    }

    // Fetch directly without spinner (spinner conflicts with raw mode)
    try {
      const filters: Record<string, unknown> = {
        my_assistants: true,
        project: projectFilter
      };

      const assistants = await this.deps.client.assistants.list({
        filters,
        minimal_response: false
      });

      return assistants;
    } catch (error) {
      console.error('Failed to fetch assistants:', error);
      return [];
    }
  }

  /**
   * Marketplace Tab: API call with different params (placeholder)
   */
  async fetchMarketplace(): Promise<(Assistant | AssistantBase)[]> {
    // PLACEHOLDER: Will use same API, different params
    // Example: client.assistants.list({ filters: { is_global: true } })
    // or: client.assistants.list({ scope: 'marketplace' })
    // No special metadata handling - same Assistant[] type
    return [];
  }
}
