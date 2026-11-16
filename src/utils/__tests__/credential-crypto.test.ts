import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { decryptWithKey, encryptWithKey } from '../credential-crypto.js';

describe('credential-crypto', () => {
  const key = crypto.randomBytes(32);

  it('round-trips AES-256-GCM', () => {
    expect(decryptWithKey(encryptWithKey('secret', key), key)).toBe('secret');
  });

  it('rejects tampered ciphertext', () => {
    const [iv, tag, enc] = encryptWithKey('secret', key).split(':');
    const flipped = (enc[0] === '0' ? '1' : '0') + enc.slice(1);
    expect(() => decryptWithKey(`${iv}:${tag}:${flipped}`, key)).toThrow();
  });

  it('rejects the legacy unauthenticated CBC format', () => {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-cbc', key, iv);
    const enc = c.update('secret', 'utf8', 'hex') + c.final('hex');
    expect(() => decryptWithKey(`${iv.toString('hex')}:${enc}`, key)).toThrow(/Unsupported/);
  });
});
