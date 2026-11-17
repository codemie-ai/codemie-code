/**
 * Resolver for the cloud-provider settings conflict.
 *
 * Reads every source that can switch Claude to a cloud provider for one flow, ranks the layers the way
 * Claude Code does and returns one result per layer plus a verdict. It reads only; nothing here writes,
 * prompts or exits. Setting values never leave this module: results carry paths and key names only.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { flagState } from '@/agents/core/evidence/routing.js';
import {
  defaultCommandRunner,
  managedSettingsPaths,
  readManagedDropIns,
  readManagedPlist,
  readManagedRegistry,
  readSettingsLayer,
  settingsLayerPaths,
  type CommandRunner,
  type SettingsLayerResult,
  type SettingsLayerState,
} from '@/agents/plugins/claude-code-otlp/event-fields/claude-settings-env.js';
import { logger } from '@/utils/logger.js';
import type { CloudProviderDescriptor } from './provider.js';

/** `connect-otlp-only` reads nothing: the gate only warns for it. */
export type ConflictFlow = 'claude-agent' | 'install' | 'connect-desktop' | 'connect-vscode' | 'connect-otlp-only';

export type ConflictScope =
  | 'user'
  | 'project'
  | 'project-local'
  | 'managed'
  | 'env'
  | 'vscode'
  | 'desktop-applied'
  | 'desktop-managed';

/** Whether a layer defines the provider flag and, if so, how it reads: `unset` means the layer does not define it. */
export type ConflictFlagValue = 'on' | 'off' | 'unknown' | 'unset';

export type ConflictVerdict = 'none' | 'conflict-editable' | 'conflict-managed' | 'unknown';

export interface ConflictLayer {
  /** File path, registry value path, or `process environment` for the shell env layer. */
  path: string;
  scope: ConflictScope;
  /** False for managed sources and the process environment. */
  editable: boolean;
  state: SettingsLayerState;
  /** This layer sets the flag on and is the layer that decides the flag in at least one source chain. */
  inEffect: boolean;
  /** This layer sets the flag on (whether or not a higher layer overrides it). */
  setsFlag: boolean;
  flag: ConflictFlagValue;
  /** Exact key to name in guidance: `env.<FLAG>` in Claude settings, the bare name in env/VS Code, `inferenceProvider` for Desktop. */
  flagKey: string;
  /** Names only: the flag, the flag-scoped keys found (only when the flag is on) and Bedrock-id model keys. */
  keyNames: string[];
  /** Names only: model keys whose value is a provider model id (`model`, `env.ANTHROPIC_MODEL`, `availableModels`; entry names for VS Code). */
  bedrockModelKeys: string[];
}

export interface ConflictResolution {
  verdict: ConflictVerdict;
  /** Claude settings layers highest first, then process env, then VS Code and Desktop layers. */
  layers: ConflictLayer[];
  /** Names the file and exact key; set whenever some source cannot be told. Never contains a value. */
  unknownReason?: string;
  warnings: string[];
}

/** Every file the resolver reads. Defaults for the Claude layers come from `settingsLayerPaths`/`managedSettingsPaths`. */
export interface ConflictPaths {
  userSettings?: string;
  projectSettings?: string;
  projectLocalSettings?: string;
  /** Managed settings files, highest first. */
  managedFiles?: string[];
  /** `managed-settings.d` directories; defaults to the one beside each managed file. */
  managedDropInDirs?: string[];
  managedPlist?: string;
  /** Applied Claude Desktop `configLibrary` file (connect-desktop). Supplied by the caller. */
  desktopApplied?: string;
  /** Claude Desktop managed settings file, or null where the platform has none (connect-desktop). */
  desktopManaged?: string | null;
  /** VS Code `settings.json` files, stable and Insiders; editions that do not exist are omitted (connect-vscode). */
  vscodeSettings?: string[];
}

export interface ConflictRunners {
  plutil?: CommandRunner;
  reg?: CommandRunner;
  /** Existence check for the managed plist; defaults to the filesystem. */
  plistExists?: (file: string) => boolean | Promise<boolean>;
  timeoutMs?: number;
}

export interface ResolveConflictInput {
  provider: CloudProviderDescriptor;
  flow: ConflictFlow;
  paths?: ConflictPaths;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  runners?: ConflictRunners;
}

