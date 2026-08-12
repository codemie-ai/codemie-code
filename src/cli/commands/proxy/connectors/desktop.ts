import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getClaudeDesktopBaseDir,
  getClaudeDesktopManagedSettingsPath,
} from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { getCodemiePath } from '@/utils/paths.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import managedMcpServers from './desktop-managed-mcp-servers.json' with { type: 'json' };
import { isValidOAuthConfig, type CanonicalMcpEntry, type McpOAuthConfig } from './managed-mcp-remote.js';

const INFERENCE_KEYS = [
  'inferenceProvider',
  'inferenceGatewayBaseUrl',
  'inferenceGatewayApiKey',
  'inferenceGatewayAuthScheme',
] as const;

interface InferenceModelEntry {
  name: string;
}

export interface ManagedMcpServerEntry {
  name: string;
  url: string;
  transport?: 'http' | 'sse';
  /**
   * `true`/`false` is the legacy flag Claude Desktop already understood; an
   * {@link McpOAuthConfig} is the structured client configuration the backend
   * now supplies. The CLI forwards it verbatim — Desktop runs the flow.
   */
  oauth?: McpOAuthConfig | boolean;
}

interface ModelsListResponse {
  data?: Array<{ id?: string }>;
}

interface CodeMieLlmModel {
  id?: string;
  base_name?: string;
  deployment_name?: string;
}

/**
 * Curated list of Claude models we expose by default.
 *
 * Each entry is matched against the gateway's `/v1/models` response either as
 * an exact ID or as `<entry>-<YYYYMMDD>` (the dated variant). The actual
 * resolved ID is what gets written to the Desktop config so the gateway
 * receives a model name it has registered.
 *
 * The opus entries are listed in descending preference (`4-8 → 4-7 → 4-6`):
 * {@link selectDesktopClaudeModels} collapses them to the single highest-priority
 * opus the gateway actually serves, so Desktop never shows more than one Opus.
 */
export const PREFERRED_CLAUDE_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-haiku-4-5',
] as const;

export const DEFAULT_COWORK_EGRESS_ALLOWED_HOSTS = ['*'] as const;

export const DEFAULT_MANAGED_MCP_SERVERS =
  managedMcpServers as readonly ManagedMcpServerEntry[];

/**
 * Fetch the model list from the gateway's SSO-backed `/v1/llm_models?include_all=true`
 * endpoint and return the IDs of usable Claude-family models. When both canonical
 * and `-vertex` registrations exist, canonical IDs are preferred. When only vertex
 * registrations exist, those IDs are returned so vertex-only tenants can connect.
 */
