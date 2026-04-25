/**
 * OpenCode Config Merger
 * ======================
 *
 * Optional merging of CodeMie-generated OpenCode config with the user's
 * existing `~/.config/opencode/config.json`.
 *
 * Activated by the `--merge-providers` CLI flag on `codemie-opencode`
 * (see AgentCLI.setupProgram). When enabled, the user retains access to their
 * own opencode providers (e.g. anthropic, github-copilot, openrouter, etc.)
 * while also getting the freshly-fetched CodeMie SSO model catalogue.
 *
 * ## Merge Rules
 *
 * Fields in CodeMie-generated config always win for the keys CodeMie owns,
 * because those keys are wired to the local SSO proxy and are refreshed on
 * every launch. The user's other providers are passed through untouched.
 *
 * | Field                          | Winner                                           |
 * |--------------------------------|--------------------------------------------------|
 * | provider.codemie-proxy         | CodeMie (always replaced – fresh models)         |
 * | provider.openai                | CodeMie if Responses-API models exist, else user |
 * | provider.ollama                | CodeMie (CodeMie owns the baseURL/timeout)       |
 * | provider.amazon-bedrock        | CodeMie when provider='bedrock', else user       |
 * | provider.<other-key>           | User (pass-through)                              |
 * | enabled_providers              | Removed entirely                                  |
 * | model                          | User's value preserved if set, else CodeMie's    |
 * | plugin                         | Union, deduplicated                              |
 * | share / other top-level fields | CodeMie (preserves existing behaviour)           |
 *
 * ## Safety
 *
 * - Function is failure-isolated: any IO or parse error logs a warning and
 *   returns without mutating the CodeMie config. Opencode still launches.
 * - The user's config file is never written. Read-only operation.
 * - Proxy/SSO plumbing is not altered: the `codemie-proxy` entry is always
 *   the CodeMie-generated one, keeping baseURL pointing at the local proxy.
 * - `enabled_providers` is removed when merging. In upstream opencode this
 *   field is a hard whitelist, and leaving it in place would hide providers
 *   authenticated outside config.json (for example GitHub Copilot credentials
 *   stored in opencode's auth.json).
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getOpenCodeConfigDir } from './opencode.paths.js';
import { logger } from '../../../utils/logger.js';

/**
 * Provider keys whose entries are owned by CodeMie when present in the
 * CodeMie-generated config. Overriding these would break the proxy wiring
 * (baseURL, apiKey, freshly-fetched model list).
 *
 * Note: `openai` is in this list only because OpenCode's built-in `openai`
 * CUSTOM_LOADER shares the provider key with the Responses API wiring.
 * When CodeMie emits an `openai` entry, it is tied to the local proxy URL
 * and must win; otherwise the user's `openai` entry is preserved.
 */
const CODEMIE_OWNED_PROVIDER_KEYS = [
  'codemie-proxy',
  'openai',
  'ollama',
  'amazon-bedrock',
] as const;

/**
 * Top-level keys that come from CodeMie and should always win when set.
 * Intentionally excludes `model` (user's model preserved if set) and
 * `provider` / `enabled_providers` / `plugin` (handled by merge rules).
 */
const CODEMIE_OWNED_TOPLEVEL_KEYS = new Set(['share']);

type UnknownRecord = Record<string, unknown>;

/**
 * Read the user's opencode config from the standard XDG path.
 *
 * Returns `null` if:
 * - The file does not exist (not an error — user just hasn't created one)
 * - The file is unreadable or contains invalid JSON (warns + returns null)
 *
 * @param filePath Optional override, primarily for tests. Defaults to
 *                 `getOpenCodeConfigDir()/config.json`.
 */
