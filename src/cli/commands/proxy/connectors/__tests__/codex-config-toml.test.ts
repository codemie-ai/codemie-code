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
  DISPLACED_PREFIX,
  commentDisplacedKeys,
  findManagedRegions,
  restoreDisplacedKeys,
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

describe('displaced keys', () => {
  it('comments out unmanaged top-level model and model_provider keys', () => {
    const text = 'model = "gpt-5"\nmodel_provider = "mine"\n\n[history]\npersistence = "none"\n';

    const out = commentDisplacedKeys(text);

    expect(out).toContain(`${DISPLACED_PREFIX}model = "gpt-5"`);
    expect(out).toContain(`${DISPLACED_PREFIX}model_provider = "mine"`);
    expect(out).toContain('persistence = "none"');
  });

  it('leaves same-named keys inside a table untouched', () => {
    const text = '[profiles.work]\nmodel = "gpt-5"\n';
    expect(commentDisplacedKeys(text)).toBe(text);
  });

  it('is idempotent - already-displaced lines are not double-commented', () => {
    const once = commentDisplacedKeys('model = "gpt-5"\n');
    expect(commentDisplacedKeys(once)).toBe(once);
  });

  it('restoreDisplacedKeys is the exact inverse', () => {
    const original = 'model = "gpt-5"\nmodel_provider = "mine"\n\n[history]\npersistence = "none"\n';
    expect(restoreDisplacedKeys(commentDisplacedKeys(original))).toBe(original);
  });
});
