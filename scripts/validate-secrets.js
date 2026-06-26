#!/usr/bin/env node
/**
 * Cross-platform secrets detection using Gitleaks
 * Works on Windows, macOS, and Linux
 *
 * Supports Docker, Podman, and Apple Containers.
 * CI uses the official gitleaks-action@v2 for better GitHub integration.
 * Both share the same .gitleaks.toml configuration.
 *
 * Local validation scans the staged git diff instead of the whole working tree.
 * That keeps generated or user-local files ignored by .gitignore (for example
 * BMAD installs under _bmad/ and .claude/skills/) out of pre-commit checks.
 */

import { spawn, spawnSync } from 'child_process';
import { platform } from 'os';
import { resolve } from 'path';
import { existsSync } from 'fs';

const isWindows = platform() === 'win32';
const projectPath = resolve(process.cwd());

const configPath = resolve(projectPath, '.gitleaks.toml');
const hasConfig = existsSync(configPath);

function commandExists(cmd) {
  const result = spawnSync(isWindows ? 'where' : 'which', [cmd], { stdio: 'ignore', shell: false });
  return result.status === 0;
}

function daemonRunning(engine) {
  const result = spawnSync(engine, ['info'], { stdio: 'ignore', shell: false });
  return result.status === 0;
}

function appleContainersRunning() {
  if (isWindows || !commandExists('container')) return false;
  const result = spawnSync('container', ['system', 'status'], { shell: false });
  const output = (result.stdout?.toString() ?? '') + (result.stderr?.toString() ?? '');
  return output.includes('container-apiserver') && /running/i.test(output);
}

function detectEngine() {
  for (const engine of ['docker', 'podman']) {
    if (commandExists(engine) && daemonRunning(engine)) return engine;
  }
  if (appleContainersRunning()) return 'container';
  return null;
}

const engine = detectEngine();

if (!engine) {
  console.error('No running container engine found (Docker, Podman, or Apple Containers)');
  console.error('Start your container engine to enable local secrets scanning');
  process.exit(1);
}

const args = [
  'run',
  '--rm',
  '-v',
  `${projectPath}:/path`,
  'ghcr.io/gitleaks/gitleaks:v8.30.1',
  'protect',
  '--staged',
  '--source=/path',
  '--verbose',
];

if (hasConfig) {
  args.push('--config=/path/.gitleaks.toml');
}

console.log('Running Gitleaks secrets detection...');

const gitleaks = spawn(engine, args, {
  stdio: 'inherit',
  shell: isWindows,
});

gitleaks.on('close', (code) => {
  process.exit(code);
});

gitleaks.on('error', (err) => {
  console.error('Failed to run Gitleaks:', err.message);
  process.exit(1);
});
