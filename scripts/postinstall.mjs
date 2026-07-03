#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
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

export async function runWindows() {
	const prefix = getNpmPrefix();
	if (!prefix) return;

	const dir = getShimDir(prefix, 'win32');

	const missing = findMissingShims(dir, getExpectedShimNames());
	if (missing.length > 0) {
		console.warn(`\n⚠️  Expected CodeMie command shims not found in ${dir}: ${missing.join(', ')}\n`);
	}

	let isInUserPath, addToUserPath;
	try {
		({ isInUserPath, addToUserPath } = await import('../dist/utils/windows-path.js'));
	} catch (error) {
		console.warn(`\n⚠️  Could not load the windows-path PATH helper (dist/ may not be built yet): ${error.message}\n`);
		return;
	}

	let alreadyInPath;
	try {
		alreadyInPath = await isInUserPath(dir);
	} catch (error) {
		console.warn(`\n⚠️  Could not check the windows-path PATH helper: ${error.message}\n`);
		return;
	}
	if (alreadyInPath) return;

	let result;
	try {
		result = await addToUserPath(dir);
	} catch (error) {
		console.warn(`\n⚠️  Could not use the windows-path PATH helper: ${error.message}\n`);
		return;
	}

	if (result.success) {
		console.log(`\n✓ Added ${dir} to PATH\n  Open a new terminal to use codemie\n`);
		return;
	}

	console.error(`\n✗ Could not update PATH automatically: ${result.error}`);
	console.error(`  Add manually: setx PATH "%PATH%;${dir}"`);
	console.error(`  (or via System Properties > Environment Variables)\n`);
	process.exitCode = 1;
}

export function runUnix(plat = platform()) {
	const prefix = getNpmPrefix();
	if (!prefix) return;

	const npmBin = getShimDir(prefix, plat);
	if (isInPath(npmBin, plat === 'win32' ? ';' : ':')) return;

	const rcFile = getShellRcFile();
	if (!rcFile) {
		console.log(`\n⚠️  Add to PATH manually:\n   export PATH="${npmBin}:$PATH"\n`);
		return;
	}

	if (alreadyInRcFile(rcFile, npmBin)) return;

	appendFileSync(rcFile, `\n# Added by @codemieai/code\nexport PATH="${npmBin}:$PATH"\n`);

	console.log(`\n✓ Added ${npmBin} to PATH in ${rcFile}`);
	console.log(`  Run: source ${rcFile}\n`);
}

export async function run() {
	if (platform() === 'win32') {
		await runWindows();
	} else {
		runUnix();
	}
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	await run();
}
