#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = 'dist/completions/manifest.json';
const helperPath = 'dist/cli/completion/dynamic.js';
const shells = ['bash', 'zsh', 'fish'];
// ACP launchers speak JSON-RPC; the proxy executables are internal services.
const nonInteractiveBins = new Set(['codemie-mcp-proxy', 'proxy-daemon']);

function fail(message) {
  throw new Error(message);
}

function readBuiltFile(path) {
  const absolute = join(root, path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size === 0) fail(`Missing, empty, or non-regular build file: ${path}`);
  return readFileSync(absolute);
}

function requireUniqueStrings(value, description) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail(`${description} must be an array of nonempty strings`);
  }
  if (new Set(value).size !== value.length) fail(`${description} contains duplicates`);
  return value;
}

function assertSameMembers(actual, expected, description) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((item) => !actualSet.has(item));
  const unexpected = actual.filter((item) => !expectedSet.has(item));
  if (missing.length || unexpected.length) {
    fail(`${description}: missing [${missing.join(', ')}]; unexpected [${unexpected.join(', ')}]`);
  }
}

function validate(tarball) {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!packageJson.bin || typeof packageJson.bin !== 'object' || Array.isArray(packageJson.bin)) {
    fail('package.json must declare its commands in a bin object');
  }
  const commands = Object.keys(packageJson.bin).filter(
    (command) => !command.endsWith('-acp') && !nonInteractiveBins.has(command)
  );
  if (!commands.includes('codemie')) fail('package.json is missing the codemie command');
  if (commands.some((command) => !/^[a-z0-9][a-z0-9-]*$/.test(command))) {
    fail('An interactive package command has an unsafe or unsupported name');
  }

  const manifestBytes = readBuiltFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (!manifest || typeof manifest !== 'object' || !manifest.files || typeof manifest.files !== 'object') {
    fail('Invalid completion manifest');
  }
  const manifestCommands = requireUniqueStrings(manifest.commands, 'manifest.commands');
  assertSameMembers(manifestCommands, commands, 'manifest command coverage');
  assertSameMembers(Object.keys(manifest.files), shells, 'manifest shells');

  const expectedFiles = {
    bash: commands.map((command) => `bash/${command}.bash`),
    zsh: commands.map((command) => `zsh/_${command}`),
    fish: commands.map((command) => `fish/${command}.fish`),
  };
  const paths = [manifestPath, helperPath];
  for (const shell of shells) {
    const files = requireUniqueStrings(manifest.files[shell], `manifest.files.${shell}`);
    assertSameMembers(files, expectedFiles[shell], `${shell} completion coverage`);
    paths.push(...files.map((file) => `dist/completions/${file}`));
  }

  for (const command of commands) {
    const zsh = readBuiltFile(`dist/completions/zsh/_${command}`).toString('utf8');
    const compdef = zsh.split(/\r?\n/)[0];
    if (!/^#compdef\s/.test(compdef)) fail(`Zsh completion for ${command} is missing its #compdef declaration`);
    const zshCommands = requireUniqueStrings(compdef.trim().split(/\s+/).slice(1), `zsh #compdef for ${command}`);
    assertSameMembers(zshCommands, [command], `zsh #compdef coverage for ${command}`);
  }

  // Inspect without extracting: the tarball is the exact artifact that will be published.
  const archive = resolve(tarball);
  const options = { maxBuffer: 64 * 1024 * 1024 };
  const entries = execFileSync('tar', ['-tzf', archive], options).toString('utf8').split('\n');
  for (const path of paths) {
    const entry = `package/${path}`;
    if (entries.filter((item) => item === entry).length !== 1) {
      fail(`Tarball must contain exactly one ${entry}`);
    }
    const packed = execFileSync('tar', ['-xOzf', archive, '--', entry], options);
    const built = readBuiltFile(path);
    if (!packed.equals(built)) fail(`Packed file differs from build output: ${entry}`);
  }
  process.stdout.write(`Validated ${commands.length} commands and ${paths.length} files in ${archive}\n`);
}

try {
  if (process.argv.length !== 3) fail('Usage: node scripts/validate-completion-artifacts.mjs <package.tgz>');
  validate(process.argv[2]);
} catch (error) {
  process.stderr.write(`Completion artifact validation failed: ${error.message}\n`);
  process.exitCode = 1;
}
