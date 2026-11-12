import { apiIdentity, ownerHash } from '@/agents/core/evidence/api-identity.js';
import { resolveEmailFromCredentials } from '@/agents/core/identity-resolver.js';
import type { JWTCredentials, SSOCredentials } from '@/providers/core/types.js';
import type { SessionStatus } from './session-status.js';
import { readRange } from './spool-files.js';

/** Any pending hook line carries the `evidence_v: 1` envelope marker. Caller holds the lock. */
export async function pendingHooksMarkedLocked(sessionId: string, status: SessionStatus): Promise<boolean> {
  const pending = await readRange(sessionId, 'hooks', status.cursors.hooks);
  if (!pending) return false;
  return pending
    .toString('utf-8')
    .split('\n')
    .some((line) => {
      try {
        return (JSON.parse(line) as { evidence_v?: unknown }).evidence_v === 1;
      } catch {
        return false;
      }
    });
}

/**
 * The forwarder's own evidence identity (spec item 7: "found by the forwarder's own key"): the
 * daemon credentials' API URL and signed-in email, the same pair the hook stamps with
 * (`resolveHookCredentials` mirrors the daemon's credential choice). `null` = no key can be built.
 */
export function forwarderIdentity(
  credentials: SSOCredentials | JWTCredentials
): { api_identity: string; owner_hash: string } | null {
  const email = resolveEmailFromCredentials(credentials);
  if (!email) return null;
  try {
    return { api_identity: apiIdentity(credentials.apiUrl), owner_hash: ownerHash(email) };
  } catch {
    return null;
  }
}
