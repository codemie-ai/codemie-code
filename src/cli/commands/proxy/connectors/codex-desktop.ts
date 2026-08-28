/**
 * Connector that points the Codex desktop app (Codex inside the ChatGPT desktop
 * app) at the local CodeMie proxy by splicing a managed provider block into the
 * user's `~/.codex/config.toml`.
 *
 * CodeMie never installs, launches or patches the app — the shared config file
 * that the app and the Codex CLI both read is the whole integration seam.
 */
import { existsSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';

import { rankCodexModelIdsByRecency } from '@/agents/plugins/codex/codex-models.js';
import type { LlmModel } from '@/providers/plugins/sso/sso.http-client.js';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { getCodemiePath } from '@/utils/paths.js';

import { sanitizeLogArgs } from '@/utils/security.js';

import {
  CODEMIE_PROVIDER_ID,
  buildManagedBlocks,
  findManagedRegions,
  spliceManagedBlocks,
  stripManagedRegions,
} from './codex-config-toml.js';
import { resolveCodexDeployment } from '@/providers/plugins/sso/proxy/plugins/codex-model-resolver.js';

import { writeAtomically } from './vscode.js';

/**
 * Resolve the config file the desktop app reads.
 *
 * Deliberately NOT `getCodexHomePath()` from the codex agent plugin. That helper
 * is used by code paths which redirect `CODEX_HOME` to a CodeMie-isolated home
 * for the CLI they spawn, and the desktop app never reads that home. A
 * `CODEX_HOME` visible here belongs to the user, and upstream documents the app
 * respecting it, so it is honoured.
 */
export function getCodexDesktopConfigPath(): string {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  return join(codexHome, 'config.toml');
}

/** Where the connector records what it owns, mirroring the Claude Desktop precedent. */
export function getCodexDesktopStatePath(): string {
  return getCodemiePath('proxy', 'codex-desktop-state.json');
}

/** Install locations for the ChatGPT desktop app, which is what ships Codex. */
export function getCodexDesktopAppCandidates(): string[] {
  const home = homedir();
  if (process.platform === 'darwin') {
    return [
      '/Applications/ChatGPT.app',
      join(home, 'Applications', 'ChatGPT.app'),
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    return [
      join(localAppData, 'Programs', 'ChatGPT'),
      join(programFiles, 'ChatGPT'),
    ];
  }
  return [];
}

/** First candidate path that exists, or null. */
export function findCodexDesktopApp(
  candidates: string[] = getCodexDesktopAppCandidates()
): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Bound on the connect-time model listing. */
const MODEL_LIST_TIMEOUT_MS = 15000;

/** Suffix for the pre-connect snapshot of the user's Codex config. */
export const BACKUP_SUFFIX = '.codemie-backup';

/**
 * Snapshot the config only when CodeMie does not already own part of it.
 *
 * Keyed on marker presence rather than backup presence on purpose. Once our
 * block is in the file, the existing backup is the true pre-CodeMie original and
 * must not be replaced by a copy that already contains our block — which is the
 * bug the Kimi hook injector's create-once backup has.
 */
export async function backupIfUnmanaged(
  configPath: string,
  currentText: string
): Promise<string | null> {
  if (!existsSync(configPath)) return null;

  const backupPath = `${configPath}${BACKUP_SUFFIX}`;
  const regions = findManagedRegions(currentText);
  const alreadyManaged = regions.header !== null || regions.table !== null;

  if (alreadyManaged) {
    if (existsSync(backupPath)) {
      logger.debug('[proxy] Codex config already managed; keeping existing backup', { backupPath });
      return backupPath;
    }
    // Managed but the backup is gone. Copying the file as-is would enshrine our
    // own block — bearer token included — as the "pre-connect original", and a
    // later disconnect fallback would restore the credential. Reconstruct the
    // original by stripping the managed regions instead.
    await writeAtomically(backupPath, stripManagedRegions(currentText));
    logger.debug('[proxy] Rebuilt missing Codex config backup without managed content', { backupPath });
    return backupPath;
  }

  await copyFile(configPath, backupPath);
  logger.debug('[proxy] Backed up Codex config', { configPath, backupPath });
  return backupPath;
}

/**
 * Discover Codex-compatible model ids through the local proxy.
 *
 * Discovery goes through the proxy rather than the backend so the connector
 * exercises exactly the path the app will use — a broken proxy fails here,
 * before the config is written, rather than after.
 */
export async function discoverCodexModels(
  proxyUrl: string,
  gatewayKey: string
): Promise<string[]> {
  const url = new URL('/v1/llm_models?include_all=true', proxyUrl).toString();

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${gatewayKey}` },
      // A proxy that accepts the socket but never answers would otherwise hang
      // `proxy connect` indefinitely, after the daemon has already started.
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ConfigurationError(
      `Could not reach the local proxy at ${proxyUrl} to list models: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
    throw new ConfigurationError(`Local proxy returned ${response.status} for ${url}.`);
  }

  const payload = (await response.json()) as LlmModel[] | { data?: LlmModel[] };
  const entries = Array.isArray(payload) ? payload : (payload.data ?? []);

  // Ranked newest-first. The gateway's own order is arbitrary and in practice
  // lists the oldest GPT-5 first, so taking entries[0] would pin a stale model.
  const ids = rankCodexModelIdsByRecency(entries);

  if (ids.length === 0) {
    throw new ConfigurationError(
      'The local proxy exposes no GPT/Codex-compatible model. ' +
      'Enable a GPT-5/Codex deployment in CodeMie, then re-run this command.'
    );
  }

  return ids;
}

/**
 * Choose the model to pin.
 *
 * An explicit request is resolved with the same rule the proxy applies to
 * in-flight requests, so `--model gpt-5.6-luna` — the undated name the app's
 * model picker displays — pins the dated deployment behind it rather than being
 * rejected. Anything with no CodeMie equivalent is an error here: at connect
 * time the user is present and can be told, so silently substituting would mean
 * they run something other than what they asked for.
 */
export function selectCodexModel(
  discovered: string[],
  requested?: string,
  profileModel?: string
): string {
  if (requested !== undefined) {
    if (requested.trim() === '') {
      throw new ConfigurationError('--model was given an empty value.');
    }

    const resolution = resolveCodexDeployment(requested.trim(), discovered, undefined);
    if (resolution.kind === 'exact' || resolution.kind === 'resolved') return resolution.model;

    throw new ConfigurationError(
      `Model "${requested}" is not available through the proxy. Available: ${discovered.join(', ')}`
    );
  }

  // No explicit --model: prefer the active profile's configured model, resolved
  // to its dated deployment the same way an in-flight request is. Only when it
  // has no CodeMie equivalent do we drop to the recency-ranked default.
  const profile = profileModel?.trim();
  if (profile) {
    const resolution = resolveCodexDeployment(profile, discovered, undefined);
    if (resolution.kind === 'exact' || resolution.kind === 'resolved') return resolution.model;
  }

  return discovered[0];
}

export interface CodexDesktopState {
  configPath: string;
  backupPath: string | null;
  model: string;
  writtenAt: string;
}

export interface WriteCodexDesktopConfigOptions {
  configPath: string;
  statePath: string;
  proxyUrl: string;
  baseUrl: string;
  gatewayKey: string;
  model: string;
  force?: boolean;
}

/** Read the config, or empty text when the file does not exist yet. */
async function readConfigText(configPath: string): Promise<string> {
  if (!existsSync(configPath)) return '';
  return readFile(configPath, 'utf-8');
}

/** Parse for validation only — the file itself is never re-serialized. */
function parseOrThrow(text: string, configPath: string): Record<string, unknown> {
  try {
    return TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigurationError(
      `Codex config at ${configPath} is not valid TOML and was not changed: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Splice the managed block into the user's Codex config and record ownership.
 *
 * The marker state is written BEFORE the config on purpose. If the config write
 * then fails, the marker over-claims — and removal is idempotent, so that is
 * harmless. The reverse order is genuinely unsafe: a written config with no
 * marker is one CodeMie can no longer recognize as its own.
 */
export async function writeCodexDesktopConfig(
  options: WriteCodexDesktopConfigOptions
): Promise<CodexDesktopState> {
  const currentText = await readConfigText(options.configPath);

  // Validate and check for conflicts before touching anything on disk.
  if (currentText.trim() !== '') {
    const parsed = parseOrThrow(currentText, options.configPath);
    const active = parsed.model_provider;
    if (!options.force && typeof active === 'string' && active !== CODEMIE_PROVIDER_ID) {
      throw new ConfigurationError(
        `Codex config already selects model_provider "${active}". ` +
        'Re-run with --force to replace it with the CodeMie provider.'
      );
    }
  }

  const backupPath = await backupIfUnmanaged(options.configPath, currentText);

  const state: CodexDesktopState = {
    configPath: options.configPath,
    backupPath,
    model: options.model,
    writtenAt: new Date().toISOString(),
  };
  await writeAtomically(options.statePath, `${JSON.stringify(state, null, 2)}\n`);

  const blocks = buildManagedBlocks({
    baseUrl: options.baseUrl,
    gatewayKey: options.gatewayKey,
    model: options.model,
  });
  const next = spliceManagedBlocks(currentText, blocks);

  // Validate what we are about to write, not just what we read. Every splice
  // edge case — a duplicated region, an unrecognized quoted key, a value that
  // escaping did not cover — surfaces here instead of landing a broken
  // config.toml on the user's disk.
  try {
    TOML.parse(next);
  } catch (error) {
    throw new ConfigurationError(
      `Refusing to write ${options.configPath}: the result would not be valid TOML ` +
      `(${error instanceof Error ? error.message : String(error)}). The file is unchanged.`
    );
  }

  await writeAtomically(options.configPath, next);

  // The gateway key is deliberately absent: sanitizeLogArgs redacts by key name,
  // and `gatewayKey` matches none of its patterns, so passing it would write the
  // credential to the log in cleartext. Nothing here needs it.
  logger.info(
    '[proxy] Codex desktop configuration written',
    ...sanitizeLogArgs({
      configPath: options.configPath,
      backupPath,
      model: options.model,
      baseUrl: options.baseUrl,
    })
  );

  return state;
}

/**
 * Throw when a stripped config still carries CodeMie-owned keys.
 *
 * The post-strip check for disconnect: a parseable result that still selects the
 * CodeMie provider means removal did not actually happen, which is what occurs
 * when the managed sentinels have been lost.
 */
function assertNoCodeMieKeys(parsed: Record<string, unknown>): void {
  if (parsed.model_provider === CODEMIE_PROVIDER_ID) {
    throw new Error(`model_provider is still "${CODEMIE_PROVIDER_ID}"`);
  }
  const providers = parsed.model_providers;
  if (providers !== null && typeof providers === 'object'
    && CODEMIE_PROVIDER_ID in (providers as Record<string, unknown>)) {
    throw new Error(`model_providers.${CODEMIE_PROVIDER_ID} is still present`);
  }
}

export interface RemoveCodexDesktopResult {
  removed: boolean;
  usedBackup: boolean;
  configPath: string | null;
}

/**
 * Remove the managed block, restoring the file to its pre-connect content.
 *
 * The surgical strip is the primary path rather than a wholesale backup restore:
 * a blind restore would also throw away any edits the user made to their Codex
 * config while connected. The backup is the fallback for when stripping cannot
 * produce a parseable file.
 */
export async function removeCodexDesktopConfig(
  statePath: string = getCodexDesktopStatePath()
): Promise<RemoveCodexDesktopResult> {
  if (!existsSync(statePath)) {
    return { removed: false, usedBackup: false, configPath: null };
  }

  const raw = await readFile(statePath, 'utf-8');
  if (raw.trim() === '') {
    return { removed: false, usedBackup: false, configPath: null };
  }

  let state: CodexDesktopState;
  try {
    state = JSON.parse(raw) as CodexDesktopState;
  } catch (error) {
    throw new ConfigurationError(
      `CodeMie Codex desktop state at ${statePath} is unreadable: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!existsSync(state.configPath)) {
    await writeAtomically(statePath, '');
    return { removed: false, usedBackup: false, configPath: state.configPath };
  }

  const currentText = await readFile(state.configPath, 'utf-8');
  const stripped = stripManagedRegions(currentText);

  let nextText = stripped;
  let usedBackup = false;
  try {
    if (stripped.trim() !== '') {
      const parsed = TOML.parse(stripped) as Record<string, unknown>;
      // Parsing is not enough: if the sentinels were lost the strip is a silent
      // no-op, and reporting success would leave the CodeMie provider — and its
      // bearer header — in the user's config.
      assertNoCodeMieKeys(parsed);
    }
  } catch {
    if (!state.backupPath || !existsSync(state.backupPath)) {
      throw new ConfigurationError(
        `Could not cleanly remove the CodeMie block from ${state.configPath} ` +
        '(the managed markers appear to be damaged or missing) and no backup is ' +
        `available to restore. Remove the model_provider and [model_providers.${CODEMIE_PROVIDER_ID}] ` +
        'entries by hand.'
      );
    }
    nextText = await readFile(state.backupPath, 'utf-8');
    usedBackup = true;
    logger.warn(
      '[proxy] Surgical removal of the CodeMie Codex block failed; restored the backup',
      ...sanitizeLogArgs({ configPath: state.configPath, backupPath: state.backupPath })
    );
  }

  await writeAtomically(state.configPath, nextText);
  await writeAtomically(statePath, '');

  return { removed: true, usedBackup, configPath: state.configPath };
}