export async function fetchClaudeModels(proxyUrl: string, gatewayKey: string): Promise<string[]> {
  const endpoint = new URL('/v1/llm_models?include_all=true', proxyUrl).toString();
  try {
    logger.info(
      '[proxy] Fetching Claude models from gateway',
      ...sanitizeLogArgs({
        endpoint,
        inferenceGatewayBaseUrl: proxyUrl,
        inferenceGatewayApiKey: gatewayKey,
        preferredModels: [...PREFERRED_CLAUDE_MODELS],
      })
    );
    const response = await fetch(new URL('/v1/llm_models?include_all=true', proxyUrl), {
      headers: { Authorization: `Bearer ${gatewayKey}` },
    });
    if (!response.ok) {
      logger.warn(
        '[proxy] Gateway model discovery failed',
        ...sanitizeLogArgs({
          endpoint,
          status: response.status,
          statusText: response.statusText,
          inferenceGatewayBaseUrl: proxyUrl,
        })
      );
      throw new ConfigurationError(
        response.status === 401
          ? `Local proxy model discovery was rejected with 401 Unauthorized at ${endpoint}. ` +
            'The local gateway key was not accepted by the proxy or was forwarded upstream incorrectly.'
          : `Local proxy model discovery failed at ${endpoint}: ${response.status} ${response.statusText}`
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new ConfigurationError(
        `Local proxy model discovery received an unexpected response (${contentType || 'no content-type'}) from ${endpoint}. ` +
        `Your SSO session may have expired — run \`codemie proxy stop && codemie profile login\` ` +
        `to re-authenticate, then run \`codemie proxy connect desktop\` again.`
      );
    }
    const json = await response.json() as ModelsListResponse | CodeMieLlmModel[];
    const ids = Array.isArray(json)
      ? json
        .map((model) => model.id || model.base_name || model.deployment_name)
        .filter((id): id is string => typeof id === 'string')
      : (json.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string');
    const allClaudeIds = ids.filter((id) => /^claude-/i.test(id));
    const nonVertexClaudeIds = allClaudeIds.filter((id) => !/-vertex$/i.test(id));
    const claudeIds = nonVertexClaudeIds.length > 0 ? nonVertexClaudeIds : allClaudeIds;
    logger.info(
      '[proxy] Gateway model discovery completed',
      ...sanitizeLogArgs({
        endpoint,
        totalModelCount: ids.length,
        totalClaudeModelCount: claudeIds.length,
        availableClaudeModels: claudeIds,
        usedVertexFallback: nonVertexClaudeIds.length === 0 && allClaudeIds.length > 0,
      })
    );
    return claudeIds;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    logger.warn(
      '[proxy] Gateway model discovery threw before completion',
      ...sanitizeLogArgs({
        endpoint,
        inferenceGatewayBaseUrl: proxyUrl,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    throw new ConfigurationError(
      `Local proxy model discovery could not reach ${endpoint}. ` +
      `Reason: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Resolve each entry in {@link PREFERRED_CLAUDE_MODELS} against the gateway's
 * model discovery response. For each preferred name, prefer the exact ID; fall
 * back to the dated variant `<preferred>-YYYYMMDD` (latest if multiple); then
 * fall back to `<preferred>-vertex` when only Vertex registrations exist.
 * Entries with no available match are dropped silently.
 *
 * Preserves the order of {@link PREFERRED_CLAUDE_MODELS}.
 */
export function selectPreferredClaudeModels(
  available: string[],
  preferred: readonly string[] = PREFERRED_CLAUDE_MODELS
): string[] {
  const availableSet = new Set(available);
  const resolved: string[] = [];
  for (const name of preferred) {
    if (availableSet.has(name)) {
      resolved.push(name);
      continue;
    }
    const datePrefix = `${name}-`;
    const dated = available
      .filter((id) => id.startsWith(datePrefix))
      .filter((id) => /^\d{6,10}$/.test(id.slice(datePrefix.length)))
      .sort()
      .pop();
    if (dated) {
      resolved.push(dated);
      continue;
    }
    const vertexId = `${name}-vertex`;
    if (availableSet.has(vertexId)) {
      resolved.push(vertexId);
    }
  }
  const missingPreferredModels = preferred.filter((name) => {
    if (resolved.includes(name)) return false;
    return !resolved.some((resolvedName) => resolvedName.startsWith(`${name}-`));
  });
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
 * then collapses the opus family to a single entry: the first (highest-priority)
 * opus that resolved. With opus ids ordered `4-8 → 4-7 → 4-6` in
 * {@link PREFERRED_CLAUDE_MODELS}, this exposes Opus 4.8 when the gateway serves
 * it and otherwise falls back to the next-best available opus. Non-opus models
 * are passed through untouched and order is preserved.
 */
export function selectDesktopClaudeModels(
  available: string[],
  preferred: readonly string[] = PREFERRED_CLAUDE_MODELS
): string[] {
  const resolved = selectPreferredClaudeModels(available, preferred);
  let opusKept = false;
  return resolved.filter((id) => {
    if (!/^claude-opus-/i.test(id)) return true;
    if (opusKept) return false;
    opusKept = true;
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getManagedMcpServerName(server: unknown): string | undefined {
  if (!isRecord(server)) return undefined;
  return typeof server.name === 'string' ? server.name : undefined;
}

function getManagedMcpServerUrl(server: unknown): string | undefined {
  if (!isRecord(server)) return undefined;
  return typeof server.url === 'string' ? server.url : undefined;
}

/**
 * Outcome of reading a stored `managedMcpServers` value.
 *
 * `parsed: false` means the value was PRESENT but unreadable — which callers that
 * reason about what the config already holds must not confuse with an empty list.
 */
type ParsedServerList =
  | { parsed: true; servers: unknown[] }
  | { parsed: false };

function parseManagedServerList(value: unknown): ParsedServerList {
  if (value === undefined || value === null) {
    return { parsed: true, servers: [] };
  }

  if (Array.isArray(value)) {
    return { parsed: true, servers: value };
  }

  if (typeof value !== 'string') {
    return { parsed: false };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? { parsed: true, servers: parsed } : { parsed: false };
  } catch {
    return { parsed: false };
  }
}

function parseJsonArray(value: unknown): unknown[] {
  const result = parseManagedServerList(value);
  return result.parsed ? result.servers : [];
}

function isValidMcpServerName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

const DESKTOP_SUPPORTED_TRANSPORTS = new Set(['http', 'sse']);

/**
 * Normalize the three accepted auth shapes into what Claude Desktop consumes.
 *
 * Precedence: a valid oauth object wins, then the oauth boolean, then the
 * legacy `auth` enum, then `false`. The final fallback preserves the behavior
 * of entries carrying neither field.
 */
export function resolveDesktopOAuth(entry: CanonicalMcpEntry): McpOAuthConfig | boolean {
  if (isValidOAuthConfig(entry.oauth)) return { ...entry.oauth };
  if (entry.oauth === true) return true;
  if (entry.oauth === false) return false;
  if (entry.auth === 'oauth') return true;
  if (entry.auth === 'none') return false;
  return false;
}

/**
 * Map client-neutral canonical entries to Claude Desktop's managedMcpServers
 * shape. Drops entries Desktop cannot represent (non-http/sse transports,
 * missing URL, or invalid name).
 */
export function mapCanonicalToDesktop(entries: CanonicalMcpEntry[]): ManagedMcpServerEntry[] {
  const result: ManagedMcpServerEntry[] = [];
  for (const entry of entries) {
    if (!DESKTOP_SUPPORTED_TRANSPORTS.has(entry.transport)) continue;
    if (!entry.url || !isValidMcpServerName(entry.name)) continue;
    result.push({
      name: entry.name,
      url: entry.url,
      transport: entry.transport as 'http' | 'sse',
      oauth: resolveDesktopOAuth(entry),
    });
  }
  return result;
}

/**
 * Copy a managed entry, including its nested oauth object.
 *
 * A shallow `{ ...entry }` would share the oauth object with
 * DEFAULT_MANAGED_MCP_SERVERS — a readonly module-level constant that lives for
 * the whole process — so a later mutation of the written config would corrupt
 * the bundled defaults for every subsequent run.
 */
export function cloneManagedEntry(entry: ManagedMcpServerEntry): ManagedMcpServerEntry {
  const copy: ManagedMcpServerEntry = { ...entry };
  if (entry.oauth !== undefined && typeof entry.oauth === 'object') {
    copy.oauth = { ...entry.oauth };
  }
  return copy;
}

/** True when the entry carries usable OAuth information (structured config or the legacy flag). */
function hasManagedOAuth(entry: ManagedMcpServerEntry): boolean {
  return entry.oauth === true || (typeof entry.oauth === 'object' && entry.oauth !== null);
}

/**
 * URL equality between two managed entries, compared verbatim. Managed entries
 * come from controlled sources (DEFAULT_MANAGED_MCP_SERVERS or the backend
 * catalog), so this is intentionally exact — no trailing-slash or host-case
 * normalization. That normalization is a known, separately-tracked gap, not
 * something this comparison closes.
 */
function sameManagedEndpoint(a: ManagedMcpServerEntry, b: ManagedMcpServerEntry): boolean {
  return a.url === b.url;
}

/** Case-insensitive name equality between two managed entries. */
function sameManagedName(a: ManagedMcpServerEntry, b: ManagedMcpServerEntry): boolean {
  return a.name.toLowerCase() === b.name.toLowerCase();
}

/**
 * Collision test between a bundled default and a backend entry: a shared name
 * OR a shared endpoint, mirroring reconcileManagedMcpServers, where both sides
 * come from controlled sources. Defined in terms of {@link sameManagedName} and
 * {@link sameManagedEndpoint} so the wide and narrow tests cannot drift apart.
 */
function collidesWithManagedEntry(a: ManagedMcpServerEntry, b: ManagedMcpServerEntry): boolean {
  return sameManagedName(a, b) || sameManagedEndpoint(a, b);
}

/** A backend entry published at the same endpoint as a bundled default that declares OAuth, without OAuth of its own. */
export interface ManagedOauthDowngrade {
  /** The bundled default that was displaced. */
  defaultName: string;
  /** The backend entry that displaced it, at weaker auth. */
  backendName: string;
  /** The endpoint the backend entry was published at. */
  url: string;
}

export interface ManagedMcpMergeResult {
  /** The entries CodeMie owns this run, defaults first, all freshly cloned. */
  managed: ManagedMcpServerEntry[];
  /** Collisions where the backend entry resolved to weaker auth than the default it displaced. */
  oauthDowngrades: ManagedOauthDowngrade[];
  /** Names of bundled defaults dropped because an org entry collided with them. */
  displacedDefaults: string[];
}

/**
 * Merge the bundled public defaults with the org catalog so a server the backend
 * also publishes is written exactly once.
 *
 * The BACKEND wins every collision outright: it is authoritative for both the
 * name and the endpoint, and its entry is written exactly as published — the CLI
 * is a courier, not a policy layer, so no oauth value is ever rewritten. A
 * collision that lowers auth relative to the bundled default it displaces is
 * logged (see {@link ManagedOauthDowngrade}), never corrected.
 */
export function mergeManagedMcpServers(
  defaults: readonly ManagedMcpServerEntry[],
  org: readonly ManagedMcpServerEntry[],
): ManagedMcpMergeResult {
  // Single pass over defaults: keptDefaults and displacedDefaults are
  // complements of the same collidesWithManagedEntry test, so they can never
  // disagree about which bundled default survived.
  const keptDefaults: ManagedMcpServerEntry[] = [];
  const displacedDefaults: string[] = [];
  for (const bundled of defaults) {
    if (org.some((entry) => collidesWithManagedEntry(bundled, entry))) {
      displacedDefaults.push(bundled.name);
    } else {
      keptDefaults.push(bundled);
    }
  }

  // Downgrade reporting is scoped to sameManagedEndpoint, not the wider
  // collidesWithManagedEntry used for displacement above — a default's oauth
  // describes ITS endpoint, not its name, so a backend entry that merely
  // reuses the name at a different endpoint is not a downgrade. Because
  // collidesWithManagedEntry is defined as sameManagedName(a, b) ||
  // sameManagedEndpoint(a, b), a reported downgrade is by construction a
  // strict subset of a displacement: an endpoint collision can never displace
  // a default without also being reportable. Do not widen this back to
  // collidesWithManagedEntry.
  const oauthDowngrades: ManagedOauthDowngrade[] = [];
  for (const entry of org) {
    if (hasManagedOAuth(entry)) continue;
    // At most one record per org entry — take the first matching default, so
    // an entry is never double-counted if it happened to match more than one.
    const downgradedDefault = defaults.find(
      (bundled) => hasManagedOAuth(bundled) && sameManagedEndpoint(bundled, entry),
    );
    if (!downgradedDefault) continue;
    oauthDowngrades.push({
      defaultName: downgradedDefault.name,
      backendName: entry.name,
      url: entry.url,
    });
  }

  return {
    managed: [...keptDefaults, ...org].map(cloneManagedEntry),
    oauthDowngrades,
    displacedDefaults,
  };
}

/**
 * The bundled defaults that are safe to seed when the org catalog fetch FAILED.
 *
 * A failed fetch must change nothing. Restoring a default whose name or URL an
 * entry already in the config occupies would make reconcileManagedMcpServers treat
 * that name as ours and drop the existing entry — silently swapping a tenant's
 * internal server for the bundled public endpoint of the same name, which is worse
 * than the revocation the null-fetch contract already forbids. Whatever the config
 * holds therefore wins; a clean or first-run config still receives the full set.
 *
 * A stored list that is present but unreadable is not an empty one: we cannot tell
 * which names and URLs it claims, so nothing is seeded at all.
 */
export function selectDefaultsForFailedFetch(
  existingServers: unknown,
  defaults: readonly ManagedMcpServerEntry[] = DEFAULT_MANAGED_MCP_SERVERS,
): ManagedMcpServerEntry[] {
  const stored = parseManagedServerList(existingServers);
  if (!stored.parsed) {
    logger.warn(
      '[proxy] Existing managed MCP list could not be parsed — seeding no bundled defaults after the failed fetch',
      ...sanitizeLogArgs({
        storedValueType: typeof existingServers,
        skippedDefaultCount: defaults.length,
      })
    );
    return [];
  }

  const existing = stored.servers.filter(isRecord);
  const takenNames = new Set(
    existing
      .map((server) => getManagedMcpServerName(server))
      .filter((name): name is string => name !== undefined)
      .map((name) => name.toLowerCase()),
  );
  const takenUrls = new Set(
    existing
      .map((server) => getManagedMcpServerUrl(server))
      .filter((url): url is string => url !== undefined),
  );
  return defaults.filter(
    (bundled) => !takenNames.has(bundled.name.toLowerCase()) && !takenUrls.has(bundled.url),
  );
}

export interface ManagedOauthShapeSummary {
  /** Entries forwarding a structured OAuth client configuration. */
  oauthConfigured: number;
  /** Entries carrying only the legacy `oauth: true` flag. */
  oauthFlagged: number;
  /** Entries with `oauth: false` or no auth information at all. */
  noAuth: number;
}

/**
 * Count the resolved oauth shapes so a silent downgrade (every entry landing on
 * `false`) or a mass validation drop is visible in the daemon log.
 *
 * Accepts loosely-typed entries so the reconciled array — managed entries plus the
 * user entries preserved beside them — can be summarized exactly as serialized.
 */
export function summarizeManagedOauthShapes(
  entries: readonly unknown[] | null,
): ManagedOauthShapeSummary {
  const summary: ManagedOauthShapeSummary = { oauthConfigured: 0, oauthFlagged: 0, noAuth: 0 };
  for (const entry of entries ?? []) {
    const oauth = isRecord(entry) ? entry.oauth : undefined;
    if (isRecord(oauth)) summary.oauthConfigured += 1;
    else if (oauth === true) summary.oauthFlagged += 1;
    else summary.noAuth += 1;
  }
  return summary;
}

export interface ReconcileResult {
  servers: unknown[];
  managedNames: string[];
}

/**
 * Reconcile the managed MCP set into an existing managedMcpServers array.
 *
 * - `managed`: the entries CodeMie owns this run (public defaults + fetched
 *   internal), already in Desktop shape.
 * - `previouslyManagedNames`: names CodeMie wrote on the prior run. Required so
 *   that an entry removed from the managed set is dropped even though Claude
 *   Desktop re-stamps entries it persists (we cannot rely on a custom marker
 *   field surviving Desktop's rewrite).
 *
 * Genuine user-added entries (never managed by us) are preserved.
 * Managed entries appear first in the returned array; user entries follow.
 */
export function reconcileManagedMcpServers(
  existingServers: unknown,
  managed: ManagedMcpServerEntry[],
  previouslyManagedNames: string[] = [],
): ReconcileResult {
  const managedNames = managed.map((s) => s.name);
  const ownedLower = new Set(
    [...previouslyManagedNames, ...managedNames].map((n) => n.toLowerCase()),
  );
  // URL comparison is intentionally case-sensitive; managed entries come from
  // controlled sources (DEFAULT_MANAGED_MCP_SERVERS or the backend catalog) and
  // are matched verbatim.
  const managedUrls = new Set(managed.map((s) => s.url));

  // Unlike selectDefaultsForFailedFetch (which asks "which names/URLs are
  // already claimed?" and must treat unreadable as unknown-therefore-claimed),
  // this asks "which existing entries must be preserved?" An unreadable value
  // yields no identifiable entries to preserve, and a non-array value cannot be
  // written back into a field Desktop reads as an array — so [] is the
  // conservative answer to *this* question, not an inconsistency with the other.
  const filtered = parseJsonArray(existingServers).filter((server) => {
    const name = getManagedMcpServerName(server);
    const url = getManagedMcpServerUrl(server);
    if (!name) {
      // Still drop nameless entries that point at a managed URL, so a managed
      // endpoint can never be double-registered under an anonymous entry.
      return !(url && managedUrls.has(url));
    }
    if (!isValidMcpServerName(name)) return false;
    if (ownedLower.has(name.toLowerCase())) return false;
    if (url && managedUrls.has(url)) return false;
    return true;
  });

  return {
    servers: [...managed.map(cloneManagedEntry), ...filtered],
    managedNames,
  };
}

interface ManagedMcpState {
  managedNames: string[];
}

/** Default location of the CLI-owned managed-MCP marker state. */
export function getManagedMcpStatePath(): string {
  return getCodemiePath('proxy', 'desktop-managed-mcp-state.json');
}

async function readManagedMcpState(statePath: string): Promise<string[]> {
  if (!existsSync(statePath)) return [];
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf-8')) as ManagedMcpState;
    return Array.isArray(parsed.managedNames)
      ? parsed.managedNames.filter((n): n is string => typeof n === 'string')
      : [];
  } catch {
    return [];
  }
}

async function writeManagedMcpState(statePath: string, managedNames: string[]): Promise<void> {
  const dir = join(statePath, '..');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  // Atomic write (tmp + rename), mirroring daemon-manager.writeState. A crash
  // mid-write must never leave a truncated marker: readManagedMcpState would
  // parse-fail and fall back to [], silently orphaning every previously-managed
  // entry (it would no longer match by name and be preserved as a user entry).
  const tmp = `${statePath}.tmp`;
  await writeFile(tmp, JSON.stringify({ managedNames }, null, 2), 'utf-8');
  await rename(tmp, statePath);
}

export interface DesktopGatewayConfig {
  inferenceProvider: 'gateway';
  inferenceGatewayBaseUrl: string;
  inferenceGatewayApiKey: string;
  inferenceGatewayAuthScheme: 'bearer';
}

interface ConfigMetaEntry {
  id: string;
  name: string;
}

interface ConfigMeta {
  appliedId?: string;
  entries?: ConfigMetaEntry[];
}

export function buildGatewayConfig(proxyUrl: string, gatewayKey: string): DesktopGatewayConfig {
  return {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: proxyUrl,
    inferenceGatewayApiKey: gatewayKey,
    inferenceGatewayAuthScheme: 'bearer',
  };
}

/**
 * Returns the base directory where Claude Desktop (3P) stores its config.
 * macOS:   ~/Library/Application Support/Claude-3p
 * Windows: %LOCALAPPDATA%\Claude-3p
 * Linux:   $XDG_CONFIG_HOME/Claude-3p, else ~/.config/Claude-3p
 */
export function getDesktopBaseDir(): string {
  return getClaudeDesktopBaseDir();
}

/**
 * Explains why a local config write may not take effect, or null when nothing
 * is in the way. Claude Desktop applies a managed (MDM) source in preference to
 * the local config library, ignoring local values entirely.
 *
 * The path is injectable so callers and tests can supply one; by default it is
 * resolved from the platform.
 */
export function describeManagedSettingsOverride(
  managedSettingsPath: string | null = getClaudeDesktopManagedSettingsPath()
): string | null {
  if (!managedSettingsPath || !existsSync(managedSettingsPath)) return null;
  return (
    `${managedSettingsPath} exists. Claude Desktop applies managed settings ` +
    `instead of local configuration, so this write may have no effect.`
  );
}

/**
 * Returns the path to the active inference config JSON file under configLibrary/.
 * If `_meta.json` doesn't exist or has no `appliedId`, returns the path that
 * a freshly-generated UUID would use; the caller is responsible for creating
 * `_meta.json` to register it.
 */
export async function getDesktopConfigPath(baseDir: string = getDesktopBaseDir()): Promise<string> {
  const libDir = join(baseDir, 'configLibrary');
  const metaPath = join(libDir, '_meta.json');
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as ConfigMeta;
      if (meta.appliedId) return join(libDir, `${meta.appliedId}.json`);
    } catch {
      // Corrupt meta — fall through to fresh UUID
    }
  }
  return join(libDir, `${randomUUID()}.json`);
}

/**
 * Write/merge the CodeMie gateway settings into Claude Desktop's
 * `configLibrary/<UUID>.json` and update `_meta.json` so the app picks them up.
 *
 * Preserves unrelated keys in the existing config file.
 * Returns the absolute path of the config file written.
 */
export async function writeDesktopConfig(
  proxyUrl: string,
  gatewayKey: string,
  baseDir: string = getDesktopBaseDir(),
  orgMcpServers: ManagedMcpServerEntry[] | null = null,
  managedStatePath: string = getManagedMcpStatePath()
): Promise<string> {
  const libDir = join(baseDir, 'configLibrary');
  if (!existsSync(libDir)) {
    await mkdir(libDir, { recursive: true });
  }

  const metaPath = join(libDir, '_meta.json');
  let meta: ConfigMeta = {};
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf-8')) as ConfigMeta;
    } catch {
      meta = {};
    }
  }

  const configId = meta.appliedId ?? randomUUID();
  const configPath = join(libDir, `${configId}.json`);

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }

  // Discover available Claude models from the gateway and curate down to the
  // preferred set (a single opus, preferring 4.8) so the user doesn't have to
  // type them manually in the GUI.
  const discoveredModels = await fetchClaudeModels(proxyUrl, gatewayKey);
  if (discoveredModels.length === 0) {
    throw new ConfigurationError(
      `Local proxy did not expose any Claude models from ${new URL('/v1/llm_models?include_all=true', proxyUrl).toString()}.`
    );
  }
  const resolvedModels = selectDesktopClaudeModels(discoveredModels);
  if (resolvedModels.length === 0) {
    throw new ConfigurationError(
      'Local proxy discovered Claude models, but none matched the preferred CodeMie desktop set.'
    );
  }
  const inferenceModels: InferenceModelEntry[] = resolvedModels.map((name) => ({ name }));
  // `orgMcpServers === null` means the catalog fetch FAILED (or was skipped for a
  // missing CodeMie URL) — distinct from a successful fetch that returned []. On
  // failure we must NOT revoke previously-managed org entries (a transient backend
  // outage would otherwise strip the user's internal MCPs) and must leave the
  // marker state untouched so a later successful run can still revoke.
  const orgFetchSucceeded = orgMcpServers !== null;

  // Dedup bundled public defaults against the org catalog so an entry the
  // backend also publishes is written once (see mergeManagedMcpServers for the
  // collision precedence). On a FAILED fetch the defaults are first narrowed to
  // those the config does not already hold, so a previously-written org entry
  // that shadowed a default is never evicted by the public endpoint it replaced.
  const org = orgMcpServers ?? [];
  const seedDefaults = orgFetchSucceeded
    ? DEFAULT_MANAGED_MCP_SERVERS
    : selectDefaultsForFailedFetch(existing.managedMcpServers);
  const { managed: managedSet, oauthDowngrades, displacedDefaults } = mergeManagedMcpServers(seedDefaults, org);
  if (oauthDowngrades.length > 0) {
    logger.warn(
      '[proxy] Managed MCP entry published without the auth its bundled default declares (auth downgrade) — forwarding it as published',
      ...sanitizeLogArgs({
        oauthDowngradeCount: oauthDowngrades.length,
        sourceBundledDefaults: oauthDowngrades.map((downgrade) => downgrade.defaultName),
        downgradedBackendEntries: oauthDowngrades.map((downgrade) => downgrade.backendName),
        downgradedUrls: oauthDowngrades.map((downgrade) => downgrade.url),
      })
    );
  }
  const previouslyManagedNames = orgFetchSucceeded ? await readManagedMcpState(managedStatePath) : [];
  const { servers: managedMcpServers, managedNames } = reconcileManagedMcpServers(
    existing.managedMcpServers,
    managedSet,
    previouslyManagedNames,
  );

  // Marker write-ahead (successful fetch only): record the UNION of previously-
  // and newly-managed names BEFORE writing the config. If we crash between this
  // write and the config write, the next run still sees every name we might have
  // left in the config and can revoke it — so neither an add nor a revoke can
  // orphan an entry. The marker is narrowed to the exact managed set AFTER the
  // config is durable (see below), which releases revoked names so a user can
  // later reclaim them. On a failed fetch we leave the prior marker untouched so
  // a later successful run can still revoke.
  if (orgFetchSucceeded) {
    const unionNames = [...new Set([...previouslyManagedNames, ...managedNames])];
    await writeManagedMcpState(managedStatePath, unionNames);
  }

  // Summarize the reconciled list we are about to serialize (not the org catalog
  // index.ts already logs), so the shape counts always add up to
  // managedMcpServerCount and a logged auth downgrade is visible in the field.
  // seededDefaultCount reports what was offered to the merge, not what was
  // written — displacedDefaultCount and displacedDefaults reconcile the difference.
  const writtenOauthShapes = summarizeManagedOauthShapes(managedMcpServers);
  logger.info(
    '[proxy] Preparing Claude Desktop config payload',
    ...sanitizeLogArgs({
      baseDir,
      configPath,
      inferenceGatewayBaseUrl: proxyUrl,
      inferenceGatewayApiKey: gatewayKey,
      discoveredModelCount: discoveredModels.length,
      discoveredModels,
      resolvedModelCount: resolvedModels.length,
      resolvedModels,
      inferenceModelsWritten: inferenceModels.length > 0,
      managedMcpServerCount: managedMcpServers.length,
      seededDefaultCount: seedDefaults.length,
      displacedDefaultCount: displacedDefaults.length,
      displacedDefaults,
      oauthDowngradeCount: oauthDowngrades.length,
      oauthConfiguredCount: writtenOauthShapes.oauthConfigured,
      oauthFlaggedCount: writtenOauthShapes.oauthFlagged,
      noAuthCount: writtenOauthShapes.noAuth,
      existingConfigKeys: Object.keys(existing),
    })
  );

  for (const key of INFERENCE_KEYS) {
    delete existing[key];
  }
  delete existing.inferenceModels;
  delete existing.coworkEgressAllowedHosts;
  delete existing.managedMcpServers;

  const merged = {
    ...existing,
    ...buildGatewayConfig(proxyUrl, gatewayKey),
    ...(inferenceModels.length > 0 ? { inferenceModels: JSON.stringify(inferenceModels) } : {}),
    coworkEgressAllowedHosts: JSON.stringify([...DEFAULT_COWORK_EGRESS_ALLOWED_HOSTS]),
    managedMcpServers: JSON.stringify(managedMcpServers),
  };
  await writeFile(configPath, JSON.stringify(merged, null, 2), 'utf-8');
  logger.info(
    '[proxy] Claude Desktop config file updated',
    ...sanitizeLogArgs({
      configPath,
      inferenceGatewayBaseUrl: proxyUrl,
      inferenceGatewayApiKey: gatewayKey,
      inferenceModelsWritten: inferenceModels.length > 0,
      resolvedModels,
      managedMcpServerCount: managedMcpServers.length,
      finalConfigKeys: Object.keys(merged),
    })
  );

  // Narrow the marker to exactly what we just wrote, now that the config is
  // durable (see the write-ahead union above). This releases names dropped from
  // the managed set so they no longer count as owned on the next run.
  if (orgFetchSucceeded) {
    await writeManagedMcpState(managedStatePath, managedNames);
  }

  const entries = meta.entries ?? [];
  if (!entries.find((e) => e.id === configId)) {
    entries.push({ id: configId, name: 'CodeMie Proxy' });
  }
  const updatedMeta: ConfigMeta = {
    appliedId: configId,
    entries,
  };
  await writeFile(metaPath, JSON.stringify(updatedMeta, null, 2), 'utf-8');

  return configPath;
}
