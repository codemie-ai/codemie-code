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

function resolveCommand(cmd) {
  const command = isWindows ? 'where' : 'which';
  const result = spawnSync(command, [cmd], { stdio: 'pipe', shell: false });
  if (result.status !== 0) return null;
  return result.stdout.toString().trim().split('\n')[0].trim();
}

function commandExists(cmd) {
  return resolveCommand(cmd) !== null;
}

function daemonRunning(engine) {
  const bin = resolveCommand(engine);
  if (!bin) return false;
  return spawnSync(bin, ['info'], { stdio: 'ignore', shell: false }).status === 0;
}

function appleContainersRunning() {
  if (platform() !== 'darwin') return false;
  const bin = resolveCommand('container');
  if (!bin) return false;
  return spawnSync(bin, ['system', 'status'], { stdio: 'ignore', shell: false }).status === 0;
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
  console.log('No container engine found - skipping secrets detection');
  console.log('Install Docker, Podman, or Apple Containers to enable local secrets scanning');
  process.exit(1);
}

const engineBin = resolveCommand(engine);
if (!engineBin) {
  console.log('Container engine binary not found — skipping secrets detection');
  process.exit(1);
}
// shell:true is used on Windows so paths with spaces must be quoted for the shell.
// On Linux/Mac shell:false passes the path directly to execve — no quoting needed.
const spawnBin = isWindows && engineBin.includes(' ') ? `"${engineBin}"` : engineBin;

// Produce the staged diff on the host so gitleaks doesn't need git access
// inside the container — required for Apple Containers which cannot run git
// against the host .git index through a bind mount.
const diffResult = spawnSync('git', ['diff', '--staged'], { stdio: 'pipe' });
if (diffResult.error) {
  console.error('Failed to get staged diff:', diffResult.error.message);
  process.exit(1);
}

const stagedDiff = diffResult.stdout;

if (!stagedDiff || stagedDiff.length === 0) {
  console.log('No staged changes to scan');
  process.exit(0);
}

const args = ['run', '--rm', '-i'];

if (hasConfig) {
  args.push('-v', `${projectPath}/.gitleaks.toml:/gitleaks.toml`);
}

args.push('ghcr.io/gitleaks/gitleaks:v8.30.1', 'detect', '--pipe', '--verbose');

if (hasConfig) {
  args.push('--config=/gitleaks.toml');
}

console.log('Running Gitleaks secrets detection...');

const gitleaks = spawn(spawnBin, args, {
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: isWindows,
});

gitleaks.stdin.write(stagedDiff);
gitleaks.stdin.end();

gitleaks.on('close', (code) => {
  process.exit(code);
});

gitleaks.on('error', (err) => {
  console.error('Failed to run Gitleaks:', err.message);
  process.exit(1);
});
