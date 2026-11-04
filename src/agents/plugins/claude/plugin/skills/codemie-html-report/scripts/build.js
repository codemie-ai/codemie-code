#!/usr/bin/env node
/**
 * build.js — finish a page in one call:
 *   1. inject-css.js       inlines the design system at the __CODEMIE_CSS__ placeholder, with the
 *                          fonts the page needs embedded
 *   2. inject-charts.js    embeds Chart.js and the CodeMieCharts helper, if the page draws charts
 *   3. inject-controls.js  adds the light/dark switch and the presenting controls
 *   4. slop-scan.mjs       checks the page's own words, speaker notes included, and styles: it fails
 *                          on any high finding, and on a medium look finding, because every look
 *                          rule it grades medium (gradients, glass, glow, eyebrows, accent rails,
 *                          uppercase labels, decorative icons and motion) breaks a design rule here
 *   5. for a deck, the slide check: stock slides, titles that name a topic or ask a question,
 *      titles that end two ways, slides that are a bullet list, notes missing on some slides
 *   6. for a deck, the layout check, when Chrome, Chromium or Edge is installed: the deck is laid
 *      out at 1600 × 900 in a headless browser and measured for text that overlaps other text,
 *      runs out of its box or off the slide, a body that overflows, and text too small to read
 *   7. a self-containment check: the one line that says whether the page opens offline
 *
 *   node build.js <path-to-html> [--out <built.html>] [--cdn] [--no-presenter] [--position bottom] [--no-layout]
 *
 * --out builds into another file and leaves the page as written, small enough to edit and build
 * again; the slop scan then reads the page as written, so its line numbers point into it.
 * --cdn loads the fonts and Chart.js from CDNs instead of embedding them: a smaller file for a page
 * served from a website, which then needs a network connection. --no-layout skips step 6.
 * CHROME_PATH names the browser for step 6 when it is not in a usual place.
 *
 * Every step is idempotent: after fixing a finding, run it again.
 * Exit codes: 0 ready, 1 a step failed, 2 not ready: a slop finding (high, or a medium look
 * finding) or a deck problem from step 5 or 6, each named with its line or slide.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const [page, ...args] = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt === -1 ? '' : args[outAt + 1] || '';
if (!page || page.startsWith('--') || (outAt !== -1 && (!out || out.startsWith('--')))) {
  console.error('Usage: node build.js <path-to-html> [--out <built.html>] [--cdn] [--no-presenter] [--position bottom] [--no-layout]');
  process.exit(1);
}
const flags = args.filter((_, i) => outAt === -1 || (i !== outAt && i !== outAt + 1));
const cdn = flags.includes('--cdn') ? ['--cdn'] : [];
const target = out || page;

// Each step gets three minutes; one that runs longer has hung, and the build stops with step failed.
const run = (script, args) => {
  const step = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit', timeout: 180000 });
  if (step.error) console.error(`${script} did not finish: ${step.error.code === 'ETIMEDOUT' ? 'it ran past three minutes' : step.error.message}.`);
  return step.status;
};

/**
 * What the page loads besides itself: scripts, styles, fonts, images, frames. `hosts` counts the
 * network hosts; `files` lists files read from beside the page, which break once the page is
 * sent on its own. Links, `data:` and in-page `#` references do not count.
 */
