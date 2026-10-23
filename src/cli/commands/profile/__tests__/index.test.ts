import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildProfileSelectionChoiceName, renderProfileSelectionUI, createProfileCommand } from '../index.js';
import { ProfileDisplay } from '../display.js';
import { ProfileSelectionCancelledError } from '../command-error.js';

vi.mock('../../../../utils/config.js', () => ({
  ConfigLoader: {
    listProfiles: vi.fn(),
    hasLocalConfig: vi.fn(),
    resolveProfileWorkspace: vi.fn(),
    getActiveProfileName: vi.fn(),
    load: vi.fn(),
    enableFallbackWarning: vi.fn(),
    switchProfile: vi.fn(),
    deleteProfile: vi.fn(),
    getProfileScope: vi.fn(),
    renameProfile: vi.fn(),
  },
}));

vi.mock('chalk', () => ({
  default: {
    dim: (str: string) => `[dim]${str}[/dim]`,
    white: (str: string) => `[white]${str}[/white]`,
    cyan: (str: string) => `[cyan]${str}[/cyan]`,
    yellow: (str: string) => `[yellow]${str}[/yellow]`,
    red: (str: string) => `[red]${str}[/red]`,
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

  it('displays each profile with the codeMieUrl of its own scope workspace', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    (ConfigLoader.listProfiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'team', active: true, profile: { provider: 'ai-run-sso' }, source: 'local' },
      { name: 'personal', active: false, profile: { provider: 'ai-run-sso' }, source: 'global' },
    ]);
    (ConfigLoader.hasLocalConfig as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (ConfigLoader.resolveProfileWorkspace as ReturnType<typeof vi.fn>).mockImplementation(
      async (_workingDir: string, isLocalProfile: boolean) => ({
        codeMieUrl: isLocalProfile ? 'https://local-workspace-url' : 'https://global-workspace-url',
      })
    );

    const formatSpy = vi.spyOn(ProfileDisplay, 'format');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const command = createProfileCommand();
      await command.parseAsync([], { from: 'user' });

      expect(formatSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'team' }),
        'https://local-workspace-url'
      );
      expect(formatSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'personal' }),
        'https://global-workspace-url'
      );
    } finally {
      logSpy.mockRestore();
      formatSpy.mockRestore();
    }
  });
});

describe('profile command errors', () => {
  async function loadConfigLoader() {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    return ConfigLoader as unknown as Record<string, ReturnType<typeof vi.fn>>;
  }

  function spyExit() {
    return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('delete prints the red reason and exits 1', async () => {
    const ConfigLoader = await loadConfigLoader();
    ConfigLoader.getProfileScope.mockRejectedValue(new Error('Profile "nope" not found. Available profiles: work'));
    const exitSpy = spyExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(createProfileCommand().parseAsync(['delete', 'nope', '--yes'], { from: 'user' }))
      .rejects.toThrow('process.exit:1');

    expect(errorSpy).toHaveBeenCalledWith(
      '[red]✗ Failed to delete profile: Profile "nope" not found. Available profiles: work[/red]'
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rename prints the red reason on failure', async () => {
    const ConfigLoader = await loadConfigLoader();
    ConfigLoader.renameProfile.mockRejectedValue(new Error('Profile "b" already exists in global config'));
    spyExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(createProfileCommand().parseAsync(['rename', 'a', 'b'], { from: 'user' }))
      .rejects.toThrow('process.exit:1');

    expect(errorSpy).toHaveBeenCalledWith('[red]✗ Failed to rename profile: Profile "b" already exists in global config[/red]');
  });

  it('rename success names the scope', async () => {
    const ConfigLoader = await loadConfigLoader();
    ConfigLoader.renameProfile.mockResolvedValue('local');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProfileCommand().parseAsync(['rename', 'a', 'b'], { from: 'user' });

    expect(ConfigLoader.renameProfile).toHaveBeenCalledWith('a', 'b', process.cwd());
    expect(logSpy).toHaveBeenCalledWith('[green]\n✓ Profile "a" renamed to "b" in local config\n[/green]');
  });

  it('switch cancellation prints Cancelled. and exits 0', async () => {
    const ConfigLoader = await loadConfigLoader();
    ConfigLoader.switchProfile.mockRejectedValue(new ProfileSelectionCancelledError());
    const exitSpy = spyExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(createProfileCommand().parseAsync(['switch', 'work'], { from: 'user' }))
      .rejects.toThrow('process.exit:0');

    expect(logSpy).toHaveBeenCalledWith('[yellow]\nCancelled.\n[/yellow]');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('delete success prints the owning scope', async () => {
    const ConfigLoader = await loadConfigLoader();
    ConfigLoader.getProfileScope.mockResolvedValue('global');
    ConfigLoader.deleteProfile.mockResolvedValue('global');
    ConfigLoader.listProfiles.mockResolvedValue([{ name: 'team', active: true, profile: { provider: 'sso' }, source: 'local' }]);
    ConfigLoader.getActiveProfileName.mockResolvedValue('team');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProfileCommand().parseAsync(['delete', 'personal', '--yes'], { from: 'user' });

    expect(ConfigLoader.deleteProfile).toHaveBeenCalledWith('personal', process.cwd());
    expect(logSpy).toHaveBeenCalledWith('[green]\n✓ Profile "personal" deleted from global config\n[/green]');
  });

  it('status prints the red reason and exits 1', async () => {
    const ConfigLoader = await loadConfigLoader();
    ConfigLoader.load.mockRejectedValue(new Error('Local config x has an unsupported format (invalid JSON); it was left unchanged.'));
    spyExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(createProfileCommand().parseAsync(['status'], { from: 'user' })).rejects.toThrow('process.exit:1');

    expect(errorSpy).toHaveBeenCalledWith(
      '[red]✗ Failed to get profile status: Local config x has an unsupported format (invalid JSON); it was left unchanged.[/red]'
    );
  });

  it('Ctrl+C in an inquirer prompt prints Cancelled. and exits 0', async () => {
    const ConfigLoader = await loadConfigLoader();
    const exitPromptError = Object.assign(new Error('User force closed the prompt with 0 null'), { name: 'ExitPromptError' });
    ConfigLoader.switchProfile.mockRejectedValue(exitPromptError);
    const exitSpy = spyExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(createProfileCommand().parseAsync(['switch', 'work'], { from: 'user' }))
      .rejects.toThrow('process.exit:0');

    expect(logSpy).toHaveBeenCalledWith('[yellow]\nCancelled.\n[/yellow]');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('enables the fallback warning for profile subcommands', async () => {
    const ConfigLoader = await loadConfigLoader();
    ConfigLoader.renameProfile.mockResolvedValue('global');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProfileCommand().parseAsync(['rename', 'a', 'b'], { from: 'user' });

    expect(ConfigLoader.enableFallbackWarning).toHaveBeenCalled();
  });
});
