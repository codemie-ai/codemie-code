import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const MASKING_NAMES = ['maskSecretsInText', 'maskSecretsDeep', 'maskSecretsInLongText'];

/** Non-test files allowed to import or define the masking functions (path relative to `src/`). */
const ALLOWLIST: Record<string, string> = {
  'utils/analytics-obfuscation.ts': 'the facade: the one module that builds analytics text masking on the primitives',
  'utils/security.ts': 'defines maskSecretsInText and maskSecretsDeep',
  'utils/long-text-masking.ts': 'defines maskSecretsInLongText and builds on maskSecretsInText'
};

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      files.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

/** Import or re-export clauses (single or multi line) that name a masking function. */
function importsMasking(source: string): boolean {
  const clauses = source.match(/(?:import|export)\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]/g) ?? [];
  return clauses.some(clause => MASKING_NAMES.some(name => new RegExp(`\\b${name}\\b`).test(clause)));
}

describe('analytics obfuscation import guard (AC14)', () => {
  it('only the facade and the allowlisted primitives import the secret-masking functions', () => {
    const offenders = listSourceFiles(SRC_ROOT)
      .map(file => relative(SRC_ROOT, file).split(sep).join('/'))
      .filter(rel => !(rel in ALLOWLIST))
      .filter(rel => importsMasking(readFileSync(join(SRC_ROOT, rel), 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(statSync(join(SRC_ROOT, rel)).isFile()).toBe(true);
    }
  });

  it('detects a multi-line import of a masking function', () => {
    expect(importsMasking("import {\n  maskSecretsDeep,\n  other\n} from '../utils/security.js';")).toBe(true);
    expect(importsMasking("import { sanitizeText } from '../utils/analytics-obfuscation.js';")).toBe(false);
  });
});
