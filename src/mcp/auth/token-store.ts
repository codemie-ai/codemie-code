/**
 * Persistence of an MCP OAuth login between runs, one file per MCP endpoint.
 *
 * A file holds the access token and its expiry, plus the refresh token together with the client
 * registration it was issued to (a refresh token only works for that client). With it a restarted
 * proxy renews an expired access token silently instead of opening the browser again.
 *
 * Nothing is shared between endpoints: each endpoint of a gateway (e.g. https://gateway.example/mcp/<name>)
 * demands its own login, so each gets its own file. One writer per file also means proxies that
 * start together never overwrite each other's state.
 *
 * Files live in ~/.codemie/mcp-auth (dir 0700, files 0600). They contain a refresh token, i.e. a
 * long-lived credential: treat them like ~/.ssh keys. MCP_PROXY_PERSIST_TOKENS=off disables reading
 * and writing; deleting the directory logs every endpoint out.
 */

import { createHash } from 'crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getCodemieHome } from '../../utils/paths.js';
import { proxyLog } from '../proxy-logger.js';

import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/client';

const FILE_VERSION = 3;
/** Treat a token as expired slightly early so it is not sent just as it lapses. */
const EXPIRY_SKEW_MS = 60_000;

/** What is needed to get a new access token without the user: valid only together. */
export interface RenewalGrant {
  refreshToken: string;
  clientInfo: OAuthClientInformationMixed;
}

export interface PersistedLogin {
  /** Access token only: refresh tokens are kept in `grant`. */
  tokens: OAuthTokens;
  /** Epoch ms; undefined when the server did not report `expires_in`. */
  expiresAt: number | undefined;
  grant: RenewalGrant | undefined;
}

interface PersistedFile {
  version: typeof FILE_VERSION;
  resource: string;
  access_token: string;
  token_type: string;
  scope?: string;
  obtainedAt: number;
  expiresAt?: number;
  refresh_token?: string;
  client?: OAuthClientInformationMixed;
}

function enabled(): boolean {
  return (process.env.MCP_PROXY_PERSIST_TOKENS || '').toLowerCase() !== 'off';
}

function dir(): string {
  return join(getCodemieHome(), 'mcp-auth');
}

function pathFor(resource: URL): string {
  const name = createHash('sha256').update(resource.href).digest('hex').slice(0, 16);
  return join(dir(), `${name}.json`);
}

function note(resource: URL, message: string): void {
  proxyLog(`[mcp-proxy][tokens] ${resource.href}: ${message}`);
}

/**
 * The persisted login for `resource`, if it is still usable: a valid access token, or a grant that
 * can renew one. The access token may already be expired when a grant is returned. Never throws.
 */
export function loadPersistedLogin(resource: URL): PersistedLogin | undefined {
  if (!enabled()) return undefined;

  try {
    const data = JSON.parse(readFileSync(pathFor(resource), 'utf-8')) as PersistedFile;
    if (data.version !== FILE_VERSION || data.resource !== resource.href) return undefined;

    const grant: RenewalGrant | undefined =
      data.refresh_token && data.client ? { refreshToken: data.refresh_token, clientInfo: data.client } : undefined;
    const fresh = data.expiresAt !== undefined && data.expiresAt - EXPIRY_SKEW_MS > Date.now();

    if (!fresh && !grant) {
      note(resource, 'persisted token expired and cannot be renewed, a login is required');
      forgetPersistedLogin(resource);
      return undefined;
    }

    note(resource, fresh
      ? `restored login (access token valid for another ${Math.round((data.expiresAt! - Date.now()) / 60_000)} min${grant ? ', renewable' : ''})`
      : 'restored login with an expired access token, renewing with the refresh token');
    return {
      tokens: {
        access_token: data.access_token,
        token_type: data.token_type,
        ...(data.scope ? { scope: data.scope } : {}),
      },
      expiresAt: data.expiresAt,
      grant,
    };
  } catch {
    return undefined; // no file, or unreadable: log in as usual
  }
}

/** Persist the current login. Nothing is written if it could not be reused later. */
export function persistLogin(resource: URL, login: PersistedLogin): void {
  if (!enabled()) return;

  // Without a lifetime or a grant there is no safe moment to stop reusing the token
  if (login.expiresAt === undefined && !login.grant) {
    note(resource, 'not persisting: no expires_in and no refresh token');
    return;
  }

  const data: PersistedFile = {
    version: FILE_VERSION,
    resource: resource.href,
    access_token: login.tokens.access_token,
    token_type: login.tokens.token_type,
    ...(login.tokens.scope ? { scope: login.tokens.scope } : {}),
    obtainedAt: Date.now(),
    ...(login.expiresAt !== undefined ? { expiresAt: login.expiresAt } : {}),
    ...(login.grant ? { refresh_token: login.grant.refreshToken, client: login.grant.clientInfo } : {}),
  };

  const path = pathFor(resource);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    chmodSync(dir(), 0o700); // mkdir's mode does not apply to a directory that already existed
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    note(resource, `persisted login (${login.grant ? 'with' : 'without'} refresh token)`);
  } catch (error) {
    note(resource, `could not persist login: ${error}`);
    try {
      unlinkSync(tmp); // never leave a half-written file holding a token behind
    } catch {
      // nothing to remove
    }
  }
}

/** Drop the persisted login for `resource` (revoked, or refused by the server). */
export function forgetPersistedLogin(resource: URL): void {
  try {
    unlinkSync(pathFor(resource));
  } catch {
    // already gone
  }
}
