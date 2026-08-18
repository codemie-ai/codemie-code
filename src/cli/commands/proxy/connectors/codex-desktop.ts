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

import { isCodexCompatibleModelName } from '@/agents/plugins/codex/codex-models.js';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { getCodemiePath } from '@/utils/paths.js';

import { sanitizeLogArgs } from '@/utils/security.js';

import {
  CODEMIE_PROVIDER_ID,
  buildManagedBlocks,
  findManagedRegions,
  spliceManagedBlocks,
} from './codex-config-toml.js';
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

  if (alreadyManaged && existsSync(backupPath)) {
    logger.debug('[proxy] Codex config already managed; keeping existing backup', { backupPath });
    return backupPath;
  }

  await copyFile(configPath, backupPath);
  logger.debug('[proxy] Backed up Codex config', { configPath, backupPath });
  return backupPath;
}

/** The fields of a gateway model-list entry this connector reads. */
interface GatewayModelEntry {
  deployment_name?: string;
  base_name?: string;
  enabled?: boolean;
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
    response = await fetch(url, { headers: { Authorization: `Bearer ${gatewayKey}` } });
  } catch (error) {
    throw new ConfigurationError(
      `Could not reach the local proxy at ${proxyUrl} to list models: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
    throw new ConfigurationError(`Local proxy returned ${response.status} for ${url}.`);
  }

  const payload = (await response.json()) as GatewayModelEntry[] | { data?: GatewayModelEntry[] };
  const entries = Array.isArray(payload) ? payload : (payload.data ?? []);

  const ids = entries
    .filter((entry) => entry.enabled !== false)
    .map((entry) => entry.deployment_name ?? entry.base_name)
    .filter(isCodexCompatibleModelName);

  if (ids.length === 0) {
    throw new ConfigurationError(
      'The local proxy exposes no GPT/Codex-compatible model. ' +
      'Enable a GPT-5/Codex deployment in CodeMie, then re-run this command.'
    );
  }

  return ids;
}

/**
 * Choose the model to pin. An explicit request must exist in the discovered set:
 * silently substituting a different model would mean the user runs something
 * other than what they asked for.
 */
export function selectCodexModel(discovered: string[], requested?: string): string {
  if (!requested) return discovered[0];
  if (discovered.includes(requested)) return requested;
  throw new ConfigurationError(
    `Model "${requested}" is not available through the proxy. Available: ${discovered.join(', ')}`
  );
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
  await writeAtomically(options.configPath, spliceManagedBlocks(currentText, blocks));

  logger.info(
    '[proxy] Codex desktop configuration written',
    ...sanitizeLogArgs({
      configPath: options.configPath,
      backupPath,
      model: options.model,
      baseUrl: options.baseUrl,
      gatewayKey: options.gatewayKey,
    })
  );

  return state;
}
