#!/usr/bin/env node
/**
 * inject-charts.js — give a page that draws charts the Chart.js runtime and the CodeMieCharts helper.
 *
 *   node inject-charts.js <path-to-html> [--cdn]
 *
 * Puts them where the page asks: at the placeholder <script>/* __CODEMIE_CHARTS__ *\/</script>; else
 * in place of a Chart.js <script src> from a CDN; else just before the first script that calls
 * CodeMieCharts or new Chart(. Any other Chart.js CDN tag is removed, so the runtime loads once.
 * A page that draws no chart is left as it is.
 *
 * The runtime is embedded from style-guide/js/chart.umd.min.js, so charts render offline; --cdn
 * links the same pinned version instead. Idempotent: a page that already has them is left as it is.
 */

const fs = require('node:fs');
const path = require('node:path');

// Keep both in step with scripts/vendor-assets.mjs. The hash is the file jsDelivr serves, which is
// also style-guide/js/chart.umd.min.js below its banner line; a browser refuses any other bytes.
const CHARTJS_VERSION = '4.5.1';
const CHARTJS_SRI = 'sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ';
const PLACEHOLDER = /<script\b[^>]*>\s*\/\*\s*__CODEMIE_CHARTS__\s*\*\/\s*<\/script>/i;
const CDN_TAG = /<script\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\/[^"']*chart(?:\.js|\.umd)[^"']*["'][^>]*>\s*<\/script>/gi;
const DRAWS = /CodeMieCharts\s*\.\s*create|new\s+Chart\s*\(/;

const args = process.argv.slice(2);
const htmlArg = args.find((a) => !a.startsWith('--'));
const cdn = args.includes('--cdn');
if (!htmlArg) {
  console.error('Usage: node inject-charts.js <path-to-html> [--cdn]');
  process.exit(1);
}
const target = path.resolve(htmlArg);
if (!fs.existsSync(target)) {
  console.error(`Error: HTML file not found: ${target}`);
  process.exit(1);
}

const html = fs.readFileSync(target, 'utf8');
if (html.includes('data-codemie-charts')) {
  console.log(`• charts already set up in ${target}`);
  process.exit(0);
}

const js = (name) => fs.readFileSync(path.join(__dirname, '..', 'style-guide', 'js', name), 'utf8')
  .replace(/<\/script/gi, '<\\/script');
const runtime = cdn
  ? `<script data-codemie-charts="runtime" src="https://cdn.jsdelivr.net/npm/chart.js@${CHARTJS_VERSION}/dist/chart.umd.min.js" integrity="${CHARTJS_SRI}" crossorigin="anonymous"></script>`
  : `<script data-codemie-charts="runtime">\n${js('chart.umd.min.js')}\n</script>`;
const block = `${runtime}\n<script data-codemie-charts="helper">\n${js('charts.js')}\n</script>`;

let at = -1;
let length = 0;
const placeholder = PLACEHOLDER.exec(html);
const tag = new RegExp(CDN_TAG.source, 'i').exec(html);
if (placeholder) {
  [at, length] = [placeholder.index, placeholder[0].length];
} else if (tag) {
  [at, length] = [tag.index, tag[0].length];
} else {
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (DRAWS.test(script[1])) {
      at = script.index;
      break;
    }
  }
}
if (at === -1) {
  console.log(`• no chart in ${target}; nothing to add`);
  process.exit(0);
}

const placed = html.slice(0, at) + block + (length ? '' : '\n') + html.slice(at + length);
fs.writeFileSync(target, placed.replace(CDN_TAG, (t) => (t.includes('data-codemie-charts') ? t : '')), 'utf8');
console.log(`✓ Chart.js ${CHARTJS_VERSION} and CodeMieCharts added to ${target} (${cdn ? 'Chart.js from jsDelivr: needs a network connection' : 'embedded'})`);
