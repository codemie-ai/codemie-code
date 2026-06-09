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
    dest: join(rootDir, 'dist/agents/plugins/claude/plugin')
  },
  {
    name: 'Gemini extension',
    src: join(rootDir, 'src/agents/plugins/gemini/extension'),
    dest: join(rootDir, 'dist/agents/plugins/gemini/extension')
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
    name: 'Analytics pricing table',
    src: join(rootDir, 'src/cli/commands/analytics/cost/pricing.json'),
    dest: join(rootDir, 'dist/cli/commands/analytics/cost/pricing.json')
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
  cpSync(config.src, config.dest, { recursive: true });

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
