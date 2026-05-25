#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

const npmBin = getNpmBinDir();
if (!npmBin) process.exit(0);

if (isInPath(npmBin)) process.exit(0);

const rcFile = getShellRcFile();
if (!rcFile) {
  console.log(`\n⚠️  Add to PATH manually:\n   export PATH="${npmBin}:$PATH"\n`);
  process.exit(0);
}

if (alreadyInRcFile(rcFile, npmBin)) process.exit(0);

appendFileSync(rcFile, `\n# Added by @codemieai/code\nexport PATH="${npmBin}:$PATH"\n`);

console.log(`\n✓ Added ${npmBin} to PATH in ${rcFile}`);
console.log(`  Run: source ${rcFile}\n`);
