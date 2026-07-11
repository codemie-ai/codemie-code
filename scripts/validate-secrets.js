#!/usr/bin/env node
/**
 * Cross-platform secrets detection using Gitleaks
 * Works on Windows (native Docker or Docker-in-WSL), macOS, and Linux
 *
 * Supports Docker, Podman, and Apple Containers.
 * On Windows without Docker Desktop, falls back to Docker running inside WSL2
 * by invoking: wsl -e bash -l -c "docker ..."
 *
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

/**
 * On Windows, check if Docker is available inside WSL2 by running
 * `wsl -e bash -l -c "docker info"`. Returns true if the daemon responds.
 */
function wslDockerRunning() {
  if (!isWindows) return false;
  const wslBin = resolveCommand('wsl');
  if (!wslBin) return false;
  const result = spawnSync(wslBin, ['-e', 'bash', '-l', '-c', 'docker info'], {
    stdio: 'ignore',
    shell: false,
  });
  return result.status === 0;
}

/**
 * Detects the available container engine.
 * Returns one of: 'docker' | 'podman' | 'container' | 'wsl-docker' | null
 */
function detectEngine() {
  for (const engine of ['docker', 'podman']) {
    if (commandExists(engine) && daemonRunning(engine)) return engine;
  }
  if (appleContainersRunning()) return 'container';
  // Fallback: Docker running inside WSL2 on Windows
  if (wslDockerRunning()) return 'wsl-docker';
  return null;
}

const engine = detectEngine();

if (!engine) {
  console.log('No container engine found - secrets detection skipped');
  console.log('Install Docker (or enable Docker in WSL2), Podman, or Apple Containers to enable local secrets scanning');
  process.exit(1);
}

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

console.log(`Running Gitleaks secrets detection (engine: ${engine})...`);

let gitleaks;

if (engine === 'wsl-docker') {
  // Docker is inside WSL2: build the full docker command as a shell string
  // and pass it via `wsl -e bash -l -c "..."`.
  // The .gitleaks.toml is mounted from the WSL-translated Windows path.
  const wslBin = resolveCommand('wsl');

  // Convert Windows path to WSL /mnt/... path: C:\foo\bar -> /mnt/c/foo/bar
  function toWslPath(winPath) {
    return winPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
  }

  const wslProjectPath = toWslPath(projectPath);
  const wslConfigPath = toWslPath(configPath);

  let dockerCmd = 'docker run --rm -i';
  if (hasConfig) {
    dockerCmd += ` -v "${wslConfigPath}:/gitleaks.toml"`;
  }
  dockerCmd += ' ghcr.io/gitleaks/gitleaks:v8.30.1 detect --pipe --verbose';
  if (hasConfig) {
    dockerCmd += ' --config=/gitleaks.toml';
  }

  // Pipe the staged diff into the WSL command via stdin
  gitleaks = spawn(wslBin, ['-e', 'bash', '-l', '-c', dockerCmd], {
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: false,
  });
} else {
  const engineBin = resolveCommand(engine);
  if (!engineBin) {
    console.log('Container engine binary not found — skipping secrets detection');
    process.exit(1);
  }
  // shell:true is used on Windows so paths with spaces must be quoted for the shell.
  // On Linux/Mac shell:false passes the path directly to execve — no quoting needed.
  const spawnBin = isWindows && engineBin.includes(' ') ? `"${engineBin}"` : engineBin;

  const args = ['run', '--rm', '-i'];
  if (hasConfig) {
    args.push('-v', `${projectPath}/.gitleaks.toml:/gitleaks.toml`);
  }
  args.push('ghcr.io/gitleaks/gitleaks:v8.30.1', 'detect', '--pipe', '--verbose');
  if (hasConfig) {
    args.push('--config=/gitleaks.toml');
  }

  gitleaks = spawn(spawnBin, args, {
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: isWindows,
  });
}

gitleaks.stdin.write(stagedDiff);
gitleaks.stdin.end();

gitleaks.on('close', (code) => {
  process.exit(code);
});

gitleaks.on('error', (err) => {
  console.error('Failed to run Gitleaks:', err.message);
  process.exit(1);
});
