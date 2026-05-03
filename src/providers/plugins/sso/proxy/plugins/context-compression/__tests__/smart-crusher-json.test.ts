import { describe, it, expect } from 'vitest';
import { compactDocumentJson, extractJsonSchema } from '../compressors/smart-crusher/index.js';

describe('extractJsonSchema', () => {
  it('returns the union of all keys across array items', () => {
    const items = [
      { id: 1, name: 'Alice', score: 0.9 },
      { id: 2, name: 'Bob' },
    ];
    const schema = extractJsonSchema(items);
    expect(schema).toContain('id');
    expect(schema).toContain('name');
    expect(schema).toContain('score');
  });

  it('returns empty string for empty array', () => {
    expect(extractJsonSchema([])).toBe('');
  });
});

describe('compactDocumentJson', () => {
  it('compresses an array of objects to schema + sentinel', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: i, value: `item_${i}`, score: i * 0.05 }));
    const json = JSON.stringify(items);
    const result = compactDocumentJson(json);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.length).toBeLessThan(json.length);
      expect(result).toContain('[');
    }
  });

  it('returns null for non-array JSON', () => {
    const result = compactDocumentJson('{"key": "value"}');
    expect(result).toBeNull();
  });

  it('returns null for arrays shorter than threshold (10 items)', () => {
    const json = JSON.stringify([1, 2, 3]);
    const result = compactDocumentJson(json);
    expect(result).toBeNull();
  });
});
