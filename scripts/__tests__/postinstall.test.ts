import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
	execSync: vi.fn(),
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
});
