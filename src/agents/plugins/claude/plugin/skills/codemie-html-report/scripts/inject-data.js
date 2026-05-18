#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve, basename, extname } from 'path';

const [htmlPath, ...sources] = process.argv.slice(2);

if (!htmlPath || sources.length === 0) {
  console.error('Usage: node inject-data.js <path-to-html-file> <json-file-or-dir> [...]');
  console.error('Example: node inject-data.js reports/report.html reports/temp/');
  process.exit(1);
}

const resolvedHtml = resolve(htmlPath);

if (!existsSync(resolvedHtml)) {
  console.error(`Error: HTML file not found: ${resolvedHtml}`);
  process.exit(1);
}

// Collect all JSON files from files and/or directories
const jsonFiles = [];
for (const src of sources) {
  const resolved = resolve(src);
  if (!existsSync(resolved)) {
    console.error(`Error: source not found: ${resolved}`);
    process.exit(1);
  }
  if (statSync(resolved).isDirectory()) {
    for (const entry of readdirSync(resolved)) {
      if (extname(entry) === '.json' && !entry.endsWith('.schema.json')) jsonFiles.push(join(resolved, entry));
    }
  } else {
    if (extname(resolved) !== '.json') {
      console.error(`Error: not a JSON file: ${resolved}`);
      process.exit(1);
    }
    jsonFiles.push(resolved);
  }
}

if (jsonFiles.length === 0) {
  console.error('Error: no JSON files found in the provided sources');
  process.exit(1);
}

let html = readFileSync(resolvedHtml, 'utf8');

let injected = 0;
for (const jsonFile of jsonFiles) {
  const name = basename(jsonFile, '.json');
  const placeholder = `/*__DATA:${name}__*/`;
  if (!html.includes(placeholder)) {
    console.warn(`  warn: no placeholder for "${name}" — skipping`);
    continue;
  }
  const data = readFileSync(jsonFile, 'utf8').trim();
  html = html.replaceAll(placeholder, data);
  console.log(`  ✓ injected ${name}`);
  injected++;
}

if (injected === 0) {
  console.error('Error: no placeholders were matched — HTML unchanged');
  process.exit(1);
}

writeFileSync(resolvedHtml, html, 'utf8');
console.log(`✓ ${injected} data block(s) injected into ${resolvedHtml}`);
