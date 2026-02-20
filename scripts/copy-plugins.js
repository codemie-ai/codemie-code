#!/usr/bin/env node

/**
 * Cross-platform script to copy plugin assets from src/ to dist/
 * Works on Windows, macOS, and Linux
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, mkdirSync, cpSync, copyFileSync, existsSync } from 'fs';

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

const copyFiles = [
  {
    name: 'Claude statusline script',
    src: join(rootDir, 'src/agents/plugins/claude/codemie-statusline.mjs'),
    dest: join(rootDir, 'dist/agents/plugins/claude/codemie-statusline.mjs')
  }
];

for (const file of copyFiles) {
  console.log(`Processing ${file.name}:`);

  if (!existsSync(file.src)) {
    console.log(`  - Warning: Source ${file.src} does not exist, skipping...`);
    continue;
  }

  // Ensure destination directory exists before copying
  mkdirSync(dirname(file.dest), { recursive: true });
  copyFileSync(file.src, file.dest);
  console.log(`  ✓ ${file.name} copied successfully\n`);
}

console.log('Plugin assets copied successfully!');
