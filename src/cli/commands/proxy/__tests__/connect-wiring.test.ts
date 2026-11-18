/**
 * Unified `proxy connect` command wiring tests (Task 4).
 * The orchestrator is mocked here so these tests assert only the CLI surface:
 * target-flag mapping, deprecated-flag notices, removed-alias stubs, and option exposure.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('../disconnect-orchestrator.js', () => ({
  disconnectTargets: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../disconnect-all.js', () => ({
  disconnectAll: vi.fn().mockResolvedValue({ disconnected: [], failed: [] }),
  stopDaemonAfterDisconnect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../connect-orchestrator.js', () => ({
  connectTargets: vi.fn().mockResolvedValue(undefined),
  // Symbols index.ts imports for other proxy subcommands (unused by these tests).
  DEFAULT_DAEMON_PORT: 4001,
  daemonMatchesRequest: vi.fn(),
  verifySsoCredentials: vi.fn(),
  printProxyError: vi.fn(),
}));

describe('proxy connect — unified command, deprecated flags and removed aliases', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('unified connect maps target flags to a ConnectTargets set', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(
      ['connect', '--claude-desktop', '--vscode', '--vscode-claude-code'],
      { from: 'user' }
    );

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: {
          claudeCodeOtlp: false,
          copilotChatOtlp: false,
          copilotCliOtlp: false,
          claudeDesktop: true,
          vscode: true,
          vscodeClaudeCode: true,
          codexDesktop: false,
          omp: false,
        },
      })
    );
  });

  it('leaves an omitted --scope undefined so the orchestrator can detect it', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(
      ['connect', '--claude-code-otlp'],
      { from: 'user' }
    );

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: expect.objectContaining({ claudeCodeOtlp: true }),
        scope: undefined,
        yes: false,
        restartDaemon: false,
        overwrite: false,
      })
    );
  });

  it('forwards an explicit --scope project as the opt-in Project scope', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(
      ['connect', '--claude-code-otlp', '--scope', 'project'],
      { from: 'user' }
    );

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'project' })
    );
  });

  it('maps --yes, --restart-daemon and --overwrite onto the connect options', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(
      ['connect', '--claude-code-otlp', '--yes', '--restart-daemon', '--overwrite'],
      { from: 'user' }
    );

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({ yes: true, restartDaemon: true, overwrite: true })
    );
  });

  it('--restart-daemon alone replaces the daemon without overwriting foreign config', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['connect', '--omp', '--restart-daemon'], { from: 'user' });

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({ restartDaemon: true, overwrite: false })
    );
  });

  it('deprecated --force acts as --restart-daemon --overwrite and prints one notice naming both', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { connectTargets } = await import('../connect-orchestrator.js');
      const { createProxyCommand } = await import('../index.js');

      await createProxyCommand().parseAsync(['connect', '--omp', '--force'], { from: 'user' });

      expect(connectTargets).toHaveBeenCalledWith(
        expect.objectContaining({ restartDaemon: true, overwrite: true })
      );
      const lines = stderr.mock.calls.map((c) => String(c[0])).join('').split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('codemie proxy connect --force');
      expect(lines[0]).toContain('--restart-daemon');
      expect(lines[0]).toContain('--overwrite');
    } finally {
      stderr.mockRestore();
    }
  });

  it('deprecated --silent acts as --yes and prints one notice naming --yes', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { connectTargets } = await import('../connect-orchestrator.js');
      const { createProxyCommand } = await import('../index.js');

      await createProxyCommand().parseAsync(['connect', '--claude-code-otlp', '--silent'], { from: 'user' });

      expect(connectTargets).toHaveBeenCalledWith(expect.objectContaining({ yes: true }));
      const lines = stderr.mock.calls.map((c) => String(c[0])).join('').split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('codemie proxy connect --silent');
      expect(lines[0]).toContain('codemie proxy connect --yes');
    } finally {
      stderr.mockRestore();
    }
  });

  it('hides --force and --silent from connect help and keeps them off start and disconnect', async () => {
    const { createProxyCommand } = await import('../index.js');
    const proxy = createProxyCommand();
    const option = (name: string, long: string) =>
      proxy.commands.find((c) => c.name() === name)?.options.find((o) => o.long === long);

    expect(option('connect', '--force')?.hidden).toBe(true);
    expect(option('connect', '--silent')?.hidden).toBe(true);
    expect(option('connect', '--yes')?.hidden).toBe(false);
    expect(option('start', '--silent')).toBeUndefined();
    expect(option('disconnect', '--silent')).toBeUndefined();
    expect(option('disconnect', '--force')).toBeUndefined();
  });

  it('forwards an explicitly selected Claude Code analytics scope', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(
      ['connect', '--claude-code-otlp', '--scope', 'user'],
      { from: 'user' }
    );

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: expect.objectContaining({ claudeCodeOtlp: true }),
        scope: 'user',
      })
    );
  });

  it('the removed `connect desktop` / `connect vscode` stubs are hidden from help', async () => {
    const { createProxyCommand } = await import('../index.js');
    const connect = createProxyCommand().commands.find((c) => c.name() === 'connect');
    const help = connect?.helpInformation() ?? '';

    expect(help).not.toMatch(/^\s+desktop\b/m);
    expect(help).not.toMatch(/^\s+vscode\b/m);
  });
});

// The real CLI mounts `proxy` under a root `program`. The removed aliases must fail naming their replacement
// under that nesting too, with any options (here `--profile x`), never with a Commander "unknown option" error.
describe('removed `connect desktop` / `connect vscode` aliases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    consoleLogSpy.mockRestore();
    process.exitCode = undefined;
  });

  async function rootWithProxy(): Promise<Command> {
    const { createProxyCommand } = await import('../index.js');
    // A bare root program, like src/cli/index.ts, with NO enablePositionalOptions.
    const root = new Command();
    root.exitOverride();
    root.addCommand(createProxyCommand());
    return root;
  }

  const stderrText = (): string => stderrSpy.mock.calls.map((c) => String(c[0])).join('');

  it.each([
    [['proxy', 'connect', 'desktop', '--profile', 'x'], 'codemie proxy connect --claude-desktop'],
    [['proxy', 'connect', 'desktop', '--profile', 'x', '--force', '--bogus'], 'codemie proxy connect --claude-desktop'],
    [['proxy', 'connect', 'vscode', '--profile', 'x', '--insiders'], 'codemie proxy connect --vscode'],
    [['proxy', 'connect', 'vscode'], 'codemie proxy connect --vscode'],
  ])('`%s` fails naming %s, exit code 1, nothing connected', async (argv, replacement) => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const root = await rootWithProxy();

    await root.parseAsync(argv, { from: 'user' });

    expect(stderrText()).toContain(replacement);
    expect(stderrText()).toContain('Removed:');
    expect(stderrText()).not.toMatch(/unknown option/i);
    expect(process.exitCode).toBe(1);
    expect(connectTargets).not.toHaveBeenCalled();
  });

  async function rootWithProxyForUnified(): Promise<Command> {
    const { createProxyCommand } = await import('../index.js');
    const root = new Command();
    root.addCommand(createProxyCommand());
    return root;
  }

  it('unified `proxy connect --vscode --profile p` still forwards flags under nesting', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const root = await rootWithProxyForUnified();

    await root.parseAsync(
      ['proxy', 'connect', '--vscode', '--profile', 'p'],
      { from: 'user' }
    );

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: {
          claudeCodeOtlp: false,
          copilotChatOtlp: false,
          copilotCliOtlp: false,
          claudeDesktop: false,
          vscode: true,
          vscodeClaudeCode: false,
          codexDesktop: false,
          omp: false,
        },
        profile: 'p',
      })
    );
  });
});

describe('proxy connect --copilot-chat-otlp / --copilot-cli-otlp and proxy disconnect', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  it('maps --copilot-chat-otlp onto the connect targets, routed to the Chat connector only', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['connect', '--copilot-chat-otlp'], { from: 'user' });

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: expect.objectContaining({ copilotChatOtlp: true, copilotCliOtlp: false }),
      })
    );
  });

  it('maps --copilot-cli-otlp onto the connect targets, routed to the CLI connector only', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['connect', '--copilot-cli-otlp'], { from: 'user' });

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: expect.objectContaining({ copilotChatOtlp: false, copilotCliOtlp: true }),
      })
    );
  });

  it('maps --copilot-chat-otlp --copilot-cli-otlp --scope project onto both connector targets', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(
      ['connect', '--copilot-chat-otlp', '--copilot-cli-otlp', '--scope', 'project'],
      { from: 'user' }
    );

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: expect.objectContaining({ copilotChatOtlp: true, copilotCliOtlp: true }),
        scope: 'project',
      })
    );
  });

  it('routes `proxy disconnect --copilot-chat-otlp` to disconnectTargets', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['disconnect', '--copilot-chat-otlp'], { from: 'user' });

    expect(disconnectTargets).toHaveBeenCalledWith({
      scope: undefined,
      insiders: false,
      aggregates: [],
      targets: {
        claudeCodeOtlp: false,
        copilotChatOtlp: true,
        copilotCliOtlp: false,
        claudeDesktop: false,
        vscodeClaudeCode: false,
        vscode: false,
        codexDesktop: false,
        omp: false,
      },
    });
  });

  it('routes `proxy disconnect --copilot-cli-otlp --scope project` to disconnectTargets', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['disconnect', '--copilot-cli-otlp', '--scope', 'project'], { from: 'user' });

    expect(disconnectTargets).toHaveBeenCalledWith({
      scope: 'project',
      insiders: false,
      aggregates: [],
      targets: {
        claudeCodeOtlp: false,
        copilotChatOtlp: false,
        copilotCliOtlp: true,
        claudeDesktop: false,
        vscodeClaudeCode: false,
        vscode: false,
        codexDesktop: false,
        omp: false,
      },
    });
  });
});

describe('proxy connect --codex-desktop and proxy disconnect', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  it('maps --codex-desktop and --model onto the connect options', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(
      ['connect', '--codex-desktop', '--model', 'gpt-5-codex'],
      { from: 'user' }
    );

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: expect.objectContaining({ codexDesktop: true }),
        model: 'gpt-5-codex',
      })
    );
  });

  it('routes `proxy disconnect --codex-desktop` to disconnectTargets', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['disconnect', '--codex-desktop'], { from: 'user' });

    expect(disconnectTargets).toHaveBeenCalledWith({
      scope: undefined,
      insiders: false,
      aggregates: [],
      targets: {
        claudeCodeOtlp: false,
        copilotChatOtlp: false,
        copilotCliOtlp: false,
        claudeDesktop: false,
        vscodeClaudeCode: false,
        vscode: false,
        codexDesktop: true,
        omp: false,
      },
    });
  });

  it('maps `proxy connect --omp` onto targets.omp', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['connect', '--omp'], { from: 'user' });

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({ targets: expect.objectContaining({ omp: true }) })
    );
  });

  it('routes `proxy disconnect --omp` to disconnectTargets', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['disconnect', '--omp'], { from: 'user' });

    expect(disconnectTargets).toHaveBeenCalledWith({
      scope: undefined,
      insiders: false,
      aggregates: [],
      targets: {
        claudeCodeOtlp: false,
        copilotChatOtlp: false,
        copilotCliOtlp: false,
        claudeDesktop: false,
        vscodeClaudeCode: false,
        vscode: false,
        codexDesktop: false,
        omp: true,
      },
    });
  });

  it('routes `proxy disconnect --claude-desktop` to disconnectTargets', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['disconnect', '--claude-desktop'], { from: 'user' });

    expect(disconnectTargets).toHaveBeenCalledWith({
      scope: undefined,
      insiders: false,
      aggregates: [],
      targets: {
        claudeCodeOtlp: false,
        copilotChatOtlp: false,
        copilotCliOtlp: false,
        claudeDesktop: true,
        vscodeClaudeCode: false,
        vscode: false,
        codexDesktop: false,
        omp: false,
      },
    });
  });

  it('routes `proxy disconnect --vscode-claude-code --insiders` to disconnectTargets', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['disconnect', '--vscode-claude-code', '--insiders'], { from: 'user' });

    expect(disconnectTargets).toHaveBeenCalledWith({
      scope: undefined,
      insiders: true,
      aggregates: [],
      targets: {
        claudeCodeOtlp: false,
        copilotChatOtlp: false,
        copilotCliOtlp: false,
        claudeDesktop: false,
        vscodeClaudeCode: true,
        vscode: false,
        codexDesktop: false,
        omp: false,
      },
    });
  });

  it('routes `proxy disconnect --vscode --insiders` to disconnectTargets', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['disconnect', '--vscode', '--insiders'], { from: 'user' });

    expect(disconnectTargets).toHaveBeenCalledWith(expect.objectContaining({
      insiders: true,
      targets: expect.objectContaining({ vscode: true, vscodeClaudeCode: false }),
    }));
  });

  it('`disconnect <target> --stop` stops the daemon once; without --stop it does not', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');
    const { stopDaemonAfterDisconnect } = await import('../disconnect-all.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(disconnectTargets).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await createProxyCommand().parseAsync(['disconnect', '--claude-desktop', '--stop'], { from: 'user' });
    expect(stopDaemonAfterDisconnect).toHaveBeenCalledTimes(1);

    vi.mocked(stopDaemonAfterDisconnect).mockClear();
    await createProxyCommand().parseAsync(['disconnect', '--claude-desktop'], { from: 'user' });
    expect(stopDaemonAfterDisconnect).not.toHaveBeenCalled();
  });

  it('`disconnect --stop` with no target is a usage error and leaves the daemon running', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');
    const { stopDaemonAfterDisconnect } = await import('../disconnect-all.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(disconnectTargets).mockImplementationOnce(async () => {
      process.exitCode = 1;
      return false;
    });
    try {
      await createProxyCommand().parseAsync(['disconnect', '--stop'], { from: 'user' });
      expect(stopDaemonAfterDisconnect).not.toHaveBeenCalled();
    } finally {
      process.exitCode = undefined;
    }
  });

  describe('Next line', () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    let written: string[];

    beforeEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      written = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    });

    afterEach(() => {
      if (original) Object.defineProperty(process.stdout, 'isTTY', original);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      vi.mocked(process.stdout.write).mockRestore();
      process.exitCode = undefined;
    });

    it('after connecting an analytics connector names proxy doctor', async () => {
      const { createProxyCommand } = await import('../index.js');

      await createProxyCommand().parseAsync(['connect', '--claude-code-otlp'], { from: 'user' });

      expect(written.join('')).toBe('Next: codemie proxy doctor\n');
    });

    it('is not printed after a failed connect', async () => {
      const { connectTargets } = await import('../connect-orchestrator.js');
      const { createProxyCommand } = await import('../index.js');
      vi.mocked(connectTargets).mockImplementationOnce(async () => {
        process.exitCode = 1;
      });

      await createProxyCommand().parseAsync(['connect'], { from: 'user' });

      expect(written.join('')).not.toContain('Next:');
    });

    it('after disconnect --all names proxy clients', async () => {
      const { createProxyCommand } = await import('../index.js');

      await createProxyCommand().parseAsync(['disconnect', '--all'], { from: 'user' });

      expect(written.join('')).toBe('Next: codemie proxy clients\n');
    });
  });

  it('`proxy disconnect --all --scope project` warns that --scope is ignored and disconnects all', async () => {
    const { disconnectAll } = await import('../disconnect-all.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { createProxyCommand } = await import('../index.js');

      await createProxyCommand().parseAsync(['disconnect', '--all', '--scope', 'project'], { from: 'user' });

      expect(disconnectAll).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('--scope has no effect with --all'));
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('proxy connect / disconnect --claude-otlp and --copilot-otlp', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  const CLAUDE_MEMBERS = {
    claudeDesktop: true,
    vscodeClaudeCode: true,
    claudeCodeOtlp: true,
    copilotChatOtlp: false,
    copilotCliOtlp: false,
    vscode: false,
    codexDesktop: false,
    omp: false,
  };

  async function connectWith(args: string[]): Promise<unknown> {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');
    await createProxyCommand().parseAsync(['connect', ...args], { from: 'user' });
    return vi.mocked(connectTargets).mock.calls[0][0];
  }

  it('connect --claude-otlp sets the three Claude members, names the aggregate and hands no scope', async () => {
    const call = await connectWith(['--claude-otlp']);

    expect(call).toEqual(expect.objectContaining({ targets: CLAUDE_MEMBERS, aggregates: ['claude-otlp'] }));
    expect(call).toHaveProperty('scope', undefined);
  });

  it('connect --copilot-otlp sets the two Copilot members', async () => {
    const call = await connectWith(['--copilot-otlp']);

    expect(call).toEqual(expect.objectContaining({
      targets: {
        claudeDesktop: false,
        vscodeClaudeCode: false,
        claudeCodeOtlp: false,
        copilotChatOtlp: true,
        copilotCliOtlp: true,
        vscode: false,
        codexDesktop: false,
        omp: false,
      },
      aggregates: ['copilot-otlp'],
    }));
  });

  it('connect --copilot-otlp --claude-otlp sets the five members, the aggregates in their declared order', async () => {
    const call = await connectWith(['--copilot-otlp', '--claude-otlp']);

    expect(call).toEqual(expect.objectContaining({
      targets: { ...CLAUDE_MEMBERS, copilotChatOtlp: true, copilotCliOtlp: true },
      aggregates: ['claude-otlp', 'copilot-otlp'],
    }));
  });

  it('connect --claude-otlp --claude-desktop is the same call as connect --claude-otlp', async () => {
    const alone = await connectWith(['--claude-otlp']);
    vi.clearAllMocks();

    expect(await connectWith(['--claude-otlp', '--claude-desktop'])).toEqual(alone);
  });

  it.each([['user'], ['project']])('connect --claude-otlp --scope %s hands the typed scope', async (scope) => {
    const call = await connectWith(['--claude-otlp', '--scope', scope]);

    expect(call).toEqual(expect.objectContaining({ scope, aggregates: ['claude-otlp'] }));
  });

  it('connect --claude-otlp hands an omitted scope as undefined, for the orchestrator to keep project lists', async () => {
    const call = await connectWith(['--claude-otlp']);

    expect(call).toEqual(expect.objectContaining({ aggregates: ['claude-otlp'], scope: undefined }));
  });

  it('connect --claude-code-otlp hands no aggregate and an omitted scope as undefined', async () => {
    const call = await connectWith(['--claude-code-otlp']);

    expect(call).toEqual(expect.objectContaining({ aggregates: [], scope: undefined }));
  });

  it('connect --claude-otlp forwards --yes, --overwrite, --restart-daemon, --insiders and --profile', async () => {
    const call = await connectWith(['--claude-otlp', '--yes', '--overwrite', '--restart-daemon', '--insiders', '--profile', 'work']);

    expect(call).toEqual(expect.objectContaining({
      yes: true, overwrite: true, restartDaemon: true, insiders: true, profile: 'work',
    }));
  });

  it('connect --claude-otlp takes the deprecated --silent and --force with their old meanings', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const call = await connectWith(['--claude-otlp', '--silent', '--force']);

      expect(call).toEqual(expect.objectContaining({ yes: true, overwrite: true, restartDaemon: true }));
    } finally {
      stderr.mockRestore();
    }
  });

  it('disconnect --claude-otlp sets the three Claude members', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['disconnect', '--claude-otlp'], { from: 'user' });

    expect(disconnectTargets).toHaveBeenCalledWith({
      scope: undefined,
      insiders: false,
      aggregates: ['claude-otlp'],
      targets: {
        claudeDesktop: true,
        vscodeClaudeCode: true,
        claudeCodeOtlp: true,
        copilotChatOtlp: false,
        copilotCliOtlp: false,
        vscode: false,
        codexDesktop: false,
        omp: false,
      },
    });
  });

  it('disconnect --copilot-otlp --scope project sets the two Copilot members with scope project', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['disconnect', '--copilot-otlp', '--scope', 'project'], { from: 'user' });

    expect(disconnectTargets).toHaveBeenCalledWith({
      scope: 'project',
      insiders: false,
      aggregates: ['copilot-otlp'],
      targets: {
        claudeDesktop: false,
        vscodeClaudeCode: false,
        claudeCodeOtlp: false,
        copilotChatOtlp: true,
        copilotCliOtlp: true,
        vscode: false,
        codexDesktop: false,
        omp: false,
      },
    });
  });

  it('both commands expose the two aggregates with their descriptions', async () => {
    const { createProxyCommand } = await import('../index.js');
    const proxy = createProxyCommand();
    const option = (command: string, long: string) =>
      proxy.commands.find((c) => c.name() === command)?.options.find((o) => o.long === long);

    for (const command of ['connect', 'disconnect']) {
      expect(option(command, '--claude-otlp')).toBeDefined();
      expect(option(command, '--copilot-otlp')).toBeDefined();
    }
    expect(option('connect', '--claude-otlp')?.description).toContain('through the CodeMie proxy');
    expect(option('connect', '--claude-otlp')?.description).toContain('codemie proxy disconnect --claude-otlp removes that route');
    expect(option('disconnect', '--claude-otlp')?.description).toContain('remove the CodeMie proxy route');
    expect(option('connect', '--scope')?.description).toContain('an existing project list is kept');
  });
});
