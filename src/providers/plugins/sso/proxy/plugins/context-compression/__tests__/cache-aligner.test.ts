import { describe, it, expect } from 'vitest';
import { createCacheAligner } from '../transforms/cache-aligner.js';
import type { ICMMessage } from '../transforms/icm.js';

function systemMsg(text: string): ICMMessage {
  return { role: 'system', content: text };
}

describe('CacheAligner — Tier 1 categories', () => {
  const aligner = createCacheAligner({ enabled: true });

  it('strips ISO 8601 timestamps', () => {
    const { messages } = aligner.align([systemMsg('Last run: 2025-11-15T08:30:00Z')]);
    expect((messages[0].content as string)).not.toContain('2025-11-15T08:30:00Z');
  });

  it('strips UUIDs', () => {
    const { messages } = aligner.align([systemMsg('session=550e8400-e29b-41d4-a716-446655440000')]);
    expect((messages[0].content as string)).not.toContain('550e8400-e29b-41d4-a716-446655440000');
  });

  it('strips request IDs (req_ prefix)', () => {
    const { messages } = aligner.align([systemMsg('Request ID: req_Abc123XY890')]);
    expect((messages[0].content as string)).not.toContain('req_Abc123XY890');
  });

  it('strips hex hashes (40+ hex chars)', () => {
    const { messages } = aligner.align([systemMsg('commit=a3f7c89b12345678901234567890abcdef123456')]);
    expect((messages[0].content as string)).not.toContain('a3f7c89b12345678901234567890abcdef123456');
  });

  it('strips version strings', () => {
    const { messages } = aligner.align([systemMsg('version: 3.14.159-beta.2')]);
    expect((messages[0].content as string)).not.toContain('3.14.159-beta.2');
  });

  it('strips Unix timestamps (10-digit numbers)', () => {
    const { messages } = aligner.align([systemMsg('timestamp=1700000000')]);
    expect((messages[0].content as string)).not.toContain('1700000000');
  });

  it('strips JWT-like tokens (base64url.base64url.base64url)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'; // gitleaks:allow
    const { messages } = aligner.align([systemMsg(`token: ${jwt}`)]);
    expect((messages[0].content as string)).not.toContain(jwt);
  });

  it('strips structural label=value patterns for dynamic labels', () => {
    const { messages } = aligner.align([systemMsg('session_id: user-abc-123\nupdated: 2024-01-01')]);
    const content = messages[0].content as string;
    expect(content).not.toContain('user-abc-123');
  });

  it('preserves static system instructions unchanged', () => {
    const stable = 'You are a helpful assistant. Always respond in English.';
    const { messages } = aligner.align([systemMsg(stable)]);
    expect((messages[0].content as string)).toBe(stable);
  });

  it('produces a stablePrefixHash', () => {
    const { stablePrefixHash } = aligner.align([systemMsg('Date: 2025-01-01. You are helpful.')]);
    expect(stablePrefixHash).toBeTruthy();
    expect(stablePrefixHash.length).toBeGreaterThan(4);
  });

  it('produces the same stablePrefixHash for same static content with different dynamic values', () => {
    const { stablePrefixHash: h1 } = aligner.align([systemMsg('Date: 2025-01-01. You are helpful.')]);
    const { stablePrefixHash: h2 } = aligner.align([systemMsg('Date: 2026-03-15. You are helpful.')]);
    expect(h1).toBe(h2);
  });
});
