import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SSOCredentials } from '../providers/core/types.js';
import { getCodemiePath } from './codemie-home.js';

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

export class CredentialStore {
  private static instance: CredentialStore;
  private encryptionKey: string;

  private constructor() {
    this.encryptionKey = this.getOrCreateEncryptionKey();
  }

  static getInstance(): CredentialStore {
    if (!CredentialStore.instance) {
      CredentialStore.instance = new CredentialStore();
    }
    return CredentialStore.instance;
  }

  /**
   * Generate a storage key for a given base URL
   * @param baseUrl - The base URL to hash
   * @returns Storage key (e.g., "sso-abc123...")
   */
  private getUrlStorageKey(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/$/, '').toLowerCase();
    const hash = crypto.createHash('sha256').update(normalized).digest('hex');
    return `sso-${hash}`;
  }

  async storeSSOCredentials(credentials: SSOCredentials, baseUrl?: string): Promise<void> {
    const encrypted = this.encrypt(JSON.stringify(credentials));

    // Determine storage key based on whether baseUrl is provided
    const accountName = baseUrl ? this.getUrlStorageKey(baseUrl) : ACCOUNT_NAME;
    const filePath = baseUrl
      ? path.join(CREDENTIALS_DIR, `${this.getUrlStorageKey(baseUrl)}.enc`)
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
    // Determine storage key based on whether baseUrl is provided
    const accountName = baseUrl ? this.getUrlStorageKey(baseUrl) : ACCOUNT_NAME;
    const filePath = baseUrl
      ? path.join(CREDENTIALS_DIR, `${this.getUrlStorageKey(baseUrl)}.enc`)
      : FALLBACK_FILE;

    // Try keychain first if available
    const keytarModule = await getKeytar();
    if (keytarModule) {
      try {
        const encrypted = await keytarModule.getPassword(SERVICE_NAME, accountName);
        if (encrypted) {
          const decrypted = this.decrypt(encrypted);
          return JSON.parse(decrypted);
        }
      } catch {
        // Fall through to file storage
      }
    }

    // Always try file storage as fallback
    try {
      const encrypted = await this.retrieveFromFile(filePath);
      if (encrypted) {
        const decrypted = this.decrypt(encrypted);
        return JSON.parse(decrypted);
      }
    } catch {
      // Unable to decrypt file storage
    }

    return null;
  }

  async clearSSOCredentials(baseUrl?: string): Promise<void> {
    // Determine storage key based on whether baseUrl is provided
    const accountName = baseUrl ? this.getUrlStorageKey(baseUrl) : ACCOUNT_NAME;
    const filePath = baseUrl
      ? path.join(CREDENTIALS_DIR, `${this.getUrlStorageKey(baseUrl)}.enc`)
      : FALLBACK_FILE;

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

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    // Use a proper 32-byte key by hashing the encryptionKey
    const key = crypto.createHash('sha256').update(this.encryptionKey).digest();
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  private decrypt(text: string): string {
    const [ivHex, encryptedHex] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    // Use a proper 32-byte key by hashing the encryptionKey
    const key = crypto.createHash('sha256').update(this.encryptionKey).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  private getOrCreateEncryptionKey(): string {
    // Use machine-specific key based on hardware info
    const machineId = os.hostname() + os.platform() + os.arch();
    return crypto.createHash('sha256').update(machineId).digest('hex');
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