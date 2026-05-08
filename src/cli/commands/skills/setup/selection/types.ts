import type { SkillListItem, SkillDetail } from 'codemie-sdk';
import type { CodemieSkill } from '@/env/types.js';
import type { BaseSelectionState, BasePanelState } from '@/cli/commands/shared/selection/types.js';

export type { ButtonType } from '@/cli/commands/shared/selection/types.js';

export interface PanelState extends BasePanelState {
  data: (SkillListItem | SkillDetail)[] | null;
  filteredData: (SkillListItem | SkillDetail)[];
}

export interface SelectionState extends BaseSelectionState {
  panels: PanelState[];
  registeredSkills: CodemieSkill[];
}
