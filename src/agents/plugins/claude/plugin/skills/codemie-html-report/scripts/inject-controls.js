#!/usr/bin/env node
/**
 * inject-controls.js — add the CodeMie theme switch and presenter controls to a
 * rendered HTML page.
 *
 *   node inject-controls.js <path-to-html> [--no-presenter] [--position bottom]
 *
 * Four idempotent edits:
 *   1. forces <html class="light"> so light is the default theme
 *   2. inlines a no-flash boot script in <head> that restores a stored choice
 *   3. inlines style-guide/css/controls.css
 *   4. inlines style-guide/js/controls.js before </body>
 *
 * The runtime adapts to the page it lands on. A page with .slide elements is
 * treated as a deck — Nav switches slides and Focus opens a two-up presenter
 * window. Any other page gets Nav that scrolls between headings, and no Focus.
 * Laser, Timer, Fullscreen and the theme switch are always present.
 */

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const htmlArg = argv.find((a) => !a.startsWith('--'));

if (!htmlArg) {
  console.error('Usage: node inject-controls.js <path-to-html> [--no-presenter] [--position bottom]');
  process.exit(1);
}

const noPresenter = argv.includes('--no-presenter');
const posFlag = argv.indexOf('--position');
const position = posFlag !== -1 && argv[posFlag + 1] === 'bottom' ? 'bottom' : 'top';

const target = path.resolve(htmlArg);
if (!fs.existsSync(target)) {
  console.error(`Error: HTML file not found: ${target}`);
  process.exit(1);
}

const cssPath = path.join(__dirname, '..', 'style-guide', 'css', 'controls.css');
const jsPath = path.join(__dirname, '..', 'style-guide', 'js', 'controls.js');
for (const [label, p] of [['controls.css', cssPath], ['controls.js', jsPath]]) {
  if (!fs.existsSync(p)) {
    console.error(`Error: ${label} not found at ${p}`);
    process.exit(1);
  }
}

let html = fs.readFileSync(target, 'utf8');

if (html.includes('data-codemie-controls')) {
  console.log(`• controls already present in ${target} — nothing to do`);
  process.exit(0);
}

const BOOT = `<script data-codemie-controls="boot">
/* Light is the CodeMie default; a stored choice wins. Runs before first paint. */
(function(){var K='codemie-theme',t;try{t=localStorage.getItem(K)}catch(e){}
if(t!=='light'&&t!=='dark')t='light';var r=document.documentElement;
r.classList.toggle('light',t==='light');r.setAttribute('data-theme',t);})();
</script>`;

// 1. light on the <html> element itself, so even a script-less view opens light
if (/<html[^>]*\bclass\s*=/i.test(html)) {
  html = html.replace(/<html([^>]*)\bclass\s*=\s*"([^"]*)"/i, (m, pre, cls) =>
    /\blight\b/.test(cls) ? m : `<html${pre}class="${(cls + ' light').trim()}"`);
} else {
  html = html.replace(/<html\b([^>]*)>/i, '<html$1 class="light">');
}

// Every insertion below is a function replacement: an inserted file is code, and a "$&" or "$'"
// in it must stay text, not become a replacement pattern.
// 2. boot script as early in <head> as possible
html = /<head\b[^>]*>/i.test(html)
  ? html.replace(/<head\b[^>]*>/i, (tag) => `${tag}\n${BOOT}`)
  : html.replace(/<body\b[^>]*>/i, (tag) => `${BOOT}\n${tag}`);

// 3. styles
// data-slop-ignore: the slop scan judges the page's own styles, not the injected controls.
const styleBlock = `<style data-codemie-controls="css" data-slop-ignore>\n${fs.readFileSync(cssPath, 'utf8')}\n</style>`;
html = /<\/head>/i.test(html)
  ? html.replace(/<\/head>/i, (tag) => `${styleBlock}\n${tag}`)
  : html.replace(/<body\b[^>]*>/i, (tag) => `${tag}\n${styleBlock}`);

// 4. runtime last, so the DOM it decorates already exists
if (position === 'bottom') {
  // Search after </head>: the inlined design system quotes "<body>" in a comment.
  const bodyTag = /<body\b([^>]*)>/gi;
  bodyTag.lastIndex = Math.max(0, html.search(/<\/head>/i));
  const m = bodyTag.exec(html);
  if (m && !/data-controls-position/.test(m[1])) {
    html = html.slice(0, m.index) + `<body${m[1]} data-controls-position="bottom">` + html.slice(m.index + m[0].length);
  }
}

let runtime = fs.readFileSync(jsPath, 'utf8');
if (noPresenter) {
  runtime = runtime.replace(
    "var PRESENTER = new URLSearchParams(location.search).get('presenter') === '1';",
    'var PRESENTER = false;',
  );
}
let scriptBlock = `<script data-codemie-controls="js" data-slop-ignore>\n${runtime}\n</script>`;
// A deck (two or more elements whose class is "slide", or data-slide) also gets the stage runtime,
// after the controls, which it relies on.
const deck = (html.match(/<[a-z][\w-]*\b[^>]*(?:\bclass\s*=\s*["'](?:[^"']*\s)?slide(?:\s[^"']*)?["']|\sdata-slide\b)[^>]*>/gi) || []).length >= 2;
if (deck) {
  const deckJs = fs.readFileSync(path.join(__dirname, '..', 'style-guide', 'js', 'deck.js'), 'utf8');
  scriptBlock += `\n<script data-codemie-controls="deck" data-slop-ignore>\n${deckJs}\n</script>`;
}
// Before the last </body>: a script on the page may hold the text "</body>" in a string.
html = /<\/body>/i.test(html)
  ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, (tag) => `${scriptBlock}\n${tag}`)
  : html + scriptBlock;

fs.writeFileSync(target, html, 'utf8');
console.log(
  `✓ Controls injected into ${target}` +
    (noPresenter ? ' (theme + laser/timer/full, no presenter view)' : '') +
    (position === 'bottom' ? ' [toolbar bottom]' : '') +
    (deck ? ' with the deck stage' : ''),
);
