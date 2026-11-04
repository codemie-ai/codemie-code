#!/usr/bin/env node
/**
 * inject-data.js — put the codemie-analytics skill's JSON files into a page's data placeholders.
 *
 *   node inject-data.js <page.html> <json-file-or-dir> [...]
 *
 * Each NAME.json replaces every /*__DATA:NAME__*\/ in the page. The file must parse as JSON. It
 * goes in as written, with "<", U+2028 and U+2029 escaped: they can only stand inside a JSON
 * string, and unescaped, a value holding "</script>" would end the <script> it is written into
 * and run as markup. A file with no placeholder is skipped and a placeholder with no file is
 * named; both are warnings. Run it on the page before scripts/build.js, so the build checks the
 * finished page.
 */

const fs = require('node:fs');
const path = require('node:path');

const [page, ...sources] = process.argv.slice(2);
if (!page || !sources.length) {
  console.error('Usage: node inject-data.js <page.html> <json-file-or-dir> [...]');
  process.exit(1);
}
const target = path.resolve(page);
if (!fs.existsSync(target)) {
  console.error(`Error: HTML file not found: ${target}`);
  process.exit(1);
}

const files = [];
for (const source of sources) {
  const at = path.resolve(source);
  if (!fs.existsSync(at)) {
    console.error(`Error: source not found: ${at}`);
    process.exit(1);
  }
  if (fs.statSync(at).isDirectory()) {
    for (const entry of fs.readdirSync(at).sort()) {
      if (entry.endsWith('.json') && !entry.endsWith('.schema.json')) files.push(path.join(at, entry));
    }
  } else if (at.endsWith('.json')) {
    files.push(at);
  } else {
    console.error(`Error: not a JSON file: ${at}`);
    process.exit(1);
  }
}
if (!files.length) {
  console.error('Error: no JSON files in the sources given');
  process.exit(1);
}

let html = fs.readFileSync(target, 'utf8');
let injected = 0;
for (const file of files) {
  const name = path.basename(file, '.json');
  const placeholder = `/*__DATA:${name}__*/`;
  if (!html.includes(placeholder)) {
    console.warn(`  warn: no placeholder for "${name}"; skipped`);
    continue;
  }
  const raw = fs.readFileSync(file, 'utf8').trim();
  try {
    JSON.parse(raw);
  } catch (e) {
    console.error(`Error: ${file} is not valid JSON (${e.message}); the page is unchanged`);
    process.exit(1);
  }
  const text = raw.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  // split and join, not replace: "$&" or "$'" in the data must stay text.
  html = html.split(placeholder).join(text);
  console.log(`  ✓ injected ${name}`);
  injected++;
}

const left = [...new Set(html.match(/\/\*__DATA:[^*]+__\*\//g) || [])];
if (left.length) console.warn(`  warn: no file for ${left.join(', ')}: that script will not run until one is given`);
if (!injected) {
  console.error('Error: no placeholder matched a file; the page is unchanged');
  process.exit(1);
}
fs.writeFileSync(target, html, 'utf8');
console.log(`✓ ${injected} data block(s) injected into ${target}`);
