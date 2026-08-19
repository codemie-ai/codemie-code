/**
 * Pure TOML splice helpers for the Codex desktop connector.
 * @group unit
 */
import { describe, expect, it } from 'vitest';
import TOML from '@iarna/toml';
import {
  HEADER_OPEN,
  HEADER_CLOSE,
  TABLE_OPEN,
  TABLE_CLOSE,
  DISPLACED_PREFIX,
  commentDisplacedKeys,
  findManagedRegions,
  restoreDisplacedKeys,
  buildManagedBlocks,
  spliceManagedBlocks,
  stripManagedRegions,
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

const BLOCKS = {
  header: 'model_provider = "codemie"\nmodel = "gpt-5-codex"',
  table: '[model_providers.codemie]\nname = "CodeMie"\nbase_url = "http://127.0.0.1:4001/v1"\nwire_api = "responses"',
};

describe('spliceManagedBlocks', () => {
  it('preserves the user comments and key order outside the managed regions', () => {
    const original = '# my notes\nsandbox_mode = "workspace-write"\n\n[history]\n# keep this\npersistence = "none"\n';

    const out = spliceManagedBlocks(original, BLOCKS);

    expect(out).toContain('# my notes');
    expect(out).toContain('# keep this');
    expect(out).toContain('sandbox_mode = "workspace-write"');
    expect(out.indexOf('model_provider = "codemie"')).toBeLessThan(out.indexOf('[history]'));
    expect(out.indexOf('[model_providers.codemie]')).toBeGreaterThan(out.indexOf('[history]'));
  });

  it('is idempotent - splicing twice equals splicing once', () => {
    const original = 'sandbox_mode = "workspace-write"\n\n[history]\npersistence = "none"\n';
    const once = spliceManagedBlocks(original, BLOCKS);
    expect(spliceManagedBlocks(once, BLOCKS)).toBe(once);
  });

  it('round-trips: strip(splice(x)) === x when x has tables', () => {
    const original = '# notes\nsandbox_mode = "workspace-write"\n\n[history]\npersistence = "none"\n';
    expect(stripManagedRegions(spliceManagedBlocks(original, BLOCKS))).toBe(original);
  });

  it('round-trips: strip(splice(x)) === x when x is empty', () => {
    expect(stripManagedRegions(spliceManagedBlocks('', BLOCKS))).toBe('');
  });

  it('round-trips: strip(splice(x)) === x when x has displaced keys', () => {
    const original = 'model = "gpt-5"\n\n[history]\npersistence = "none"\n';
    expect(stripManagedRegions(spliceManagedBlocks(original, BLOCKS))).toBe(original);
  });
});

describe('buildManagedBlocks', () => {
  it('emits the responses wire API, the bearer header and the pinned model', () => {
    const blocks = buildManagedBlocks({
      baseUrl: 'http://127.0.0.1:4001/v1',
      gatewayKey: 'codemie-proxy',
      model: 'gpt-5-codex',
    });

    expect(blocks.header).toContain('model_provider = "codemie"');
    expect(blocks.header).toContain('model = "gpt-5-codex"');
    expect(blocks.table).toContain('wire_api = "responses"');
    expect(blocks.table).toContain('base_url = "http://127.0.0.1:4001/v1"');
    expect(blocks.table).toContain('Authorization = "Bearer codemie-proxy"');
  });

  it('produces a file that parses as valid TOML', () => {
    const blocks = buildManagedBlocks({
      baseUrl: 'http://127.0.0.1:4001/v1',
      gatewayKey: 'codemie-proxy',
      model: 'gpt-5-codex',
    });
    const spliced = spliceManagedBlocks('model = "gpt-5"\n\n[history]\npersistence = "none"\n', blocks);

    const parsed = TOML.parse(spliced) as Record<string, unknown>;

    expect(parsed.model_provider).toBe('codemie');
    expect(parsed.model).toBe('gpt-5-codex');
    expect(parsed.history).toEqual({ persistence: 'none' });
  });

  it('escapes quotes and backslashes in values', () => {
    const blocks = buildManagedBlocks({
      baseUrl: 'http://h/v1?q="x"\\y',
      gatewayKey: 'k"1',
      model: 'm',
    });
    expect(() => TOML.parse(spliceManagedBlocks('', blocks))).not.toThrow();
  });
});

describe('unterminated and mismatched sentinels (data-loss guards)', () => {
  it('does not delete to end of file when the header close sentinel is missing', () => {
    // A user edit, a partial write, or another tool can remove the close marker.
    // findManagedRegions documents such a region as unmanaged precisely so the
    // writer never deletes content it cannot delimit.
    const text = `${HEADER_OPEN}\nmodel_provider = "codemie"\n\n[history]\npersistence = "none"\n`;

    const stripped = stripManagedRegions(text);

    expect(stripped).toContain('[history]');
    expect(stripped).toContain('persistence = "none"');
  });

  it('does not delete to end of file when the table close sentinel is missing', () => {
    const text = `[history]\npersistence = "none"\n\n${TABLE_OPEN}\n[model_providers.codemie]\nname = "CodeMie"\n`;

    const stripped = stripManagedRegions(text);

    expect(stripped).toContain('persistence = "none"');
  });

  it('never yields an empty file from input that had unmanaged content', () => {
    const text = `${HEADER_OPEN}\nmodel_provider = "codemie"\n\nsandbox_mode = "workspace-write"\n`;
    expect(stripManagedRegions(text).trim()).not.toBe('');
  });

  it('recognizes and cuts a sentinel carrying a trailing carriage return', () => {
    // Windows is a supported platform and the app rewrites this file.
    const blocks = { header: 'model_provider = "codemie"', table: '[model_providers.codemie]' };
    const spliced = spliceManagedBlocks('sandbox_mode = "workspace-write"\n', blocks);
    const crlf = spliced.replace(new RegExp(HEADER_OPEN, 'g'), `${HEADER_OPEN}\r`);

    const regions = findManagedRegions(crlf);
    expect(regions.header).not.toBeNull();

    // Splicing again must replace, never duplicate.
    const respliced = spliceManagedBlocks(crlf, blocks);
    expect(respliced.split('model_provider = "codemie"').length - 1).toBe(1);
  });

  it('does not duplicate the managed block when sentinels have trailing whitespace', () => {
    const blocks = { header: 'model_provider = "codemie"', table: '[model_providers.codemie]' };
    const spliced = spliceManagedBlocks('sandbox_mode = "x"\n', blocks);
    const padded = spliced.replace(TABLE_OPEN, `${TABLE_OPEN}  `);

    const respliced = spliceManagedBlocks(padded, blocks);

    expect(respliced.split('[model_providers.codemie]').length - 1).toBe(1);
  });
});
