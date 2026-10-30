/**
 * Text and layout constants for the per-agent model setup wizard.
 */

export const WIZARD_TEXT = {
  STAGE_AGENTS: 'Agents',
  STAGE_REVIEW: 'Review',
  AGENTS_TITLE: 'Which agents will use this profile?',
  AGENTS_NOTE: 'Each selected agent gets its own models and active model in the next steps.',
  AGENTS_REQUIRED: 'Select at least one agent.',
  MODELS_TITLE: (agent: string) => `${agent} · Models`,
  MODELS_NOTE: (agent: string) => `Only models ${agent} supports are listed. Type to search or to add a model by name.`,
  MODELS_RULE_FREE_NOTE: (agent: string) => `No model rules for ${agent} - any model works, so every model is listed.`,
  MODELS_EMPTY_CATALOG_NOTE: 'The provider lists no models: type a model name and press Enter to add it.',
  MODELS_REQUIRED: (agent: string) => `Select at least one model for ${agent}.`,
  ACTIVE_TITLE: (agent: string) => `${agent} · Active model`,
  ACTIVE_NOTE: (agent: string) => `${agent} starts with this model. Switch later with "codemie models switch --agent".`,
  ACTIVE_ONLY_NOTE: (agent: string, name: string) =>
    `${name} has no in-session model menu - it always runs on its active model. ` +
    `Change it later with "codemie models switch --agent ${agent}".`,
  ACTIVE_REQUIRED: (agent: string) => `Select the active model for ${agent}.`,
  REVIEW_TITLE: 'Review',
  REVIEW_NOTE: 'Save writes these models to the profile.',
  SAVE_BUTTON: 'Save',
  UNVERIFIED_TAG: 'unverified',
  ACTIVE_TAG: '(active)',
  USE_CUSTOM: (id: string) => `+ Use "${id}"`,
  USE_CUSTOM_UNVERIFIED: (agent: string) => `does not look like a ${agent} model - saved as unverified`,
  SEARCH_ROW: '🔍 Search Ollama library...',
  SELECTED_COUNT: (count: number) => `${count} selected`,
  NOT_SUPPORTED: (provider: string) => `not supported by ${provider}`,
  NO_COMPATIBLE_MODEL: (provider: string) => `no compatible model on ${provider}`,
  RULE_FREE_AGENTS: (names: string) => `No model rules for: ${names} - any model is used as-is.`,
  INSTRUCTIONS_MULTI: '↑↓ Navigate • Space Select • Enter Continue • Esc Back',
  INSTRUCTIONS_MULTI_SEARCH: '↑↓ Navigate • Space Select • Type to search • Enter Continue • Esc Back',
  INSTRUCTIONS_SINGLE: '↑↓ Navigate • Enter Select • Esc Back',
  INSTRUCTIONS_SINGLE_SEARCH: '↑↓ Navigate • Type to search • Enter Select • Esc Back',
  INSTRUCTIONS_REVIEW: '←→ Choose • Enter Confirm • Esc Back',
} as const;

/** Row id of the provider-side model search action. */
export const SEARCH_ROW_ID = '__search__';

/** Rows visible at once; the list scrolls around the cursor. */
export const VISIBLE_ROWS = 12;

export const KEEP_ALIVE_INTERVAL_MS = 1000;
