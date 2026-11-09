import { resolveHookCredentials } from '../hook-credentials.js';
import { resolveEmailFromCredentials } from '../identity-resolver.js';
import { apiIdentity, ownerHash } from './api-identity.js';

/** The signed-in owner and backend, as the stamp keys them; null when either cannot be established. Never throws. */
export async function currentEvidenceIdentity(): Promise<{ api_identity: string; owner_hash: string } | null> {
  try {
    const credentials = await resolveHookCredentials();
    if (!credentials?.apiUrl) return null;
    const email = resolveEmailFromCredentials(credentials);
    if (!email) return null;
    return { api_identity: apiIdentity(credentials.apiUrl), owner_hash: ownerHash(email) };
  } catch {
    return null;
  }
}
