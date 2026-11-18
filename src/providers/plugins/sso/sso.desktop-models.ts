/**
 * The Claude Desktop model list, built from a CodeMie catalog.
 *
 * Shared by the Desktop connector (`codemie proxy connect --claude-desktop`, which checks the
 * list before it configures Desktop) and the proxy's `GET /v1/models`, which Desktop calls
 * on start to fill its picker.
 */

import { createHash } from 'node:crypto';
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { isClaudeFamilyModel, isRouterModel, type ModelFamilyFields } from '../../../utils/model-family.js';
import { resolveTenantModelId } from './sso.model-name-resolver.js';
import { catalogModelIdentifiers, resolveClaudeExtraModels } from './sso.claude-extra-models.js';
import type { LlmModel } from './sso.http-client.js';

/** The catalog entry fields the Desktop list reads; `id` covers OpenAI-style `{ data: [{ id }] }` replies. */
export type DesktopCatalogEntry = ModelFamilyFields & { id?: string; enabled?: boolean };

/** A Claude-family catalog entry Claude Desktop can be offered. */
export interface DesktopModel {
  id: string;
  /** The model's name in CodeMie; Desktop shows it instead of the raw ID. */
  label?: string;
  isRouter: boolean;
}

/**
 * Curated Claude models that head Desktop's list; the first one served is Desktop's default.
 *
 * Each entry is matched against the catalog either as an exact ID or as
 * `<entry>-<YYYYMMDD>` (the dated variant). The actual resolved ID is what
 * Desktop is offered, so the gateway receives a model name it has registered.
 *
 * Opus, Sonnet, and Haiku entries are listed in descending preference
 * (`opus: 5.5 → 5 → 4-8 → 4-7 → 4-6`, `sonnet: 5.5 → 5 → 4-6`, `haiku: 5.5 → 4-5`):
 * {@link selectDesktopClaudeModels} puts the highest-priority ID the gateway serves
 * in each family first. It does not limit the list: every other Claude model follows.
 */
export const PREFERRED_CLAUDE_MODELS = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-5-5',
  'claude-haiku-4-5',
] as const;

const CLAUDE_ID_PATTERN = /^claude-/i;
const ROUTER_MODEL_PATTERN = /^claude-(.+-)?router(-.+)?$/i;

/**
 * The catalog's usable Claude-family models with their CodeMie names. When both
 * canonical and `-vertex` registrations exist, canonical IDs are preferred. When
 * only vertex registrations exist, those IDs are returned so vertex-only tenants
 * can connect. Routers are kept when {@link isClaudeFamilyModel} — the rule every Claude client
 * shares — says they run on Claude. Plain models stay limited to `claude-*` IDs, the ones
 * {@link PREFERRED_CLAUDE_MODELS} can match.
 */
export function toDesktopModels(entries: readonly DesktopCatalogEntry[]): DesktopModel[] {
  const routers: DesktopModel[] = [];
  const models: DesktopModel[] = [];
  for (const entry of entries) {
    const id = entry.id || entry.base_name || entry.deployment_name;
    if (typeof id !== 'string' || entry.enabled === false) continue;
    // A router the backend declares is never offered as a plain model, even when it is not Claude-family.
    if (isRouterModel(entry)) {
      if (isClaudeFamilyModel(entry)) routers.push({ id, label: entry.label, isRouter: true });
    } else if (ROUTER_MODEL_PATTERN.test(id)) {
      // An OpenAI-style reply carries no router flag, so only the alias can tell.
      routers.push({ id, label: entry.label, isRouter: true });
    } else if (CLAUDE_ID_PATTERN.test(id)) {
      models.push({ id, label: entry.label, isRouter: false });
    }
  }
  const nonVertexModels = models.filter((model) => !/-vertex$/i.test(model.id));
  return [...(nonVertexModels.length > 0 ? nonVertexModels : models), ...routers];
}

/**
 * Resolve each entry in {@link PREFERRED_CLAUDE_MODELS} against the catalog via
 * {@link resolveTenantModelId} — exact match, a dated variant (latest if multiple),
 * or a `-vertex` variant, in that order. Entries with no available match are
 * dropped silently.
 *
 * Preserves the order of {@link PREFERRED_CLAUDE_MODELS}.
 */
export function selectPreferredClaudeModels(
  available: string[],
  preferred: readonly string[] = PREFERRED_CLAUDE_MODELS
): string[] {
  const resolved: string[] = [];
  const missingPreferredModels: string[] = [];
  for (const name of preferred) {
    const match = resolveTenantModelId(name, available);
    if (match) {
      resolved.push(match);
    } else {
      missingPreferredModels.push(name);
    }
  }
  logger.info(
    '[proxy] Preferred Claude model selection completed',
    ...sanitizeLogArgs({
      preferredModels: [...preferred],
      availableClaudeModels: available,
      selectedModels: resolved,
      missingPreferredModels,
    })
  );
  return resolved;
}

