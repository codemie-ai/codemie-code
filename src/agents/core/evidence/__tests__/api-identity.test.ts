import { describe, it, expect } from 'vitest';
import { apiIdentity, ownerHash } from '../api-identity.js';

describe('apiIdentity (AC14)', () => {
  it('distinguishes base paths', () => {
    expect(apiIdentity('https://h.example/a')).not.toBe(apiIdentity('https://h.example/b'));
  });

  it('strips userinfo, query, fragment', () => {
    const id = apiIdentity('https://u:tok@h.example/a?x=1#f');
    expect(id).toBe('https://h.example/a');
    expect(id).not.toContain('tok');
  });

  it('drops default ports, keeps others', () => {
    expect(apiIdentity('https://h.example:443/a')).toBe('https://h.example/a');
    expect(apiIdentity('http://h.example:80/a')).toBe('http://h.example/a');
    expect(apiIdentity('https://h.example:8443/a')).toBe('https://h.example:8443/a');
  });

  it('lowercases host, keeps path case, collapses slashes, drops trailing slash', () => {
    expect(apiIdentity('HTTPS://H.Example//Api//V1/')).toBe('https://h.example/Api/V1');
    expect(apiIdentity('https://h.example/')).toBe('https://h.example');
  });

  it('brackets IPv6', () => {
    expect(apiIdentity('http://[::1]:8080/x')).toBe('http://[::1]:8080/x');
  });

  it('is stable across calls', () => {
    expect(apiIdentity('https://h.example/a')).toBe(apiIdentity('https://h.example/a'));
  });

  it('throws without echoing the input', () => {
    for (const bad of ['', 'not a url', 'ftp://h/x', 'https://u:secret@']) {
      try {
        apiIdentity(bad);
        throw new Error('expected throw');
      } catch (e) {
        expect((e as Error).message).not.toContain('secret');
        expect((e as Error).message).toMatch(/invalid api url/i);
      }
    }
  });
});

describe('ownerHash', () => {
  it('is case/whitespace-insensitive sha256 hex', () => {
    const h = ownerHash('User@Example.com');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(ownerHash('  user@example.COM ')).toBe(h);
    expect(ownerHash('user@example.com')).toBe(h);
    expect(ownerHash('other@example.com')).not.toBe(h);
  });
});
