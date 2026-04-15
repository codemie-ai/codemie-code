import type { SkillListItem, SkillDetail } from 'codemie-sdk';
import type { PanelId, PaginationControl } from './constants.js';
import type { CodemieSkill } from '@/env/types.js';

export type ButtonType = 'continue' | 'cancel';

export interface SelectionState {
  panels: PanelState[];
  activePanelId: PanelId;
  searchQuery: string;
  selectedIds: Set<string>;
  registeredIds: Set<string>;
  registeredSkills: CodemieSkill[];
  isSearchFocused: boolean;
  isPaginationFocused: PaginationControl | null;
  areNavigationButtonsFocused: boolean;
  focusedButton: ButtonType;
}

export interface PanelState {
  id: PanelId;
  label: string;
  isActive: boolean;
  data: (SkillListItem | SkillDetail)[] | null;
  filteredData: (SkillListItem | SkillDetail)[];
  isFetching: boolean;
  error: string | null;
  currentPage: number;
  totalItems: number;
  totalPages: number;
}
