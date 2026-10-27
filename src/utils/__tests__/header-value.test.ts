import { describe, it, expect } from 'vitest';
import { validateHeaderValue } from 'node:http';
import { encodeAttributionHeader, rawProjectHeader } from '../header-value.js';

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

  it('leaves printable ASCII with spaces, percent and @ unchanged', () => {
    expect(encodeAttributionHeader('100%/done x')).toBe('100%/done x');
    expect(encodeAttributionHeader('jane_doe@epam.com')).toBe('jane_doe@epam.com');
  });

  it('encodes only the segments that contain non-printable-ASCII characters', () => {
    expect(encodeAttributionHeader('my repo/100%/café x')).toBe('my repo/100%/caf%C3%A9%20x');
  });

  it('encodes control characters', () => {
    expect(encodeAttributionHeader('a\nb')).toBe('a%0Ab');
  });

  it('replaces lone surrogates instead of throwing', () => {
    expect(encodeAttributionHeader('a\uD800b')).toBe('a%EF%BF%BDb');
    expect(encodeAttributionHeader('a\uDC00')).toBe('a%EF%BF%BD');
    expect(encodeAttributionHeader('x\uD83D\uDE00')).toBe('x%F0%9F%98%80');
  });

  it('leaves an already-encoded ASCII value unchanged', () => {
    expect(encodeAttributionHeader('Proj%20A')).toBe('Proj%20A');
  });

  it('encodes the percent sign again when the segment is non-ASCII', () => {
    expect(encodeAttributionHeader('é%20')).toBe('%C3%A9%2520');
  });

  it.each(['org/repo', 'café', 'clients/репо-тест', 'a\nb', 'jane_doe@epam.com'])(
    'round-trips and is a valid header value: %j',
    (value) => {
      const encoded = encodeAttributionHeader(value);
      expect(decodeURIComponent(encoded)).toBe(value);
      expect(() => validateHeaderValue('X', encoded)).not.toThrow();
    }
  );
});

describe('rawProjectHeader', () => {
  it('returns Latin-1 values unchanged', () => {
    expect(rawProjectHeader('my-project')).toBe('my-project');
    expect(rawProjectHeader('a@b.com')).toBe('a@b.com');
  });

  it('returns undefined for non-Latin-1 or control characters', () => {
    expect(rawProjectHeader('проект')).toBeUndefined();
    expect(rawProjectHeader('a\nb')).toBeUndefined();
  });
});
