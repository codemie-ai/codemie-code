import { HTTPClient } from '@/providers/core/base/http-client.js';
import { buildAuthHeaders } from '@/providers/core/codemie-auth-helpers.js';
import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;
const CANONICAL_TRANSPORTS = new Set(['http', 'sse', 'stdio']);
const CANONICAL_AUTH = new Set(['oauth', 'none']);

/**
 * OAuth client configuration supplied by the backend for a managed MCP server.
 *
 * The CLI never performs the OAuth flow itself — it forwards this object to the
 * client (Claude Desktop), which owns the flow. The index signature is
 * deliberate: unknown backend keys (a future `audience`, `resource`, `pkce`, …)
 * must survive to the client without a CLI release.
 */
export interface McpOAuthConfig {
  clientId: string;
  authorizationUrl: string;
  tokenUrl: string;
  scope?: string;
  callbackHost?: string;
  callbackPort?: number;
  [key: string]: unknown;
}

/** Client-neutral MCP entry returned by GET /v1/mcp/managed-servers. */
export interface CanonicalMcpEntry {
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  /** Legacy flag retained for the rollout window; superseded by `oauth`. */
  auth?: 'oauth' | 'none';
  oauth?: McpOAuthConfig | boolean;
  description?: string;
  clients?: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Sanity-gate an oauth object: require the fields the client cannot run a flow
 * without, type-check the optional ones, and let every unknown key through
 * untouched. This is deliberately not an allowlist.
 */
export function isValidOAuthConfig(value: unknown): value is McpOAuthConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (!isNonEmptyString(o.clientId)) return false;
  if (!isNonEmptyString(o.authorizationUrl)) return false;
  if (!isNonEmptyString(o.tokenUrl)) return false;
  if (o.scope !== undefined && o.scope !== null && typeof o.scope !== 'string') return false;
  if (o.callbackHost !== undefined && o.callbackHost !== null && typeof o.callbackHost !== 'string') return false;
  if (o.callbackPort !== undefined && o.callbackPort !== null) {
    if (typeof o.callbackPort !== 'number' || !Number.isInteger(o.callbackPort)) return false;
    if (o.callbackPort < 1 || o.callbackPort > 65535) return false;
  }
  return true;
}

function isValidCanonicalEntry(value: unknown): value is CanonicalMcpEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e.name !== 'string' || !VALID_NAME.test(e.name)) return false;
  if (typeof e.transport !== 'string' || !CANONICAL_TRANSPORTS.has(e.transport)) return false;
  if (typeof e.url !== 'string') return false;
  // Optional fields: the backend (FastAPI response_model) serializes unset
  // optionals as `null`, so treat null the same as undefined ("absent").
  if (e.auth !== undefined && e.auth !== null && (typeof e.auth !== 'string' || !CANONICAL_AUTH.has(e.auth))) return false;
  // `oauth` accepts a boolean flag or a structured config object. A malformed
  // object invalidates the WHOLE entry: forwarding half a client configuration
  // would make the client fail the flow with no diagnosis.
  if (e.oauth !== undefined && e.oauth !== null) {
    if (typeof e.oauth === 'object') {
      if (!isValidOAuthConfig(e.oauth)) return false;
    } else if (typeof e.oauth !== 'boolean') {
      return false;
    }
  }
  if (e.description !== undefined && e.description !== null && typeof e.description !== 'string') return false;
  if (
    e.clients !== undefined && e.clients !== null &&
    (!Array.isArray(e.clients) || !e.clients.every((c) => typeof c === 'string'))
  ) return false;
  return true;
}

function pickCanonicalFields(e: CanonicalMcpEntry): CanonicalMcpEntry {
  const out: CanonicalMcpEntry = { name: e.name, transport: e.transport };
  if (e.url !== undefined && e.url !== null) out.url = e.url;
  if (e.auth !== undefined && e.auth !== null) out.auth = e.auth;
  // Copy the oauth value wholesale instead of rebuilding it from known keys:
  // that is what lets a future backend field reach the client without a CLI
  // release. The shallow copy detaches it from the parsed response payload.
  if (e.oauth !== undefined && e.oauth !== null) {
    out.oauth = typeof e.oauth === 'object' ? { ...e.oauth } : e.oauth;
  }
  if (e.description !== undefined && e.description !== null) out.description = e.description;
  if (Array.isArray(e.clients)) out.clients = e.clients;
  return out;
}

/**
 * Fetch the client-neutral managed MCP catalog from CodeMie.
 *
 * Returns `null` on any failure (missing creds, network error, non-2xx, bad
 * body) so callers can distinguish a transient outage from an authoritative
 * empty catalog. Returns `[]` only when the backend responded successfully with
 * an empty list. Routes through the shared {@link HTTPClient} + buildAuthHeaders
 * like every other CodeMie request (e.g. fetchCodeMieUserInfo).
 */
export async function fetchManagedMcpServers(
  client: string,
  codeMieUrl: string,
): Promise<CanonicalMcpEntry[] | null> {
  try {
    if (!codeMieUrl) return null;
    const sso = new CodeMieSSO();
    const creds = await sso.getStoredCredentials(codeMieUrl);
    if (!creds?.cookies || !creds.apiUrl) {
      logger.warn('[proxy] Managed MCP fetch skipped: no SSO credentials');
      return null;
    }
    // Preserve any base path on the API URL (e.g. `/code-assistant-api`): build
    // from the full apiUrl, not a root-absolute path which would drop it.
    const endpoint = new URL(`${creds.apiUrl.replace(/\/+$/, '')}/v1/mcp/managed-servers`);
    endpoint.searchParams.set('client', client);

    // Go through the shared HTTPClient like fetchCodeMieUserInfo: enterprise
    // on-prem CodeMie deployments commonly use self-signed certs (so we need
    // rejectUnauthorized: false), it bounds the request with a timeout, and
    // buildAuthHeaders attaches the cookie plus the standard CLI-identifying
    // headers every other CodeMie request sends. A raw fetch would reject those
    // certs and could hang.
    const httpClient = new HTTPClient({
      timeout: 10000,
      maxRetries: 3,
      rejectUnauthorized: false,
    });
    const response = await httpClient.getRaw(endpoint.toString(), buildAuthHeaders(creds.cookies));

    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      logger.warn(
        '[proxy] Managed MCP fetch failed',
        ...sanitizeLogArgs({ status, statusText: response.statusMessage }),
      );
      return null;
    }
    const json = response.data ? (JSON.parse(response.data) as unknown) : null;
    // A non-array body is a contract violation → treat as failure (null), so the
    // caller does not mistake it for an authoritative "empty catalog".
    if (!Array.isArray(json)) return null;
    const valid = json.filter(isValidCanonicalEntry).map(pickCanonicalFields);
    const dropped = json.length - valid.length;
    if (dropped > 0) {
      logger.warn(
        '[proxy] Managed MCP entries dropped by validation',
        ...sanitizeLogArgs({ received: json.length, kept: valid.length, dropped }),
      );
    }
    // A non-empty payload where NOTHING survived is a backend contract failure,
    // not an authoritative empty catalog. Returning [] here would make
    // writeDesktopConfig revoke every org MCP server the tenant has.
    if (json.length > 0 && valid.length === 0) return null;
    return valid;
  } catch (error) {
    logger.warn(
      '[proxy] Managed MCP fetch threw',
      ...sanitizeLogArgs({ error: error instanceof Error ? error.message : String(error) }),
    );
    return null;
  }
}
