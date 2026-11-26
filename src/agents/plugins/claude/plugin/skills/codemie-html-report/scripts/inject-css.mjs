#!/usr/bin/env node
/**
 * inject-css.mjs — inline the CodeMie design system and its fonts into a page.
 *
 *   node inject-css.mjs <path-to-html> [--cdn]
 *
 * Replaces the placeholder comment __CODEMIE_CSS__ (written as a CSS comment inside a <style>
 * element) with the eight style-guide files in order: tokens, base, typography, buttons, forms,
 * components, layout, utilities. The result is wrapped in slop:ignore comments, so the slop scan
 * judges only the page's own styles.
 *
 * Fonts are embedded, so the page looks the same offline. Of the faces in style-guide/fonts/fonts.css
 * it embeds only those the page needs: a subset whose unicode-range covers a character the page
 * uses (its scripts included, since chart labels and injected data are text too), of Geist and
 * Geist Mono, the product's two faces. An English report gets two faces, about 68 KB.
 * --cdn keeps the Google Fonts @import instead: a smaller file that needs a network connection.
 *
 * The agent never reads or writes the CSS itself, which keeps a page build about 40k tokens cheaper.
 * Idempotent: a page without the placeholder is left as it is.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FILES = ['tokens', 'base', 'typography', 'buttons', 'forms', 'components', 'layout', 'utilities'];
const PLACEHOLDER = '/* __CODEMIE_CSS__ */';
const START = '/* slop:ignore-start — CodeMie design system, inlined by scripts/inject-css.mjs */';
const GOOGLE_FONTS_IMPORT = /^@import url\(['"]?https:\/\/fonts\.googleapis\.com[^)]*\)\s*;[ \t]*\r?\n?/m;

const args = process.argv.slice(2);
const htmlArg = args.find((a) => !a.startsWith('--'));
const cdn = args.includes('--cdn');
if (!htmlArg) {
  console.error('Usage: node inject-css.mjs <path-to-html> [--cdn]');
  process.exit(1);
}
const target = path.resolve(htmlArg);
if (!fs.existsSync(target)) {
  console.error(`Error: HTML file not found: ${target}`);
  process.exit(1);
}

const html = fs.readFileSync(target, 'utf8');
if (!html.includes(PLACEHOLDER)) {
  if (html.includes(START)) {
    console.log(`• design system already inlined in ${target}`);
    process.exit(0);
  }
  // Another spelling would build a page with no styles and call it ready.
  console.error(`Error: no ${PLACEHOLDER} placeholder in ${target}. Put <style>${PLACEHOLDER}</style> in its <head>, spelt exactly so.`);
  process.exit(1);
}

/** "U+0000-00FF, U+0131, U+04??" as [from, to] code point pairs. */
function ranges(value) {
  return value.split(',').map((part) => {
    const r = part.trim().replace(/^U\+/i, '');
    if (r.includes('?')) return [parseInt(r.replace(/\?/g, '0'), 16), parseInt(r.replace(/\?/g, 'F'), 16)];
    const [from, to] = r.split('-');
    return [parseInt(from, 16), parseInt(to || from, 16)];
  });
}

/**
 * The embedded faces this page needs, and a one-line account of them. Pages and decks use the
 * product's faces: a page sets its interface in Geist Mono and its reading text in Geist, a deck
 * the other way round, so both always take both. Geist has no italics; a browser slants it.
 */
function fontsFor(page) {
  const used = new Set();
  for (const ch of page) used.add(ch.codePointAt(0));
  const families = ['Geist', 'Geist Mono'];
  const file = fs.readFileSync(path.join(__dirname, '..', 'style-guide', 'fonts', 'fonts.css'), 'utf8');
  const picked = [];
  for (const [face, subset, rules] of file.matchAll(/\/\* ([a-z-]+) \*\/\s*@font-face\s*\{([^}]*)\}/g)) {
    const family = (rules.match(/font-family:\s*'([^']+)'/) || [])[1];
    const isItalic = /font-style:\s*italic/.test(rules);
    if (!families.includes(family) || isItalic) continue;
    const covered = ranges(rules.match(/unicode-range:\s*([^;]+);/)[1]);
    for (const cp of used) {
      if (covered.some(([from, to]) => cp >= from && cp <= to)) {
        picked.push({ face, name: `${family}${isItalic ? ' italic' : ''} ${subset}` });
        break;
      }
    }
  }
  const css = picked.map((p) => p.face).join('\n');
  return { css, note: `${picked.map((p) => p.name).join(', ')}; ${Math.round(css.length / 1024)} KB` };
}

const dir = path.join(__dirname, '..', 'style-guide', 'css');
// Card titles state a finding and stat descriptions carry a number's base and period, which
// rarely fit the product's one-line, cut-off text.
const OVERRIDES = '/* codemie-html-report: findings, labels and bases wrap instead of being cut off */\n' +
  '.card-title, .stat-card-label, .stat-card-desc { white-space: normal; overflow: visible; text-overflow: clip; }';
// A deck (two or more elements whose class is "slide", or data-slide) also gets the stage layout.
const deck = (html.match(/<[a-z][\w-]*\b[^>]*(?:\bclass\s*=\s*["'](?:[^"']*\s)?slide(?:\s[^"']*)?["']|\sdata-slide\b)[^>]*>/gi) || []).length >= 2;
const files = deck ? [...FILES, 'deck'] : FILES;
// Each file goes in under its own name, so the built page shows where every rule comes from.
const system = files.map((name) => `/* ==== style-guide/css/${name}.css ==== */\n${fs.readFileSync(path.join(dir, `${name}.css`), 'utf8')}`).join('\n') + '\n' + OVERRIDES;
const fonts = cdn ? { css: '', note: 'from Google Fonts, which needs a network connection' } : fontsFor(html);
// With --cdn, a comment may precede @import, so tokens.css's font import of Geist and Geist Mono
// stays valid after the marker.
const css = cdn ? system : `${fonts.css}\n${system.replace(GOOGLE_FONTS_IMPORT, '')}`;
const block = `${START}\n${css}\n/* slop:ignore-end */`;
fs.writeFileSync(target, html.replace(PLACEHOLDER, () => block), 'utf8');
console.log(`✓ Design system inlined into ${target} (${files.length} files${deck ? ', deck layout included' : ''}, ${Math.round(system.length / 1024)} KB; fonts: ${fonts.note})`);
