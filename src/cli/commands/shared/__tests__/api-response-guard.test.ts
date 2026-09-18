import { describe, it, expect } from 'vitest';
import { assertApiListResponse } from '../api-response-guard.js';

interface Shape {
  items: string[];
}

const isShape = (r: unknown): r is Shape =>
  !!r && typeof r === 'object' && Array.isArray((r as Partial<Shape>).items);

describe('assertApiListResponse', () => {
  it('does not throw and narrows the type when the response matches the shape', () => {
    const response: unknown = { items: ['a', 'b'] };

    expect(() => assertApiListResponse(response, isShape, 'widgets')).not.toThrow();
  });

  it('throws a re-auth error when the response looks like a Keycloak login redirect', () => {
    const html = '<!DOCTYPE html><html><head><title>Sign in</title></head><body>keycloak login</body></html>';

    expect(() => assertApiListResponse(html, isShape, 'widgets')).toThrow(
      /session has expired.*codemie profile login/i
    );
  });

  it('throws a generic unexpected-response error for any other shape mismatch', () => {
    expect(() => assertApiListResponse({ unrelated: true }, isShape, 'widgets')).toThrow(
      /unexpected response fetching widgets/i
    );
  });

  it('throws the generic error for null/undefined responses', () => {
    expect(() => assertApiListResponse(null, isShape, 'widgets')).toThrow(
      /unexpected response fetching widgets/i
    );
    expect(() => assertApiListResponse(undefined, isShape, 'widgets')).toThrow(
      /unexpected response fetching widgets/i
    );
  });
});
