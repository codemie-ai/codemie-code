#!/usr/bin/env node

/**
 * Cross-platform script to copy plugin assets from src/ to dist/
 * Works on Windows, macOS, and Linux
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, mkdirSync, cpSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const copyConfigs = [
  {
    name: 'Claude plugin',
    src: join(rootDir, 'src/agents/plugins/claude/plugin'),
    dest: join(rootDir, 'dist/agents/plugins/claude/plugin'),
    // statusline.ts lives in this tree as normal TS source; tsc compiles it and
    // scripts/bundle-statusline.mjs bundles it separately, both under dist/. Exclude .ts here so
    // this wholesale asset copy doesn't also duplicate the raw source (and its __tests__ file)
    // into the published package.
    filter: (src) => !src.endsWith('.ts')
  },
  {
    name: 'Gemini extension',
    src: join(rootDir, 'src/agents/plugins/gemini/extension'),
    dest: join(rootDir, 'dist/agents/plugins/gemini/extension')
  },
  {
    name: 'Kimi extension',
    src: join(rootDir, 'src/agents/plugins/kimi/extension'),
    dest: join(rootDir, 'dist/agents/plugins/kimi/extension')
  },
  {
    // Loaded by Pi itself, so it must ship byte-identical — tsc does not compile .js under src/.
    name: 'Pi run-ledger extension',
    src: join(rootDir, 'src/agents/plugins/pi/extension'),
    dest: join(rootDir, 'dist/agents/plugins/pi/extension')
  },
  {
    name: 'Top-level assets',
    src: join(rootDir, 'assets'),
    dest: join(rootDir, 'dist/assets')
  },
  {
    name: 'Analytics report assets (CSS + Chart.js)',
    src: join(rootDir, 'src/cli/commands/analytics/report/assets'),
    dest: join(rootDir, 'dist/cli/commands/analytics/report/assets')
  },
  {
    name: 'Analytics report client app',
    src: join(rootDir, 'src/cli/commands/analytics/report/client'),
    dest: join(rootDir, 'dist/cli/commands/analytics/report/client')
  }
];

// Individual non-TS files copied next to their compiled modules (read at runtime).
const fileConfigs = [
  {
    name: 'Analytics report template',
    src: join(rootDir, 'src/cli/commands/analytics/report/template.html'),
    dest: join(rootDir, 'dist/cli/commands/analytics/report/template.html')
  },
  {
    name: 'Model pricing table',
    src: join(rootDir, 'src/utils/pricing.json'),
    dest: join(rootDir, 'dist/utils/pricing.json')
  },
  {
    // Plain JS, zero project imports — deployed as-is beside any agent's statusline (see
    // statusline-installer.ts) as well as imported normally by pricing.ts/usage-readers.ts.
    name: 'Routing headers domain module',
    src: join(rootDir, 'src/utils/routing-headers.mjs'),
    dest: join(rootDir, 'dist/utils/routing-headers.mjs')
  },
  {
    name: 'Bedrock pricing domain module',
    src: join(rootDir, 'src/utils/bedrock-pricing.mjs'),
    dest: join(rootDir, 'dist/utils/bedrock-pricing.mjs')
  }
];

console.log('Copying plugin assets...\n');

for (const config of copyConfigs) {
  console.log(`Processing ${config.name}:`);

  // Remove destination if it exists
  if (existsSync(config.dest)) {
    console.log(`  - Removing old ${config.dest}`);
    rmSync(config.dest, { recursive: true, force: true });
  }

  // Check if source exists
  if (!existsSync(config.src)) {
    console.log(`  - Warning: Source ${config.src} does not exist, skipping...`);
    continue;
  }

  // Create parent directories
  console.log(`  - Creating ${config.dest}`);
  mkdirSync(config.dest, { recursive: true });

  // Copy recursively
  console.log(`  - Copying from ${config.src}`);
  cpSync(config.src, config.dest, { recursive: true, ...(config.filter ? { filter: config.filter } : {}) });

  console.log(`  ✓ ${config.name} copied successfully\n`);
}

for (const config of fileConfigs) {
  console.log(`Processing ${config.name}:`);

  if (!existsSync(config.src)) {
    console.log(`  - Warning: Source ${config.src} does not exist, skipping...`);
    continue;
  }

  // Ensure parent directory exists (it normally does from tsc output)
  mkdirSync(dirname(config.dest), { recursive: true });
  cpSync(config.src, config.dest);

  console.log(`  ✓ ${config.name} copied successfully\n`);
}

console.log('Plugin assets copied successfully!');
