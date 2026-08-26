/**
 * lint-staged config — replaces the inline package.json entry.
 *
 * "vitest related" builds a full Vite dependency graph before running any tests.
 * On WSL2 (Windows filesystem /mnt/c/...) that graph walk exceeds any practical
 * timeout. Instead we locate test files by directory convention:
 *
 *   src/foo/bar/baz.ts  →  src/foo/bar/__tests__/*.test.ts
 *
 * This is equivalent for the 99 % case (each __tests__/ covers its sibling
 * source files) and takes ~seconds rather than minutes.
 *
 * NOTE: When using a function config, lint-staged does NOT append staged files to
 * the returned command strings automatically. They must be included explicitly.
 */

import { readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Return all *.test.ts files in the __tests__/ directory that sits next to
 * `sourceFile`. Returns an empty array when no such directory exists.
 */
function adjacentTests(sourceFile) {
  const testsDir = join(dirname(sourceFile), '__tests__');
  if (!existsSync(testsDir)) return [];
  try {
    return readdirSync(testsDir)
      .filter((f) => f.endsWith('.test.ts') || f.endsWith('.spec.ts'))
      .map((f) => join(testsDir, f));
  } catch {
    return [];
  }
}

export default {
  '*.ts': (stagedFiles) => {
    const testFiles = new Set();

    for (const file of stagedFiles) {
      if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) {
        testFiles.add(file);
      } else {
        adjacentTests(file).forEach((t) => testFiles.add(t));
      }
    }

    // lint-staged does not append staged files automatically in function configs.
    const eslint = `eslint --max-warnings=0 --no-warn-ignored ${stagedFiles.join(' ')}`;
    if (testFiles.size === 0) return [eslint];

    const tests = [...testFiles].join(' ');
    return [eslint, `npx vitest run --passWithNoTests ${tests}`];
  },

  'package.json': ['npm run license-check'],
};
