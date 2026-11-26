/**
 * Browser logins that MCP proxies are waiting on, one file per proxy process.
 *
 * Claude Code runs each mcp-proxy over stdio, so the proxy has no terminal to show the
 * authorization URL or read a pasted callback. When the browser cannot reach the proxy's
 * callback server (SSH, containers), `codemie mcp-auth` reads these files to finish the login.
 */

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getCodemiePath } from '../../utils/paths.js';
import { isProcessAlive } from '../../utils/processes.js';

export interface PendingLogin {
  pid: number;
  serverUrl: string;
  authorizationUrl: string;
  redirectUrl: string;
}

const pendingDir = () => getCodemiePath('mcp-auth-pending');
const ownFile = () => join(pendingDir(), `${process.pid}.json`);

export function writePendingLogin(login: Omit<PendingLogin, 'pid'>): void {
  try {
    mkdirSync(pendingDir(), { recursive: true, mode: 0o700 });
    writeFileSync(ownFile(), JSON.stringify({ pid: process.pid, ...login }), { mode: 0o600 });
  } catch {
    // Best effort: the browser callback still works without it
  }
}

export function clearPendingLogin(): void {
  try {
    unlinkSync(ownFile());
  } catch {
    // Already gone
  }
}

/** Logins whose proxy is still running; files left by dead proxies are removed. */
export function listPendingLogins(): PendingLogin[] {
  let names: string[];
  try {
    names = readdirSync(pendingDir()).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }

  const logins: PendingLogin[] = [];
  for (const name of names) {
    const file = join(pendingDir(), name);
    try {
      const login = JSON.parse(readFileSync(file, 'utf-8')) as PendingLogin;
      if (isProcessAlive(login.pid)) {
        logins.push(login);
        continue;
      }
    } catch {
      // Unreadable file: treat like a dead proxy
    }
    try {
      unlinkSync(file);
    } catch {
      // Removed concurrently
    }
  }
  return logins;
}
