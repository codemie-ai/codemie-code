import { describe, it, expect } from 'vitest';
import { validateHeaderValue } from 'node:http';
import { encodeAttributionHeader } from '../header-value.js';

describe('encodeAttributionHeader', () => {
  it('leaves plain slash-separated values unchanged', () => {
    expect(encodeAttributionHeader('org/repo')).toBe('org/repo');
  });

  it('encodes Latin-1 non-ASCII characters', () => {
    expect(encodeAttributionHeader('café')).toBe('caf%C3%A9');
  });

  it('encodes each segment and keeps the slash', () => {
    expect(encodeAttributionHeader('clients/репо-тест')).toBe('clients/' + encodeURIComponent('репо-тест'));
  });

  it('escapes literal percent and spaces', () => {
    expect(encodeAttributionHeader('100%/done x')).toBe('100%25/done%20x');
  });

  it('encodes control characters', () => {
    expect(encodeAttributionHeader('a\nb')).toBe('a%0Ab');
  });

  it('replaces lone surrogates instead of throwing', () => {
    expect(encodeAttributionHeader('a\uD800b')).toBe('a%EF%BF%BDb');
    expect(encodeAttributionHeader('a\uDC00')).toBe('a%EF%BF%BD');
    expect(encodeAttributionHeader('x\uD83D\uDE00')).toBe('x%F0%9F%98%80');
  });

  it('encodes an already-encoded value again', () => {
    expect(encodeAttributionHeader('Proj%20A')).toBe('Proj%2520A');
  });

  it.each(['org/repo', 'café', 'clients/репо-тест', '100%/done x', 'a\nb'])(
    'round-trips and is a valid header value: %j',
    (value) => {
      const encoded = encodeAttributionHeader(value);
      expect(decodeURIComponent(encoded)).toBe(value);
      expect(() => validateHeaderValue('X', encoded)).not.toThrow();
    }
  );
});
