import type { Assistant, AssistantBase } from 'codemie-sdk';
import type { PanelId, PaginationControl } from './constants.js';

export type ButtonType = 'continue' | 'cancel';

export interface SelectionState {
  panels: PanelState[];
  activePanelId: PanelId;
  searchQuery: string;
  selectedIds: Set<string>;
  registeredIds: Set<string>;
  isSearchFocused: boolean;
  isPaginationFocused: PaginationControl | null;
  areNavigationButtonsFocused: boolean;
  focusedButton: ButtonType;
}

export interface PanelState {
  id: PanelId;
  label: string;
  isActive: boolean;
  data: (Assistant | AssistantBase)[] | null;
  filteredData: (Assistant | AssistantBase)[];
  isFetching: boolean;
  error: string | null;
  currentPage: number;
  totalItems: number;
  totalPages: number;
}
