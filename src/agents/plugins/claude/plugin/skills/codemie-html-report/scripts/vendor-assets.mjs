#!/usr/bin/env node
/**
 * vendor-assets.mjs — refresh the fonts and the chart runtime the build embeds, so a finished page
 * opens with no network: as an email or Teams attachment, behind a proxy that blocks CDNs, offline.
 *
 *   node vendor-assets.mjs
 *
 * Writes:
 *   style-guide/fonts/fonts.css        Inter and JetBrains Mono for pages, Geist and Geist Mono for
 *                                      decks, in every subset Google Fonts serves, as base64
 *                                      @font-face; scripts/inject-css.js embeds only the faces a
 *                                      page's kind, characters, italics and code actually use
 *   style-guide/fonts/LICENSE-OFL.txt  all four families are SIL OFL 1.1, which permits embedding
 *   style-guide/js/chart.umd.min.js    Chart.js, MIT, at the version pinned below
 *
 * A maintainer runs it when a font or the Chart.js version changes; building a page never needs it.
 * Zero dependencies. Node 18+ (global fetch).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

// Inter and JetBrains Mono for pages; Geist and Geist Mono for decks.
const FAMILIES = 'family=Inter:ital,wght@0,400..700;1,400&family=JetBrains+Mono:wght@400..500&family=Geist:wght@400..800&family=Geist+Mono:wght@400..600&display=swap';
// Keep both in step with scripts/inject-charts.js. A new version needs its new hash: jsDelivr shows
// it on the file's page, and the download below is refused unless it matches.
const CHARTJS_VERSION = '4.5.1';
const CHARTJS_SRI = 'sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ';
const OFL = {
  Inter: 'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt',
  'JetBrains Mono': 'https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/OFL.txt',
  Geist: 'https://raw.githubusercontent.com/google/fonts/main/ofl/geist/OFL.txt',
  'Geist Mono': 'https://raw.githubusercontent.com/google/fonts/main/ofl/geistmono/OFL.txt',
};
// Google Fonts serves woff2, and one variable file per subset, only to a current browser.
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const out = (relative) => new URL(`../style-guide/${relative}`, import.meta.url);
const today = new Date().toISOString().slice(0, 10);

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return as === 'bytes' ? Buffer.from(await res.arrayBuffer()) : res.text();
}

const css = await get(`https://fonts.googleapis.com/css2?${FAMILIES}`);
const blocks = [...css.matchAll(/\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)];
if (!blocks.length) throw new Error('no @font-face blocks in the Google Fonts response');

const faces = [];
for (const [, subset, block] of blocks) {
  const url = block.match(/url\((https:[^)]+)\)/)?.[1];
  if (!url) throw new Error(`no font URL in the ${subset} block`);
  const font = await get(url, 'bytes');
  faces.push(`/* ${subset} */\n${block.replace(/url\(https:[^)]+\)/, `url(data:font/woff2;base64,${font.toString('base64')})`)}`);
}

mkdirSync(out('fonts'), { recursive: true });
writeFileSync(out('fonts/fonts.css'), `/* Inter, JetBrains Mono, Geist and Geist Mono from Google Fonts, embedded by scripts/vendor-assets.mjs on ${today}.
   SIL Open Font License 1.1, see LICENSE-OFL.txt. Keep each face's subset comment: inject-css.js reads it. */
${faces.join('\n')}\n`);

const licences = [];
for (const [family, url] of Object.entries(OFL)) licences.push(`${family}\n${'='.repeat(family.length)}\n\n${(await get(url)).trim()}\n`);
writeFileSync(out('fonts/LICENSE-OFL.txt'), licences.join('\n\n'));

const chartBytes = await get(`https://cdn.jsdelivr.net/npm/chart.js@${CHARTJS_VERSION}/dist/chart.umd.min.js`, 'bytes');
const sri = `sha384-${createHash('sha384').update(chartBytes).digest('base64')}`;
if (sri !== CHARTJS_SRI) throw new Error(`Chart.js ${CHARTJS_VERSION} hashes to ${sri}, not the pinned ${CHARTJS_SRI}; nothing written for it`);
const chart = chartBytes.toString('utf8');
mkdirSync(out('js'), { recursive: true });
writeFileSync(out('js/chart.umd.min.js'), `/* Chart.js v${CHARTJS_VERSION} | MIT | embedded by scripts/vendor-assets.mjs on ${today} */\n${chart}`);

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`✓ fonts.css: ${faces.length} faces, ${kb(faces.join('').length)}`);
console.log(`✓ chart.umd.min.js: Chart.js ${CHARTJS_VERSION}, ${kb(chart.length)}`);
