import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  getClaudeDesktopBaseDir,
  getClaudeDesktopManagedSettingsPath,
} from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import {
  appliedConfigId,
  desktopGatewayOfEntry,
  isCodeMieGatewayConfig,
  isDesktopPointedAtLocalProxy,
  readDesktopGatewayConfig,
} from '@/telemetry/clients/claude-desktop/claude-desktop.gateway.js';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import { writeFileAtomic } from '@/utils/atomic-write.js';
import { withPidLock } from '@/utils/pid-lock.js';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { getCodemiePath } from '@/utils/paths.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import {
  toDesktopModels,
  type DesktopCatalogEntry,
  type DesktopModel,
} from '@/providers/plugins/sso/sso.desktop-models.js';
import { CLAUDE_DESKTOP, clientOfGatewayKey } from '@/providers/plugins/sso/proxy/proxy-clients.js';
import { DEFAULT_GATEWAY_KEY, readState } from '../daemon-manager.js';
import { buildProxyLlmModelsUrl } from './tenant-catalog.js';
import { isSymbolicLink } from './vscode.js';
import managedMcpServers from './desktop-managed-mcp-servers.json' with { type: 'json' };
import { isValidOAuthConfig, type CanonicalMcpEntry, type McpOAuthConfig } from './managed-mcp-remote.js';

/**
 * Claude Desktop's Bedrock parameters (`inferenceBedrockRegion`, `inferenceBedrockProfile`, ...). They never
 * coexist with the gateway provider a connect write ends on. Kept in step with `BEDROCK.desktopKeyPrefix` in
 * src/agents/plugins/claude/cloud-provider-conflict/provider.ts (not imported: the CLI does not reach into plugins).
 */
const DESKTOP_BEDROCK_KEY_PREFIX = 'inferenceBedrock';

const INFERENCE_KEYS = [
  'inferenceProvider',
  'inferenceGatewayBaseUrl',
  'inferenceGatewayApiKey',
  'inferenceGatewayAuthScheme',
] as const;

/**
 * Keys that choose how Claude Desktop signs in to the inference provider instead of
 * sending the static gateway key: an interactive "gateway SSO" device-code grant
 * (`inferenceCredentialKind: "interactive"`, or the older `inferenceGatewayAuthScheme: "sso"`
 * which Desktop rewrites to it), an external OIDC identity provider, or a credential helper.
 *
 * Any one of them left in the applied config — e.g. after "Sign in with your organization"
 * on the login screen — keeps Desktop probing the proxy's `/.well-known/oauth-authorization-server`
 * and stuck on the welcome screen, even though `connect` rewrote the gateway URL and key.
 * `connect` and `disconnect` own the gateway's sign-in, so they drop all of them.
 */
const GATEWAY_SIGN_IN_KEYS = [
  'inferenceCredentialKind',
  'inferenceGatewayOidc',
  'inferenceGatewayOidcAuthFlow',
  'inferenceIdpOidc',
  'inferenceIdpAuthFlow',
  'inferenceCredentialHelper',
  'inferenceCredentialHelperArgs',
  'inferenceCredentialHelperWindows',
  'inferenceCredentialHelperTtlSec',
  'inferenceCredentialHelperTimeoutSec',
  'inferenceCredentialHelperSilentRefreshEnabled',
] as const;

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

export {
  selectDesktopClaudeModels,
  selectPreferredClaudeModels,
  type DesktopModel,
} from '@/providers/plugins/sso/sso.desktop-models.js';

export const DEFAULT_COWORK_EGRESS_ALLOWED_HOSTS = ['*'] as const;

export const DEFAULT_MANAGED_MCP_SERVERS =
  managedMcpServers as readonly ManagedMcpServerEntry[];

/**
 * Fetch the model list from the gateway's SSO-backed `/v1/llm_models?include_all=true`
 * endpoint and return the usable Claude-family models with their CodeMie names (see
 * {@link toDesktopModels}).
 *
 * When `project` is set it is sent as `project_id`, so the backend narrows the list
 * to the models that project allows (the project's Models tab).
 *
 * Returns `null` when the upstream catalog failed (5xx), distinct from a catalog that
 * holds no Claude models (`[]`).
 */
export async function fetchClaudeModels(
  proxyUrl: string,
  gatewayKey: string,
  project: string | undefined
): Promise<DesktopModel[] | null> {
  const endpoint = buildProxyLlmModelsUrl(proxyUrl, project);
  try {
    logger.info(
      '[proxy] Fetching Claude models from gateway',
      ...sanitizeLogArgs({
        endpoint,
        project,
        inferenceGatewayBaseUrl: proxyUrl,
        inferenceGatewayApiKey: gatewayKey,
      })
    );
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${gatewayKey}` },
    });
    if (!response.ok) {
      const isUpstreamFailure = response.status >= 500 && response.status < 600;
      logger.warn(
        '[proxy] Gateway model discovery failed',
        ...sanitizeLogArgs({
          endpoint,
          status: response.status,
          statusText: response.statusText,
          inferenceGatewayBaseUrl: proxyUrl,
        })
      );
      if (isUpstreamFailure) {
        logger.warn(
          '[proxy] Upstream model catalog failed; skipping the connect-time Claude model check, Desktop discovers models at launch',
          ...sanitizeLogArgs({ endpoint })
        );
        return null;
      }
      throw new ConfigurationError(
        response.status === 401
          ? `Local proxy model discovery was rejected with 401 Unauthorized at ${endpoint}. ` +
            'The local gateway key was not accepted by the proxy or was forwarded upstream incorrectly.'
          : response.status === 404 && project
            ? `Local proxy model discovery failed at ${endpoint}: project "${project}" was not found. ` +
              'Check the project in your CodeMie profile, then run `codemie proxy connect --claude-desktop` again.'
            : `Local proxy model discovery failed at ${endpoint}: ${response.status} ${response.statusText}`
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new ConfigurationError(
        `Local proxy model discovery received an unexpected response (${contentType || 'no content-type'}) from ${endpoint}. ` +
        `Your SSO session may have expired — run \`codemie proxy stop && codemie profile login\` ` +
        `to re-authenticate, then run \`codemie proxy connect --claude-desktop\` again.`
      );
    }
    const json = await response.json() as ModelsListResponse | DesktopCatalogEntry[];
    const entries: DesktopCatalogEntry[] = Array.isArray(json) ? json : (json.data ?? []);
    const claudeModels = toDesktopModels(entries);
    logger.info(
      '[proxy] Gateway model discovery completed',
      ...sanitizeLogArgs({
        endpoint,
        totalModelCount: entries.length,
        totalClaudeModelCount: claudeModels.length,
        availableClaudeModels: claudeModels.map((model) => model.id),
      })
    );
    return claudeModels;
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
 * Issuer written into a structured oauth config that arrives without one.
 *
 * This is a deliberate, narrow exception to the courier rule stated throughout
 * this module (the CLI forwards backend oauth values verbatim). Without an
 * issuer, Desktop treats the config as "explicit" mode and fabricates one from
 * the *origin* of `tokenUrl`, which can never equal a Keycloak realm issuer —
 * so every flow dies with `Issuer mismatch in authorization response
 * (RFC 9207)`. Forwarding a config we know Desktop cannot complete is worse
 * than supplying the CodeMie default, and it mirrors DEFAULT_CODEMIE_BASE_URL:
 * the CLI already ships a CodeMie endpoint as its built-in default.
 *
 * A backend that publishes `authorizationServer` always wins — this only fills
 * the gap, and becomes dead weight once every deployment serves the field.
 */
