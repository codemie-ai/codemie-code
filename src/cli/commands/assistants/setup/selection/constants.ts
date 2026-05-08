export {
  ANSI, KEY, BOX, SYMBOL, PAGINATION_CONTROL, CONFIG, PANEL_ID, PANEL_IDS, SHARED_TEXT,
  type PaginationControl, type PanelId,
} from '@/cli/commands/shared/selection/constants.js';

import { SHARED_TEXT } from '@/cli/commands/shared/selection/constants.js';

export const TEXT = {
  ...SHARED_TEXT,
  LABEL: 'Assistants',
  NO_ASSISTANTS: 'No assistants found.',
  ERROR_PREFIX: 'Error: ',
} as const;

export const API_SCOPE = {
  VISIBLE_TO_USER: 'visible_to_user',
  MARKETPLACE: 'marketplace',
} as const;
