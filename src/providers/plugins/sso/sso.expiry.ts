/**
 * Expiry that may be enforced locally: the stored expiresAt counts only when a
 * codemie_access_token is present. Cookie-only credentials (including legacy
 * ones with a synthetic 24h expiresAt) never expire locally.
 */
export function effectiveExpiresAt(credentials: {
  cookies: Record<string, string>;
  expiresAt?: number;
}): number | undefined {
  return credentials.cookies?.codemie_access_token ? credentials.expiresAt : undefined;
}