const ENV_LAYER_PATH = 'process environment';
const VSCODE_ENV_KEY = 'claudeCode.environmentVariables';
const CLAUDE_FILE_SCOPES: readonly ConflictScope[] = ['user', 'project', 'project-local', 'managed'];

type Decision =
  | { kind: 'none' }
  | { kind: 'on'; layer: ConflictLayer }
  | { kind: 'unknown'; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Scalar flag values are classified by the shared rule; anything else cannot be told. */
function classifyFlag(value: unknown): ConflictFlagValue {
  if (value === undefined) return 'unset';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return flagState(String(value));
  return 'unknown';
}

interface KeyInfo {
  keyNames: string[];
  bedrockModelKeys: string[];
}

/** Key names found in an env-like map (and, for settings files, the top level). Names only, never values. */
function collectKeys(
  provider: CloudProviderDescriptor,
  env: Record<string, unknown>,
  top: Record<string, unknown> | undefined,
  envPrefix: string,
  flagOn: boolean
): KeyInfo {
  const keyNames: string[] = [];
  const bedrockModelKeys: string[] = [];
  if (env[provider.flag] !== undefined) keyNames.push(`${envPrefix}${provider.flag}`);
  if (flagOn) {
    for (const key of provider.flagScopedKeys.env) {
      if (key !== provider.flag && env[key] !== undefined) keyNames.push(`${envPrefix}${key}`);
    }
    for (const key of provider.flagScopedKeys.topLevel) {
      if (top?.[key] !== undefined) keyNames.push(key);
    }
  }
  for (const key of provider.modelKeys.env) {
    if (provider.isModelId(env[key])) bedrockModelKeys.push(`${envPrefix}${key}`);
  }
  if (top) {
    for (const key of provider.modelKeys.topLevel) {
      if (provider.isModelId(top[key])) bedrockModelKeys.push(key);
    }
    for (const key of provider.modelKeys.list) {
      const list = top[key];
      if (Array.isArray(list) && list.some((item) => provider.isModelId(item))) bedrockModelKeys.push(key);
    }
  }
  for (const name of bedrockModelKeys) if (!keyNames.includes(name)) keyNames.push(name);
  return { keyNames, bedrockModelKeys };
}

function makeLayer(
  base: Pick<ConflictLayer, 'path' | 'scope' | 'editable' | 'state'>,
  flag: ConflictFlagValue,
  flagKey: string,
  keys: KeyInfo = { keyNames: [], bedrockModelKeys: [] }
): ConflictLayer {
  return { ...base, inEffect: false, setsFlag: flag === 'on', flag, flagKey, ...keys };
}

/** A Claude Code settings layer (user, project, local, managed): the flag lives in the `env` block. */
function settingsLayer(
  provider: CloudProviderDescriptor,
  result: SettingsLayerResult,
  scope: ConflictScope,
  editable: boolean
): ConflictLayer {
  const base = { path: result.path, scope, editable, state: result.state };
  const flagKey = `env.${provider.flag}`;
  const parsed = result.parsed;
  if (result.state !== 'ok' || !parsed) return makeLayer(base, 'unset', flagKey);
  const block = parsed.env;
  if (block !== undefined && !isPlainObject(block)) {
    // An `env` that is not an object could still carry the flag in some form: cannot tell.
    return makeLayer({ ...base, state: 'unreadable' }, 'unset', flagKey);
  }
  const env = block ?? {};
  const flag = classifyFlag(env[provider.flag]);
  return makeLayer(base, flag, flagKey, collectKeys(provider, env, parsed, 'env.', flag === 'on'));
}

function envLayer(provider: CloudProviderDescriptor, env: NodeJS.ProcessEnv): ConflictLayer {
  const raw = env[provider.flag];
  const defined = typeof raw === 'string' && raw !== '';
  const base = { path: ENV_LAYER_PATH, scope: 'env' as const, editable: false, state: defined ? ('ok' as const) : ('absent' as const) };
  return makeLayer(base, defined ? flagState(raw) : 'unset', provider.flag, {
    keyNames: defined ? [provider.flag] : [],
    bedrockModelKeys: [],
  });
}

/** Claude Desktop applied/managed config: `inferenceProvider: "bedrock"` selects the provider. */
function desktopLayer(
  provider: CloudProviderDescriptor,
  result: SettingsLayerResult,
  scope: 'desktop-applied' | 'desktop-managed',
  editable: boolean
): ConflictLayer {
  const base = { path: result.path, scope, editable, state: result.state };
  const flagKey = 'inferenceProvider';
  const parsed = result.parsed;
  if (result.state !== 'ok' || !parsed) return makeLayer(base, 'unset', flagKey);
  const value = parsed[flagKey];
  const flag: ConflictFlagValue =
    value === undefined ? 'unset' : typeof value === 'string' ? (value.trim().toLowerCase() === provider.name ? 'on' : 'off') : 'unknown';
  const keyNames: string[] = value === undefined ? [] : [flagKey];
  if (flag === 'on') keyNames.push(...Object.keys(parsed).filter((k) => k.startsWith(provider.desktopKeyPrefix)));
  return makeLayer(base, flag, flagKey, { keyNames, bedrockModelKeys: [] });
}

/** One VS Code settings file: `claudeCode.environmentVariables` entries, read as JSONC like the connector does. */
async function readVscodeLayer(provider: CloudProviderDescriptor, file: string): Promise<ConflictLayer> {
  const base = { path: file, scope: 'vscode' as const, editable: true };
  const flagKey = provider.flag;
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const missing = code === 'ENOENT' || code === 'ENOTDIR';
    return makeLayer({ ...base, state: missing ? 'absent' : 'unreadable' }, 'unset', flagKey);
  }
  if (raw.trim().length === 0) return makeLayer({ ...base, state: 'ok' }, 'unset', flagKey);
  const errors: ParseError[] = [];
  const parsed: unknown = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(parsed)) return makeLayer({ ...base, state: 'unreadable' }, 'unset', flagKey);
  const entries = parsed[VSCODE_ENV_KEY];
  const env: Record<string, unknown> = {};
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (isPlainObject(entry) && typeof entry.name === 'string') env[entry.name] = entry.value;
    }
  }
  const flag = classifyFlag(env[provider.flag]);
  return makeLayer({ ...base, state: 'ok' }, flag, flagKey, collectKeys(provider, env, undefined, '', flag === 'on'));
}

