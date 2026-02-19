import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as execModule from '../exec.js';

describe('windows-path', () => {
	let execSpy: ReturnType<typeof vi.spyOn>;
	const originalPlatform = process.platform;

	beforeEach(() => {
		execSpy = vi.spyOn(execModule, 'exec');
		// Mock Windows platform
		Object.defineProperty(process, 'platform', {
			value: 'win32',
			configurable: true,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// Restore original platform
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			configurable: true,
		});
	});

	describe('findCommandDirectory', () => {
		it('should find command directory from where output', async () => {
			execSpy.mockResolvedValue({
				code: 0,
				stdout: 'C:\\Users\\Test\\AppData\\Local\\Programs\\Claude\\claude.exe\n',
				stderr: '',
			});

			const { findCommandDirectory } = await import('../windows-path.js');
			const result = await findCommandDirectory('claude');

			expect(result).toBe('C:\\Users\\Test\\AppData\\Local\\Programs\\Claude');
			// Verify full path to where.exe is used
			expect(execSpy).toHaveBeenCalledWith(
				expect.stringContaining('\\where.exe'),
				['claude'],
				{ timeout: 5000 }
			);
		});

		it('should return null if command not found', async () => {
			execSpy.mockResolvedValue({
				code: 1,
				stdout: '',
				stderr: 'INFO: Could not find files for the given pattern(s).\n',
			});

			const { findCommandDirectory } = await import('../windows-path.js');
			const result = await findCommandDirectory('nonexistent');

			expect(result).toBeNull();
		});

		it('should return null on non-Windows platform', async () => {
			Object.defineProperty(process, 'platform', {
				value: 'darwin',
				configurable: true,
			});

			const { findCommandDirectory } = await import('../windows-path.js');
			const result = await findCommandDirectory('claude');

			expect(result).toBeNull();
			expect(execSpy).not.toHaveBeenCalled();
		});

		it('should handle multiple paths and return first', async () => {
			execSpy.mockResolvedValue({
				code: 0,
				stdout:
					'C:\\Program Files\\Claude\\claude.exe\nC:\\Users\\Test\\claude.exe\n',
				stderr: '',
			});

			const { findCommandDirectory } = await import('../windows-path.js');
			const result = await findCommandDirectory('claude');

			expect(result).toBe('C:\\Program Files\\Claude');
		});

		it('should handle paths with dots (.local style paths)', async () => {
			execSpy.mockResolvedValue({
				code: 0,
				stdout: 'C:\\Users\\Mykyta_Ponikarov\\.local\\bin\\claude.exe\n',
				stderr: '',
			});

			const { findCommandDirectory } = await import('../windows-path.js');
			const result = await findCommandDirectory('claude');

			expect(result).toBe('C:\\Users\\Mykyta_Ponikarov\\.local\\bin');
			expect(execSpy).toHaveBeenCalledWith(
				expect.stringContaining('\\where.exe'),
				['claude'],
				{ timeout: 5000 }
			);
		});

		it('should handle paths with underscores in usernames', async () => {
			execSpy.mockResolvedValue({
				code: 0,
				stdout: 'C:\\Users\\Test_User_123\\.local\\bin\\claude.exe\n',
				stderr: '',
			});

			const { findCommandDirectory } = await import('../windows-path.js');
			const result = await findCommandDirectory('claude');

			expect(result).toBe('C:\\Users\\Test_User_123\\.local\\bin');
		});
	});

	describe('isInUserPath', () => {
		it('should detect if directory is in PATH', async () => {
			execSpy.mockResolvedValue({
				code: 0,
				stdout:
					'PATH    REG_EXPAND_SZ    C:\\Users\\Test\\bin;C:\\Program Files\\Claude;C:\\Windows\n',
				stderr: '',
			});

			const { isInUserPath } = await import('../windows-path.js');
			const result = await isInUserPath('C:\\Program Files\\Claude');

			expect(result).toBe(true);
			// Verify full path to reg.exe is used
			expect(execSpy).toHaveBeenCalledWith(
				expect.stringContaining('\\reg.exe'),
				['query', 'HKCU\\Environment', '/v', 'PATH'],
				{ timeout: 5000 }
			);
		});

		it('should handle case-insensitive matching', async () => {
			execSpy.mockResolvedValue({
				code: 0,
				stdout:
					'PATH    REG_EXPAND_SZ    c:\\program files\\claude;c:\\windows\n',
				stderr: '',
			});

			const { isInUserPath } = await import('../windows-path.js');
			const result = await isInUserPath('C:\\Program Files\\Claude');

			expect(result).toBe(true);
		});

		it('should handle trailing backslashes', async () => {
			execSpy.mockResolvedValue({
				code: 0,
				stdout: 'PATH    REG_EXPAND_SZ    C:\\Program Files\\Claude\\\n',
				stderr: '',
			});

			const { isInUserPath } = await import('../windows-path.js');
			const result = await isInUserPath('C:\\Program Files\\Claude\\\\');

			expect(result).toBe(true);
		});

		it('should return false if directory not in PATH', async () => {
			execSpy.mockResolvedValue({
				code: 0,
				stdout: 'PATH    REG_EXPAND_SZ    C:\\Windows;C:\\Windows\\System32\n',
				stderr: '',
			});

			const { isInUserPath } = await import('../windows-path.js');
			const result = await isInUserPath('C:\\Program Files\\Claude');

			expect(result).toBe(false);
		});

		it('should return false on non-Windows platform', async () => {
			Object.defineProperty(process, 'platform', {
				value: 'linux',
				configurable: true,
			});

			const { isInUserPath } = await import('../windows-path.js');
			const result = await isInUserPath('/usr/local/bin');

			expect(result).toBe(false);
			expect(execSpy).not.toHaveBeenCalled();
		});
	});

	describe('addToUserPath', () => {
		it('should add directory to PATH', async () => {
			// Mock reg query (get current PATH)
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'PATH    REG_EXPAND_SZ    C:\\Windows;C:\\Windows\\System32\n',
				stderr: '',
			});

			// Mock setx (set new PATH)
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'SUCCESS: Specified value was saved.\n',
				stderr: '',
			});

			const { addToUserPath } = await import('../windows-path.js');
			const result = await addToUserPath('C:\\Program Files\\Claude');

			expect(result.success).toBe(true);
			expect(result.requiresRestart).toBe(true);
			expect(result.pathAdded).toBe('C:\\Program Files\\Claude');
			expect(result.alreadyInPath).toBe(false);

			// Verify full paths are used for security
			expect(execSpy).toHaveBeenCalledWith(
				expect.stringContaining('\\reg.exe'),
				['query', 'HKCU\\Environment', '/v', 'PATH'],
				{ timeout: 5000 }
			);
			expect(execSpy).toHaveBeenCalledWith(
				expect.stringContaining('\\setx.exe'),
				['PATH', 'C:\\Windows;C:\\Windows\\System32;C:\\Program Files\\Claude'],
				{ timeout: 10000 }
			);
		});

		it('should handle empty current PATH', async () => {
			// Mock reg query with no PATH
			execSpy.mockResolvedValueOnce({
				code: 1,
				stdout: '',
				stderr: 'ERROR: The system was unable to find the specified registry key or value.\n',
			});

			// Mock setx
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'SUCCESS: Specified value was saved.\n',
				stderr: '',
			});

			const { addToUserPath } = await import('../windows-path.js');
			const result = await addToUserPath('C:\\Program Files\\Claude');

			expect(result.success).toBe(true);
			expect(result.alreadyInPath).toBe(false);
			expect(execSpy).toHaveBeenCalledWith(
				expect.stringContaining('\\setx.exe'),
				['PATH', 'C:\\Program Files\\Claude'],
				{ timeout: 10000 }
			);
		});

		it('should detect and skip duplicate entries', async () => {
			// Mock reg query with directory already in PATH
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'PATH    REG_EXPAND_SZ    C:\\Program Files\\Claude;C:\\Windows\n',
				stderr: '',
			});

			const { addToUserPath } = await import('../windows-path.js');
			const result = await addToUserPath('C:\\Program Files\\Claude');

			expect(result.success).toBe(true);
			expect(result.requiresRestart).toBe(true);
			expect(result.alreadyInPath).toBe(true);
			// Should not call setx if already in PATH
			expect(execSpy).toHaveBeenCalledTimes(1);
		});

		it('should reject relative paths', async () => {
			const { addToUserPath } = await import('../windows-path.js');
			const result = await addToUserPath('relative\\path');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid directory path');
			expect(result.alreadyInPath).toBe(false);
			expect(execSpy).not.toHaveBeenCalled();
		});

		it('should reject paths with shell metacharacters', async () => {
			const { addToUserPath } = await import('../windows-path.js');

			const maliciousPaths = [
				'C:\\test & calc.exe',
				'C:\\test | whoami',
				'C:\\test; echo hi',
				'C:\\test && dir',
				'C:\\test > output.txt',
				'C:\\test < input.txt',
				'C:\\test ^ test2',
				'C:\\test (malicious)'
			];

			for (const path of maliciousPaths) {
				const result = await addToUserPath(path);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Invalid directory path');
				expect(result.alreadyInPath).toBe(false);
			}

			expect(execSpy).not.toHaveBeenCalled();
		});

		it('should accept paths with dots and underscores (safe characters)', async () => {
			// Mock reg query (get current PATH)
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'PATH    REG_EXPAND_SZ    C:\\Windows\n',
				stderr: '',
			});

			// Mock setx (set new PATH)
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'SUCCESS: Specified value was saved.\n',
				stderr: '',
			});

			const { addToUserPath } = await import('../windows-path.js');
			const result = await addToUserPath('C:\\Users\\Test_User\\.local\\bin');

			expect(result.success).toBe(true);
			expect(result.pathAdded).toBe('C:\\Users\\Test_User\\.local\\bin');
			expect(result.requiresRestart).toBe(true);
			expect(result.alreadyInPath).toBe(false);

			// Verify the path with dots and underscores was added correctly
			expect(execSpy).toHaveBeenCalledWith(
				expect.stringContaining('\\setx.exe'),
				['PATH', 'C:\\Windows;C:\\Users\\Test_User\\.local\\bin'],
				{ timeout: 10000 }
			);
		});

		it('should reject PATH exceeding 1024 character limit', async () => {
			// Create a very long PATH
			const longPath = 'C:\\' + 'a'.repeat(1000);

			// Mock reg query with existing PATH
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: `PATH    REG_EXPAND_SZ    ${longPath}\n`,
				stderr: '',
			});

			const { addToUserPath } = await import('../windows-path.js');
			const result = await addToUserPath('C:\\Program Files\\Claude');

			expect(result.success).toBe(false);
			expect(result.error).toContain('PATH too long');
			expect(result.error).toContain('1024');
			expect(result.alreadyInPath).toBe(false);
			// Should only call reg query, not setx
			expect(execSpy).toHaveBeenCalledTimes(1);
		});

		it('should return error on non-Windows platform', async () => {
			Object.defineProperty(process, 'platform', {
				value: 'darwin',
				configurable: true,
			});

			const { addToUserPath } = await import('../windows-path.js');
			const result = await addToUserPath('/usr/local/bin');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Not Windows platform');
			expect(result.requiresRestart).toBe(false);
			expect(result.alreadyInPath).toBe(false);
			expect(execSpy).not.toHaveBeenCalled();
		});

		it('should handle setx failure', async () => {
			// Mock reg query
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'PATH    REG_EXPAND_SZ    C:\\Windows\n',
				stderr: '',
			});

			// Mock setx failure
			execSpy.mockResolvedValueOnce({
				code: 1,
				stdout: '',
				stderr: 'ERROR: Invalid syntax.\n',
			});

			const { addToUserPath } = await import('../windows-path.js');
			const result = await addToUserPath('C:\\Program Files\\Claude');

			expect(result.success).toBe(false);
			expect(result.error).toContain('setx failed');
			expect(result.requiresRestart).toBe(false);
			expect(result.alreadyInPath).toBe(false);
		});
	});

	describe('ensureCommandInPath', () => {
		it('should add command to PATH if not present', async () => {
			// Mock where command
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'C:\\Program Files\\Claude\\claude.exe\n',
				stderr: '',
			});

			// Mock reg query (check if in PATH)
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'PATH    REG_EXPAND_SZ    C:\\Windows\n',
				stderr: '',
			});

			// Mock reg query for addToUserPath (get current PATH)
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'PATH    REG_EXPAND_SZ    C:\\Windows\n',
				stderr: '',
			});

			// Mock setx
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'SUCCESS: Specified value was saved.\n',
				stderr: '',
			});

			const { ensureCommandInPath } = await import('../windows-path.js');
			const result = await ensureCommandInPath('claude');

			expect(result.success).toBe(true);
			expect(result.pathAdded).toBe('C:\\Program Files\\Claude');
			expect(result.requiresRestart).toBe(true);
			expect(result.alreadyInPath).toBe(false);
		});

		it('should return success if already in PATH', async () => {
			// Mock where command
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'C:\\Program Files\\Claude\\claude.exe\n',
				stderr: '',
			});

			// Mock reg query (already in PATH)
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'PATH    REG_EXPAND_SZ    C:\\Program Files\\Claude;C:\\Windows\n',
				stderr: '',
			});

			const { ensureCommandInPath } = await import('../windows-path.js');
			const result = await ensureCommandInPath('claude');

			expect(result.success).toBe(true);
			expect(result.requiresRestart).toBe(true);
			expect(result.alreadyInPath).toBe(true);
			// Should not call setx if already in PATH
			expect(execSpy).toHaveBeenCalledTimes(2);
		});

		it('should return error if command not found', async () => {
			// Mock where command failure
			execSpy.mockResolvedValueOnce({
				code: 1,
				stdout: '',
				stderr: 'INFO: Could not find files for the given pattern(s).\n',
			});

			const { ensureCommandInPath } = await import('../windows-path.js');
			const result = await ensureCommandInPath('nonexistent');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Could not locate');
			expect(result.requiresRestart).toBe(false);
			expect(result.alreadyInPath).toBe(false);
		});

		it('should return error on non-Windows platform', async () => {
			Object.defineProperty(process, 'platform', {
				value: 'linux',
				configurable: true,
			});

			const { ensureCommandInPath } = await import('../windows-path.js');
			const result = await ensureCommandInPath('claude');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Not Windows platform');
			expect(result.requiresRestart).toBe(false);
			expect(result.alreadyInPath).toBe(false);
			expect(execSpy).not.toHaveBeenCalled();
		});

		it('should handle .local/bin style paths correctly', async () => {
			// Mock where command finding Claude in .local/bin
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'C:\\Users\\Mykyta_Ponikarov\\.local\\bin\\claude.exe\n',
				stderr: '',
			});

			// Mock reg query (check if in PATH) - not in PATH yet
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'PATH    REG_EXPAND_SZ    C:\\Windows;C:\\Windows\\System32\n',
				stderr: '',
			});

			// Mock reg query for addToUserPath (get current PATH)
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'PATH    REG_EXPAND_SZ    C:\\Windows;C:\\Windows\\System32\n',
				stderr: '',
			});

			// Mock setx
			execSpy.mockResolvedValueOnce({
				code: 0,
				stdout: 'SUCCESS: Specified value was saved.\n',
				stderr: '',
			});

			const { ensureCommandInPath } = await import('../windows-path.js');
			const result = await ensureCommandInPath('claude');

			expect(result.success).toBe(true);
			expect(result.pathAdded).toBe('C:\\Users\\Mykyta_Ponikarov\\.local\\bin');
			expect(result.requiresRestart).toBe(true);
			expect(result.alreadyInPath).toBe(false);

			// Verify the .local/bin path was added correctly
			expect(execSpy).toHaveBeenCalledWith(
				expect.stringContaining('\\setx.exe'),
				['PATH', 'C:\\Windows;C:\\Windows\\System32;C:\\Users\\Mykyta_Ponikarov\\.local\\bin'],
				{ timeout: 10000 }
			);
		});
	});
});
