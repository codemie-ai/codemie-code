import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDirname } from '@/utils/paths.js';

const SKILLS = join(getDirname(import.meta.url), '..', 'plugin', 'skills');
const HTML_REPORT = join(SKILLS, 'codemie-html-report');
const HUMANIZER = join(SKILLS, 'codemie-humanizer');

describe('Claude plugin skills', () => {
  // codemie-html-report carries copies of codemie-humanizer's scanner and glossary so it works
  // without that skill installed; codemie-humanizer is their source of truth.
  it.each(['scripts/slop-scan.mjs', 'references/glossary.md'])(
    'keeps %s byte-identical in codemie-html-report and codemie-humanizer',
    (file) => {
      const copy = readFileSync(join(HTML_REPORT, file));
      const source = readFileSync(join(HUMANIZER, file));
      expect(copy.equals(source), `${file} drifted; copy it over from codemie-humanizer`).toBe(true);
    },
  );

  it('ships codemie-html-report scripts as ES modules, with no CommonJS package.json pin', () => {
    expect(existsSync(join(HTML_REPORT, 'package.json'))).toBe(false);
    const scripts = readdirSync(join(HTML_REPORT, 'scripts'));
    expect(scripts.filter((name) => name.endsWith('.js'))).toEqual([]);
    for (const name of scripts) {
      const text = readFileSync(join(HTML_REPORT, 'scripts', name), 'utf8');
      expect(text, `${name} uses require()`).not.toMatch(/\brequire\(/);
    }
  });
});
