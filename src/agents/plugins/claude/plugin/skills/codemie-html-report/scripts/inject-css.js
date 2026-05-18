#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const htmlPath = process.argv[2];

if (!htmlPath) {
  console.error('Usage: node inject-css.js <path-to-html-file>');
  console.error('Example: node inject-css.js reports/leaderboard-2026-Q1.html');
  process.exit(1);
}

const resolvedHtml = resolve(htmlPath);
const bundlePath = join(__dirname, '..', 'style-guide', 'css', 'bundle.css');

if (!existsSync(resolvedHtml)) {
  console.error(`Error: HTML file not found: ${resolvedHtml}`);
  process.exit(1);
}

if (!existsSync(bundlePath)) {
  console.error(`Error: bundle.css not found at ${bundlePath}`);
  console.error('Rebuild it — see style-guide/README.md for the command.');
  process.exit(1);
}

const html = readFileSync(resolvedHtml, 'utf8');

if (!html.includes('/* __CODEMIE_CSS__ */')) {
  console.error(`Error: placeholder "/* __CODEMIE_CSS__ */" not found in ${resolvedHtml}`);
  console.error('The HTML file must contain: <style>/* __CODEMIE_CSS__ */</style>');
  process.exit(1);
}

const css = readFileSync(bundlePath, 'utf8');
writeFileSync(resolvedHtml, html.replace('/* __CODEMIE_CSS__ */', css), 'utf8');
console.log(`✓ CSS injected into ${resolvedHtml}`);
