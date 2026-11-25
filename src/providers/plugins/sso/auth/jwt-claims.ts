/**
 * Pure JWT claim decoding. Keytar-free and logger-free on purpose: the esbuild-bundled statusline
 * reaches it through `selection.ts` consumers, so it imports nothing.
 */

/**
 * Decode a JWT's `exp` claim into an epoch-millisecond expiry. Returns undefined when the token
 * is absent or malformed/has no decodable `exp` — the caller then treats the credential as
 * having no locally known expiry.
 */
export function decodeJwtExpiresAt(token: string | undefined): number | undefined {
  if (!token) return undefined;
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64').toString('utf8'),
      );
      if (payload.exp && typeof payload.exp === 'number') {
        return payload.exp * 1000;
      }
    }
  } catch {
    // malformed JWT — no known expiry
  }
  return undefined;
}
