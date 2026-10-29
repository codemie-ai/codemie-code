/**
 * Security Utilities
 *
 * Consolidated security operations including:
 * - Data sanitization and redaction for logs
 * - Encrypted credential storage
 * - Sensitive data detection
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SSOCredentials, JWTCredentials } from '../providers/core/types.js';
import { getCodemiePath } from './paths.js';
import {
  deriveMachineEncryptionKey,
  encryptWithKey,
  decryptWithKey,
  deriveUrlStorageKey,
  deriveLegacyUrlStorageKey,
} from './credential-crypto.js';

// ============================================================================
// Data Sanitization and Redaction
// ============================================================================

/**
 * Patterns to identify sensitive keys in objects
 */
const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /auth[_-]?token/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /bearer[_-]?token/i,
  /password/i,
  /secret/i,
  /credential/i,
  /private[_-]?key/i,
  /cookie/i,
  /authorization/i
];

/**
 * Patterns to identify sensitive values (even if key name is not sensitive)
 */
const SENSITIVE_VALUE_PATTERNS = [
  /^sk-[a-zA-Z0-9]{20,}$/, // OpenAI API keys
  /^sk-ant-[a-zA-Z0-9-_]{95,}$/, // Anthropic API keys
  /^ya29\.[a-zA-Z0-9-_]{100,}$/, // Google OAuth tokens
  /^[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}$/, // JWT tokens
  /^Bearer\s+[A-Za-z0-9-_.+/=]{20,}$/i, // Bearer tokens
];

/**
 * Check if a key name indicates sensitive data
 */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test(key));
}

/**
 * Check if a value looks like sensitive data
 */
function isSensitiveValue(value: string): boolean {
  if (value.length < 20) return false; // Short strings unlikely to be secrets
  return SENSITIVE_VALUE_PATTERNS.some(pattern => pattern.test(value));
}

/**
 * Mask a sensitive string, showing only first and last few characters
 */
function maskString(value: string, showChars = 4): string {
  if (value.length <= showChars * 2) {
    return '[REDACTED]';
  }
  return `${value.slice(0, showChars)}...${value.slice(-showChars)} [REDACTED]`;
}

/**
 * Sanitize a value for logging
 */
export function sanitizeValue(value: unknown, key?: string): unknown {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return value;
  }

  // Check if key name is sensitive
  if (key && isSensitiveKey(key)) {
    if (typeof value === 'string') {
      return maskString(value);
    }
    if (typeof value === 'object') {
      return '[REDACTED OBJECT]';
    }
    return '[REDACTED]';
  }

  // Handle strings
  if (typeof value === 'string') {
    if (isSensitiveValue(value)) {
      return maskString(value);
    }
    return value;
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item));
  }

  // Handle objects
  if (typeof value === 'object') {
    return sanitizeObject(value as Record<string, unknown>);
  }

  // Handle primitives (numbers, booleans, etc.)
  return value;
}

/**
 * Sanitize an object for logging
 */
export function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    sanitized[key] = sanitizeValue(value, key);
  }

  return sanitized;
}

/** Marker that replaces a secret; no part of the secret is shown. */
const REDACTED = '[REDACTED]';

/** Longest text scanned by `maskSecretsInText`; anything beyond is dropped so the scan stays bounded. */
const MAX_MASK_INPUT_CHARS = 64 * 1024;

/** Deepest nesting `maskSecretsDeep` walks; anything deeper is redacted whole. */
const MAX_MASK_DEPTH = 32;

const NAME_VALUE_SEPARATOR = String.raw`\\?["']?[ \t]*[:=][ \t]*`;
const QUOTED_OR_MASKED_VALUE = String.raw`\[REDACTED\]|\\?"[^"\r\n]*"|\\?'[^'\r\n]*'`;
const VALUE_END = String.raw`(?=[\s"',;.)\]}]|$)`;

/** Plain words that follow a secret-sounding name in prose or status output ("token: expired"). */
const STATUS_WORD_VALUE = String.raw`(?!(?:expired|invalid|required|missing|none|null|nil|undefined|true|false|empty|unset|valid|revoked|hidden)${VALUE_END})`;

/** A number or a path after the bare names pass/pwd ("pass: 12 tests", "PWD=/home/x"). */
const NUMBER_OR_PATH_VALUE = String.raw`(?!\d+${VALUE_END})(?![/~\\]|\.{1,2}[/\\]|[A-Za-z]:[/\\])`;

