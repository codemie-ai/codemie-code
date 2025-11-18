import * as keytar from 'keytar';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SSOCredentials } from '../types/sso.js';

const SERVICE_NAME = 'codemie-code';
const ACCOUNT_NAME = 'sso-credentials';
const FALLBACK_FILE = path.join(os.homedir(), '.codemie', 'sso-credentials.enc');

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

    try {
      // Try secure keychain storage first
      await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, encrypted);
    } catch {
      console.warn('Keychain not available, using encrypted file storage');
      await this.storeToFile(encrypted);
    }
  }

  async retrieveSSOCredentials(): Promise<SSOCredentials | null> {
    try {
      // Try keychain first
      const encrypted = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
      if (encrypted) {
        const decrypted = this.decrypt(encrypted);
        return JSON.parse(decrypted);
      }
    } catch {
      // Fall back to file storage
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
    try {
      await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
    } catch {
      // Also clear file storage
      try {
        await fs.unlink(FALLBACK_FILE);
      } catch {
        // Ignore file not found errors
      }
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