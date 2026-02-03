import type { Assistant, AssistantBase, CodeMieClient } from 'codemie-sdk';
import type { ProviderProfile } from '@/env/types.js';
import type { SetupCommandOptions } from '../index.js';

export type TabId = 'registered' | 'project' | 'marketplace';

export interface TabState {
  id: TabId;
  label: string;
  isActive: boolean;
  data: (Assistant | AssistantBase)[] | null; // null = not fetched yet
  filteredData: (Assistant | AssistantBase)[]; // After search filter applied
  isFetching: boolean;
  error: string | null;
}

export interface SelectionState {
  tabs: TabState[]; // Array of 3 tabs
  activeTabId: TabId;
  searchQuery: string;
  selectedIds: Set<string>; // Persists across tabs
  registeredIds: Set<string>; // Original registered state (read-only)
}

export interface OrchestratorOptions {
  initialAssistants: (Assistant | AssistantBase)[];
  registeredIds: Set<string>;
  config: ProviderProfile;
  options: SetupCommandOptions;
  client: CodeMieClient;
}
