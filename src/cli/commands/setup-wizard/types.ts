/**
 * Types for the per-agent model setup wizard (EPMCDME-15641).
 */

import type { AgentModelSet, ProviderProfile } from '@/env/types.js';
import type { ProviderTemplate } from '@/providers/core/types.js';

/** One selectable (or informational) row of a list screen. */
export interface ListRow {
  id: string;
  /** Rendered label; may carry chalk styling. */
  label: string;
  /** Dim line rendered under the label. */
  detail?: string;
  /** Reason the row cannot be selected; rendered dim next to the label. */
  disabled?: string;
  /** `action` rows end the screen with `{ action: 'row' }` instead of toggling. */
  kind?: 'item' | 'action';
  /** For a custom row: the row inserted into the list once it is used. */
  addAs?: ListRow;
}

export interface ListScreenSpec {
  /** Breadcrumb of wizard stages, e.g. ["Agents", "Claude Code", "Review"]. */
  stages: string[];
  /** Index into `stages` of the current stage. */
  stageIndex: number;
  /** Screen title, e.g. "Claude Code · Models". */
  title: string;
  /** Dim lines under the title. */
  notes?: string[];
  /** Undimmed lines under the notes (e.g. a review summary). */
  body?: string[];
  mode: 'multi' | 'single';
  rows: ListRow[];
  /** Initially selected ids (`single`: at most one). */
  selected: string[];
  /** Typing filters rows by id; a query matching no id may offer `customRow`. */
  searchable?: boolean;
  /** Row offered for a typed query that matches no row id exactly. */
  customRow?: (query: string) => ListRow | undefined;
  /** Error shown on Continue when the selection is not acceptable. */
  validate?: (selected: string[]) => string | undefined;
  /** Live status line under the rows. */
  status?: (selected: string[]) => string | undefined;
  /** Continue button label; defaults to "Continue". */
  continueLabel?: string;
}

export type ListScreenResult =
  | { action: 'continue'; selected: string[]; added: string[] }
  | { action: 'row'; id: string; selected: string[]; added: string[] }
  | { action: 'back' }
  | { action: 'cancel' };

/** Inputs the wizard needs from `codemie setup`. */
export interface AgentModelsWizardInput {
  /** Provider catalog ids; empty when the provider lists none (typed entry only). */
  models: string[];
  provider: string;
  providerTemplate?: ProviderTemplate;
  /** Catalog router hint (ModelInfo.metadata.isRouter), when the provider reports one. */
  isRouter?: (modelId: string) => boolean;
  /** Live recommendations; the template's static list is used when absent. */
  recommendedIds?: Set<string>;
  /** Provider-side model search (Ollama library); resolves to an id or undefined. */
  searchModel?: () => Promise<string | undefined>;
  /** Existing profile on an update, for preselection. */
  existing?: Pick<ProviderProfile, 'provider' | 'model' | 'agentModels'>;
}

/** Chosen models per agent, keyed by base agent name in offered order. */
export type AgentModelsResult = Record<string, AgentModelSet>;

/** Work-in-progress selection for one agent. */
export interface AgentDraft {
  models: string[];
  model?: string;
  /** Typed or searched ids added to this agent's list beyond the catalog. */
  extra: string[];
  /** Ids the user accepted despite the agent's model-name rule. */
  confirmed: Set<string>;
}