const STRONG_SECRET_NAME =
  '[A-Za-z0-9_-]{0,60}(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|secret[_-]?key|signing[_-]?key|encryption[_-]?key|master[_-]?key|auth[_-]?key|credentials?)';

// pass and pwd double as ordinary words and as the shell's working directory, so a number or path value is left alone
const BARE_PASS_NAME = '[A-Za-z0-9_-]{0,60}pwd|(?:[A-Za-z0-9_-]{0,60}[_-])?pass';

/** `NAME=value` / `name: value` / `"name": "value"`; an unquoted value is kept when `exempt` matches it. */
function nameValueRule(name: string, exempt: string): [RegExp, string] {
  return [
    new RegExp(
      String.raw`\b((?:${name})${NAME_VALUE_SEPARATOR})(?:${QUOTED_OR_MASKED_VALUE}|${STATUS_WORD_VALUE}${exempt}[^\s"']+)`,
      'gi',
    ),
    `$1${REDACTED}`,
  ];
}

/**
 * Secret formats found embedded in free text (not anchored, unlike SENSITIVE_VALUE_PATTERNS).
 * Every quantifier is bounded or runs over a character class that cannot overlap the next
 * token, so matching stays linear on adversarial input. Each entry replaces the whole match.
 * Pattern matching is best effort: a secret in a format listed here is masked, any other passes through.
 */
