/**
 * Persistence of an MCP OAuth login between runs, one file per MCP endpoint.
 *
 * A file holds the access token and its expiry, plus the refresh token together with the client
 * registration it was issued to (a refresh token only works for that client). With it a restarted
 * proxy renews an expired access token silently instead of opening the browser again.
 *
 * Nothing is shared between endpoints: each endpoint of a gateway (e.g. https://gateway.example/mcp/<name>)
 * demands its own login, so each gets its own file. Normally one process writes a file, but adoption
 * (a proxy picking up a login another proxy just persisted) means two writers per file are possible;
 * there is no cross-process lock, writes are atomic (temp file + rename) and the last writer wins.
 *
 * Files live in ~/.codemie/mcp-auth (dir 0700, files 0600) as `<hash>.enc`. They contain a refresh
 * token, i.e. a long-lived credential, so the content is encrypted with the same machine-bound
 * AES-256-GCM key as the SSO/JWT credentials (credential-crypto.ts): a file that is copied off the
 * machine by a backup, a sync tool or a support bundle is unreadable there. The key is derived from
 * machine facts, not from a secret, so this does not protect against another process running as the
 * same user.
 *
 * Deviation from CredentialStore (security.ts): that store prefers the OS keychain, whereas this one
 * always uses the encrypted file. Every proxy process reads its login unattended and per process, which
 * must not raise a keychain prompt, so the keychain is deliberately not used here (the repo guide
 * security-practices.md describes the keychain-first behaviour of CredentialStore, not this store).
 *
 * The 0700/0600 modes and the machine-bound key protect on POSIX only: chmodSync is largely a no-op on
 * Windows, where the file relies on the user profile ACLs alone.
 *
 * MCP_PROXY_PERSIST_TOKENS=off disables reading and writing; deleting the directory logs every
 * endpoint out.
 */

import { createHash } from 'crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { decryptWithKey, deriveMachineEncryptionKey, encryptWithKey } from '../../utils/credential-crypto.js';
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
  return join(dir(), `${name}.enc`);
}

function note(resource: URL, message: string): void {
  proxyLog(`[mcp-proxy][tokens] ${resource.href}: ${message}`);
}

/** The decoded file plus what is derived from it, before any decision about its use. */
interface DecodedFile {
  data: PersistedFile;
  grant: RenewalGrant | undefined;
  /** The access token is valid beyond the skew. */
  fresh: boolean;
}

/** Read and decode the file for `resource`. Does not check the kill switch, never deletes, never throws. */
function decode(resource: URL): DecodedFile | undefined {
  try {
    const data = JSON.parse(
      decryptWithKey(readFileSync(pathFor(resource), 'utf-8'), deriveMachineEncryptionKey()),
    ) as PersistedFile;
    if (data.version !== FILE_VERSION || data.resource !== resource.href) return undefined;

    const grant: RenewalGrant | undefined =
      data.refresh_token && data.client ? { refreshToken: data.refresh_token, clientInfo: data.client } : undefined;
    const fresh = data.expiresAt !== undefined && data.expiresAt - EXPIRY_SKEW_MS > Date.now();
    return { data, grant, fresh };
  } catch {
    return undefined; // no file, or unreadable (e.g. written on another machine): log in as usual
  }
}

function toLogin({ data, grant }: DecodedFile): PersistedLogin {
  return {
    tokens: {
      access_token: data.access_token,
      token_type: data.token_type,
      ...(data.scope ? { scope: data.scope } : {}),
    },
    expiresAt: data.expiresAt,
    grant,
  };
}

/**
 * The persisted login for `resource`, if it is still usable: a valid access token, or a grant that
 * can renew one. The access token may already be expired when a grant is returned. A login that is
 * neither valid nor renewable is deleted. Never throws.
 */
export function loadPersistedLogin(resource: URL): PersistedLogin | undefined {
  if (!enabled()) return undefined;

  const decoded = decode(resource);
  if (!decoded) return undefined;

  if (!decoded.fresh && !decoded.grant) {
    note(resource, 'persisted token expired and cannot be renewed, a login is required');
    forgetPersistedLogin(resource);
    return undefined;
  }

  note(resource, decoded.fresh
    ? `restored login (access token valid for another ${Math.round((decoded.data.expiresAt! - Date.now()) / 60_000)} min${decoded.grant ? ', renewable' : ''})`
    : 'restored login with an expired access token, renewing with the refresh token');
  return toLogin(decoded);
}

/**
 * Like `loadPersistedLogin`, but read-only: it never deletes the file and writes no log line. Used to
 * look at what another process persisted without changing it. Never throws.
 */
export function peekPersistedLogin(resource: URL): PersistedLogin | undefined {
  if (!enabled()) return undefined;

  const decoded = decode(resource);
  if (!decoded || (!decoded.fresh && !decoded.grant)) return undefined;
  return toLogin(decoded);
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
    writeFileSync(tmp, encryptWithKey(JSON.stringify(data), deriveMachineEncryptionKey()), { mode: 0o600 });
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

/**
 * Drop the persisted login for `resource` only if it still holds `refreshToken`. A file with another
 * refresh token was written by a process that logged in again meanwhile and must survive. Returns
 * whether the file was removed. Never throws.
 */
export function forgetPersistedLoginIf(resource: URL, refreshToken: string): boolean {
  const decoded = decode(resource);
  if (decoded?.grant?.refreshToken !== refreshToken) return false;
  try {
    unlinkSync(pathFor(resource));
    return true;
  } catch {
    return false; // already gone
  }
}
