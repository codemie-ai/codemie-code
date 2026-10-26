/**
 * client-install-step unit tests
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client-install.js', () => {
  class ClientInstallError extends Error {
    constructor(message: string, public readonly downloadPage: string) {
      super(message);
      this.name = 'ClientInstallError';
    }
  }
  const mk = (app: string, label: string) => ({
    app,
    label,
    downloadPage: `https://dl.example/${app}`,
    resolve: vi.fn().mockResolvedValue({ url: `https://dl.example/${app}.zip`, size: 5 * 1024 * 1024 }),
  });
  return {
    ClientInstallError,
    CLIENT_SPECS: {
      'claude-desktop': mk('claude-desktop', 'Claude Desktop'),
      'codex-desktop': mk('codex-desktop', 'ChatGPT (Codex)'),
      vscode: mk('vscode', 'VS Code'),
    },
    findInstalledClient: vi.fn(),
    installClient: vi.fn(),
  };
});
vi.mock('../../../../utils/exec.js', () => ({ exec: vi.fn() }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../connectors/vscode.js', () => ({
  getVsCodeProductDir: vi.fn().mockReturnValue('/home/u/Library/Application Support/Code'),
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

const realPlatform = process.platform;
const realTty = process.stdin.isTTY;

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
function setTty(v: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
}

async function load() {
  const step = await import('../client-install-step.js');
  const ci = await import('../client-install.js');
  const { exec } = await import('../../../../utils/exec.js');
  const { mkdir } = await import('node:fs/promises');
  const inquirer = (await import('inquirer')).default;
  return { step, ci, exec: vi.mocked(exec), mkdir: vi.mocked(mkdir), prompt: vi.mocked(inquirer.prompt) };
}

describe('ensureClientsInstalled', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('darwin');
    setTty(true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    setPlatform(realPlatform);
    setTty(realTty);
  });

  it('does nothing when the app is already installed', async () => {
    const { step, ci, prompt } = await load();
    vi.mocked(ci.findInstalledClient).mockReturnValue('/Applications/Claude.app');

    const r = await step.ensureClientsInstalled({ claudeDesktop: true }, {});

    expect(r).toBe('proceed');
    expect(ci.installClient).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('installs a missing app after the user confirms', async () => {
    const { step, ci, prompt } = await load();
    vi.mocked(ci.findInstalledClient).mockReturnValue(null);
    vi.mocked(ci.installClient).mockResolvedValue('/u/Applications/Claude.app');
    prompt.mockResolvedValue({ confirm: true } as never);

    const r = await step.ensureClientsInstalled({ claudeDesktop: true }, {});

    expect(r).toBe('proceed');
    const msg = (prompt.mock.calls[0][0] as unknown as Array<{ message: string; default: boolean }>)[0];
    expect(msg.message).toContain('Claude Desktop (5.0 MB)');
    expect(msg.default).toBe(false);
    expect(ci.installClient).toHaveBeenCalledWith(
      ci.CLIENT_SPECS['claude-desktop'],
      { download: { url: 'https://dl.example/claude-desktop.zip', size: 5 * 1024 * 1024 } }
    );
  });

  it('omits the size when the download size is unknown', async () => {
    const { step, ci, prompt } = await load();
    vi.mocked(ci.findInstalledClient).mockReturnValue(null);
    vi.mocked(ci.CLIENT_SPECS['claude-desktop'].resolve).mockResolvedValueOnce({ url: 'u' });
    vi.mocked(ci.installClient).mockResolvedValue('/p');
    prompt.mockResolvedValue({ confirm: true } as never);

    await step.ensureClientsInstalled({ claudeDesktop: true }, {});

    const msg = (prompt.mock.calls[0][0] as unknown as Array<{ message: string }>)[0].message;
    expect(msg).not.toContain('undefined');
    expect(msg).not.toContain('(');
  });

  it('returns cancelled and installs nothing when the user declines', async () => {
    const { step, ci, prompt } = await load();
    vi.mocked(ci.findInstalledClient).mockReturnValue(null);
    prompt.mockResolvedValue({ confirm: false } as never);

    const r = await step.ensureClientsInstalled({ claudeDesktop: true }, {});

    expect(r).toBe('cancelled');
    expect(ci.installClient).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Install cancelled'));
  });

  it('skips the prompt with yes', async () => {
    const { step, ci, prompt } = await load();
    vi.mocked(ci.findInstalledClient).mockReturnValue(null);
    vi.mocked(ci.installClient).mockResolvedValue('/p');

    await step.ensureClientsInstalled({ codexDesktop: true }, { yes: true });

    expect(prompt).not.toHaveBeenCalled();
    expect(ci.installClient).toHaveBeenCalledTimes(1);
  });

  it('throws without a TTY and without yes', async () => {
    const { step, ci } = await load();
    const { ConfigurationError } = await import('../../../../utils/errors.js');
    setTty(false);
    vi.mocked(ci.findInstalledClient).mockReturnValue(null);

    await expect(step.ensureClientsInstalled({ claudeDesktop: true }, {})).rejects.toThrow(ConfigurationError);
    await expect(step.ensureClientsInstalled({ claudeDesktop: true }, {})).rejects.toThrow('--yes');
    expect(ci.installClient).not.toHaveBeenCalled();
  });

  it('wraps a failing resolve into a ClientInstallError with the download page', async () => {
    const { step, ci } = await load();
    vi.mocked(ci.findInstalledClient).mockReturnValue(null);
    vi.mocked(ci.CLIENT_SPECS['claude-desktop'].resolve).mockRejectedValueOnce(new Error('ENOTFOUND'));

    const err = await step.ensureClientsInstalled({ claudeDesktop: true }, { yes: true }).catch((e) => e);

    expect(err).toBeInstanceOf(ci.ClientInstallError);
    expect(err.message).toContain('Claude Desktop');
    expect(err.message).toContain('ENOTFOUND');
    expect(err.message).toContain('Check your connection');
    expect(err.downloadPage).toBe(ci.CLIENT_SPECS['claude-desktop'].downloadPage);
    expect(ci.installClient).not.toHaveBeenCalled();
  });

  it('installs VS Code once for vscode + vscodeClaudeCode and the extension only for the latter', async () => {
    const { step, ci, exec, mkdir } = await load();
    vi.mocked(ci.findInstalledClient).mockReturnValue(null);
    vi.mocked(ci.installClient).mockResolvedValue('/u/Applications/Visual Studio Code.app');
    exec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await step.ensureClientsInstalled({ vscode: true, vscodeClaudeCode: true }, { yes: true });

    expect(ci.installClient).toHaveBeenCalledTimes(1);
    expect(mkdir).toHaveBeenCalledWith('/home/u/Library/Application Support/Code', { recursive: true });
    expect(exec).toHaveBeenCalledWith(
      '/u/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      ['--install-extension', 'anthropic.claude-code'],
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('does not install the extension for --vscode alone but still creates the Code dir', async () => {
    const { step, ci, exec, mkdir } = await load();
    vi.mocked(ci.findInstalledClient).mockReturnValue('/Applications/Visual Studio Code.app');

    await step.ensureClientsInstalled({ vscode: true }, {});

    expect(exec).not.toHaveBeenCalled();
    expect(mkdir).toHaveBeenCalledTimes(1);
  });

  it('throws a ClientInstallError with the VS Code page when the extension install fails', async () => {
    const { step, ci, exec } = await load();
    vi.mocked(ci.findInstalledClient).mockReturnValue('/Applications/Visual Studio Code.app');
    exec.mockResolvedValue({ code: 1, stdout: '', stderr: 'bad thing\nmore' });

    const err = await step.ensureClientsInstalled({ vscodeClaudeCode: true }, {}).catch((e) => e);

    expect(err).toBeInstanceOf(ci.ClientInstallError);
    expect(err.message).toContain('Could not install the Claude Code extension in VS Code: bad thing');
    expect(err.message).not.toContain('more');
    expect(err.downloadPage).toBe(ci.CLIENT_SPECS.vscode.downloadPage);
  });

  it('reports a Code folder it cannot create as a ClientInstallError', async () => {
    const { step, ci, mkdir } = await load();
    vi.mocked(ci.findInstalledClient).mockReturnValue('/Applications/Visual Studio Code.app');
    mkdir.mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

    const err = await step.ensureClientsInstalled({ vscode: true }, {}).catch((e) => e);

    expect(err).toBeInstanceOf(ci.ClientInstallError);
    expect(err.message).toContain('EACCES');
    expect(err.downloadPage).toBe(ci.CLIENT_SPECS.vscode.downloadPage);
  });

  it('reports an extension install that hangs as a ClientInstallError', async () => {
    const { step, ci, exec } = await load();
    vi.mocked(ci.findInstalledClient).mockReturnValue('/Applications/Visual Studio Code.app');
    exec.mockRejectedValue(new Error('Command timed out after 300000ms'));

    const err = await step.ensureClientsInstalled({ vscodeClaudeCode: true }, {}).catch((e) => e);

    expect(err).toBeInstanceOf(ci.ClientInstallError);
    expect(err.message).toContain('timed out');
    expect(err.downloadPage).toBe(ci.CLIENT_SPECS.vscode.downloadPage);
  });

  it('aborts before downloading anything when any app is declined', async () => {
    const { step, ci, prompt } = await load();
    vi.mocked(ci.findInstalledClient).mockReturnValue(null);
    prompt.mockResolvedValueOnce({ confirm: true } as never).mockResolvedValueOnce({ confirm: false } as never);

    const r = await step.ensureClientsInstalled({ claudeDesktop: true, codexDesktop: true }, {});

    expect(r).toBe('cancelled');
    expect(ci.installClient).not.toHaveBeenCalled();
  });
});

describe('assertInstallClientSupported', () => {
  it('passes on darwin', async () => {
    const { step } = await load();
    expect(() => step.assertInstallClientSupported({}, 'darwin')).not.toThrow();
  });

  it.each(['win32', 'linux'] as const)('rejects %s', async (p) => {
    const { step } = await load();
    expect(() => step.assertInstallClientSupported({}, p)).toThrow('macOS');
  });

  it('rejects --insiders', async () => {
    const { step } = await load();
    expect(() => step.assertInstallClientSupported({ insiders: true }, 'darwin')).toThrow('--insiders');
  });
});
