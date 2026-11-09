/**
 * Persistent storage for MCP OAuth tokens and client registration info.
 *
 * `McpOAuthProvider` previously kept all OAuth state in memory only, so every new
 * proxy process (one per MCP server, per Claude Code session — see stdio-http-bridge.ts)
 * started blank, got a 401, and re-opened the browser authorization page. See
 * https://github.com/codemie-ai/codemie-code/issues/643.
 *
 * Reuses the same machine-derived AES-256 encryption as CredentialStore (security.ts)
 * so the file is opaque at rest, but keys and stores per MCP *server URL* rather than
 * per SSO base URL: unlike deriveUrlStorageKey (protocol+host only — fine for SSO,
 * where the whole API lives under one base URL), MCP servers share one host with
 * different paths (e.g. https://mcp.epam.com/mcp/jira vs. .../mcp/kb), so the key here
 * must include the full URL or two different servers' tokens would collide onto one file.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { getCodemiePath } from '../../utils/paths.js';
import {
  deriveMachineEncryptionKey,
  encryptWithKey,
  decryptWithKey,
} from '../../utils/credential-crypto.js';
import { logger } from '../../utils/logger.js';

import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/client';

export interface McpStoredCredentials {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

/** Full-URL hash so two servers on the same host never share a storage key. */
function deriveMcpStorageKey(serverUrl: string): string {
  return crypto.createHash('sha256').update(serverUrl).digest('hex');
}

// Resolved per call (not cached at module load) so CODEMIE_HOME overrides — e.g. test
// isolation via process.env.CODEMIE_HOME — are picked up even if this module was already
// imported beforehand.
function filePathFor(serverUrl: string): string {
  return getCodemiePath('credentials', `mcp-${deriveMcpStorageKey(serverUrl)}.enc`);
}

export async function loadMcpCredentials(serverUrl: string): Promise<McpStoredCredentials | null> {
  try {
    const encrypted = await fs.readFile(filePathFor(serverUrl), 'utf8');
    const decrypted = decryptWithKey(encrypted, deriveMachineEncryptionKey());
    return JSON.parse(decrypted) as McpStoredCredentials;
  } catch {
    // Missing file, or undecryptable (e.g. written on a different machine) — treat as absent.
    return null;
  }
}

export async function saveMcpCredentials(serverUrl: string, data: McpStoredCredentials): Promise<void> {
  const filePath = filePathFor(serverUrl);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const encrypted = encryptWithKey(JSON.stringify(data), deriveMachineEncryptionKey());
    await fs.writeFile(filePath, encrypted, 'utf8');
  } catch (error) {
    // Best-effort: falling back to in-memory-only behavior (the pre-fix state) beats crashing the proxy.
    logger.debug(`[mcp-proxy] Failed to persist MCP OAuth credentials: ${(error as Error).message}`);
  }
}

export async function clearMcpCredentials(serverUrl: string): Promise<void> {
  try {
    await fs.unlink(filePathFor(serverUrl));
  } catch {
    // Ignore missing file.
  }
}
