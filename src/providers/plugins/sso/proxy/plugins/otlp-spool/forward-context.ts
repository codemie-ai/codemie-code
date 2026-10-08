/**
 * Per-forward-tick context: the CLI version banner, and the identity resolution glue
 * the hook-record mapping step calls once per batch. Split out of `forwarder.ts` to keep
 * that module under the documented 500-line structure cap (code-quality.md).
 */

import { execSync } from 'node:child_process';
import type { SSOCredentials, JWTCredentials } from '@/providers/core/types.js';
import { resolveIdentity, type IdentitySource } from './identity.js';

export interface ForwardContext {
  credentials: SSOCredentials | JWTCredentials;
  baseUrl: string;
  projectName: string;
  userEmail: string;
  /** Per-session developer-identity cache, resolved once */
  identity?: { developerName?: string; identitySource?: IdentitySource };
}

/** The installed CodeMie CLI version, resolved once at import time. */
export function resolveCodemieCliVersion(): string {
  try {
    const output = execSync('codemie --version', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
    return versionMatch ? versionMatch[1] : output;
  } catch {
    return '';
  }
}

/**
 * Resolve and cache this forward tick's developer identity once, from the first record that
 * carries a real `cwd`. An empty `cwd` (every synthetic transcript-derived record) is skipped
 * rather than cached, mirroring the same empty-`cwd` guard every other per-tick cache uses —
 * otherwise the first such record in a batch would permanently cache the cwd-less (and
 * therefore less accurate) result for every later record in the same tick.
 */
export async function resolveDeveloperIdentity(ctx: ForwardContext, cwd: string): Promise<void> {
  if (!cwd) {
    return;
  }
  if (!ctx.identity) {
    ctx.identity = {};
  }
  if (ctx.identity.developerName !== undefined) {
    return;
  }
  const { developerName, identitySource } = await resolveIdentity(ctx.credentials, cwd);
  ctx.identity.developerName = developerName;
  ctx.identity.identitySource = identitySource;
}
