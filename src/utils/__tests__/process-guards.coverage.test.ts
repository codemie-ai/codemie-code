/**
 * Every declared bin must either install the process guards or be an explicit,
 * justified exclusion — so a new entrypoint fails here rather than silently
 * shipping without a fatal-error net (EPMCDME-14148).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDirname } from '../paths.js';

const REPO_ROOT = join(getDirname(import.meta.url), '..', '..', '..');

/**
 * Long-running processes must survive an unhandled rejection; installProcessGuards
 * exits on the first one, which would be wrong for them.
 */
const EXCLUDED: Record<string, string> = {
  'codemie-mcp-proxy':
    'owns uncaughtException/unhandledRejection handlers with a deliberate survive-on-rejection policy',
  'proxy-daemon': 'long-running daemon — must not exit on the first unhandled rejection',
};

describe('process guard coverage across bin entrypoints', () => {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')
  ) as { bin: Record<string, string> };

  const entrypoints = Object.entries(pkg.bin);

  it('declares at least the known entrypoints', () => {
    expect(entrypoints.length).toBeGreaterThanOrEqual(14);
  });

  it.each(entrypoints)('%s installs the guards or is explicitly excluded', (name, relPath) => {
    // Strip comments first: the excluded entrypoints name the function in a
    // comment explaining why they opt out.
    const source = readFileSync(join(REPO_ROOT, relPath), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const installs = /^\s*installProcessGuards\(\);/m.test(source);

    if (name in EXCLUDED) {
      expect(
        installs,
        `${name} is listed as excluded (${EXCLUDED[name]}) but now installs the guards — drop it from EXCLUDED`
      ).toBe(false);
      return;
    }

    expect(
      installs,
      `${name} (${relPath}) neither installs the guards nor is listed in EXCLUDED with a reason`
    ).toBe(true);
  });

  it('lists no stale exclusions', () => {
    const declared = new Set(entrypoints.map(([name]) => name));
    for (const name of Object.keys(EXCLUDED)) {
      expect(declared.has(name), `EXCLUDED lists ${name}, which package.json no longer declares`).toBe(true);
    }
  });
});
