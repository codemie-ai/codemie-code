#!/usr/bin/env node
import { execSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  appendFileSync,
  chmodSync,
  symlinkSync,
  unlinkSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// npm strips execute bits on macOS when unpacking prebuilt binaries
if (process.platform === 'darwin') {
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    const helper = join(packageRoot, 'node_modules', 'node-pty', 'prebuilds', arch, 'spawn-helper');
    if (existsSync(helper)) {
      try { chmodSync(helper, 0o755); } catch (e) { console.warn(`[postinstall] chmod failed for ${helper}: ${e.message}`); }
    }
  }
}

function getNpmBinDir() {
  try {
    const prefix = execSync('npm config get prefix', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    return join(prefix, 'bin');
  } catch {
    return null;
  }
}

function getShellRcFile() {
  const shell = process.env.SHELL ?? '';
  const home = homedir();
  if (shell.includes('zsh')) return join(home, '.zshrc');
  if (shell.includes('bash')) {
    const bashProfile = join(home, '.bash_profile');
    return existsSync(bashProfile) ? bashProfile : join(home, '.bashrc');
  }
  return null;
}

function isInPath(dir) {
  return (process.env.PATH ?? '').split(':').includes(dir);
}

function alreadyInRcFile(rcFile, dir) {
  if (!existsSync(rcFile)) return false;
  return readFileSync(rcFile, 'utf8').includes(dir);
}

function getBinNames() {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  return Object.keys(pkg.bin ?? {});
}

function safeLstat(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Hosts like Claude Code run lifecycle hooks (e.g. `codemie hook`) in a plain
 * non-interactive, non-login shell, which never sources ~/.zshrc or ~/.bashrc.
 * A PATH fix appended to a shell rc file is therefore invisible to those hook
 * subshells even though it works for the user's regular terminal. Symlinking
 * into /usr/local/bin — on PATH for every shell regardless of interactivity —
 * fixes hook resolution too.
 */
function linkIntoUniversalPath(npmBin) {
  const universalDir = '/usr/local/bin';
  const binNames = getBinNames();

  if (!existsSync(universalDir)) {
    return binNames.map(
      (name) => `sudo mkdir -p ${universalDir} && sudo ln -sf "${join(npmBin, name)}" "${join(universalDir, name)}"`,
    );
  }

  const manualCommands = [];
  for (const name of binNames) {
    const source = join(npmBin, name);
    const target = join(universalDir, name);
    if (!existsSync(source) || source === target) continue;

    const targetStat = safeLstat(target);
    try {
      if (targetStat) {
        if (!targetStat.isSymbolicLink()) {
          manualCommands.push(
            `# ${target} already exists and isn't a symlink — if it isn't the CodeMie CLI, replace it manually: sudo ln -sf "${source}" "${target}"`,
          );
          continue;
        }
        if (readlinkSync(target) === source) continue; // already correct
        const oldTarget = readlinkSync(target);
        unlinkSync(target);
        try {
          symlinkSync(source, target);
        } catch (createErr) {
          try { symlinkSync(oldTarget, target); } catch { /* restore failed, fall through */ }
          throw createErr;
        }
        continue;
      }
      symlinkSync(source, target);
    } catch {
      manualCommands.push(`sudo ln -sf "${source}" "${target}"`);
    }
  }
  return manualCommands;
}

function printUniversalLinkHint(manualCommands) {
  console.log(
    `\n⚠️  Could not link all CLI binaries into /usr/local/bin. Hooks run by hosts like Claude Code ` +
      `(e.g. SessionStart) execute in a non-interactive shell that doesn't read ~/.zshrc or ~/.bashrc, ` +
      `so they need this to find "codemie". Ask an admin to run, or run yourself with sudo:\n`,
  );
  for (const cmd of manualCommands) console.log(`   ${cmd}`);
  console.log('');
}

const npmBin = getNpmBinDir();
if (!npmBin) process.exit(0);

const universalLinkFailures = process.platform === 'win32' ? [] : linkIntoUniversalPath(npmBin);

if (isInPath(npmBin)) {
  if (universalLinkFailures.length > 0) printUniversalLinkHint(universalLinkFailures);
  process.exit(0);
}

const rcFile = getShellRcFile();
if (!rcFile) {
  console.log(`\n⚠️  Add to PATH manually:\n   export PATH="${npmBin}:$PATH"\n`);
  if (universalLinkFailures.length > 0) printUniversalLinkHint(universalLinkFailures);
  process.exit(0);
}

if (!alreadyInRcFile(rcFile, npmBin)) {
  appendFileSync(rcFile, `\n# Added by @codemieai/code\nexport PATH="${npmBin}:$PATH"\n`);
  console.log(`\n✓ Added ${npmBin} to PATH in ${rcFile}`);
  console.log(`  Run: source ${rcFile}\n`);
}

if (universalLinkFailures.length > 0) printUniversalLinkHint(universalLinkFailures);