const DEFAULT_AUTHORIZATION_SERVER: readonly string[] = [
  'https://auth.codemie.lab.epam.com/realms/codemie-prod',
];

/**
 * True when the value is an issuer list Desktop can actually use.
 *
 * Anything else — absent, null, a bare string, an empty array, or an array with
 * a blank entry — counts as "not provided" and takes the default. Desktop reads
 * this field as an array; a malformed value keeps it in explicit mode just as a
 * missing one does, so treating the two alike is what makes the fallback
 * effective rather than merely present.
 */
function hasUsableAuthorizationServer(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((issuer) => typeof issuer === 'string' && issuer.trim().length > 0)
  );
}

/**
 * Normalize the three accepted auth shapes into what Claude Desktop consumes.
 *
 * Precedence: a valid oauth object wins, then the oauth boolean, then the
 * legacy `auth` enum, then `false`. The final fallback preserves the behavior
 * of entries carrying neither field.
 *
 * A structured oauth config additionally gains {@link DEFAULT_AUTHORIZATION_SERVER}
 * when it carries no usable issuer. The boolean and legacy `auth` shapes are
 * left alone: they tell Desktop to discover the server's own protected-resource
 * metadata, so an injected issuer would override a working discovery path.
 */
export function resolveDesktopOAuth(entry: CanonicalMcpEntry): McpOAuthConfig | boolean {
  if (isValidOAuthConfig(entry.oauth)) {
    const oauth: McpOAuthConfig = { ...entry.oauth };
    if (!hasUsableAuthorizationServer(oauth.authorizationServer)) {
      // Fresh array per entry. Assigning the module constant itself would share
      // one mutable array across every managed entry, and cloneManagedEntry's
      // shallow oauth copy would not detach it — the same aliasing hazard that
      // function exists to prevent.
      oauth.authorizationServer = [...DEFAULT_AUTHORIZATION_SERVER];
    }
    return oauth;
  }
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
  /**
   * `sha256` fingerprints ({@link fingerprintManagedMcpEntry}) of what CodeMie writes for each managed name,
   * keyed by lowercase name. An entry the user edited is not re-fingerprinted: it keeps the fingerprint
   * recorded before, so it is still seen as edited, and stays the user's, on every later run. That holds
   * after its name left the managed set too: the baseline is kept for as long as the edited entry stays in
   * the config, so a name that comes back into the set finds the edit still protected. It is dropped once
   * the entry is gone or equals the baseline again.
   */
  fingerprints: Record<string, string>;
  /**
   * The baseline of the entries as they are in the config now: per name, the recorded fingerprint the entry
   * matches (the previous one or the pending one, see {@link reconcileManagedMcpServers}), or the recorded
   * one for an entry the user edited. This is what a write-ahead marker keeps as the previous baseline, so a
   * run that stops before it commits cannot make an entry it wrote look like an edit.
   */
  priorFingerprints: Record<string, string>;
}

/**
 * Keys Claude Desktop stamps on entries it stores itself (e.g. `source: "user"`
 * on servers added through its UI) but rejects inside `managedMcpServers`.
 * Preserved entries are re-written as managed ones, so drop them.
 */
const DESKTOP_LOCAL_MCP_KEYS = ['source'] as const;

function stripDesktopLocalKeys(server: unknown): unknown {
  if (!isRecord(server)) return server;
  if (!DESKTOP_LOCAL_MCP_KEYS.some((key) => key in server)) return server;
  const copy: Record<string, unknown> = { ...server };
  for (const key of DESKTOP_LOCAL_MCP_KEYS) delete copy[key];
  return copy;
}

/** JSON with every object's keys sorted, so equal values serialize alike whatever the key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Fingerprint of a managed MCP entry: `sha256` of its canonical JSON after the keys Desktop stamps itself
 * ({@link DESKTOP_LOCAL_MCP_KEYS}) are dropped, so Desktop re-stamping an entry is not an edit.
 */
export function fingerprintManagedMcpEntry(entry: unknown): string {
  return createHash('sha256').update(canonicalJson(stripDesktopLocalKeys(entry))).digest('hex');
}

interface ManagedMcpPartition {
  /** The managed entries to write: fresh clones, without those whose existing entry the user edited. */
  written: ManagedMcpServerEntry[];
  /** The existing entries that stay: the user's own, and the managed ones the user edited. */
  preserved: unknown[];
  /** Lowercase names of managed entries whose existing entry the user edited. */
  editedNames: Set<string>;
  /** Baselines of the existing entries that differ from them (edited), by lowercase name: to be kept. */
  retained: Map<string, string>;
  /** Per lowercase name of an existing entry with a recorded baseline, the baseline it matches or, edited, the recorded one. */
  baseline: Map<string, string>;
}

