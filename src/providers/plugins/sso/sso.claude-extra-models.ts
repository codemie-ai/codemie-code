/**
 * Non-Claude models a profile opted into for the Claude clients.
 *
 * Claude Code's `/model` picker and Claude Desktop's model list offer only Claude-family
 * models by default, since other families may not handle Claude-specific features well.
 * A profile's `claudeExtraModels` (set with `codemie-claude models select`) adds chosen
 * catalog models on top. Shared by both clients so they offer the same set.
 */

import type { LlmModel } from './sso.http-client.js';
import { isClaudeFamilyModel } from '../../../utils/model-family.js';

const NON_CHAT_MODEL_PATTERNS: RegExp[] = [
  /embedding/i,
  /rerank/i,
  /whisper/i,
  /tts/i,
  /moderation/i,
  /image/i,
  /vision-only/i,
];

function searchText(model: LlmModel): string {
  return [model.deployment_name, model.base_name, model.label, model.provider]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Whether a deployment can serve an agent session at all: enabled, tool- and stream-capable,
 * and not an embedding/rerank/audio/image endpoint. Says nothing about model family.
 */
export function isServableCatalogModel(model: LlmModel): boolean {
  if (!model.enabled) return false;
  if (model.features?.tools === false || model.features?.streaming === false) return false;
  return !NON_CHAT_MODEL_PATTERNS.some((pattern) => pattern.test(searchText(model)));
}

/**
 * Every id the catalog may expose an entry under (deployment name, base name, label), so a
 * stored id matches whichever of them it was saved as.
 */
export function catalogModelIdentifiers(model: LlmModel): string[] {
  return [model.deployment_name, model.base_name, model.label].filter(
    (value): value is string => Boolean(value)
  );
}

/** The id a model is stored under in `claudeExtraModels`. */
export function catalogModelId(model: LlmModel): string | undefined {
  return model.deployment_name || model.base_name || model.label || undefined;
}

/** The models a profile may opt into: servable and outside the Claude family, sorted by name. */
export function listClaudeExtraModelCandidates(catalog: readonly LlmModel[]): LlmModel[] {
  const seen = new Set<string>();
  const candidates: LlmModel[] = [];
  for (const model of catalog) {
    const id = catalogModelId(model);
    if (!id || seen.has(id)) continue;
    if (!isServableCatalogModel(model) || isClaudeFamilyModel(model)) continue;
    seen.add(id);
    candidates.push(model);
  }
  return candidates.sort((a, b) => (a.label || catalogModelId(a) || '').localeCompare(b.label || catalogModelId(b) || ''));
}

/**
 * The opted-in models the catalog still serves, in the order they were stored. An id the
 * catalog no longer has (retired, or not allowed for the project) is skipped.
 */
export function resolveClaudeExtraModels(catalog: readonly LlmModel[], ids: readonly string[]): LlmModel[] {
  const resolved: LlmModel[] = [];
  for (const id of ids) {
    const model = catalog.find((entry) => isServableCatalogModel(entry) && catalogModelIdentifiers(entry).includes(id));
    if (model && !resolved.includes(model)) resolved.push(model);
  }
  return resolved;
}

/** `claudeExtraModels` from a profile record, keeping only non-empty strings. */
export function readClaudeExtraModels(profile: { claudeExtraModels?: unknown } | null | undefined): string[] {
  const value = profile?.claudeExtraModels;
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
}

/** `claudeExtraModels` of the profile an agent session runs under (`CODEMIE_PROFILE_CONFIG`). */
export function claudeExtraModelsFromEnv(env: NodeJS.ProcessEnv): string[] {
  if (!env.CODEMIE_PROFILE_CONFIG) return [];
  try {
    return readClaudeExtraModels(JSON.parse(env.CODEMIE_PROFILE_CONFIG) as { claudeExtraModels?: unknown });
  } catch {
    return [];
  }
}
