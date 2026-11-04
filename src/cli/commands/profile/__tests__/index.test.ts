import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildProfileSelectionChoiceName, renderProfileSelectionUI, createProfileCommand } from '../index.js';
import { ProfileDisplay } from '../display.js';

vi.mock('../../../../utils/config.js', () => ({
  ConfigLoader: {
    listProfiles: vi.fn(),
    hasLocalConfig: vi.fn(),
    resolveProfileIdentity: vi.fn(),
    getActiveProfileName: vi.fn(),
    load: vi.fn(),
  },
}));

vi.mock('chalk', () => ({
  default: {
    dim: (str: string) => `[dim]${str}[/dim]`,
    white: (str: string) => `[white]${str}[/white]`,
    cyan: (str: string) => `[cyan]${str}[/cyan]`,
    yellow: (str: string) => `[yellow]${str}[/yellow]`,
    green: Object.assign(
      (str: string) => `[green]${str}[/green]`,
      { bold: (str: string) => `[green][bold]${str}[/bold][/green]` }
    ),
    black: (str: string) => `[black]${str}[/black]`,
    bold: Object.assign(
      vi.fn((str: string) => `[bold]${str}[/bold]`),
      { cyan: (str: string) => `[bold][cyan]${str}[/cyan][/bold]` }
    ),
    bgRgb: vi.fn(() => ({
      black: (str: string) => `[bg-purple][black]${str}[/black][/bg-purple]`,
    })),
    rgb: vi.fn(() => {
      const fn = (str: string) => `[purple]${str}[/purple]`;
      fn.bold = (str: string) => `[purple][bold]${str}[/bold][/purple]`;
      return fn;
    }),
  },
}));

describe('profile command helpers', () => {
  it('aligns active and inactive profile selection choices with stable marker gutters', () => {
    const active = buildProfileSelectionChoiceName({
      name: 'default',
      provider: 'sso',
      source: 'local',
      isActive: true,
    });
    const inactive = buildProfileSelectionChoiceName({
      name: 'work',
      provider: 'bedrock',
      source: 'global',
      isActive: false,
    });

    expect(active).toBe('  [green]●[/green] [green][bold]default[/bold][/green] [dim](sso)[/dim][yellow] [Local][/yellow]');
    expect(inactive).toBe('  [white]○[/white] [white]work[/white] [dim](bedrock)[/dim][cyan] [Global][/cyan]');
  });

  it('renders profile selection with the custom selection UI instead of Inquirer markers', () => {
    const output = renderProfileSelectionUI({
      message: 'Select profile to switch to:',
      profiles: [
        {
          name: 'novartis',
          active: false,
          profile: { provider: 'ai-run-sso' },
          source: 'global',
        },
        {
          name: 'personal',
          active: true,
          profile: { provider: 'ai-run-sso' },
          source: 'global',
        },
      ],
      cursorIndex: 0,
    });

    expect(output).not.toContain('? Select profile');
    expect(output).not.toContain('❯');
    expect(output).toContain('[purple]› [/purple][white]○[/white] [white]novartis[/white] [dim](ai-run-sso)[/dim][cyan] [Global][/cyan]');
    expect(output).toContain('  [green]●[/green] [green][bold]personal[/bold][/green] [dim](ai-run-sso)[/dim][cyan] [Global][/cyan]');
  });
});

describe('ProfileDisplay — resolved identity', () => {
  it('format() renders the resolved codeMieUrl and project even when the profile record has none', () => {
    const output = ProfileDisplay.format(
      { name: 'personal', active: true, profile: { provider: 'ai-run-sso' }, source: 'global' },
      { codeMieUrl: 'https://workspace-url', project: 'shared-proj (shared fallback)' }
    );

    expect(output).toContain('https://workspace-url');
    expect(output).toContain('Project');
    expect(output).toContain('shared-proj (shared fallback)');
  });

  it('format() shows no Project line when the provider has no CodeMie project', () => {
    const output = ProfileDisplay.format(
      { name: 'local-llm', active: false, profile: { provider: 'ollama' }, source: 'global' },
      { codeMieUrl: undefined, project: undefined }
    );

    expect(output).not.toContain('Project');
  });

  it('formatStatus() renders the resolved codeMieUrl and project', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      ProfileDisplay.formatStatus(
        { name: 'personal', active: true, profile: { provider: 'ai-run-sso' }, source: 'global' },
        undefined,
        { codeMieUrl: 'https://workspace-url', project: 'mtlx-csd' }
      );

      const rendered = logSpy.mock.calls.map(call => call.join(' ')).join('\n');
      expect(rendered).toContain('https://workspace-url');
      expect(rendered).toContain('mtlx-csd');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('listProfiles — per-profile resolved identity display (AC8)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves each profile by its own name and shows its own project and state', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    (ConfigLoader.listProfiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'mtlx-amsd', active: true, profile: { provider: 'ai-run-sso' }, source: 'global' },
      { name: 'mtlx-csd', active: false, profile: { provider: 'ai-run-sso' }, source: 'global' },
      { name: 'personal', active: false, profile: { provider: 'anthropic-subscription' }, source: 'global' },
      { name: 'legacy', active: false, profile: { provider: 'ai-run-sso' }, source: 'global' },
    ]);
    (ConfigLoader.hasLocalConfig as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const byName: Record<string, unknown> = {
      'mtlx-amsd': { state: 'own', identity: { codeMieUrl: 'https://same', codeMieProject: 'mtlx-amsd' } },
      'mtlx-csd': { state: 'own', identity: { codeMieUrl: 'https://same', codeMieProject: 'mtlx-csd' } },
      personal: { state: 'none', identity: {} },
      legacy: { state: 'unowned', identity: { codeMieUrl: 'https://same', codeMieProject: 'mtlx-amsd' } },
    };
    (ConfigLoader.resolveProfileIdentity as ReturnType<typeof vi.fn>).mockImplementation(
      async (_workingDir: string, name: string) => byName[name]
    );

    const formatSpy = vi.spyOn(ProfileDisplay, 'format');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const command = createProfileCommand();
      await command.parseAsync([], { from: 'user' });

      expect(formatSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'mtlx-amsd' }),
        { codeMieUrl: 'https://same', project: 'mtlx-amsd' }
      );
      expect(formatSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'mtlx-csd' }),
        { codeMieUrl: 'https://same', project: 'mtlx-csd' }
      );
      expect(formatSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'personal' }),
        { codeMieUrl: undefined, project: 'off CodeMie' }
      );
      expect(formatSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'legacy' }),
        { codeMieUrl: 'https://same', project: 'mtlx-amsd (shared fallback)' }
      );
    } finally {
      logSpy.mockRestore();
      formatSpy.mockRestore();
    }
  });
});