function externalLoads(html) {
  // Script bodies and CSS comments are text, not loads; the opening tags keep their attributes.
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2').replace(/\/\*[\s\S]*?\*\//g, '');
  const patterns = [
    /<(?:script|img|iframe|source|video|audio|embed|track|image|input)\b[^>]*?\s(?:src|srcset|href|xlink:href|poster)\s*=\s*["']?\s*([^\s"'>]+)/gi,
    /<link\b(?=[^>]*\srel\s*=\s*["']?[^"'>]*\b(?:stylesheet|icon|preload|modulepreload|manifest)\b)[^>]*?\shref\s*=\s*["']?\s*([^\s"'>]+)/gi,
    /@import\s+(?:url\(\s*)?["']?\s*([^\s"')]+)/gi,
    /url\(\s*["']?\s*([^\s"')]+)/gi,
  ];
  const hosts = new Map();
  const files = new Set();
  const seen = new Set(); // @import url(…) matches two patterns; count each URL once
  for (const re of patterns) {
    for (const m of markup.matchAll(re)) {
      const at = m.index + m[0].lastIndexOf(m[1]);
      if (seen.has(at)) continue;
      seen.add(at);
      const ref = m[1];
      if (/^(?:data|blob|about|javascript|mailto|tel):|^#|^\{|^\$/i.test(ref)) continue;
      if (/^(?:https?:)?\/\//i.test(ref)) {
        const host = ref.replace(/^(?:https?:)?\/\//i, '').split(/[/?#]/)[0];
        hosts.set(host, (hosts.get(host) || 0) + 1);
      } else {
        files.add(ref.replace(/^file:\/\//i, ''));
      }
    }
  }
  return { hosts, files };
}

// Slides that exist in every generated deck and carry nothing: the whole title is one of these.
const STOCK_SLIDE = /^(?:agenda|contents|table of contents|thank you|thanks|questions|any questions|q\s*&\s*a|key takeaways|takeaways|summary|executive summary|overview|introduction|about us|conclusions?|next steps|appendix|backup)$/i;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.,%$€£-]*/gu;
const textOf = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// The visual a slide is drawn with: the first of these classes its markup uses. references/deck.md,
// section 3, says which shape of evidence each one is for.
const VISUALS = [['chart-frame', 'chart'], ['dg', 'drawing'], ['screen', 'screen'], ['terminal', 'terminal'], ['hub', 'hub'],
  ['bars', 'bars'], ['hbars', 'hbars'], ['stack', 'stack'], ['waffle', 'waffle'], ['ladder', 'ladder'], ['into', 'into'],
  ['steps', 'steps'], ['layers', 'layers'], ['rows', 'rows'], ['chain', 'flow'], ['zone', 'flow'], ['table', 'table'], ['decisions', 'decisions'], ['focus', 'number'],
  ['kpis', 'numbers'], ['cols-2', 'panes'], ['cols-3', 'panes'], ['cols-4', 'panes'], ['callouts', 'callouts'], ['chips', 'chips']];
const visualOf = (part) => {
  const classes = new Set([...part.matchAll(/\bclass\s*=\s*["']([^"']*)["']/gi)].flatMap((m) => m[1].split(/\s+/)));
  return (VISUALS.find(([c]) => classes.has(c)) || [, 'text'])[1];
};
/** Numbers in a slide's tables, lists and plain text, outside its source line: values a chart could draw. */
const loose = (part) => {
  const body = part.replace(/<p\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:fine|note)\b[^>]*>[\s\S]*?<\/p>/gi, '');
  return (textOf(body.replace(/<h[12]\b[\s\S]*?<\/h[12]>/i, '')).match(/(?<![\w.])\d+(?:[.,]\d+)?(?!\w)/g) || [])
    .filter((x) => !/^(?:19|20)\d\d$/.test(x));
};

/** In a table, the numbers of its one numeric column; 0 when numbers run in several (a comparison). */
const series = (part) => {
  const cols = new Map();
  for (const row of part.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    (row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || []).forEach((cell, i) => {
      const n = loose(cell).length;
      if (n) cols.set(i, (cols.get(i) || 0) + n);
    });
  }
  return cols.size === 1 ? [...cols.values()][0] : 0;
};

/** True when the slide's body is nothing but one plain list of four or more items. */
function onlyBullets(part) {
  const body = (part.match(/<div\b[^>]*\bclass\s*=\s*["'][^"']*\bslide-body\b[^"']*["'][^>]*>([\s\S]*)<\/div>/i) || [])[1];
  if (!body) return false;
  const rest = body.replace(/<p\b[^>]*>[\s\S]*?<\/p>/gi, '').trim();
  const list = rest.match(/^<(ul|ol)>([\s\S]*)<\/\1>$/i);
  return !!list && (list[2].match(/<li\b/gi) || []).length >= 4;
}

// The icon names deck.js draws, read from its ICONS table so the two never drift.
const ICON_NAMES = new Set(
  [...(fs.readFileSync(path.join(__dirname, '..', 'style-guide', 'js', 'deck.js'), 'utf8').match(/var ICONS = \{([\s\S]*?)\n {2}\};/) || ['', ''])[1]
    .matchAll(/^\s+([a-z]+):/gm)].map((m) => m[1]),
);

/** For a deck: the count, and the slides that break a rule of references/deck.md. */
function deckCheck(html) {
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const tags = [...markup.matchAll(/<[a-z][\w-]*\b[^>]*(?:\bclass\s*=\s*["'](?:[^"']*\s)?slide(?:\s[^"']*)?["']|\sdata-slide\b)[^>]*>/gi)];
  if (tags.length < 2) return null;
  const fix = [];
  const check = [];
  const noNotes = [];
  const endings = { stop: [], open: [] };
  const kinds = [];
  const backup = tags.filter((t) => /\sdata-backup\b/.test(t[0])).length;
  tags.forEach((t, i) => {
    const n = i + 1;
    const part = markup.slice(t.index, i + 1 < tags.length ? tags[i + 1].index : markup.length);
    const cls = (t[0].match(/\bclass\s*=\s*["']([^"']*)/i) || [])[1] || '';
    const free = /\b(?:cover|statement|close)\b/.test(cls);
    const words = (textOf(part).match(WORD) || []).length;
    const title = textOf((part.match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i) || [])[1] || '');
    if (!/\sdata-notes\s*=\s*["'][^"']/.test(t[0])) noNotes.push(n);
    const kind = free ? cls.match(/\b(?:cover|statement|close)\b/)[0] : visualOf(part);
    kinds.push({ n, kind, backup: /\sdata-backup\b/.test(t[0]) });
    if (kind === 'cover' && !/\bcover-art\b/.test(part)) check.push(`Slide ${n}: the cover has no picture: draw the deck's model or its key number small in div.cover-art.`);
    const nums = kind === 'table' ? series(part) : ['text', 'callouts'].includes(kind) ? loose(part).length : 0;
    if (nums >= 3 && nums <= 12) check.push(`Slide ${n} carries ${nums} numbers in ${kind === 'text' ? 'its text' : `a ${kind === 'table' ? 'table' : 'list'}`}: if they grow, compare or add up to a whole, draw them (bars, hbars, stack).`);
    if (/\bcover\b/.test(cls) && title.length > 65) check.push(`Slide ${n}: the cover title runs ${title.length} characters; under 60 keeps it to three lines, and the lede carries the rest.`);
    if (kind === 'close') {
      const said = [...part.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => textOf(m[1]));
      if (said.length > 3) fix.push(`Slide ${n}: the close has ${said.length} lines; it holds two or three.`);
      said.forEach((l, k) => {
        if (l.length > 36) fix.push(`Slide ${n}: close line ${k + 1} runs ${l.length} characters; keep it to its verb and a few words, under 36, so it holds one line. The detail is on the slides before.`);
      });
    }
    if (!free) {
      const bare = title.replace(/[.!?:]+$/, '').trim();
      if (!title) fix.push(`Slide ${n} has no h2: give it the sentence it proves.`);
      else if (STOCK_SLIDE.test(bare)) fix.push(`Slide ${n} "${title}" is a stock slide: cut it, or title it with what it shows.`);
      else if (/\?$/.test(title)) fix.push(`Slide ${n} "${title}" asks a question: title it with the answer.`);
      else {
        (/[.!]$/.test(title) ? endings.stop : endings.open).push(n);
        if (bare.split(/\s+/).length <= 3 && !/\d/.test(bare)) check.push(`Slide ${n} "${title}" may name a topic: if so, write the sentence the slide proves.`);
      }
      if (onlyBullets(part)) fix.push(`Slide ${n} is a bullet list: show it as panes, a chain, steps, a table or a chart.`);
    }
    if (title.length > 110) fix.push(`Slide ${n}: the title runs ${title.length} characters; two lines hold about 100.`);
    const unknown = [...new Set([...part.matchAll(/\bdata-i\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]))].filter((x) => !ICON_NAMES.has(x));
    if (unknown.length) fix.push(`Slide ${n}: no icon named ${unknown.join(', ')}; use one of ${[...ICON_NAMES].join(', ')}.`);
    if (words > 150) check.push(`Slide ${n}: ${words} words, which reads as a document; move detail to data-notes or split it.`);
  });
  if (endings.stop.length && endings.open.length) {
    const [few, many] = endings.stop.length < endings.open.length ? [endings.stop, endings.open] : [endings.open, endings.stop];
    const one = few.length === 1;
    const how = few === endings.stop ? (one ? 'ends with a full stop' : 'end with a full stop') : (one ? 'has no full stop' : 'have no full stop');
    fix.push(`Titles end two ways: slide${one ? '' : 's'} ${few.join(', ')} ${how}, unlike ${many.length} other${many.length > 1 ? 's' : ''}.`);
  }
  // Variety: the same visual on consecutive slides, or on many, means the ideas were not drawn by their shape.
  const body = kinds.filter((k) => !['cover', 'statement', 'close'].includes(k.kind) && !k.backup);
  for (let i = 0; i + 1 < body.length; i++) {
    const [a, b, c] = [body[i], body[i + 1], body[i + 2]];
    if (c && a.kind === b.kind && b.kind === c.kind && (i === 0 || body[i - 1].kind !== a.kind)) fix.push(`Slides ${a.n}, ${b.n} and ${c.n} are all drawn as ${a.kind}: give each idea the visual its evidence calls for.`);
    else if (a.kind === b.kind && (!c || c.kind !== a.kind) && (i === 0 || body[i - 1].kind !== a.kind)) check.push(`Slides ${a.n} and ${b.n} are both drawn as ${a.kind}: if their evidence differs, so should the visual.`);
  }
  const counts = body.reduce((m, k) => m.set(k.kind, (m.get(k.kind) || 0) + 1), new Map());
  for (const [kind, count] of counts) if (count >= 3 && count * 3 > body.length && kind !== 'text') check.push(`${count} of ${body.length} slides are drawn as ${kind}: vary the visuals by what each slide shows.`);
  if (noNotes.length && noNotes.length < tags.length) fix.push(`No data-notes on slide${noNotes.length > 1 ? 's' : ''} ${noNotes.join(', ')}: each slide needs what the presenter says and the sources.`);
  const lines = [...fix.map((l) => `  Fix: ${l}`), ...check.map((l) => `  Check: ${l}`)];
  const head = `Deck: ${tags.length} slides${backup ? ` (${backup} backup)` : ''}, notes on ${tags.length - noNotes.length}.` +
    `${lines.length ? '' : ' Every slide passes the slide check.'}\nVisuals: ${kinds.map((k) => `${k.n} ${k.kind}`).join(' · ')}`;
  return { problems: fix.length, report: `\n${head}${lines.length ? `\n${lines.join('\n')}` : ''}` };
}

/* ------------------------------------------------------------------ layout check */

/** A browser to lay the deck out in: CHROME_PATH, then Chrome, Chromium or Edge where they install. */
function findBrowser() {
  if (process.env.CHROME_PATH) return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const fixed = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    win32: [`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`],
  }[process.platform] || [];
  for (const f of fixed) if (fs.existsSync(f)) return f;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
    }
  }
  return null;
}

// Runs inside the deck once its fonts are in and deck.js has fitted each slide. Every slide is laid
// out (the hidden ones too), so each can be measured; the result goes on <body data-layout>.
const PROBE = `<script data-layout-probe>(function () {
  var errors = [];
  addEventListener('error', function (e) { errors.push(String(e.message || e)); });
  function blockOf(el) { while (el && getComputedStyle(el).display === 'inline') el = el.parentElement; return el; }
  function measure() {
    var out = { slides: [], errors: errors };
    var slides = [].slice.call(document.querySelectorAll('.slide, [data-slide]'));
    slides.forEach(function (s, i) {
      var box = s.getBoundingClientRect(), body = s.querySelector('.slide-body');
      var p = { n: i + 1, issues: [], shrunk: body && parseFloat(body.style.fontSize) < 20 ? parseFloat(body.style.fontSize) : 0,
        fill: body && body.hasAttribute('data-fill') ? +body.getAttribute('data-fill') : 100 };
      if (s.hasAttribute('data-overflow')) {
        var by = body ? body.scrollHeight - body.clientHeight : 0;
        p.issues.push(['overflow', Math.max(by, s.scrollHeight - s.clientHeight, s.scrollWidth - s.clientWidth)]);
      }
      var texts = [], seen = [], walk = document.createTreeWalker(s, NodeFilter.SHOW_TEXT), node;
      while ((node = walk.nextNode())) {
        if (!/\\S/.test(node.nodeValue)) continue;
        var el = node.parentElement, cs = getComputedStyle(el);
        if (cs.display === 'none' || el.closest('defs, title, desc')) continue;
        var label = node.nodeValue.trim().replace(/\\s+/g, ' ').slice(0, 48), size = parseFloat(cs.fontSize), rects;
        if (el.closest('svg')) {
          var m = el.getScreenCTM();
          size = size * (m ? Math.sqrt(m.a * m.a + m.b * m.b) : 1);
          rects = [el.getBoundingClientRect()];
        } else {
          var range = document.createRange();
          range.selectNodeContents(node);
          rects = [].slice.call(range.getClientRects());
          var b = blockOf(el);
          if (b && b.clientWidth > 0 && b.scrollWidth > b.clientWidth + 2 && seen.indexOf(b) < 0) {
            seen.push(b);
            // Named by the classes the page wrote: deck.js's own .rise is left out.
            var own = typeof b.className === 'string' ? b.className.trim().split(/\\s+/).filter(function (c) { return c && c !== 'rise'; }) : [];
            p.issues.push(['clip', label, b.tagName.toLowerCase() + (own.length ? '.' + own.join('.') : '')]);
          }
        }
        // A screen is a picture of a product: its own small print is the product's, not the slide's.
        if (size < (el.closest('.screen') ? 9.5 : 13.5)) p.issues.push(['small', Math.round(size), label]);
        rects.forEach(function (q) {
          if (q.width < 1 || q.height < 1) return;
          if (q.right > box.right + 2 || q.bottom > box.bottom + 2 || q.left < box.left - 2 || q.top < box.top - 2) p.issues.push(['outside', label]);
          var pad = q.height * 0.18;
          texts.push({ l: q.left, r: q.right, t: q.top + pad, b: q.bottom - pad, node: node, label: label });
        });
      }
      // A label in a drawing that runs past the smallest shape around its middle.
      [].slice.call(s.querySelectorAll('svg text')).forEach(function (t) {
        var tb = t.getBoundingClientRect(), cx = (tb.left + tb.right) / 2, cy = (tb.top + tb.bottom) / 2, best = null, area = Infinity;
        if (!tb.width) return;
        [].slice.call(t.ownerSVGElement.querySelectorAll('rect')).forEach(function (r) {
          var rb = r.getBoundingClientRect();
          if (cx > rb.left && cx < rb.right && cy > rb.top && cy < rb.bottom && rb.width * rb.height < area) { best = rb; area = rb.width * rb.height; }
        });
        if (best && (tb.left < best.left - 1 || tb.right > best.right + 1)) p.issues.push(['clip', t.textContent.trim().replace(/\s+/g, ' ').slice(0, 48)]);
      });
      for (var a = 0; a < texts.length; a++) for (var c = a + 1; c < texts.length; c++) {
        var x = texts[a], y = texts[c];
        if (x.node === y.node) continue;
        if (Math.min(x.r, y.r) - Math.max(x.l, y.l) > 3 && Math.min(x.b, y.b) - Math.max(x.t, y.t) > 3) p.issues.push(['overlap', x.label, y.label]);
      }
      out.slides.push(p);
    });
    out.canvases = document.querySelectorAll('.slide canvas').length;
    out.charts = window.Chart && Chart.instances ? Object.keys(Chart.instances).length : 0;
    document.body.setAttribute('data-layout', JSON.stringify(out));
  }
  addEventListener('load', function () {
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () { setTimeout(measure, 600); });
  });
})();</script>`;

const quote = (s) => `"${s.length >= 48 ? `${s}…` : s}"`;

/** One line per problem, three per slide at most, in slide order. */
function layoutReport(data, browser) {
  const lines = [];
  const notes = [];
  let problems = 0;
  for (const s of data.slides) {
    const seen = new Set();
    const mine = [];
    for (const [kind, a, b] of s.issues) {
      const key = `${kind}|${a}|${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (kind === 'overflow') mine.push(`the body runs ${a} px past the slide: cut words, or split the slide`);
      else if (kind === 'overlap') mine.push(`text overlaps text: ${quote(a)} and ${quote(b)}`);
      else if (kind === 'clip') mine.push(`text runs out of its box${b ? `, a ${b}` : ''}: ${quote(a)}`);
      else if (kind === 'outside') mine.push(`text sits off the slide: ${quote(a)}`);
      else if (kind === 'small') mine.push(`${a} px text, ${quote(b)}: 14 px is the smallest that reads on a screen`);
    }
    problems += mine.length;
    mine.slice(0, 3).forEach((m) => lines.push(`  Fix: slide ${s.n}: ${m}.`));
    if (mine.length > 3) lines.push(`  Fix: slide ${s.n}: ${mine.length - 3} more of the same kind.`);
    if (s.shrunk) notes.push(`  Check: slide ${s.n}: the body shrank to ${s.shrunk} px to fit; it is full.`);
    else if (s.fill < 33) notes.push(`  Check: slide ${s.n}: its content fills ${s.fill}% of the slide's height: give the idea a bigger visual or its evidence beside it, not more words.`);
  }
  if (data.canvases > data.charts) { problems += 1; lines.push(`  Fix: ${data.canvases - data.charts} chart canvas(es) drew nothing; check the script that draws them.`); }
  for (const e of data.errors.slice(0, 3)) { problems += 1; lines.push(`  Fix: a script error: ${e}`); }
  const name = path.basename(browser).replace(/\.(exe|app)$/i, '');
  const head = `Layout, measured in ${name} at 1600 × 900: ` +
    (problems ? `${problems} problem${problems > 1 ? 's' : ''}.` : `no overlap, overflow or small text on ${data.slides.length} slides.`);
  return { problems, report: `\n${[head, ...lines, ...notes].join('\n')}` };
}

/**
 * Lays the built deck out in a headless browser and measures every slide. The browser gets no
 * more than a viewer's would: a fresh profile, file pages that cannot read other files, and, for a
 * page built to open offline, no network at all (every request goes to a closed local port, so a
 * script in the page reaches neither the internet nor a service on this machine).
 */
function layoutCheck(file, offline) {
  const browser = findBrowser();
  if (!browser) {
    return Promise.resolve({ problems: 0, report: '\nLayout check skipped: no Chrome, Chromium or Edge found. Set CHROME_PATH to one to measure the slides.' });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemie-deck-'));
  const probe = path.join(dir, 'deck.html');
  const base = `<base href="${pathToFileURL(path.dirname(path.resolve(file)) + path.sep).href}">`;
  const html = fs.readFileSync(file, 'utf8')
    .replace(/<head\b[^>]*>/i, (m) => m + base)
    .replace(/<\/body>(?![\s\S]*<\/body>)/i, `${PROBE}</body>`);
  fs.writeFileSync(probe, html);
  const profile = path.join(dir, 'profile');
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--mute-audio', '--disable-extensions', '--disable-background-networking', `--user-data-dir=${profile}`,
    ...(offline ? ['--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>'] : []),
    // ?static, as for screenshots: the layout is measured at rest, never mid-motion.
    '--window-size=1648,948', '--virtual-time-budget=8000', '--dump-dom', `${pathToFileURL(probe).href}?static`];
  if (process.platform === 'linux' && process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.stdout.on('data', (d) => {
      out += d;
      if (/<\/html>\s*$/.test(out)) child.kill();
    });
    child.stderr.on('data', (d) => { err += d; });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (process.platform !== 'win32') spawnSync('pkill', ['-f', profile]);
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the OS clears its temp folder */ }
      const m = out.match(/\sdata-layout="([^"]*)"/);
      if (m) {
        const json = m[1].replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        return resolve(layoutReport(JSON.parse(json), browser));
      }
      const blocked = /Operation not permitted|Permission denied|bootstrap_check_in|Failed to create socket/i.test(err);
      resolve({
        problems: 0,
        report: blocked
          ? '\nLayout check skipped: the browser could not start here (a sandbox blocks it). Run this build once outside the sandbox to measure the slides.'
          : '\nLayout check skipped: the browser returned no measurement.',
      });
    };
    child.on('close', finish);
    child.on('error', finish);
  });
}

(async () => {
  if (out && path.resolve(out) !== path.resolve(page)) fs.copyFileSync(page, out);
  if (run('inject-css.js', [target, ...cdn]) !== 0) process.exit(1);
  if (run('inject-charts.js', [target, ...cdn]) !== 0) process.exit(1);
  if (run('inject-controls.js', [target, ...flags.filter((f) => !['--cdn', '--no-layout'].includes(f))]) !== 0) process.exit(1);
  // The design system and the controls are never scanned, so the page as written gives the same
  // findings, at the lines you edit.
  const scan = run('slop-scan.mjs', [page, '--fail-on', 'high', '--fail-on-look', 'medium']);
  if (scan !== 0 && scan !== 2) process.exit(1);

  const built = fs.readFileSync(path.resolve(target), 'utf8');
  let problems = scan === 2 ? 1 : 0;
  const deck = deckCheck(built);
  if (deck) {
    console.log(deck.report);
    problems += deck.problems;
    if (!flags.includes('--no-layout')) {
      const layout = await layoutCheck(target, !cdn.length);
      console.log(layout.report);
      problems += layout.problems;
    }
  }
  const { hosts, files } = externalLoads(built);
  if (hosts.size) console.log(`\nNot self-contained: loads from ${[...hosts].map(([h, n]) => `${h} (${n})`).join(', ')}. It needs a network connection to render as built.`);
  if (files.size) {
    const list = [...files].slice(0, 5).join(', ') + (files.size > 5 ? ` and ${files.size - 5} more` : '');
    console.log(`\nNot self-contained: loads ${list} from beside the page, which a copy sent on its own will not have. Embed each (an image as a data: URI) or drop it.`);
  }
  if (!hosts.size && !files.size) console.log('\nSelf-contained: loads nothing from the network or from other files. Opens offline; safe to email or share in Teams.');
  if (out) console.log(`\nBuilt ${out} from ${page}: edit ${page} and build again.`);
  if (problems) console.log('\nNot ready: fix each finding and "Fix:" line above, then run the build again.');
  process.exit(problems ? 2 : 0);
})();
