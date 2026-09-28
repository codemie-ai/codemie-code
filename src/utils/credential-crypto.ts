/**
 * Credential-encryption primitives.
 *
 * Split out of security.ts (rather than kept there and re-exported) because the Claude Code
 * statusline (src/agents/plugins/claude/plugin/statusline.ts) needs to decrypt the same
 * credential files security.ts's CredentialStore writes, without hand-copying the derivation —
 * but that file is bundled standalone by scripts/bundle-statusline.mjs into one self-contained
 * artifact with no node_modules resolution at runtime. security.ts itself is NOT safe to import
 * into that bundle: CredentialStore lazily loads the optional `keytar` native module (a `.node`
 * binary esbuild has no loader for), and esbuild resolves an entire imported file's module graph
 * even when only a few of its exports are actually used, so pulling in security.ts pulls in
 * keytar too and the build fails outright (observed on CI, not just locally). This module has
 * only Node builtin imports (crypto, os) — nothing esbuild can choke on — so statusline.ts
 * imports it directly instead, and security.ts imports it right back for CredentialStore's own
 * use. Keep it that way: importing anything else in here (fs, keytar, or security.ts itself)
 * reintroduces the same bundling failure.
 */

import * as crypto from 'crypto';
import * as os from 'os';
import { URL } from 'url';

/** Machine-specific AES-256 key, derived identically wherever a credential file is read or written. */
export function deriveMachineEncryptionKey(): Buffer {
  const machineId = os.hostname() + os.platform() + os.arch();
  const hex = crypto.createHash('sha256').update(machineId).digest('hex');
  return crypto.createHash('sha256').update(hex).digest();
}

export function encryptWithKey(text: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

/** Decrypts either the current AES-256-GCM format (`iv:authTag:encrypted`) or the legacy AES-256-CBC format (`iv:encrypted`). */
export function decryptWithKey(text: string, key: Buffer): string {
  const parts = text.split(':');
  if (parts.length === 3) {
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(parts[2], 'hex', 'utf8') + decipher.final('utf8');
  }
  // Legacy CBC format: iv:encrypted (backward compat for existing stored credentials)
  const iv = Buffer.from(parts[0], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return decipher.update(parts[1], 'hex', 'utf8') + decipher.final('utf8');
}

/**
 * Reduce a URL to protocol+host, or return it unchanged if it is not an
 * http(s) URL with a host.
 *
 * `new URL()` does not throw on `scheme:rest` strings — `new URL('localhost:8080')`
 * parses as protocol `localhost:` with an *empty* host. Without the host and
 * protocol guard every scheme-less `host:port` would normalize to the same
 * `scheme://` and two different instances would share one credential entry.
 */
export function normalizeUrlForKey(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.host && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      return `${parsed.protocol}//${parsed.host}`.toLowerCase();
    }
  } catch {
    // Not a parseable URL — fall through to the raw form.
  }
  return baseUrl.replace(/\/$/, '').toLowerCase();
}

function hashStorageKey(normalized: string): string {
  return `sso-${crypto.createHash('sha256').update(normalized).digest('hex')}`;
}

/**
 * Generate a storage key for a given URL.
 *
 * Reduces the URL to protocol+host before hashing so storage and retrieval
 * always agree on a key regardless of which path a caller passes in (e.g.
 * a bare portal URL from `codemie setup` vs. a full API URL from
 * `codemie profile login --url <api-url>`). Only stripping a trailing
 * slash here (without dropping the path) would make the key sensitive to
 * whichever URL variant happened to be passed at store time.
 * @param baseUrl - The URL to hash (path/query/hash, if any, are discarded)
 * @returns Storage key (e.g., "sso-abc123...")
 */
export function deriveUrlStorageKey(baseUrl: string): string {
  return hashStorageKey(normalizeUrlForKey(baseUrl));
}

/**
 * Storage key as it was derived before the URL was normalized to protocol+host.
 * Only used to find and clean up credentials written by an earlier version.
 */
export function deriveLegacyUrlStorageKey(baseUrl: string): string {
  return hashStorageKey(baseUrl.replace(/\/$/, '').toLowerCase());
}
