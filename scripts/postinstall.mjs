#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, delimiter, dirname, posix as pathPosix } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getNpmPrefix() {
	try {
		return execSync('npm config get prefix', {
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return null;
	}
}

export function getShimDir(prefix, plat = platform()) {
	// posix.join (not the OS-native join) so this is correct regardless of which
	// OS this script itself is running on, matching how src/utils/windows-path.ts
	// uses path.win32 explicitly for its own platform-specific branch.
	return plat === 'win32' ? prefix : pathPosix.join(prefix, 'bin');
}

export function isInPath(dir, sep = delimiter) {
	// sep defaults to the real path.delimiter for actual use; the parameter exists
	// so both the ';' (win32) and ':' (posix) branches are deterministically
	// testable regardless of which OS this script itself runs on.
	return (process.env.PATH ?? '').split(sep).includes(dir);
}

export function getShellRcFile() {
	const shell = process.env.SHELL ?? '';
	const home = homedir();
	if (shell.includes('zsh')) return join(home, '.zshrc');
	if (shell.includes('bash')) {
		const bashProfile = join(home, '.bash_profile');
		return existsSync(bashProfile) ? bashProfile : join(home, '.bashrc');
	}
	return null;
}

export function alreadyInRcFile(rcFile, dir) {
	if (!existsSync(rcFile)) return false;
	return readFileSync(rcFile, 'utf8').includes(dir);
}

export function getExpectedShimNames() {
	const packageJsonPath = join(__dirname, '..', 'package.json');
	const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
	return Object.keys(pkg.bin ?? {});
}

export function findMissingShims(dir, names) {
	return names.filter((name) => !existsSync(join(dir, `${name}.cmd`)));
}
