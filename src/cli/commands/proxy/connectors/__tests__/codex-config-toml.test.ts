/**
 * Pure TOML splice helpers for the Codex desktop connector.
 * @group unit
 */
import { describe, expect, it } from 'vitest';
import {
  HEADER_OPEN,
  HEADER_CLOSE,
  TABLE_OPEN,
  TABLE_CLOSE,
  findManagedRegions,
} from '../codex-config-toml.js';

describe('findManagedRegions', () => {
  it('returns null ranges for a file with no managed sentinels', () => {
    const text = 'model = "gpt-5"\n\n[history]\npersistence = "none"\n';
    expect(findManagedRegions(text)).toEqual({ header: null, table: null });
  });

  it('returns character ranges for both regions when present', () => {
    const text = [
      HEADER_OPEN,
      'model_provider = "codemie"',
      HEADER_CLOSE,
      '',
      '[history]',
      'persistence = "none"',
      '',
      TABLE_OPEN,
      '[model_providers.codemie]',
      TABLE_CLOSE,
      '',
    ].join('\n');

    const regions = findManagedRegions(text);

    expect(regions.header).not.toBeNull();
    expect(regions.table).not.toBeNull();
    expect(text.slice(regions.header!.start, regions.header!.end)).toContain('model_provider = "codemie"');
    expect(text.slice(regions.table!.start, regions.table!.end)).toContain('[model_providers.codemie]');
  });

  it('treats a region whose close sentinel is missing as absent', () => {
    const text = `${HEADER_OPEN}\nmodel_provider = "codemie"\n`;
    expect(findManagedRegions(text).header).toBeNull();
  });
});
