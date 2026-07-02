import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

vi.mock('node:child_process', () => ({
	execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	appendFileSync: vi.fn(),
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
});
