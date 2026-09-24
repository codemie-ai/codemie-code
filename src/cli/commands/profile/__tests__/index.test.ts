import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildProfileSelectionChoiceName, renderProfileSelectionUI, createProfileCommand } from '../index.js';
import { ProfileDisplay } from '../display.js';

vi.mock('../../../../utils/config.js', () => ({
  ConfigLoader: {
    listProfiles: vi.fn(),
    hasLocalConfig: vi.fn(),
    resolveWorkspace: vi.fn(),
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

describe('ProfileDisplay — workspace-resolved codeMieUrl', () => {
  it('format() renders the workspace codeMieUrl even when the profile itself has none', () => {
    const output = ProfileDisplay.format(
      { name: 'personal', active: true, profile: { provider: 'ai-run-sso' }, source: 'global' },
      'https://workspace-url'
    );

    expect(output).toContain('https://workspace-url');
  });

  it('formatStatus() renders the workspace codeMieUrl even when the profile itself has none', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      ProfileDisplay.formatStatus(
        { name: 'personal', active: true, profile: { provider: 'ai-run-sso' }, source: 'global' },
        undefined,
        'https://workspace-url'
      );

      const rendered = logSpy.mock.calls.map(call => call.join(' ')).join('\n');
      expect(rendered).toContain('https://workspace-url');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('listProfiles — workspace-resolved codeMieUrl display', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('displays the workspace-resolved codeMieUrl for the profile list, not a per-profile one', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    (ConfigLoader.listProfiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'personal', active: true, profile: { provider: 'ai-run-sso' }, source: 'global' },
    ]);
    (ConfigLoader.hasLocalConfig as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (ConfigLoader.resolveWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue({
      codeMieUrl: 'https://workspace-url',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const command = createProfileCommand();
      await command.parseAsync([], { from: 'user' });

      const rendered = logSpy.mock.calls.map(call => call.join(' ')).join('\n');
      expect(rendered).toContain('https://workspace-url');
    } finally {
      logSpy.mockRestore();
    }
  });
});
