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
