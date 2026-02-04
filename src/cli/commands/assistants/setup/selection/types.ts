import type { Assistant, AssistantBase } from 'codemie-sdk';
import type { PanelId } from './constants.js';

export interface SelectionState {
  panels: PanelState[];
  activePanelId: PanelId;
  searchQuery: string;
  selectedIds: Set<string>;
  registeredIds: Set<string>;
  isSearchFocused: boolean;
}

export interface PanelState {
  id: PanelId;
  label: string;
  isActive: boolean;
  data: (Assistant | AssistantBase)[] | null;
  filteredData: (Assistant | AssistantBase)[];
  isFetching: boolean;
  error: string | null;
}
