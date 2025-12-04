import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SSOCredentials } from '../providers/core/types.js';

const SERVICE_NAME = 'codemie-code';
const ACCOUNT_NAME = 'sso-credentials';
const FALLBACK_FILE = path.join(os.homedir(), '.codemie', 'sso-credentials.enc');

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

  async storeSSOCredentials(credentials: SSOCredentials): Promise<void> {
    const encrypted = this.encrypt(JSON.stringify(credentials));

    const keytarModule = await getKeytar();
    if (keytarModule) {
      try {
        // Try secure keychain storage first
        await keytarModule.setPassword(SERVICE_NAME, ACCOUNT_NAME, encrypted);
        return;
      } catch {
        // Fall through to file storage
      }
    }

    // Use encrypted file storage as fallback
    await this.storeToFile(encrypted);
  }

  async retrieveSSOCredentials(): Promise<SSOCredentials | null> {
    // Try keychain first if available
    const keytarModule = await getKeytar();
    if (keytarModule) {
      try {
        const encrypted = await keytarModule.getPassword(SERVICE_NAME, ACCOUNT_NAME);
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
      const encrypted = await this.retrieveFromFile();
      if (encrypted) {
        const decrypted = this.decrypt(encrypted);
        return JSON.parse(decrypted);
      }
    } catch {
      // Unable to decrypt file storage
    }

    return null;
  }

  async clearSSOCredentials(): Promise<void> {
    // Clear keychain if available
    const keytarModule = await getKeytar();
    if (keytarModule) {
      try {
        await keytarModule.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
      } catch {
        // Ignore errors, will try file storage next
      }
    }

    // Also clear file storage
    try {
      await fs.unlink(FALLBACK_FILE);
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

  private async storeToFile(encrypted: string): Promise<void> {
    const dir = path.dirname(FALLBACK_FILE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(FALLBACK_FILE, encrypted, 'utf8');
  }

  private async retrieveFromFile(): Promise<string | null> {
    try {
      return await fs.readFile(FALLBACK_FILE, 'utf8');
    } catch {
      return null;
    }
  }
}