const EMBEDDED_SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // PEM block, including one cut off before its END line
  [/-----BEGIN [A-Z0-9 ]{1,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,40}-----|$)/g, REDACTED],
  // scheme://user:password@host - keep scheme and host
  [/\b([a-zA-Z][a-zA-Z0-9+.-]{0,20}:\/\/)[^\s:@/]+:[^\s@/]+@/g, `$1${REDACTED}@`],
  // Authorization header or JSON field: the whole credential after any scheme word (Negotiate, AWS4-..., ...)
  [/(\bauthorization\\?["']?[ \t]*[:=][ \t]*\\?["']?)[^\s"'\\;][^\r\n"'\\;]*/gi, `$1${REDACTED}`],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Bearer token (needs a digit or 20+ characters so prose such as "Bearer authentication" is left alone)
  [/\b(Bearer[ \t]+)(?=[A-Za-z0-9._~+/-]{0,200}\d|[A-Za-z0-9._~+/-]{20})[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${REDACTED}`],
  // OpenAI / Anthropic keys
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  // Stripe secret and restricted keys
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
  // Google API keys and OAuth access tokens
  [/\bAIza[A-Za-z0-9_-]{30,}/g, REDACTED],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, REDACTED],
  // npm and Hugging Face tokens
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bhf_[A-Za-z0-9]{30,}/g, REDACTED],
  // AWS access key ids
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  // GitHub tokens
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  // GitLab personal access tokens
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  // Slack tokens
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  // Space-separated secret flags: --password hunter2, --api-key abc (not --token-file, nor an option or $VAR value)
  [
    /(--[a-z0-9-]{0,40}(?:password|passwd|secret|token|api-?key|access-?key|private-?key|credentials?)[ \t]+)(?![-$])(?:\\?"[^"\r\n]*"|\\?'[^'\r\n]*'|[^\s"']+)/gi,
    `$1${REDACTED}`,
  ],
  // curl -u user:password / --user user:password (a numeric uid:gid pair such as docker's -u 1000:1000 is not a login)
  [
    /(\bcurl\b[^\n|;&]{0,300}?[ \t](?:-u[ \t]*|--(?:proxy-)?user[ \t=]+))(?:\\?["'])?(?!\$)[^\s"':]+:(?!\d+(?:[\s"']|$))[^\s"']+(?:\\?["'])?/g,
    `$1${REDACTED}`,
  ],
  // mysql -pSECRET (attached; "-p SECRET" with a space makes mysql prompt, and SECRET is the database name)
  [/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]{0,300}?[ \t]-p)(?!-)\S+/g, `$1${REDACTED}`],
  // NAME=value / name: value / "name": "value" where the name ends in a secret word
  nameValueRule(STRONG_SECRET_NAME, ''),
  nameValueRule(BARE_PASS_NAME, NUMBER_OR_PATH_VALUE),
];

/**
 * Replace secrets embedded anywhere in free text with `[REDACTED]`, leaving the
 * surrounding text intact. Input beyond 64 KB is dropped before scanning.
 */
export function maskSecretsInText(text: string): string {
  let masked = text.length > MAX_MASK_INPUT_CHARS ? text.slice(0, MAX_MASK_INPUT_CHARS) : text;
  for (const [pattern, replacement] of EMBEDDED_SECRET_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

/**
 * Walk strings, arrays and objects and mask every string with `maskSecretsInText`; a string
 * or container under a sensitive key (SENSITIVE_KEY_PATTERNS) is redacted whole. Other values are untouched
 * and the input is never mutated. `skipKeys` applies to top-level keys only.
 */
export function maskSecretsDeep(value: unknown, skipKeys?: ReadonlySet<string>): unknown {
  return maskDeep(value, skipKeys, 0);
}

function maskDeep(value: unknown, skipKeys: ReadonlySet<string> | undefined, depth: number): unknown {
  if (typeof value === 'string') {
    return maskSecretsInText(value);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (depth >= MAX_MASK_DEPTH) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map(item => maskDeep(item, undefined, depth + 1));
  }
  const masked: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (skipKeys?.has(key)) {
      masked[key] = child;
    } else if ((typeof child === 'string' || (typeof child === 'object' && child !== null)) && isSensitiveKey(key)) {
      masked[key] = REDACTED;
    } else {
      masked[key] = maskDeep(child, undefined, depth + 1);
    }
  }
  return masked;
}

/**
 * Sanitize cookie object - only show cookie names and count
 */
export function sanitizeCookies(cookies: Record<string, string> | undefined): string {
  if (!cookies || typeof cookies !== 'object') {
    return 'none';
  }

  const names = Object.keys(cookies);
  if (names.length === 0) {
    return 'none';
  }

  return `${names.length} cookie(s): ${names.join(', ')} [values redacted]`;
}

/**
 * Sanitize authentication token - only show type and prefix
 */
export function sanitizeAuthToken(token: string | undefined): string {
  if (!token) {
    return 'none';
  }

  if (token === 'sso-authenticated') {
    return 'sso-authenticated (placeholder)';
  }

  // Show only prefix for real tokens
  if (token.length > 8) {
    return `${token.slice(0, 8)}... [${token.length} chars, redacted]`;
  }

  return '[REDACTED]';
}

/**
 * Sanitize HTTP headers - special handling for cookie and set-cookie headers
 */
export function sanitizeHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    // Special handling for cookie headers
    if (lowerKey === 'cookie') {
      if (typeof value === 'string') {
        // Parse cookie string and show names only
        const cookieNames = value.split(';')
          .map(c => c.trim().split('=')[0])
          .filter(Boolean);
        sanitized[key] = `${cookieNames.length} cookie(s): ${cookieNames.join(', ')} [values redacted]`;
      } else {
        sanitized[key] = '[REDACTED]';
      }
    }
    // Special handling for set-cookie headers (array of strings)
    else if (lowerKey === 'set-cookie') {
      if (Array.isArray(value)) {
        const cookieNames = value.map(cookie => {
          const name = cookie.split('=')[0].trim();
          return name;
        });
        sanitized[key] = `Setting ${cookieNames.length} cookie(s): ${cookieNames.join(', ')} [values redacted]`;
      } else if (typeof value === 'string') {
        const name = value.split('=')[0].trim();
        sanitized[key] = `Setting cookie: ${name} [value redacted]`;
      } else {
        sanitized[key] = '[REDACTED]';
      }
    }
    // Special handling for authorization header
    else if (lowerKey === 'authorization') {
      if (typeof value === 'string') {
        const parts = value.split(' ');
        if (parts.length === 2) {
          sanitized[key] = `${parts[0]} [token redacted]`;
        } else {
          sanitized[key] = '[REDACTED]';
        }
      } else {
        sanitized[key] = '[REDACTED]';
      }
    }
    // Other sensitive headers
    else if (isSensitiveKey(key)) {
      sanitized[key] = '[REDACTED]';
    }
    // Non-sensitive headers pass through
    else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Sanitize log arguments before writing to console or file
 */
export function sanitizeLogArgs(...args: unknown[]): unknown[] {
  return args.map(arg => {
    if (typeof arg === 'string') {
      // Check if string looks like sensitive data
      if (isSensitiveValue(arg)) {
        return maskString(arg);
      }
      return arg;
    }

    if (typeof arg === 'object' && arg !== null) {
      return sanitizeValue(arg);
    }

    return arg;
  });
}

// ============================================================================
// Credential Storage
// ============================================================================

const SERVICE_NAME = 'codemie-code';
const ACCOUNT_NAME = 'sso-credentials';
const FALLBACK_FILE = getCodemiePath('sso-credentials.enc');
const CREDENTIALS_DIR = getCodemiePath('credentials');

/**
 * Lazy load keytar to avoid requiring system dependencies during test imports
 * Falls back gracefully if keytar is not available (e.g., in CI environments)
 */
let keytar: typeof import('keytar') | null | undefined = undefined;
async function getKeytar(): Promise<typeof import('keytar') | null> {
  if (keytar !== undefined) {
    return keytar;
  }
  try {
    keytar = await import('keytar');
    return keytar;
  } catch {
    // Keytar not available (missing system dependencies)
    keytar = null;
    return null;
  }
}

/**
 * Secure credential storage with encryption
 *
 * Stores SSO credentials using:
 * - System keychain (macOS Keychain, Windows Credential Vault) when available
 * - Encrypted file storage as fallback
 * - Machine-specific AES-256-CBC encryption
 */
export class CredentialStore {
  private static instance: CredentialStore;
  private encryptionKey: Buffer;

  private constructor() {
    this.encryptionKey = deriveMachineEncryptionKey();
  }

  static getInstance(): CredentialStore {
    if (!CredentialStore.instance) {
      CredentialStore.instance = new CredentialStore();
    }
    return CredentialStore.instance;
  }

  async storeSSOCredentials(credentials: SSOCredentials, baseUrl?: string): Promise<void> {
    const encrypted = encryptWithKey(JSON.stringify(credentials), this.encryptionKey);

    // Determine storage key based on whether baseUrl is provided
    const accountName = baseUrl ? deriveUrlStorageKey(baseUrl) : ACCOUNT_NAME;
    const filePath = baseUrl
      ? path.join(CREDENTIALS_DIR, `${deriveUrlStorageKey(baseUrl)}.enc`)
      : FALLBACK_FILE;

    // Store to keychain if available (best effort, don't fail if it errors)
    const keytarModule = await getKeytar();
    if (keytarModule) {
      try {
        await keytarModule.setPassword(SERVICE_NAME, accountName, encrypted);
      } catch {
        // Continue to file storage even if keychain fails
      }
    }

    // Always store to file as well for consistency
    await this.storeToFile(encrypted, filePath);
  }

  async retrieveSSOCredentials(baseUrl?: string): Promise<SSOCredentials | null> {
    if (!baseUrl) {
      return this.readCredential(ACCOUNT_NAME, FALLBACK_FILE);
    }

    const key = deriveUrlStorageKey(baseUrl);
    const current = await this.readCredential(key, this.credentialFilePath(key));
    if (current) {
      return current;
    }

    // Credentials written before the key was normalized live under the raw-URL key.
    // Migrate on first read, otherwise they stay unreachable — and undeletable,
    // since clearSSOCredentials would only ever look at the normalized key.
    const legacyKey = deriveLegacyUrlStorageKey(baseUrl);
    if (legacyKey === key) {
      return null;
    }

    const legacy = await this.readCredential(legacyKey, this.credentialFilePath(legacyKey));
    if (!legacy) {
      return null;
    }

    await this.storeSSOCredentials(legacy, baseUrl);
    await this.deleteCredential(legacyKey, this.credentialFilePath(legacyKey));
    return legacy;
  }

  async clearSSOCredentials(baseUrl?: string): Promise<void> {
    if (!baseUrl) {
      await this.deleteCredential(ACCOUNT_NAME, FALLBACK_FILE);
      return;
    }

    const key = deriveUrlStorageKey(baseUrl);
    await this.deleteCredential(key, this.credentialFilePath(key));

    const legacyKey = deriveLegacyUrlStorageKey(baseUrl);
    if (legacyKey !== key) {
      await this.deleteCredential(legacyKey, this.credentialFilePath(legacyKey));
    }
  }

  private credentialFilePath(storageKey: string): string {
    return path.join(CREDENTIALS_DIR, `${storageKey}.enc`);
  }

  private async readCredential(
    accountName: string,
    filePath: string,
  ): Promise<SSOCredentials | null> {
    const keytarModule = await getKeytar();
    if (keytarModule) {
      try {
        const encrypted = await keytarModule.getPassword(SERVICE_NAME, accountName);
        if (encrypted) {
          return JSON.parse(decryptWithKey(encrypted, this.encryptionKey));
        }
      } catch {
        // Fall through to file storage
      }
    }

    try {
      const encrypted = await this.retrieveFromFile(filePath);
      if (encrypted) {
        return JSON.parse(decryptWithKey(encrypted, this.encryptionKey));
      }
    } catch {
      // Unable to decrypt file storage
    }

    return null;
  }

  private async deleteCredential(accountName: string, filePath: string): Promise<void> {
    const keytarModule = await getKeytar();
    if (keytarModule) {
      try {
        await keytarModule.deletePassword(SERVICE_NAME, accountName);
      } catch {
        // Ignore errors, will try file storage next
      }
    }

    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore file not found errors
    }
  }

  /**
   * Store JWT credentials securely
   * @param credentials - JWT credentials to store
   * @param baseUrl - Optional base URL for per-URL storage
   */
  async storeJWTCredentials(credentials: JWTCredentials, baseUrl?: string): Promise<void> {
    const encrypted = encryptWithKey(JSON.stringify(credentials), this.encryptionKey);

    // Determine storage key based on whether baseUrl is provided
    // Use jwt- prefix to avoid collision with SSO credentials
    const accountName = baseUrl ? `jwt-${deriveUrlStorageKey(baseUrl)}` : 'jwt-credentials';
    const filePath = baseUrl
      ? path.join(CREDENTIALS_DIR, `jwt-${deriveUrlStorageKey(baseUrl)}.enc`)
      : path.join(CREDENTIALS_DIR, 'jwt-credentials.enc');

    // Store to keychain if available (best effort, don't fail if it errors)
    const keytarModule = await getKeytar();
    if (keytarModule) {
      try {
        await keytarModule.setPassword(SERVICE_NAME, accountName, encrypted);
      } catch {
        // Continue to file storage even if keychain fails
      }
    }

    // Always store to file as well for consistency
    await this.storeToFile(encrypted, filePath);
  }

  /**
   * Retrieve JWT credentials from secure storage
   * @param baseUrl - Optional base URL for per-URL retrieval
   * @returns JWT credentials or null if not found or expired
   */
  async retrieveJWTCredentials(baseUrl?: string): Promise<JWTCredentials | null> {
    // Determine storage key based on whether baseUrl is provided
    const accountName = baseUrl ? `jwt-${deriveUrlStorageKey(baseUrl)}` : 'jwt-credentials';
    const filePath = baseUrl
      ? path.join(CREDENTIALS_DIR, `jwt-${deriveUrlStorageKey(baseUrl)}.enc`)
      : path.join(CREDENTIALS_DIR, 'jwt-credentials.enc');

    // Try keychain first if available
    const keytarModule = await getKeytar();
    if (keytarModule) {
      try {
        const encrypted = await keytarModule.getPassword(SERVICE_NAME, accountName);
        if (encrypted) {
          const decrypted = decryptWithKey(encrypted, this.encryptionKey);
          const credentials = JSON.parse(decrypted) as JWTCredentials;

          // Check token expiration
          if (credentials.expiresAt && Date.now() > credentials.expiresAt) {
            return null; // Token expired
          }

          return credentials;
        }
      } catch {
        // Fall through to file storage
      }
    }

    // Always try file storage as fallback
    try {
      const encrypted = await this.retrieveFromFile(filePath);
      if (encrypted) {
        const decrypted = decryptWithKey(encrypted, this.encryptionKey);
        const credentials = JSON.parse(decrypted) as JWTCredentials;

        // Check token expiration
        if (credentials.expiresAt && Date.now() > credentials.expiresAt) {
          return null; // Token expired
        }

        return credentials;
      }
    } catch {
      // Unable to decrypt file storage
    }

    return null;
  }

  /**
   * Clear JWT credentials from secure storage
   * @param baseUrl - Optional base URL for per-URL deletion
   */
  async clearJWTCredentials(baseUrl?: string): Promise<void> {
    // Determine storage key based on whether baseUrl is provided
    const accountName = baseUrl ? `jwt-${deriveUrlStorageKey(baseUrl)}` : 'jwt-credentials';
    const filePath = baseUrl
      ? path.join(CREDENTIALS_DIR, `jwt-${deriveUrlStorageKey(baseUrl)}.enc`)
      : path.join(CREDENTIALS_DIR, 'jwt-credentials.enc');

    // Clear keychain if available
    const keytarModule = await getKeytar();
    if (keytarModule) {
      try {
        await keytarModule.deletePassword(SERVICE_NAME, accountName);
      } catch {
        // Ignore errors, will try file storage next
      }
    }

    // Also clear file storage
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore file not found errors
    }
  }

  private async storeToFile(encrypted: string, filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, encrypted, 'utf8');
  }

  private async retrieveFromFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  }
}
