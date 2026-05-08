import type { PanelId, PaginationControl } from './constants.js';

export type ButtonType = 'continue' | 'cancel';

export interface SelectableItem {
  id: string;
  name: string;
  description?: string | null;
}

export interface BasePanelState {
  id: string;
  label: string;
  isActive: boolean;
  data: SelectableItem[] | null;
  filteredData: SelectableItem[];
  isFetching: boolean;
  error: string | null;
  currentPage: number;
  totalItems: number;
  totalPages: number;
}

export interface BaseSelectionState {
  panels: BasePanelState[];
  activePanelId: PanelId;
  searchQuery: string;
  selectedIds: Set<string>;
  registeredIds: Set<string>;
  isSearchFocused: boolean;
  isPaginationFocused: PaginationControl | null;
  areNavigationButtonsFocused: boolean;
  focusedButton: ButtonType;
}
