import type { Assistant, AssistantBase } from 'codemie-sdk';
import type { CodemieAssistant } from '@/env/types.js';
import type { BaseSelectionState, BasePanelState } from '@/cli/commands/shared/selection/types.js';

export type { ButtonType } from '@/cli/commands/shared/selection/types.js';

export interface PanelState extends BasePanelState {
  data: (Assistant | AssistantBase)[] | null;
  filteredData: (Assistant | AssistantBase)[];
}

export interface SelectionState extends BaseSelectionState {
  panels: PanelState[];
  registeredAssistants: CodemieAssistant[];
}
