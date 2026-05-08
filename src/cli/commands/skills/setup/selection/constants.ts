export {
  ANSI, KEY, BOX, SYMBOL, PAGINATION_CONTROL, CONFIG, PANEL_ID, PANEL_IDS,
  type PaginationControl, type PanelId,
} from '@/cli/commands/shared/selection/constants.js';

export const TEXT = {
  LABEL: 'Skills',
  NO_SKILLS: 'No skills found.',
  ERROR_PREFIX: 'Error: ',
} as const;

export const API_SCOPE = {
  PROJECT: 'project',
  MARKETPLACE: 'marketplace',
} as const;
