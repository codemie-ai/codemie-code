import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;
const CANONICAL_TRANSPORTS = new Set(['http', 'sse', 'stdio']);
const CANONICAL_AUTH = new Set(['oauth', 'none']);

/** Client-neutral MCP entry returned by GET /v1/mcp/managed-servers. */
export interface CanonicalMcpEntry {
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  auth?: 'oauth' | 'none';
  description?: string;
  clients?: string[];
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
 * an empty list. Auth mirrors the SDK's cookie scheme.
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
    const cookie = Object.entries(creds.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join(';');
    // Preserve any base path on the API URL (e.g. `/code-assistant-api`): build
    // from the full apiUrl, not a root-absolute path which would drop it.
    const endpoint = new URL(`${creds.apiUrl.replace(/\/+$/, '')}/v1/mcp/managed-servers`);
    endpoint.searchParams.set('client', client);

    const response = await fetch(endpoint, { headers: { cookie } });
    if (!response.ok) {
      logger.warn(
        '[proxy] Managed MCP fetch failed',
        ...sanitizeLogArgs({ status: response.status, statusText: response.statusText }),
      );
      return null;
    }
    const json = (await response.json()) as unknown;
    // A non-array body is a contract violation → treat as failure (null), so the
    // caller does not mistake it for an authoritative "empty catalog".
    if (!Array.isArray(json)) return null;
    return json.filter(isValidCanonicalEntry).map(pickCanonicalFields);
  } catch (error) {
    logger.warn(
      '[proxy] Managed MCP fetch threw',
      ...sanitizeLogArgs({ error: error instanceof Error ? error.message : String(error) }),
    );
    return null;
  }
}
