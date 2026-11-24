import { createHash } from 'node:crypto';

/**
 * Canonical API identity: scheme + lowercased host + non-default port + normalized path.
 * Never includes userinfo, query or fragment. Error text never echoes the input (may hold credentials).
 */
export function apiIdentity(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Invalid API URL: cannot parse');
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) {
    throw new Error('Invalid API URL: must be http(s) with a host');
  }
  // WHATWG URL already lowercases host, brackets IPv6 and drops default ports.
  const path = u.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/** sha256 hex of the trimmed, lowercased signed-in email. */
export function ownerHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}
