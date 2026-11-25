import { resolveHookCredentials } from '../hook-credentials.js';
import { resolveEmailFromCredentials } from '../identity-resolver.js';
import { apiIdentity, ownerHash } from './api-identity.js';

/** The signed-in owner and backend, as the stamp keys them; null when either cannot be established. Never throws. */
export async function currentEvidenceIdentity(): Promise<{ api_identity: string; owner_hash: string } | null> {
  try {
    const auth = await resolveHookCredentials();
    if (!auth?.apiUrl) return null;
    const email = resolveEmailFromCredentials(auth);
    if (!email) return null;
    return { api_identity: apiIdentity(auth.apiUrl), owner_hash: ownerHash(email) };
  } catch {
    return null;
  }
}