export async function readUserOpenCodeConfig(
  filePath?: string,
): Promise<UnknownRecord | null> {
  const path = filePath ?? join(getOpenCodeConfigDir(), 'config.json');

  if (!existsSync(path)) {
    logger.debug(`[opencode-merge] No user opencode config found at ${path}; merge is a no-op`);
    return null;
  }

  try {
    const raw = await readFile(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn(`[opencode-merge] User opencode config at ${path} is not a JSON object; skipping merge`);
      return null;
    }
    return parsed as UnknownRecord;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[opencode-merge] Failed to read/parse user opencode config at ${path}: ${message}`);
    return null;
  }
}

/**
 * Merge two provider maps. CodeMie-owned keys win when present in the
 * CodeMie map; all other keys from the user map are passed through.
 *
 * @param codeMieProviders - Provider map from CodeMie-generated config
 * @param userProviders    - Provider map from the user's config (may be empty)
 * @param ownedKeys        - Keys CodeMie owns unconditionally when it has them
 */
export function mergeProviderMaps(
  codeMieProviders: UnknownRecord,
  userProviders: UnknownRecord,
  ownedKeys: readonly string[] = CODEMIE_OWNED_PROVIDER_KEYS,
): UnknownRecord {
  const result: UnknownRecord = {};
  const ownedSet = new Set(ownedKeys);

  // Start with user's providers — these are the "extras" the user wants to keep
  for (const [key, value] of Object.entries(userProviders)) {
    if (ownedSet.has(key) && key in codeMieProviders) {
      // CodeMie owns this key and has emitted it → CodeMie wins, skip user's entry
      continue;
    }
    result[key] = value;
  }

  // Overlay CodeMie providers (always win when CodeMie emitted them)
  for (const [key, value] of Object.entries(codeMieProviders)) {
    result[key] = value;
  }

  return result;
}

/**
 * Merge two `enabled_providers` arrays.
 *
 * Legacy helper retained for explicit unit coverage and possible future use.
 *
 * IMPORTANT: `mergeOpenCodeProviders()` intentionally does NOT use this result
 * in the final merged config. In upstream opencode, `enabled_providers` is a
 * hard whitelist. Keeping any whitelist in the injected config would hide
 * authenticated providers that come from opencode's auth store rather than
 * from config.json (for example GitHub Copilot).
 */
export function mergeEnabledProviders(
  codeMieList: unknown,
  userList: unknown,
): string[] {
  const codeMieArr = Array.isArray(codeMieList)
    ? codeMieList.filter((x): x is string => typeof x === 'string')
    : [];
  const userArr = Array.isArray(userList)
    ? userList.filter((x): x is string => typeof x === 'string')
    : [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...codeMieArr, ...userArr]) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Merge two `plugin` arrays (file:// URLs to opencode plugins).
 * Order: CodeMie's plugins first (hooks plugin, etc.), user's appended.
 * Duplicates removed.
 */
export function mergePluginArrays(
  codeMieList: unknown,
  userList: unknown,
): string[] | undefined {
  const codeMieArr = Array.isArray(codeMieList)
    ? codeMieList.filter((x): x is string => typeof x === 'string')
    : [];
  const userArr = Array.isArray(userList)
    ? userList.filter((x): x is string => typeof x === 'string')
    : [];

  if (codeMieArr.length === 0 && userArr.length === 0) return undefined;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...codeMieArr, ...userArr]) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Merge the user's opencode config into the CodeMie-generated config **in place**.
 *
 * This is the primary entry point invoked from `OpenCodePlugin.beforeRun` when
 * `--merge-providers` is active.
 *
 * If there is no user config, or the file is unreadable/invalid, the CodeMie
 * config is returned untouched and a debug/warn is logged. The caller should
 * always proceed with `codeMieConfig` regardless of merge outcome.
 *
 * @param codeMieConfig - The CodeMie-generated config object (mutated in place)
 * @param filePath      - Optional override for the user config path (tests only)
 */
export async function mergeOpenCodeProviders(
  codeMieConfig: UnknownRecord,
  filePath?: string,
): Promise<void> {
  const userConfig = await readUserOpenCodeConfig(filePath);
  if (!userConfig) return;

  // --- providers ---
  const codeMieProviders = isRecord(codeMieConfig.provider) ? codeMieConfig.provider : {};
  const userProviders = isRecord(userConfig.provider) ? userConfig.provider : {};
  codeMieConfig.provider = mergeProviderMaps(codeMieProviders, userProviders);

  // Upstream opencode treats `enabled_providers` as a hard whitelist. That is
  // correct for CodeMie-only launches, but it breaks `--merge-providers`
  // because providers authenticated outside config.json (for example Copilot in
  // opencode's auth.json) are loaded by opencode and then filtered out by the
  // whitelist. Remove the field entirely so all authenticated providers remain
  // visible while still merging our provider definitions.
  delete codeMieConfig.enabled_providers;

  // --- model: preserve user's value if set ---
  if (typeof userConfig.model === 'string' && userConfig.model.length > 0) {
    logger.debug(
      `[opencode-merge] Preserving user's top-level model: "${userConfig.model}" ` +
      `(CodeMie's computed model "${String(codeMieConfig.model)}" is still available via the codemie-proxy provider)`,
    );
    codeMieConfig.model = userConfig.model;
  }

  // --- plugin: union, deduplicated ---
  const mergedPlugins = mergePluginArrays(codeMieConfig.plugin, userConfig.plugin);
  if (mergedPlugins) {
    codeMieConfig.plugin = mergedPlugins;
  }

  // --- pass through any extra top-level keys from user config that CodeMie
  //     does not set (e.g. mcp servers, mode, autoshare overrides). CodeMie's
  //     top-level values always win for the keys it emits. ---
  for (const [key, value] of Object.entries(userConfig)) {
    if (key === 'provider' || key === 'enabled_providers' || key === 'model' || key === 'plugin') continue;
    if (CODEMIE_OWNED_TOPLEVEL_KEYS.has(key)) continue; // CodeMie wins
    if (key in codeMieConfig) continue;                 // CodeMie already set it
    codeMieConfig[key] = value;
  }

  const mergedProviderCount = Object.keys(codeMieConfig.provider as UnknownRecord).length;
  logger.info(
    `[opencode-merge] Merged user opencode config: ${mergedProviderCount} providers total in final config`,
  );
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Export owned key list so tests can assert against a single source of truth
export { CODEMIE_OWNED_PROVIDER_KEYS };
