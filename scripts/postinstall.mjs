#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { posix as pathPosix } from 'node:path';

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
