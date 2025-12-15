#!/usr/bin/env node
/**
 * Cross-platform secrets detection using Gitleaks
 * Works on Windows, macOS, and Linux
 *
 * This script runs Gitleaks in a Docker container for local validation.
 * CI uses the official gitleaks-action@v2 for better GitHub integration.
 * Both share the same .gitleaks.toml configuration.
 */

import { spawn } from 'child_process';
import { platform } from 'os';
import { resolve } from 'path';
import { existsSync } from 'fs';

const isWindows = platform() === 'win32';
const projectPath = resolve(process.cwd());

// Check if .gitleaks.toml exists
const configPath = resolve(projectPath, '.gitleaks.toml');
const hasConfig = existsSync(configPath);

const args = [
  'run',
  '--rm',
  '-v',
  `${projectPath}:/path`,
  'ghcr.io/gitleaks/gitleaks:latest',
  'detect',
  '--source=/path',
  '--verbose',
  '--no-git'
];

// Add config file if it exists
if (hasConfig) {
  args.push('--config=/path/.gitleaks.toml');
}

console.log('Running Gitleaks secrets detection...');

const gitleaks = spawn('docker', args, {
  stdio: 'inherit',
  shell: isWindows
});

gitleaks.on('close', (code) => {
  process.exit(code);
});

gitleaks.on('error', (err) => {
  console.error('Failed to run Gitleaks:', err.message);
  process.exit(1);
});
