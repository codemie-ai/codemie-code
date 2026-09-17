import { describe, expect, it } from 'vitest';
import { VS_CODE_CAPABILITY_TABLE } from '../vscode-models.js';

describe('VS_CODE_CAPABILITY_TABLE', () => {
  it('has a unique, date-free family key per entry', () => {
    const families = VS_CODE_CAPABILITY_TABLE.map((e) => e.family);
    expect(new Set(families).size).toBe(families.length);
    for (const family of families) {
      expect(family).not.toMatch(/[-._]20\d{2}[-._]\d{2}[-._]\d{2}/);
    }
  });
});