/**
 * Build the ordered model list Claude Desktop is offered; its first entry is Desktop's default.
 *
 * Three groups, in this order:
 * 1. The curated pick: {@link selectPreferredClaudeModels} collapsed to the first
 *    (highest-priority) resolved ID per Opus, Sonnet and Haiku family, in
 *    {@link PREFERRED_CLAUDE_MODELS} order.
 * 2. Every router, in catalog order.
 * 3. Every other plain model, in catalog order. Only the exact picked IDs are left out,
 *    so dated, undated and version-first variants of a picked model still appear.
 */
export function selectDesktopClaudeModels(
  available: readonly DesktopModel[],
  preferred: readonly string[] = PREFERRED_CLAUDE_MODELS
): DesktopModel[] {
  const byId = new Map(available.map((model) => [model.id, model]));
  const resolved = selectPreferredClaudeModels(
    available.filter((model) => !model.isRouter).map((model) => model.id),
    preferred
  );
  // Routers (e.g. `claude-router-standard`, `sy-signal-claude-v1`) are not tied to a family, so
  // they bypass the curated list and are always offered when the gateway serves them.
  const routers = available.filter((model) => model.isRouter);
  let opusKept = false;
  let sonnetKept = false;
  let haikuKept = false;
  const picked = resolved.filter((id) => {
    if (/^claude-opus-/i.test(id)) {
      if (opusKept) return false;
      opusKept = true;
      return true;
    }
    if (/^claude-sonnet-/i.test(id)) {
      if (sonnetKept) return false;
      sonnetKept = true;
      return true;
    }
    if (/^claude-haiku-/i.test(id)) {
      if (haikuKept) return false;
      haikuKept = true;
      return true;
    }
    return true;
  });
  const pickedIds = new Set(picked);
  const remaining = available.filter((model) => !model.isRouter && !pickedIds.has(model.id));
  return [...picked.map((id) => byId.get(id) ?? { id, isRouter: false }), ...routers, ...remaining];
}

/**
 * Prefix of the ID an extra (non-Claude) model is offered to Desktop under. Desktop accepts
 * only IDs that read as Claude and rejects any that name another model family (`grok`,
 * `gpt`, ...), in discovery and in `inferenceModels` alike. So an extra model is listed under
 * `claude-x-<hash>`, an opaque ID that never spells a family name, with its real name as the
 * display name; {@link resolveDesktopExtraModelId} maps it back before the request goes upstream.
 */
const DESKTOP_EXTRA_MODEL_PREFIX = 'claude-x-';
/** Hex only (0-9, a-f), so the hash can never contain a model family name. */
const DESKTOP_EXTRA_MODEL_HASH_LENGTH = 10;

/** The ID Desktop is offered for an extra model's real (stored) ID. Deterministic, so no state is kept. */
export function desktopExtraModelAlias(realId: string): string {
  const hash = createHash('sha256').update(realId).digest('hex').slice(0, DESKTOP_EXTRA_MODEL_HASH_LENGTH);
  return `${DESKTOP_EXTRA_MODEL_PREFIX}${hash}`;
}

/**
 * The real model ID behind an ID Desktop sends: the extra model whose alias it is, or
 * `undefined` when it is not an alias of one of `extraIds`.
 */
export function resolveDesktopExtraModelId(id: string, extraIds: readonly string[]): string | undefined {
  if (!id.startsWith(DESKTOP_EXTRA_MODEL_PREFIX)) return undefined;
  return extraIds.find((extraId) => desktopExtraModelAlias(extraId) === id);
}

/**
 * Appends the non-Claude models the profile opted into (`claudeExtraModels`, see
 * {@link resolveClaudeExtraModels}) after the Claude lineup, under their opaque
 * alias ({@link desktopExtraModelAlias}) and their real name as the label. Ids the catalog no
 * longer serves are skipped, and a model already in the lineup is not listed twice.
 */
export function withDesktopExtraModels(
  models: readonly DesktopModel[],
  catalog: readonly LlmModel[],
  extraIds: readonly string[]
): DesktopModel[] {
  const listed = new Set(models.map((model) => model.id));
  const extras: DesktopModel[] = [];
  for (const extraId of extraIds) {
    const [model] = resolveClaudeExtraModels(catalog, [extraId]);
    if (!model || catalogModelIdentifiers(model).some((id) => listed.has(id))) continue;
    catalogModelIdentifiers(model).forEach((id) => listed.add(id));
    extras.push({
      id: desktopExtraModelAlias(extraId),
      label: model.label || extraId,
      isRouter: isRouterModel(model),
    });
  }
  return [...models, ...extras];
}

/**
 * The name Desktop shows: the model's CodeMie name, so its picker matches the web. A
 * router without one would show the raw ID, so derive a name: `claude-router-premium` →
 * `Router Premium`. A model without one keeps Desktop's built-in display name (undefined).
 */
export function desktopModelDisplayName(model: DesktopModel): string | undefined {
  const label = model.label?.trim();
  if (label) return label;
  if (!model.isRouter) return undefined;
  return model.id
    .replace(/^claude-/i, '')
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
