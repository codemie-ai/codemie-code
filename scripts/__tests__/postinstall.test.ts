import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { isInUserPath, addToUserPath } from '../../dist/utils/windows-path.js';

vi.mock('node:child_process', () => ({
	execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	appendFileSync: vi.fn(),
}));

vi.mock('../../dist/utils/windows-path.js', () => ({
	isInUserPath: vi.fn(),
	addToUserPath: vi.fn(),
}));

describe('postinstall', () => {
	const originalPlatform = process.platform;
	const originalExitCode = process.exitCode;

	beforeEach(() => {
		vi.mocked(execSync).mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			configurable: true,
		});
		process.exitCode = originalExitCode;
	});

	describe('getNpmPrefix', () => {
		it('returns the trimmed npm prefix on success', async () => {
			vi.mocked(execSync).mockReturnValue('C:\\Users\\Test\\AppData\\Roaming\\npm\n' as unknown as Buffer);

			const { getNpmPrefix } = await import('../postinstall.mjs');
			const result = getNpmPrefix();

			expect(result).toBe('C:\\Users\\Test\\AppData\\Roaming\\npm');
			expect(execSync).toHaveBeenCalledWith(
				'npm config get prefix',
				{ encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
			);
		});

		it('returns null if npm is unavailable', async () => {
			vi.mocked(execSync).mockImplementation(() => {
				throw new Error('command not found');
			});

			const { getNpmPrefix } = await import('../postinstall.mjs');
			const result = getNpmPrefix();

			expect(result).toBeNull();
		});
	});

	describe('getShimDir', () => {
		it('returns the prefix directly on win32 (no bin/ join)', async () => {
			const { getShimDir } = await import('../postinstall.mjs');
			const result = getShimDir('C:\\Users\\Test\\AppData\\Roaming\\npm', 'win32');

			expect(result).toBe('C:\\Users\\Test\\AppData\\Roaming\\npm');
		});

		it('returns prefix/bin on non-win32 platforms', async () => {
			const { getShimDir } = await import('../postinstall.mjs');
			const result = getShimDir('/usr/local', 'darwin');

			expect(result).toBe('/usr/local/bin');
		});
	});

	describe('isInPath', () => {
		const originalPath = process.env.PATH;

		afterEach(() => {
			process.env.PATH = originalPath;
		});

		it('detects a directory using ";" on win32', async () => {
			process.env.PATH = 'C:\\Windows;C:\\Users\\Test\\AppData\\Roaming\\npm;C:\\Windows\\System32';

			const { isInPath } = await import('../postinstall.mjs');
			expect(isInPath('C:\\Users\\Test\\AppData\\Roaming\\npm', ';')).toBe(true);
			expect(isInPath('C:\\Nonexistent', ';')).toBe(false);
		});

		it('detects a directory using ":" on unix', async () => {
			process.env.PATH = '/usr/local/bin:/usr/local/lib/node/bin:/usr/bin';

			const { isInPath } = await import('../postinstall.mjs');
			expect(isInPath('/usr/local/lib/node/bin', ':')).toBe(true);
			expect(isInPath('/nonexistent', ':')).toBe(false);
		});
	});

	describe('getShellRcFile', () => {
		const originalShell = process.env.SHELL;

		afterEach(() => {
			process.env.SHELL = originalShell;
		});

		it('returns .zshrc when SHELL contains zsh', async () => {
			process.env.SHELL = '/bin/zsh';

			const { getShellRcFile } = await import('../postinstall.mjs');
			expect(getShellRcFile()).toMatch(/\.zshrc$/);
		});

		it('returns .bash_profile when it exists and SHELL contains bash', async () => {
			process.env.SHELL = '/bin/bash';
			vi.mocked(existsSync).mockReturnValue(true);

			const { getShellRcFile } = await import('../postinstall.mjs');
			expect(getShellRcFile()).toMatch(/\.bash_profile$/);
		});

		it('returns .bashrc when .bash_profile does not exist and SHELL contains bash', async () => {
			process.env.SHELL = '/bin/bash';
			vi.mocked(existsSync).mockReturnValue(false);

			const { getShellRcFile } = await import('../postinstall.mjs');
			expect(getShellRcFile()).toMatch(/\.bashrc$/);
		});

		it('returns null when SHELL is unset (Windows)', async () => {
			delete process.env.SHELL;

			const { getShellRcFile } = await import('../postinstall.mjs');
			expect(getShellRcFile()).toBeNull();
		});
	});

	describe('alreadyInRcFile', () => {
		it('returns false when the rc file does not exist', async () => {
			vi.mocked(existsSync).mockReturnValue(false);

			const { alreadyInRcFile } = await import('../postinstall.mjs');
			expect(alreadyInRcFile('/home/user/.bashrc', '/usr/local/bin')).toBe(false);
		});

		it('returns true when the rc file already contains the dir', async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue('export PATH="/usr/local/bin:$PATH"\n');

			const { alreadyInRcFile } = await import('../postinstall.mjs');
			expect(alreadyInRcFile('/home/user/.bashrc', '/usr/local/bin')).toBe(true);
		});
	});

	describe('getExpectedShimNames', () => {
		it('returns the keys of package.json bin field', async () => {
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({ bin: { codemie: './bin/codemie.js', 'codemie-claude': './bin/codemie-claude.js' } })
			);

			const { getExpectedShimNames } = await import('../postinstall.mjs');
			expect(getExpectedShimNames()).toEqual(['codemie', 'codemie-claude']);
		});
	});

	describe('findMissingShims', () => {
		it('returns names whose .cmd file does not exist in dir', async () => {
			vi.mocked(existsSync).mockImplementation((p) => !String(p).includes('codemie-claude.cmd'));

			const { findMissingShims } = await import('../postinstall.mjs');
			const result = findMissingShims('C:\\npm', ['codemie', 'codemie-claude']);

			expect(result).toEqual(['codemie-claude']);
		});

		it('returns an empty array when all shims exist', async () => {
			vi.mocked(existsSync).mockReturnValue(true);

			const { findMissingShims } = await import('../postinstall.mjs');
			const result = findMissingShims('C:\\npm', ['codemie', 'codemie-claude']);

			expect(result).toEqual([]);
		});
	});

	describe('runWindows', () => {
		beforeEach(() => {
			vi.mocked(execSync).mockReturnValue('C:\\Users\\Test\\AppData\\Roaming\\npm\n' as unknown as Buffer);
			vi.mocked(existsSync).mockReturnValue(true); // all shims present by default
		});

		it('does nothing if npm prefix cannot be determined', async () => {
			vi.mocked(execSync).mockImplementation(() => {
				throw new Error('npm not found');
			});

			const { runWindows } = await import('../postinstall.mjs');
			await runWindows();

			expect(isInUserPath).not.toHaveBeenCalled();
			expect(process.exitCode).toBeFalsy();
		});

		it('is a no-op when the shim dir is already in PATH', async () => {
			vi.mocked(isInUserPath).mockResolvedValue(true);

			const { runWindows } = await import('../postinstall.mjs');
			await runWindows();

			expect(addToUserPath).not.toHaveBeenCalled();
			expect(process.exitCode).toBeFalsy();
		});

		it('adds the shim dir to PATH when missing, and does not set a failing exit code', async () => {
			vi.mocked(isInUserPath).mockResolvedValue(false);
			vi.mocked(addToUserPath).mockResolvedValue({
				success: true,
				pathAdded: 'C:\\Users\\Test\\AppData\\Roaming\\npm',
				requiresRestart: true,
				alreadyInPath: false,
			});

			const { runWindows } = await import('../postinstall.mjs');
			await runWindows();

			expect(addToUserPath).toHaveBeenCalledWith('C:\\Users\\Test\\AppData\\Roaming\\npm');
			expect(process.exitCode).toBeFalsy();
		});

		it('sets exitCode 1 and prints manual instructions when addToUserPath fails', async () => {
			vi.mocked(isInUserPath).mockResolvedValue(false);
			vi.mocked(addToUserPath).mockResolvedValue({
				success: false,
				error: 'setx failed: access denied',
				requiresRestart: false,
				alreadyInPath: false,
			});
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const { runWindows } = await import('../postinstall.mjs');
			await runWindows();

			expect(process.exitCode).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('setx failed: access denied'));
		});

		it('warns but does not fail when expected shim files are missing', async () => {
			vi.mocked(existsSync).mockReturnValue(false); // no shims found
			vi.mocked(isInUserPath).mockResolvedValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ bin: { codemie: './bin/codemie.js' } }));
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const { runWindows } = await import('../postinstall.mjs');
			await runWindows();

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('codemie'));
			expect(process.exitCode).toBeFalsy();
		});
	});

	describe('runUnix', () => {
		beforeEach(() => {
			vi.mocked(execSync).mockReturnValue('/usr/local\n' as unknown as Buffer);
			process.env.PATH = '/usr/bin:/bin';
			process.env.SHELL = '/bin/bash';
		});

		it('does nothing if npm prefix cannot be determined', async () => {
			vi.mocked(execSync).mockImplementation(() => {
				throw new Error('npm not found');
			});

			const { runUnix } = await import('../postinstall.mjs');
			runUnix('linux');

			expect(appendFileSync).not.toHaveBeenCalled();
		});

		it('is a no-op when the shim dir is already in PATH', async () => {
			process.env.PATH = '/usr/local/bin:/usr/bin:/bin';

			const { runUnix } = await import('../postinstall.mjs');
			runUnix('linux');

			expect(appendFileSync).not.toHaveBeenCalled();
		});

		it('is a no-op when the rc file already contains the dir', async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue('export PATH="/usr/local/bin:$PATH"\n');

			const { runUnix } = await import('../postinstall.mjs');
			runUnix('linux');

			expect(appendFileSync).not.toHaveBeenCalled();
		});

		it('appends to the rc file when the dir is missing from PATH and not already recorded', async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue('# existing rc contents\n');

			const { runUnix } = await import('../postinstall.mjs');
			runUnix('linux');

			expect(appendFileSync).toHaveBeenCalledWith(
				expect.stringContaining('.bash_profile'),
				expect.stringContaining('/usr/local/bin')
			);
		});
	});
});
