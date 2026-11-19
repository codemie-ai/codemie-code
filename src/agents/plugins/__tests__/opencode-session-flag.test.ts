/**
 * EPMCDME-15955: `codemie-opencode -s <ses_id>` must reach the opencode binary untouched.
 *
 * @group unit
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenCodePluginMetadata } from '../opencode/opencode.plugin.js';
import { transformFlags } from '../../core/flag-transform.js';
import type { AgentConfig } from '../../core/types.js';

vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

describe('opencode -s <session> pass-through', () => {
  it('keeps -s ses_x intact through enrichArgs and transformFlags', () => {
    const enrich = OpenCodePluginMetadata.lifecycle?.enrichArgs;
    expect(enrich).toBeDefined();

    const config = {} as AgentConfig;
    const enriched = enrich!(['-s', 'ses_x'], config);
    const finalArgs = transformFlags(enriched, OpenCodePluginMetadata.flagMappings, config);

    const idx = finalArgs.indexOf('-s');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(finalArgs[idx + 1]).toBe('ses_x');
    expect(finalArgs.filter(a => a === 'ses_x')).toHaveLength(1);
  });

  describe('BaseAgentAdapter spawn contract', () => {
    const source = readFileSync(
      join(import.meta.dirname, '../../core/BaseAgentAdapter.ts'),
      'utf-8'
    );

    it('Windows shell argument join does not quote a ses_ id', () => {
      // Mirror of the quoting predicate in BaseAgentAdapter's Windows branch.
      expect(source).toContain(String.raw`/[ "()&|<>^%[\]{}]/.test(arg)`);
      const needsQuote = (arg: string): boolean => /[ "()&|<>^%[\]{}]/.test(arg);
      expect(needsQuote('ses_2a1B9cD3eF')).toBe(false);
      expect(needsQuote('-s')).toBe(false);
    });

    it('spawn options carry no cwd override', () => {
      const start = source.indexOf('const child = spawn(finalCommand, finalArgs, {');
      expect(start).toBeGreaterThan(-1);
      const optionsBlock = source.slice(start, source.indexOf('});', start));
      expect(optionsBlock).not.toMatch(/\bcwd\b/);
    });
  });
});
