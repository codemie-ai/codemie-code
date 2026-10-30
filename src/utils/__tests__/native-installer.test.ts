import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../processes.js', () => ({ exec: vi.fn() }));
vi.mock('../windows-path.js', () => ({ ensureCommandInPath: vi.fn() }));
vi.mock('../logger.js', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('fs/promises', () => ({ rm: vi.fn().mockResolvedValue(undefined) }));

import {
	buildInstallerCommand,
	buildPowerShellInstallerArgs,
	isPowerShellInstallerUrl,
	describeWindowsPowerShellFailure,
	installNativeAgent,
} from '../native-installer.js';
import { exec } from '../processes.js';
import { rm } from 'fs/promises';
import { AgentInstallationError } from '../errors.js';

const claudeUrls = {
	macOS: 'https://claude.ai/install.sh',
	windows: 'https://claude.ai/install.cmd',
	linux: 'https://claude.ai/install.sh',
};
const kimiUrls = {
	macOS: 'https://code.kimi.com/kimi-code/install.sh',
	windows: 'https://code.kimi.com/kimi-code/install.ps1',
	linux: 'https://code.kimi.com/kimi-code/install.sh',
};

const execMock = vi.mocked(exec);
const rmMock = vi.mocked(rm);
const originalPlatform = process.platform;
function setPlatform(p: string) {
	Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => {
	setPlatform(originalPlatform);
});

describe('buildInstallerCommand', () => {
	it('keeps the Windows batch command byte-identical', () => {
		expect(buildInstallerCommand('claude', claudeUrls, '2.0.30', 'windows', ['--force'])).toBe(
			'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd 2.0.30 --force && del install.cmd'
		);
	});

	it('keeps macOS/linux commands unchanged', () => {
		expect(buildInstallerCommand('claude', claudeUrls, '2.0.30', 'macOS', ['--force'])).toBe(
			'curl -fsSL https://claude.ai/install.sh | bash -s -- 2.0.30 --force'
		);
		expect(buildInstallerCommand('claude', claudeUrls, undefined, 'linux')).toBe(
			'curl -fsSL https://claude.ai/install.sh | bash'
		);
	});
});

describe('PowerShell installer helpers', () => {
	it('detects .ps1 urls only', () => {
		expect(isPowerShellInstallerUrl(kimiUrls.windows)).toBe(true);
		expect(isPowerShellInstallerUrl('https://claude.ai/install.cmd')).toBe(false);
		expect(isPowerShellInstallerUrl('https://claude.ai/install.sh')).toBe(false);
	});

	it('builds PowerShell args without cmd syntax', () => {
		const args = buildPowerShellInstallerArgs(kimiUrls.windows);
		expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
		const script = args[5];
		expect(script).toContain(kimiUrls.windows);
		expect(script).toContain('[codemie-step:download]');
		expect(script).toContain('[codemie-step:run]');
		expect(script).not.toMatch(/cmd|&&|curl|del /);
	});

	it('rejects non-https and quote-containing urls', () => {
		expect(() => buildPowerShellInstallerArgs('http://x.com/a.ps1')).toThrow(AgentInstallationError);
		expect(() => buildPowerShellInstallerArgs("https://x.com/a'.ps1")).toThrow(AgentInstallationError);
	});
});

describe('installNativeAgent on Windows with PowerShell installer', () => {
	beforeEach(() => setPlatform('win32'));

	it('runs powershell without a shell and passes KIMI_VERSION merged onto process env', async () => {
		execMock.mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
		await installNativeAgent('kimi', kimiUrls, '0.42.0', { versionEnvVar: 'KIMI_VERSION' });

		const call = execMock.mock.calls[0];
		expect(call[0]).toBe('powershell');
		expect(call[1]).toContain('-NoProfile');
		expect(call[2]).toMatchObject({ shell: false });
		const env = (call[2] as { env: Record<string, string> }).env;
		expect(env.PATH ?? env.Path).toBeTruthy();
		expect(env.KIMI_VERSION).toBe('0.42.0');
		expect(JSON.stringify(call)).not.toContain('install.cmd');
	});

	it.each([undefined, 'latest', 'stable'])('does not set KIMI_VERSION for %s', async (v) => {
		execMock.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
		await installNativeAgent('kimi', kimiUrls, v, { versionEnvVar: 'KIMI_VERSION' });
		const env = (execMock.mock.calls[0][2] as { env: Record<string, string> }).env;
		expect(env.KIMI_VERSION).toBeUndefined();
	});

	it('reports download step failures', async () => {
		execMock.mockResolvedValue({ code: 1, stdout: '[codemie-step:download] boom', stderr: '' });
		const p = installNativeAgent('kimi', kimiUrls, undefined, { versionEnvVar: 'KIMI_VERSION' });
		await expect(p).rejects.toThrow(AgentInstallationError);
		await expect(p).rejects.toThrow(/download/i);
	});

	it('reports run step failures with cleanup guidance', async () => {
		execMock.mockResolvedValue({ code: 1, stdout: '[codemie-step:run] boom', stderr: '' });
		const p = installNativeAgent('kimi', kimiUrls, undefined, {});
		await expect(p).rejects.toThrow(/\.kimi-code\\bin/);
		await expect(p).rejects.toThrow(/\.bak/);
	});

	it('does not retry on execution policy output', async () => {
		execMock.mockResolvedValue({ code: 1, stdout: '', stderr: 'PSSecurityException' });
		await expect(installNativeAgent('kimi', kimiUrls, undefined, {})).rejects.toThrow(AgentInstallationError);
		expect(execMock).toHaveBeenCalledTimes(1);
	});

	it('does not remove install.cmd on the PowerShell path', async () => {
		execMock.mockResolvedValue({ code: 1, stdout: '', stderr: 'x' });
		await expect(installNativeAgent('kimi', kimiUrls, undefined, {})).rejects.toThrow();
		expect(rmMock).not.toHaveBeenCalled();
	});
});

describe('describeWindowsPowerShellFailure', () => {
	it('includes exit code and output when no marker', () => {
		const msg = describeWindowsPowerShellFailure('weird output', 7, kimiUrls.windows);
		expect(msg).toContain('7');
		expect(msg).toContain('weird output');
	});
});

describe('batch path temp file cleanup', () => {
	it('removes install.cmd after a failed exec on Windows', async () => {
		setPlatform('win32');
		execMock.mockResolvedValue({ code: 1, stdout: '', stderr: 'fail' });
		await expect(installNativeAgent('claude', claudeUrls, undefined, {})).rejects.toThrow();
		expect(rmMock).toHaveBeenCalledWith(expect.stringMatching(/install\.cmd$/), { force: true });
	});

	it('removes install.cmd when exec throws', async () => {
		setPlatform('win32');
		execMock.mockRejectedValue(new Error('spawn fail'));
		await expect(installNativeAgent('claude', claudeUrls, undefined, {})).rejects.toThrow();
		expect(rmMock).toHaveBeenCalledWith(expect.stringMatching(/install\.cmd$/), { force: true });
	});

	it('does not touch files on linux', async () => {
		setPlatform('linux');
		execMock.mockResolvedValue({ code: 1, stdout: '', stderr: 'fail' });
		await expect(installNativeAgent('claude', claudeUrls, undefined, {})).rejects.toThrow();
		expect(rmMock).not.toHaveBeenCalled();
	});
});
