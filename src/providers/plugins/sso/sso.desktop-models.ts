/**
 * The Claude Desktop model list, built from a CodeMie catalog.
 *
 * Shared by the Desktop connector (`codemie proxy connect --claude-desktop`, which checks the
 * list before it configures Desktop) and the proxy's `GET /v1/models`, which Desktop calls
 * on start to fill its picker.
 */

import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { isClaudeFamilyModel, isRouterModel, type ModelFamilyFields } from '../../../utils/model-family.js';
import { resolveTenantModelId } from './sso.model-name-resolver.js';

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
 * Curated list of Claude models we expose by default.
 *
 * Each entry is matched against the catalog either as an exact ID or as
 * `<entry>-<YYYYMMDD>` (the dated variant). The actual resolved ID is what
 * Desktop is offered, so the gateway receives a model name it has registered.
 *
 * Opus, Sonnet, and Haiku entries are listed in descending preference
 * (`opus: 5.5 → 5 → 4-8 → 4-7 → 4-6 → 3`, `sonnet: 5.5 → 5 → 4-6`, `haiku: 5.5 → 4-5`):
 * {@link selectDesktopClaudeModels} collapses each family to the single
 * highest-priority ID the gateway actually serves, so Desktop never shows more
 * than one Opus, Sonnet, or Haiku (matching the latest cloud Desktop lineup).
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
 * Build the exact model set Claude Desktop should be offered.
 *
 * Resolves the curated preferred list via {@link selectPreferredClaudeModels},
 * then collapses the opus, sonnet, and haiku families to a single entry each:
 * the first (highest-priority) ID that resolved. With preferred order
 * `opus: 5.5 → 5 → 4-8 → 4-7 → 4-6 → 3`, `sonnet: 5.5 → 5 → 4-6`, and
 * `haiku: 5.5 → 4-5` in {@link PREFERRED_CLAUDE_MODELS}, this exposes the
 * highest-priority model in each family when the gateway serves it and
 * otherwise falls back to the next-best available ID. Order is preserved.
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
  const models = resolved.filter((id) => {
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
  return [...models.map((id) => byId.get(id) ?? { id, isRouter: false }), ...routers];
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