/** The own string value of `key` in a fingerprint record, so a name such as `__proto__` is never read as recorded. */
function recordedFingerprint(fingerprints: Record<string, string>, key: string): string | undefined {
  if (!Object.hasOwn(fingerprints, key)) return undefined;
  const value = fingerprints[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Split an existing managedMcpServers array into the managed entries to write and the entries that stay.
 *
 * An existing entry whose name is managed (now or on an earlier run) is the user's when a baseline is recorded
 * for it and its own fingerprint matches neither the previous one (`fingerprints`) nor the pending one
 * (`pendingFingerprints`, what an interrupted run was about to write): it is kept, and the managed entry of
 * that name is not written. Without a recorded baseline (a state an earlier CLI wrote, first run, failed
 * fetch) the entry is replaced.
 *
 * The baseline of an entry that differs from it is reported in `retained` whether its name is managed or not,
 * so it outlives the name's stay in the managed set; the baseline of an entry that is gone or matches it is not.
 */
function partitionManagedMcpServers(
  existingServers: unknown,
  managed: ManagedMcpServerEntry[],
  previouslyManagedNames: string[],
  fingerprints: Record<string, string>,
  pendingFingerprints: Record<string, string> = {}
): ManagedMcpPartition {
  const ownedLower = new Set(
    [...previouslyManagedNames, ...managed.map((s) => s.name)].map((n) => n.toLowerCase()),
  );
  const existing = parseJsonArray(existingServers);

  const editedNames = new Set<string>();
  const editedEntries = new Set<unknown>();
  const retained = new Map<string, string>();
  const baseline = new Map<string, string>();
  const matched = new Map<string, string>();
  for (const server of existing) {
    const name = getManagedMcpServerName(server);
    if (!name || !isValidMcpServerName(name)) continue;
    const lower = name.toLowerCase();
    const previous = recordedFingerprint(fingerprints, lower);
    const pending = recordedFingerprint(pendingFingerprints, lower);
    const recorded = previous ?? pending;
    if (recorded === undefined) continue;
    const own = fingerprintManagedMcpEntry(server);
    if (own === previous || own === pending) {
      matched.set(lower, own);
      continue;
    }
    // Two entries of one name: the edited one decides, whichever comes first.
    retained.set(lower, recorded);
    if (ownedLower.has(lower)) {
      editedNames.add(lower);
      editedEntries.add(server);
    }
  }
  for (const [lower, fingerprint] of matched) {
    if (!retained.has(lower)) baseline.set(lower, fingerprint);
  }
  for (const [lower, fingerprint] of retained) baseline.set(lower, fingerprint);

  const written = managed
    .filter((entry) => !editedNames.has(entry.name.toLowerCase()))
    .map(cloneManagedEntry);
  // URL comparison is intentionally case-sensitive; managed entries come from
  // controlled sources (DEFAULT_MANAGED_MCP_SERVERS or the backend catalog) and
  // are matched verbatim. Only the entries actually written claim their URL.
  const managedUrls = new Set(written.map((s) => s.url));

  // Unlike selectDefaultsForFailedFetch (which asks "which names/URLs are
  // already claimed?" and must treat unreadable as unknown-therefore-claimed),
  // this asks "which existing entries must be preserved?" An unreadable value
  // yields no identifiable entries to preserve, and a non-array value cannot be
  // written back into a field Desktop reads as an array — so [] is the
  // conservative answer to *this* question, not an inconsistency with the other.
  const preserved = existing.filter((server) => {
    if (editedEntries.has(server)) return true;
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
  }).map(stripDesktopLocalKeys);

  return { written, preserved, editedNames, retained, baseline };
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
 * - `fingerprints`: what CodeMie last committed per lowercase name (see
 *   {@link ReconcileResult.fingerprints}). An existing managed entry that no longer matches its fingerprint
 *   was edited by the user and is kept as it is.
 * - `pendingFingerprints`: what a run that did not finish was about to write. An entry that matches either
 *   `fingerprints` or this is CodeMie's, not an edit: the config may or may not have been replaced before
 *   that run stopped.
 *
 * Genuine user-added entries (never managed by us) are preserved.
 * Managed entries appear first in the returned array; user entries follow.
 */
export function reconcileManagedMcpServers(
  existingServers: unknown,
  managed: ManagedMcpServerEntry[],
  previouslyManagedNames: string[] = [],
  fingerprints: Record<string, string> = {},
  pendingFingerprints: Record<string, string> = {},
): ReconcileResult {
  const managedNames = managed.map((s) => s.name);
  const { written, preserved, retained, baseline } = partitionManagedMcpServers(
    existingServers,
    managed,
    previouslyManagedNames,
    fingerprints,
    pendingFingerprints,
  );

  const next = new Map<string, string>(retained);
  for (const entry of written) {
    next.set(entry.name.toLowerCase(), fingerprintManagedMcpEntry(entry));
  }

  return {
    servers: [...written, ...preserved],
    managedNames,
    fingerprints: Object.fromEntries(next),
    priorFingerprints: Object.fromEntries(baseline),
  };
}

/**
 * What the CLI-owned marker holds for one Desktop config: the names CodeMie wrote into its managedMcpServers
 * and the fingerprints of what it wrote. The history of one config says nothing about another's.
 */
interface ManagedMcpConfigRecord {
  managedNames: string[];
  /** See {@link ReconcileResult.fingerprints}. Also the retained baselines of edited entries that left the managed set. */
  fingerprints: Record<string, string>;
  /**
   * Set only between the write-ahead marker of a connect and its final commit: the fingerprints that run was
   * about to write. A record that still has it was left by a run that stopped in between.
   */
  pendingFingerprints?: Record<string, string>;
}

/**
 * The marker file: one record per config UUID. An earlier CLI wrote `{ managedNames }` alone, with no config
 * id; it is still read ({@link parseManagedMcpStore}). The top-level `managedNames` is also written, as the names
 * of the config written last, so an earlier CLI run after this one (a rollback) still knows which servers it may
 * revoke; this CLI never reads it while `configs` is there.
 */
interface ManagedMcpState {
  configs: Record<string, ManagedMcpConfigRecord>;
  managedNames?: string[];
}

/** The marker as read: the records by config, and the record of a state no config is recorded for. */
interface ManagedMcpStore {
  configs: Map<string, ManagedMcpConfigRecord>;
  /** A state without a config id (or an unreadable one): only a target that holds a CodeMie-written entry adopts it. */
  untied?: ManagedMcpConfigRecord;
}

/** What a stored marker tells about one config. */
interface ManagedMcpHistory {
  managedNames: string[];
  fingerprints: Record<string, string>;
  pendingFingerprints: Record<string, string>;
  /** The marker holds a record for this config (or adopted an earlier CLI's untied state for it): disconnect may drop it. */
  tied: boolean;
}

/** Default location of the CLI-owned managed-MCP marker state. */
export function getManagedMcpStatePath(): string {
  return getCodemiePath('proxy', 'desktop-managed-mcp-state.json');
}

const NO_MANAGED_MCP_HISTORY: ManagedMcpHistory = {
  managedNames: [],
  fingerprints: {},
  pendingFingerprints: {},
  tied: false,
};

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string')
  );
}

function parseManagedMcpRecord(value: unknown): ManagedMcpConfigRecord {
  const raw = isRecord(value) ? value : {};
  const record: ManagedMcpConfigRecord = {
    managedNames: Array.isArray(raw.managedNames)
      ? raw.managedNames.filter((n): n is string => typeof n === 'string')
      : [],
    fingerprints: stringRecord(raw.fingerprints),
  };
  const pending = stringRecord(raw.pendingFingerprints);
  if (Object.keys(pending).length > 0) record.pendingFingerprints = pending;
  return record;
}

/**
 * Read a marker of either generation: per-config records, or an earlier CLI's `{ managedNames }`, kept as the
 * untied record. Anything unreadable is an empty untied record, which disconnect may clean.
 */
function parseManagedMcpStore(raw: unknown): ManagedMcpStore {
  const configs = new Map<string, ManagedMcpConfigRecord>();
  if (!isRecord(raw)) return { configs, untied: parseManagedMcpRecord(undefined) };
  if (isRecord(raw.configs)) {
    for (const [configId, record] of Object.entries(raw.configs)) {
      if (isRecord(record)) configs.set(configId, parseManagedMcpRecord(record));
    }
    return { configs };
  }
  return { configs, untied: parseManagedMcpRecord(raw) };
}

async function readManagedMcpStore(statePath: string): Promise<ManagedMcpStore> {
  if (!existsSync(statePath)) return { configs: new Map() };
  try {
    return parseManagedMcpStore(JSON.parse(await readFile(statePath, 'utf-8')));
  } catch {
    // An unreadable marker holds no history; it counts as an untied one, which disconnect may clean.
    return parseManagedMcpStore(undefined);
  }
}

/**
 * The managed-MCP history that applies to config `configId`: its record, or an earlier CLI's untied state when
 * the target already holds an entry CodeMie wrote (`targetOwned`). The record of another config, a missing
 * marker and an unreadable one give no history.
 */
async function readManagedMcpState(
  statePath: string,
  configId: string,
  targetOwned: boolean
): Promise<ManagedMcpHistory> {
  const store = await readManagedMcpStore(statePath);
  const record = store.configs.get(configId) ?? (targetOwned ? store.untied : undefined);
  if (!record) return NO_MANAGED_MCP_HISTORY;
  return {
    managedNames: record.managedNames,
    fingerprints: record.fingerprints,
    pendingFingerprints: record.pendingFingerprints ?? {},
    tied: true,
  };
}

/**
 * Set (or, with `null`, drop) the record of `configId`. The records of the other configs are kept as they
 * are, and an untied state is gone: this is the first write of a CLI that ties every record to a config. The
 * file is removed when no record is left. The top-level `managedNames` an earlier CLI reads
 * ({@link ManagedMcpState}) is the names of the record set here, and is left out when the record is dropped.
 */
async function writeManagedMcpRecord(
  statePath: string,
  configId: string,
  record: ManagedMcpConfigRecord | null
): Promise<void> {
  const { configs } = await readManagedMcpStore(statePath);
  if (record) configs.set(configId, record);
  else configs.delete(configId);
  if (configs.size === 0) {
    await rm(statePath, { force: true });
    return;
  }
  const state: ManagedMcpState = { configs: Object.fromEntries(configs) };
  if (record) state.managedNames = record.managedNames;
  const dir = join(statePath, '..');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  // Atomic write (tmp + rename), mirroring daemon-manager.writeState. A crash
  // mid-write must never leave a truncated marker: readManagedMcpStore would
  // parse-fail and fall back to no history, silently orphaning every previously-managed
  // entry (it would no longer match by name and be preserved as a user entry).
  const tmp = `${statePath}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmp, statePath);
}

/** Runs `fn` while holding the Desktop-config lock next to the managed-MCP marker; one codemie process at a time. */
function withDesktopConfigLock<T>(managedStatePath: string, fn: () => Promise<T>): Promise<T> {
  return withPidLock(
    `${managedStatePath}.lock`,
    fn,
    () => new ConfigurationError(
      'Another codemie connect or disconnect is changing the Claude Desktop configuration. ' +
      'Wait for it to finish, then run the command again.'
    )
  );
}

export interface DesktopGatewayConfig {
  inferenceProvider: 'gateway';
  inferenceGatewayBaseUrl: string;
  inferenceGatewayApiKey: string;
  inferenceGatewayAuthScheme: 'bearer';
  /** Pins Desktop to the static gateway key, so it never starts an interactive gateway SSO sign-in. */
  inferenceCredentialKind: 'static';
}

/** Name `connect` gives the Claude Desktop config entry it owns in `configLibrary/_meta.json`. */
export const CODEMIE_DESKTOP_CONFIG_NAME = 'CodeMie Proxy';

export interface ConfigMetaEntry {
  id: string;
  name: string;
}

export interface ConfigMeta {
  appliedId?: string;
  entries?: ConfigMetaEntry[];
}

/** The Claude Desktop config entry `connect` writes and `disconnect` cleans. */
export interface CodeMieDesktopConfigTarget {
  configId: string;
  /** No CodeMie entry exists yet: `configId` is a fresh UUID with no file and no `_meta.json` entry. */
  isNew: boolean;
  /** The safe `appliedId` of `_meta.json`, if any. */
  appliedId: string | undefined;
  /** Name of the applied entry when it is not the CodeMie one and has a `_meta.json` entry. */
  previousAppliedName: string | undefined;
}

export function buildGatewayConfig(proxyUrl: string, gatewayKey: string): DesktopGatewayConfig {
  return {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: proxyUrl,
    inferenceGatewayApiKey: gatewayKey,
    inferenceGatewayAuthScheme: 'bearer',
    inferenceCredentialKind: 'static',
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
 * If `_meta.json` doesn't exist or has no safe `appliedId`, returns the path that
 * a freshly-generated UUID would use; the caller is responsible for creating
 * `_meta.json` to register it.
 */
export async function getDesktopConfigPath(baseDir: string = getDesktopBaseDir()): Promise<string> {
  const libDir = join(baseDir, 'configLibrary');
  const metaPath = join(libDir, '_meta.json');
  if (existsSync(metaPath)) {
    try {
      const appliedId = appliedConfigId(JSON.parse(await readFile(metaPath, 'utf-8')));
      if (appliedId) return join(libDir, `${appliedId}.json`);
    } catch {
      // Corrupt meta — fall through to fresh UUID
    }
  }
  return join(libDir, `${randomUUID()}.json`);
}

/**
 * True when a parsed Desktop config entry is positively CodeMie's: a loopback gateway pointed at the local proxy
 * of `localKey`. A key matching the daemon's (shared, or `<key>.claude-desktop`) proves it. A sealed key proves
 * nothing, since Desktop seals any key, so it counts only when the entry also has the exact shape `connect`
 * writes. Never throws.
 */
export function isCodeMieOwnedDesktopEntry(entry: unknown, localKey: string): boolean {
  const gateway = desktopGatewayOfEntry(entry);
  if (!gateway || !isDesktopPointedAtLocalProxy(gateway, localKey)) return false;
  if (!gateway.sealed) return true;
  return (
    isRecord(entry) &&
    entry.inferenceCredentialKind === 'static' &&
    entry.modelDiscoveryEnabled === true &&
    entry.coworkEgressAllowedHosts === JSON.stringify([...DEFAULT_COWORK_EGRESS_ALLOWED_HOSTS])
  );
}

/** True when `_meta.json` lists `configId` under the name `connect` gives its entry ({@link CODEMIE_DESKTOP_CONFIG_NAME}). */
function isNamedCodeMieConfig(meta: ConfigMeta, configId: string): boolean {
  const entries = Array.isArray(meta.entries) ? meta.entries : [];
  return entries.some((entry) => entry?.id === configId && entry.name === CODEMIE_DESKTOP_CONFIG_NAME);
}

/**
 * True when config `configId` holds CodeMie's entry. The entry named {@link CODEMIE_DESKTOP_CONFIG_NAME} only has
 * to point at the local proxy ({@link isDesktopPointedAtLocalProxy}, a sealed key included): an earlier CLI wrote it
 * without the shape this one adds, and the user may have changed that shape in Desktop since. Any other entry has
 * to be positively CodeMie's ({@link isCodeMieOwnedDesktopEntry}), since another local gateway can look like it.
 * Never throws.
 */
function isCodeMieDesktopConfig(meta: ConfigMeta, configId: string, entry: unknown, localKey: string): boolean {
  if (!isNamedCodeMieConfig(meta, configId)) return isCodeMieOwnedDesktopEntry(entry, localKey);
  const gateway = desktopGatewayOfEntry(entry);
  return gateway !== null && isDesktopPointedAtLocalProxy(gateway, localKey);
}

async function readConfigEntry(configPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Picks the Claude Desktop config entry CodeMie owns, whichever entry is applied: (a) the entry named
 * {@link CODEMIE_DESKTOP_CONFIG_NAME} (the applied one of several, else the first), even when its file is missing;
 * (b) the applied entry when it is positively CodeMie's ({@link isCodeMieOwnedDesktopEntry}: pointed at the local
 * proxy of `localKey`, a sealed key only with the shape `connect` writes); (c) a new UUID. Entries
 * whose id is not a safe file name are skipped. A safe `pinnedId` (the entry an earlier resolve chose) replaces the
 * three rules. Read-only.
 */
export async function resolveCodeMieDesktopConfig(
  libDir: string,
  meta: ConfigMeta,
  localKey: string,
  pinnedId?: string
): Promise<CodeMieDesktopConfigTarget> {
  const appliedId = appliedConfigId(meta);
  const entries = Array.isArray(meta.entries) ? meta.entries : [];
  const named = entries.filter(
    (entry) => entry?.name === CODEMIE_DESKTOP_CONFIG_NAME && typeof entry.id === 'string' && isSafeSessionId(entry.id)
  );

  let configId: string | undefined;
  let isNew: boolean;
  if (pinnedId !== undefined && isSafeSessionId(pinnedId)) {
    configId = pinnedId;
    isNew = !entries.some((entry) => entry?.id === pinnedId);
  } else {
    configId = named.find((entry) => entry.id === appliedId)?.id ?? named[0]?.id;
    if (!configId && appliedId) {
      const applied = await readConfigEntry(join(libDir, `${appliedId}.json`));
      if (isCodeMieOwnedDesktopEntry(applied, localKey)) configId = appliedId;
    }
    isNew = configId === undefined;
  }
  const resolvedId = configId ?? randomUUID();
  const appliedName =
    appliedId && appliedId !== resolvedId ? entries.find((entry) => entry?.id === appliedId)?.name : undefined;
  const previousAppliedName = typeof appliedName === 'string' ? appliedName : undefined;
  return { configId: resolvedId, isNew, appliedId, previousAppliedName };
}

/**
 * The id of the CodeMie entry ({@link resolveCodeMieDesktopConfig}) when its file exists and is CodeMie's
 * ({@link isCodeMieDesktopConfig}). A named entry whose file is missing or not CodeMie's (a stale key) gives
 * way to the applied entry when that one is CodeMie's. With neither validated, the named entry's file is still
 * returned when it exists, so the caller can say why it was left. Read-only.
 */
async function findCodeMieConfigOnDisk(libDir: string, meta: ConfigMeta, localKey: string): Promise<string | undefined> {
  const target = await resolveCodeMieDesktopConfig(libDir, meta, localKey);
  if (target.isNew) return undefined;
  const namedPath = join(libDir, `${target.configId}.json`);
  const namedExists = existsSync(namedPath);
  if (namedExists && isCodeMieDesktopConfig(meta, target.configId, await readConfigEntry(namedPath), localKey)) {
    return target.configId;
  }
  const { appliedId } = target;
  if (appliedId && appliedId !== target.configId) {
    const applied = await readConfigEntry(join(libDir, `${appliedId}.json`));
    if (isCodeMieOwnedDesktopEntry(applied, localKey)) return appliedId;
  }
  return namedExists ? target.configId : undefined;
}

/** The safe config id of `configPath` when it is a `<id>.json` directly under `libDir`, else undefined. */
function configIdOfPath(libDir: string, configPath: string | undefined): string | undefined {
  if (configPath === undefined || resolve(dirname(configPath)) !== resolve(libDir)) return undefined;
  const file = basename(configPath);
  if (!file.endsWith('.json')) return undefined;
  const id = file.slice(0, -'.json'.length);
  return isSafeSessionId(id) ? id : undefined;
}

async function readConfigMeta(metaPath: string): Promise<ConfigMeta> {
  if (!existsSync(metaPath)) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(metaPath, 'utf-8'));
    return isRecord(parsed) ? (parsed as ConfigMeta) : {};
  } catch {
    return {};
  }
}

/**
 * Path of the config entry `connect` writes and activates ({@link resolveCodeMieDesktopConfig}); a fresh UUID path
 * when there is none yet. A corrupt `_meta.json` counts as empty. The local key is the one the daemon state file
 * names, else the default key.
 */
export async function getCodeMieDesktopConfigPath(
  baseDir: string = getDesktopBaseDir(),
  stateFile?: string
): Promise<string> {
  const libDir = join(baseDir, 'configLibrary');
  const meta = await readConfigMeta(join(libDir, '_meta.json'));
  const localKey = (await readState(stateFile))?.gatewayKey ?? DEFAULT_GATEWAY_KEY;
  const { configId } = await resolveCodeMieDesktopConfig(libDir, meta, localKey);
  return join(libDir, `${configId}.json`);
}

export interface WriteDesktopConfigResult {
  /** Absolute path of the config file written. */
  configPath: string;
  /** Name of the entry that was active before connect switched Desktop to CodeMie's; absent when nothing was switched or no named entry was active. */
  switchedFrom?: string;
  /** True when `appliedId` changed to the CodeMie entry. */
  activated: boolean;
}

/**
 * Write/merge the CodeMie gateway settings into Claude Desktop's CodeMie config entry
 * (`configLibrary/<UUID>.json`, see {@link resolveCodeMieDesktopConfig}) and make it the applied
 * entry in `_meta.json`, so the app picks them up even when another config was active. No other
 * config file is touched. Desktop is given its named key, `<gatewayKey>.claude-desktop`; the
 * catalog read through the daemon keeps the shared `gatewayKey`.
 *
 * Preserves unrelated keys in the existing config file and unknown `_meta.json` fields; `_meta.json`
 * is rewritten only when the entry was added or was not applied yet.
 *
 * `targetConfigPath` is the entry an earlier {@link getCodeMieDesktopConfigPath} chose (the connect gate inspected
 * it), so the write lands on the same file whichever gateway key each side read; a path outside the library is
 * ignored and the entry is resolved here. It is a pin, not an order: when an entry CodeMie owns has appeared
 * meanwhile under another id, the write fails and asks to run the command again.
 *
 * The model check runs first; everything that reads or writes `_meta.json`, the config file or the managed-MCP
 * marker then runs under a lock, so two concurrent connects register one entry and never overwrite each other.
 */
export async function writeDesktopConfig(
  proxyUrl: string,
  gatewayKey: string,
  baseDir: string = getDesktopBaseDir(),
  orgMcpServers: ManagedMcpServerEntry[] | null = null,
  managedStatePath: string = getManagedMcpStatePath(),
  project?: string,
  targetConfigPath?: string
): Promise<WriteDesktopConfigResult> {
  // Check the Claude models the profile's project offers Desktop, so a project with none
  // fails here with a clear message. The list itself is not written: with no
  // `inferenceModels` in its config Desktop asks the proxy's `GET /v1/models` on every
  // start (DesktopModelsPlugin), so later changes on the project's Models tab reach it.
  // `null` means the upstream catalog failed, so the check is skipped rather than failed.
  // Network I/O: done before the lock is taken, never under it.
  const discoveredModels = await fetchClaudeModels(proxyUrl, gatewayKey, project);
  if (discoveredModels !== null && discoveredModels.length === 0) {
    throw new ConfigurationError(
      project
        ? `Project "${project}" does not allow any Claude models. Select at least one Claude model or router ` +
          'on the project\'s Models tab, then run `codemie proxy connect --claude-desktop` again.'
        : `Local proxy did not expose any Claude models from ${buildProxyLlmModelsUrl(proxyUrl, undefined)}.`
    );
  }
  return withDesktopConfigLock(managedStatePath, () =>
    writeDesktopConfigLocked(proxyUrl, gatewayKey, baseDir, orgMcpServers, managedStatePath, discoveredModels, targetConfigPath)
  );
}

async function writeDesktopConfigLocked(
  proxyUrl: string,
  gatewayKey: string,
  baseDir: string,
  orgMcpServers: ManagedMcpServerEntry[] | null,
  managedStatePath: string,
  discoveredModels: DesktopModel[] | null,
  targetConfigPath: string | undefined
): Promise<WriteDesktopConfigResult> {
  const libDir = join(baseDir, 'configLibrary');
  if (!existsSync(libDir)) {
    await mkdir(libDir, { recursive: true });
  }
  const desktopKey = `${gatewayKey}.${CLAUDE_DESKTOP}`;

  const metaPath = join(libDir, '_meta.json');
  const meta = await readConfigMeta(metaPath);

  const pinnedId = configIdOfPath(libDir, targetConfigPath);
  const target = await resolveCodeMieDesktopConfig(libDir, meta, gatewayKey, pinnedId);
  if (pinnedId !== undefined) {
    const current = await resolveCodeMieDesktopConfig(libDir, meta, gatewayKey);
    if (!current.isNew && current.configId !== pinnedId) {
      throw new ConfigurationError(
        'Claude Desktop configuration changed while connecting; run the command again.'
      );
    }
  }
  const { configId } = target;
  const configPath = join(libDir, `${configId}.json`);

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const targetOwned = isCodeMieDesktopConfig(meta, configId, existing, gatewayKey);

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
  const history = orgFetchSucceeded
    ? await readManagedMcpState(managedStatePath, configId, targetOwned)
    : NO_MANAGED_MCP_HISTORY;
  const { servers: managedMcpServers, managedNames, fingerprints, priorFingerprints } = reconcileManagedMcpServers(
    existing.managedMcpServers,
    managedSet,
    history.managedNames,
    history.fingerprints,
    history.pendingFingerprints,
  );

  // Marker write-ahead (successful fetch only): record the UNION of previously-
  // and newly-managed names BEFORE writing the config. If we crash between this
  // write and the config write, the next run still sees every name we might have
  // left in the config and can revoke it — so neither an add nor a revoke can
  // orphan an entry. The fingerprints are journaled the same way: what the
  // entries in the config match now stays as the previous baseline, and what this
  // run is about to write goes in as the pending one, so whichever side of the
  // config write a crash falls on, no entry CodeMie wrote reads as a user edit.
  // The marker is narrowed to the exact managed set AFTER the config is durable
  // (see below), which releases revoked names so a user can later reclaim them. On
  // a failed fetch we leave the prior marker untouched so a later successful run
  // can still revoke.
  if (orgFetchSucceeded) {
    const unionNames = [...new Set([...history.managedNames, ...managedNames])];
    await writeManagedMcpRecord(managedStatePath, configId, {
      managedNames: unionNames,
      fingerprints: priorFingerprints,
      pendingFingerprints: fingerprints,
    });
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
      inferenceGatewayApiKey: desktopKey,
      discoveredModelCount: discoveredModels?.length ?? null,
      discoveredModels: discoveredModels?.map((model) => model.id) ?? null,
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

  for (const key of [...INFERENCE_KEYS, ...GATEWAY_SIGN_IN_KEYS]) {
    delete existing[key];
  }
  for (const key of Object.keys(existing)) {
    if (key.startsWith(DESKTOP_BEDROCK_KEY_PREFIX)) delete existing[key];
  }
  delete existing.inferenceModels;
  delete existing.modelDiscoveryEnabled;
  delete existing.coworkEgressAllowedHosts;
  delete existing.managedMcpServers;

  const merged = {
    ...existing,
    ...buildGatewayConfig(proxyUrl, desktopKey),
    modelDiscoveryEnabled: true,
    coworkEgressAllowedHosts: JSON.stringify([...DEFAULT_COWORK_EGRESS_ALLOWED_HOSTS]),
    managedMcpServers: JSON.stringify(managedMcpServers),
  };
  await writeFileAtomic(configPath, JSON.stringify(merged, null, 2));
  logger.info(
    '[proxy] Claude Desktop config file updated',
    ...sanitizeLogArgs({
      configPath,
      inferenceGatewayBaseUrl: proxyUrl,
      inferenceGatewayApiKey: desktopKey,
      managedMcpServerCount: managedMcpServers.length,
      finalConfigKeys: Object.keys(merged),
    })
  );

  // Narrow the marker to exactly what we just wrote, now that the config is
  // durable (see the write-ahead union above). This releases names dropped from
  // the managed set so they no longer count as owned on the next run.
  if (orgFetchSucceeded) {
    await writeManagedMcpRecord(managedStatePath, configId, { managedNames, fingerprints });
  }

  const entries = Array.isArray(meta.entries) ? [...meta.entries] : [];
  const appended = !entries.some((entry) => entry?.id === configId);
  if (appended) {
    entries.push({ id: configId, name: CODEMIE_DESKTOP_CONFIG_NAME });
  }
  const activated = target.appliedId !== configId;
  if (appended || activated) {
    const updatedMeta: ConfigMeta = { ...meta, appliedId: configId, entries };
    await writeFileAtomic(metaPath, JSON.stringify(updatedMeta, null, 2));
  }
  if (activated) {
    logger.info(
      '[proxy] Activated the CodeMie Claude Desktop config',
      ...sanitizeLogArgs({ configId, previousAppliedId: target.appliedId ?? null })
    );
  }

  const switchedFrom = activated ? target.previousAppliedName : undefined;
  return switchedFrom === undefined ? { configPath, activated } : { configPath, activated, switchedFrom };
}

/**
 * Moves Claude Desktop's applied config from the shared key of the daemon of gateway key `gatewayKey` on `port` to
 * Desktop's named key, `<gatewayKey>.claude-desktop`: only `inferenceGatewayApiKey` of the applied entry changes;
 * `_meta.json`, the managed-MCP marker and every other field are left, and nothing is fetched. Writes only for a
 * loopback gateway on `port` whose key is sealed (Desktop alone opens it) or reads as the shared key. `unchanged`
 * otherwise: Desktop's own or another client's named key, a refused key, no key, another port, a config that is not a
 * loopback gateway, no applied config, an unreadable config (a link to nothing included), a platform without a
 * Desktop directory. The entry is replaced atomically, a symbolic link written through; a failed write throws.
 */
export async function moveDesktopToNamedKey(
  gatewayKey: string,
  port: number,
  baseDir?: string
): Promise<'moved' | 'unchanged'> {
  let configPath: string;
  let entry: Record<string, unknown>;
  try {
    const libDir = join(baseDir ?? getDesktopBaseDir(), 'configLibrary');
    const configId = appliedConfigId(JSON.parse(await readFile(join(libDir, '_meta.json'), 'utf-8')));
    if (!configId) return 'unchanged';
    configPath = join(libDir, `${configId}.json`);
    entry = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    logger.debug('[proxy] Claude Desktop config not readable for the named key', ...sanitizeLogArgs(error));
    return 'unchanged';
  }
  const gateway = desktopGatewayOfEntry(entry);
  if (gateway?.port !== port) return 'unchanged';
  if (!gateway.sealed) {
    const named = gateway.apiKey === undefined ? null : clientOfGatewayKey(`Bearer ${gateway.apiKey}`, gatewayKey);
    if (named === null || named.client !== undefined) return 'unchanged';
  }

  const desktopKey = `${gatewayKey}.${CLAUDE_DESKTOP}`;
  entry.inferenceGatewayApiKey = desktopKey;
  await writeFileAtomic(configPath, JSON.stringify(entry, null, 2));
  logger.info(
    '[proxy] Moved Claude Desktop to its named key',
    ...sanitizeLogArgs({ configPath, inferenceGatewayApiKey: desktopKey })
  );
  return 'moved';
}

export interface RemoveDesktopConfigResult {
  removed: boolean;
  /** Config file the gateway settings were removed from; absent when none was found. */
  configPath?: string;
  /** True when nothing but CodeMie settings was left, so the config file was deleted. */
  deletedConfigFile: boolean;
  /** Why nothing was removed; absent when `removed` is true. */
  reason?: string;
}

/**
 * The local gateway Claude Desktop's applied config points at, or null when Desktop is not
 * connected to CodeMie's (no applied config or an unsafe `appliedId`, not a loopback gateway
 * config, a readable gateway key other than the local one alone or with `.claude-desktop`, no
 * key, a URL without a port, anything unreadable, an unsupported platform). A key Desktop has
 * sealed gives the port. The local key is the one the daemon state file names, else the default
 * key. Read-only; never throws.
 */
export async function readDesktopGateway(baseDir?: string, stateFile?: string): Promise<{ port: number } | null> {
  const gateway = await readDesktopGatewayConfig(baseDir);
  if (!gateway) return null;
  const localKey = (await readState(stateFile))?.gatewayKey ?? DEFAULT_GATEWAY_KEY;
  return isDesktopPointedAtLocalProxy(gateway, localKey) ? { port: gateway.port } : null;
}

/**
 * The local gateway Claude Desktop's CodeMie entry points at ({@link findCodeMieConfigOnDisk}), whichever config is
 * applied, or null when there is no such entry, it is not pointed at the local proxy, or anything is unreadable. What
 * `disconnect` asks to decide whether there is a CodeMie entry to clean; what Desktop uses is {@link readDesktopGateway}.
 * The local key is the one the daemon state file names, else the default key. Read-only; never throws.
 */
export async function readCodeMieDesktopGateway(baseDir?: string, stateFile?: string): Promise<{ port: number } | null> {
  try {
    const libDir = join(baseDir ?? getDesktopBaseDir(), 'configLibrary');
    const meta = await readConfigMeta(join(libDir, '_meta.json'));
    const localKey = (await readState(stateFile))?.gatewayKey ?? DEFAULT_GATEWAY_KEY;
    const configId = await findCodeMieConfigOnDisk(libDir, meta, localKey);
    if (!configId) return null;
    const entry = await readConfigEntry(join(libDir, `${configId}.json`));
    const gateway = desktopGatewayOfEntry(entry);
    return gateway && isCodeMieDesktopConfig(meta, configId, entry, localKey) ? { port: gateway.port } : null;
  } catch (error) {
    logger.debug('[proxy] Claude Desktop CodeMie config not readable', ...sanitizeLogArgs(error));
    return null;
  }
}

/**
 * Reverse {@link writeDesktopConfig}: strip the CodeMie gateway settings and managed MCP
 * servers from the CodeMie `configLibrary/<UUID>.json` ({@link resolveCodeMieDesktopConfig}),
 * whichever config is applied, so Claude Desktop returns to its normal login. Never creates an
 * entry and never touches another config; `appliedId` is dropped only when it named the deleted entry.
 *
 * Only acts on a config whose gateway points at a loopback address with a key the local daemon accepts (or one
 * Desktop has sealed) — any other gateway, a local one with another key included, was configured by the user, not
 * by `connect`. MCP servers the user added themselves and any
 * unrelated keys are preserved. When nothing else remains, the config file is deleted and its
 * `_meta.json` entry dropped, so Desktop no longer has a CodeMie profile applied; a config that is
 * a symbolic link has its target written `{}` first (a failed write is only logged), then the link is removed.
 */
export async function removeDesktopConfig(
  baseDir: string = getDesktopBaseDir(),
  managedStatePath: string = getManagedMcpStatePath()
): Promise<RemoveDesktopConfigResult> {
  const metaPath = join(baseDir, 'configLibrary', '_meta.json');
  if (!existsSync(metaPath)) {
    return { removed: false, deletedConfigFile: false, reason: 'Claude Desktop config not found' };
  }
  return withDesktopConfigLock(managedStatePath, () => removeDesktopConfigLocked(baseDir, managedStatePath));
}

async function removeDesktopConfigLocked(baseDir: string, managedStatePath: string): Promise<RemoveDesktopConfigResult> {
  const libDir = join(baseDir, 'configLibrary');
  const metaPath = join(libDir, '_meta.json');

  let meta: ConfigMeta;
  try {
    const parsed: unknown = JSON.parse(await readFile(metaPath, 'utf-8'));
    meta = isRecord(parsed) ? (parsed as ConfigMeta) : {};
  } catch (error) {
    throw new ConfigurationError(
      `Claude Desktop config index at ${metaPath} is unreadable: ` +
      `${error instanceof Error ? error.message : String(error)}. The file was not changed.`
    );
  }

  const localKey = (await readState())?.gatewayKey ?? DEFAULT_GATEWAY_KEY;
  const configId = await findCodeMieConfigOnDisk(libDir, meta, localKey);
  if (!configId) {
    return { removed: false, deletedConfigFile: false, reason: 'no CodeMie Claude Desktop config' };
  }
  const configPath = join(libDir, `${configId}.json`);

  let existing: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf-8'));
    if (!isRecord(parsed)) throw new Error('expected a JSON object');
    existing = parsed;
  } catch (error) {
    throw new ConfigurationError(
      `Claude Desktop config at ${configPath} is unreadable: ` +
      `${error instanceof Error ? error.message : String(error)}. The file was not changed.`
    );
  }

  if (!isCodeMieGatewayConfig(existing)) {
    return { removed: false, configPath, deletedConfigFile: false, reason: 'no CodeMie gateway configured' };
  }
  if (!isCodeMieDesktopConfig(meta, configId, existing, localKey)) {
    return { removed: false, configPath, deletedConfigFile: false, reason: 'its local gateway is not CodeMie\'s' };
  }

  for (const key of [...INFERENCE_KEYS, ...GATEWAY_SIGN_IN_KEYS]) {
    delete existing[key];
  }
  delete existing.inferenceModels;
  delete existing.modelDiscoveryEnabled;
  delete existing.coworkEgressAllowedHosts;

  // Drop every server CodeMie manages (names recorded on earlier runs plus the bundled
  // defaults) but keep the ones the user added and the managed ones the user edited since
  // CodeMie wrote them. Passing the defaults as the "managed" set makes the partition also
  // match them by URL; what it writes back is dropped, what it preserves stays. The guard
  // above proved the entry is CodeMie's, so a marker of an earlier CLI counts for it.
  const history = await readManagedMcpState(managedStatePath, configId, true);
  const { preserved: userServers, retained } = partitionManagedMcpServers(
    existing.managedMcpServers,
    [...DEFAULT_MANAGED_MCP_SERVERS],
    history.managedNames,
    history.fingerprints,
    history.pendingFingerprints
  );
  if (userServers.length > 0) {
    existing.managedMcpServers = JSON.stringify(userServers);
  } else {
    delete existing.managedMcpServers;
  }

  const deletedConfigFile = Object.keys(existing).length === 0;
  if (deletedConfigFile) {
    // The next connect writes a new file under a new id, so a kept link would be read by nothing:
    // the target is emptied (a synced dotfile loses CodeMie's gateway too) and the link removed.
    if (await isSymbolicLink(configPath)) {
      try {
        await writeFileAtomic(configPath, '{}');
      } catch (error) {
        logger.warn(
          '[proxy] Could not empty the target of the linked Claude Desktop config; removing the link',
          ...sanitizeLogArgs({ configPath, error: error instanceof Error ? error.message : String(error) })
        );
      }
    }
    await rm(configPath, { force: true });
    const updatedMeta: ConfigMeta = {
      ...meta,
      entries: (Array.isArray(meta.entries) ? meta.entries : []).filter((entry) => entry?.id !== configId),
    };
    if (updatedMeta.appliedId === configId) delete updatedMeta.appliedId;
    await writeFileAtomic(metaPath, JSON.stringify(updatedMeta, null, 2));
  } else {
    await writeFileAtomic(configPath, JSON.stringify(existing, null, 2));
  }

  // Only the record of this config goes, and not all of it: the baselines of the edited servers left in the
  // config stay, so they are still the user's when CodeMie connects again. Another config's record is not touched.
  if (history.tied) {
    await writeManagedMcpRecord(
      managedStatePath,
      configId,
      retained.size > 0 ? { managedNames: [], fingerprints: Object.fromEntries(retained) } : null
    );
  }

  logger.info(
    '[proxy] Removed CodeMie config from Claude Desktop',
    ...sanitizeLogArgs({ configPath, deletedConfigFile, keptUserServerCount: userServers.length })
  );

  return { removed: true, configPath, deletedConfigFile };
}
