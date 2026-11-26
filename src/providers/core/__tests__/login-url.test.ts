import { describe, expect, it } from 'vitest';
import { resolveLoginUrl } from '../login-url.js';

const API = 'https://codemie.lab.epam.com/code-assistant-api';

describe('resolveLoginUrl', () => {
  it('falls back to the API origin without a codeMieUrl', () => {
    expect(resolveLoginUrl(API)).toBe('https://codemie.lab.epam.com');
  });

  it('keeps a codeMieUrl that is the bare API origin', () => {
    expect(resolveLoginUrl(API, 'https://codemie.lab.epam.com')).toBe('https://codemie.lab.epam.com');
  });

  it('ignores a codeMieUrl set to the API URL (path on the same origin)', () => {
    expect(resolveLoginUrl(API, API)).toBe('https://codemie.lab.epam.com');
  });

  it('keeps a codeMieUrl with a non-API path', () => {
    expect(resolveLoginUrl(API, 'https://codemie.lab.epam.com/ui')).toBe('https://codemie.lab.epam.com/ui');
  });

  it('ignores a codeMieUrl on another origin', () => {
    expect(resolveLoginUrl(API, 'https://other.example.com')).toBe('https://codemie.lab.epam.com');
  });
});