/** Highest layer that defines the flag decides; an unreadable layer reached first means cannot tell. */
function decide(chain: ConflictLayer[]): Decision {
  for (const layer of chain) {
    if (layer.state === 'absent') continue;
    if (layer.state === 'malformed' && CLAUDE_FILE_SCOPES.includes(layer.scope)) continue;
    if (layer.state === 'malformed' || layer.state === 'unreadable') {
      return { kind: 'unknown', reason: `${layer.path}: cannot be read, so it is unknown whether ${layer.flagKey} is set there` };
    }
    if (layer.flag === 'unset') continue;
    if (layer.flag === 'unknown') {
      return {
        kind: 'unknown',
        reason: `${layer.path}: ${layer.flagKey} has a value that is not a recognised on/off spelling (use 1/true/yes/on or 0/false/no/off)`,
      };
    }
    return layer.flag === 'on' ? { kind: 'on', layer } : { kind: 'none' };
  }
  return { kind: 'none' };
}

function malformedWarning(layer: ConflictLayer): string {
  return `${layer.path} is not valid JSON, so Claude Code ignores it; CodeMie analytics attribution stays unknown until the file is fixed.`;
}

export async function resolveProviderConflict(input: ResolveConflictInput): Promise<ConflictResolution> {
  const { provider, flow } = input;
  if (flow === 'connect-otlp-only') return { verdict: 'none', layers: [], warnings: [] };

  const started = Date.now();
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const paths = input.paths ?? {};
  const runners = input.runners ?? {};
  const timeoutMs = runners.timeoutMs;

  const agentFlow = flow === 'claude-agent' || flow === 'install';
  const defaults = settingsLayerPaths(cwd, env, platform);
  const managedFiles = paths.managedFiles ?? managedSettingsPaths(platform);
  const dropInDirs =
    paths.managedDropInDirs ?? (paths.managedFiles ? paths.managedFiles.map((f) => join(dirname(f), 'managed-settings.d')) : undefined);

  const [user, project, local, managedFileResults, dropIns, plist, registry, desktopApplied, desktopManaged, vscode] =
    await Promise.all([
      readSettingsLayer(paths.userSettings ?? defaults[0]),
      agentFlow ? readSettingsLayer(paths.projectSettings ?? defaults[1]) : undefined,
      agentFlow ? readSettingsLayer(paths.projectLocalSettings ?? defaults[2]) : undefined,
      Promise.all(managedFiles.map(readSettingsLayer)),
      readManagedDropIns(platform, dropInDirs),
      platform === 'darwin'
        ? readManagedPlist(runners.plutil ?? defaultCommandRunner, runners.plistExists, { file: paths.managedPlist, timeoutMs })
        : undefined,
      platform === 'win32' ? readManagedRegistry(runners.reg ?? defaultCommandRunner, { timeoutMs }) : undefined,
      flow === 'connect-desktop' && paths.desktopApplied ? readSettingsLayer(paths.desktopApplied) : undefined,
      flow === 'connect-desktop' && paths.desktopManaged ? readSettingsLayer(paths.desktopManaged) : undefined,
      flow === 'connect-vscode' ? Promise.all((paths.vscodeSettings ?? []).map((f) => readVscodeLayer(provider, f))) : undefined,
    ]);

  const managed = (r: SettingsLayerResult): ConflictLayer => settingsLayer(provider, r, 'managed', false);
  // Managed tier, highest first: OS policy (plist, HKLM), drop-ins (later name wins), managed file, HKCU.
  const registryLayers = (registry ?? []).map(managed);
  const managedChain: ConflictLayer[] = [
    ...(plist ? [managed(plist)] : []),
    ...registryLayers.filter((l) => l.path.startsWith('HKLM')),
    ...[...dropIns].reverse().map(managed),
    ...managedFileResults.map(managed),
    ...registryLayers.filter((l) => !l.path.startsWith('HKLM')),
  ];

  const claudeChain: ConflictLayer[] = [
    ...managedChain,
    ...(local ? [settingsLayer(provider, local, 'project-local', true)] : []),
    ...(project ? [settingsLayer(provider, project, 'project', true)] : []),
    settingsLayer(provider, user, 'user', true),
    ...(agentFlow ? [envLayer(provider, env)] : []),
  ];

  const chains: ConflictLayer[][] = [];
  const extras: ConflictLayer[] = [];
  if (agentFlow) {
    chains.push(claudeChain);
  } else if (flow === 'connect-desktop') {
    chains.push(claudeChain);
    if (desktopManaged) {
      const layer = desktopLayer(provider, desktopManaged, 'desktop-managed', false);
      extras.push(layer);
      chains.push([layer]);
    }
    if (desktopApplied) {
      const layer = desktopLayer(provider, desktopApplied, 'desktop-applied', true);
      extras.push(layer);
      chains.push([layer]);
    }
  } else if (vscode && vscode.length > 0) {
    // VS Code entries are process env for the extension: below every Claude settings layer, each edition on its own.
    for (const layer of vscode) chains.push([...claudeChain, layer]);
    extras.push(...vscode);
  } else {
    chains.push(claudeChain);
  }

  const layers = [...claudeChain, ...extras];
  const decisions = chains.map((chain) => decide(chain));
  for (const d of decisions) if (d.kind === 'on') d.layer.inEffect = true;

  const warnings: string[] = [];
  for (const layer of layers) {
    if (layer.state === 'malformed' && CLAUDE_FILE_SCOPES.includes(layer.scope)) {
      const message = malformedWarning(layer);
      warnings.push(message);
      logger.warn(`[cloud-provider-conflict] ${message}`);
    }
  }

  const unknownReasons = [
    ...new Set(decisions.flatMap((d) => (d.kind === 'unknown' ? [d.reason] : []))),
  ];
  const ons = decisions.flatMap((d) => (d.kind === 'on' ? [d.layer] : []));
  const verdict: ConflictVerdict = ons.some((l) => l.scope === 'managed' || l.scope === 'desktop-managed')
    ? 'conflict-managed'
    : unknownReasons.length > 0
      ? 'unknown'
      : ons.length > 0
        ? 'conflict-editable'
        : 'none';

  logger.debug(
    `[cloud-provider-conflict] resolved ${provider.name} for ${flow} in ${Date.now() - started}ms: ${verdict}, ${layers.length} layers`
  );

  return {
    verdict,
    layers,
    ...(unknownReasons.length > 0 ? { unknownReason: unknownReasons.join('; ') } : {}),
    warnings,
  };
}
