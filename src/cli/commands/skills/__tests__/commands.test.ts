/**
 * Command-level tests for `codemie skills {add,update,remove,list}`.
 *
 * These tests parse real Commander argv through each createXxxCommand() but
 * mock auth, the metrics emitter, and the upstream spawn. They are the most
 * useful proxy for end-to-end behavior because they verify:
 *   - argv parsing and option mapping
 *   - auth gate runs before any side effect
 *   - the right argv is passed to the upstream binary for each option combo
 *   - metric attributes match spec §8 (scope, target_agents, agent_selection_mode)
 *   - exit codes propagate from the upstream binary
 *
 * For full subprocess e2e, see `tests/integration/cli-commands/skills.test.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireAuth = vi.fn();
const mockRunSkillsCli = vi.fn();
const mockEmitStarted = vi.fn();
const mockEmitCompleted = vi.fn();
const mockEmitFailed = vi.fn();
const mockStartSkillMetric = vi.fn();
const mockInquirerPrompt = vi.fn();

vi.mock('../lib/require-auth.js', () => ({
  requireAuthenticatedSession: () => mockRequireAuth(),
}));

vi.mock('../lib/run-skills-cli.js', () => ({
  runSkillsCli: (...args: unknown[]) => mockRunSkillsCli(...args),
}));

vi.mock('../lib/skills-metrics.js', () => ({
  startSkillMetric: (...args: unknown[]) => mockStartSkillMetric(...args),
  emitStarted: (...args: unknown[]) => mockEmitStarted(...args),
  emitCompleted: (...args: unknown[]) => mockEmitCompleted(...args),
  emitFailed: (...args: unknown[]) => mockEmitFailed(...args),
}));

vi.mock('inquirer', () => ({
  default: { prompt: (...args: unknown[]) => mockInquirerPrompt(...args) },
}));

let workspace: string;
let exitSpy: ReturnType<typeof vi.spyOn>;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let exitCalls: number[];

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'codemie-skill-cmd-'));

  // process.chdir is unsupported in vitest worker threads; spoof process.cwd()
  // instead so the commands' agent detection scans the temp workspace.
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workspace);

  mockRequireAuth.mockReset().mockResolvedValue(true);
  mockRunSkillsCli.mockReset().mockResolvedValue({ code: 0, stdout: '', stderr: '', signal: null });
  mockStartSkillMetric.mockReset().mockResolvedValue({ command: 'add', sessionId: 's', agentVersion: '0', workingDirectory: workspace, transport: null });
  mockEmitStarted.mockReset().mockResolvedValue(undefined);
  mockEmitCompleted.mockReset().mockResolvedValue(undefined);
  mockEmitFailed.mockReset().mockResolvedValue(undefined);
  mockInquirerPrompt.mockReset();

  // Record every process.exit call. Production process.exit terminates the
  // process; in tests we throw so the action stops, but the wrapper's outer
  // catch will run again and call process.exit(1). The first recorded code is
  // the one the wrapper actually meant to surface.
  exitCalls = [];
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`__EXIT__:${code ?? 0}`);
  }) as never);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  exitSpy.mockRestore();
  cwdSpy.mockRestore();
  vi.resetModules();
});

async function importCommands(): Promise<typeof import('../index.js')> {
  vi.resetModules();
  return import('../index.js');
}

async function parse(argv: string[]): Promise<void> {
  const { createSkillsCommand } = await importCommands();
  const command = createSkillsCommand();
  command.exitOverride();
  await command.parseAsync(['node', 'codemie', ...argv]);
}

describe('codemie skills add', () => {
  it('passes explicit --agent through to the upstream binary verbatim (spec §11)', async () => {
    const platformSpy = vi.spyOn(os, 'platform').mockReturnValue('linux' as NodeJS.Platform);
    try {
      await parse(['add', 'owner/repo', '--skill', 'foo', '-a', 'claude-code', '-y']);
      expect(mockRequireAuth).toHaveBeenCalledOnce();
      expect(mockRunSkillsCli).toHaveBeenCalledOnce();
      const [args] = mockRunSkillsCli.mock.calls[0]!;
      expect(args).toEqual(['add', 'owner/repo', '--yes', '--skill', 'foo', '--agent', 'claude-code']);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('auto-passes --agent claude-code when only .claude/ exists (spec §4)', async () => {
    mkdirSync(path.join(workspace, '.claude'));
    await parse(['add', 'owner/repo', '-y']);
    const [args] = mockRunSkillsCli.mock.calls[0]!;
    expect(args).toContain('--agent');
    const idx = args.indexOf('--agent');
    expect(args[idx + 1]).toBe('claude-code');
  });

  it('auto-passes --agent cursor when only .cursor/ exists', async () => {
    mkdirSync(path.join(workspace, '.cursor'));
    await parse(['add', 'owner/repo', '-y']);
    const [args] = mockRunSkillsCli.mock.calls[0]!;
    const idx = args.indexOf('--agent');
    expect(args[idx + 1]).toBe('cursor');
  });

  it('does not pass --agent when no marker exists', async () => {
    await parse(['add', 'owner/repo', '-y']);
    const [args] = mockRunSkillsCli.mock.calls[0]!;
    expect(args).not.toContain('--agent');
  });

  it('does not pass --agent on multiple markers in non-interactive mode (spec §4)', async () => {
    mkdirSync(path.join(workspace, '.claude'));
    mkdirSync(path.join(workspace, '.cursor'));
    await parse(['add', 'owner/repo', '-y']);
    const [args] = mockRunSkillsCli.mock.calls[0]!;
    expect(args).not.toContain('--agent');
  });

  it('emits target_agents only when wrapper owns the selection', async () => {
    mkdirSync(path.join(workspace, '.claude'));
    await parse(['add', 'owner/repo', '-y']);

    const [, attrs] = mockEmitCompleted.mock.calls[0]!;
    expect(attrs.target_agents).toEqual(['claude-code']);
    expect(attrs.agent_selection_mode).toBe('auto_detected');
  });

  it('omits target_agents and selection_mode when wrapper falls through to upstream', async () => {
    await parse(['add', 'owner/repo', '-y']);
    const [, attrs] = mockEmitCompleted.mock.calls[0]!;
    expect(attrs.target_agents).toBeUndefined();
    expect(attrs.agent_selection_mode).toBeUndefined();
  });

  it('emits failed and exits with upstream exit code when skills CLI fails', async () => {
    mockRunSkillsCli.mockResolvedValueOnce({
      code: 7,
      stdout: '',
      stderr: 'CODEMIE_SKILL_EGRESS_BLOCKED audit attempt',
      signal: null,
    });

    await expect(parse(['add', 'owner/repo', '-y'])).rejects.toThrow(/__EXIT__:/);

    // The first exit call is the one the wrapper actually wants to surface;
    // any subsequent exit call comes from the test-only outer catch block
    // re-handling the synthetic __EXIT__ error (in production process.exit
    // would never return, so the catch block cannot run).
    expect(exitCalls[0]).toBe(7);
    expect(mockEmitFailed.mock.calls.length).toBeGreaterThanOrEqual(1);
    const [, attrs] = mockEmitFailed.mock.calls[0]!;
    expect(attrs.error_code).toBe('egress_blocked');
  });

  it('forwards --skill list to upstream args (spec §8.3 fan-out source)', async () => {
    await parse(['add', 'owner/repo', '--skill', 'a', 'b', 'c', '-y']);
    const [args] = mockRunSkillsCli.mock.calls[0]!;
    const idx = args.indexOf('--skill');
    expect(args.slice(idx + 1, idx + 4)).toEqual(['a', 'b', 'c']);
  });

  it('passes --copy when --copy is requested', async () => {
    await parse(['add', 'owner/repo', '--copy', '-y']);
    const [args] = mockRunSkillsCli.mock.calls[0]!;
    expect(args).toContain('--copy');
  });
});

describe('codemie skills update', () => {
  it('passes positional skill names to upstream', async () => {
    await parse(['update', 'foo', 'bar', '-y']);
    const [args] = mockRunSkillsCli.mock.calls[0]!;
    expect(args).toEqual(['update', '--yes', 'foo', 'bar']);
  });

  it('forwards --global and --project flags', async () => {
    await parse(['update', '--global', '-y']);
    const [args] = mockRunSkillsCli.mock.calls[0]!;
    expect(args).toContain('--global');
    expect(args).toContain('--yes');
  });

  it('reports scope=unknown when neither --global nor --project is set', async () => {
    await parse(['update', 'foo', '-y']);
    const [, attrs] = mockEmitCompleted.mock.calls[0]!;
    expect(attrs.scope).toBe('unknown');
  });

  it('reports scope=global when --global is set', async () => {
    await parse(['update', '--global', '-y']);
    const [, attrs] = mockEmitCompleted.mock.calls[0]!;
    expect(attrs.scope).toBe('global');
  });

  it('exits with upstream non-zero exit code', async () => {
    mockRunSkillsCli.mockResolvedValueOnce({ code: 3, stdout: '', stderr: '', signal: null });
    await expect(parse(['update'])).rejects.toThrow(/__EXIT__:/);
    expect(exitCalls[0]).toBe(3);
  });
});

describe('codemie skills remove', () => {
  it('passes --skill and --agent options through (spec §3)', async () => {
    await parse(['remove', '-s', 'foo', '-a', 'claude-code', '-y']);
    const [args] = mockRunSkillsCli.mock.calls[0]!;
    expect(args).toEqual(['remove', '--yes', '--skill', 'foo', '--agent', 'claude-code']);
  });

  it('does NOT auto-detect agents (only emits target_agents on explicit --agent)', async () => {
    mkdirSync(path.join(workspace, '.claude'));
    await parse(['remove', 'foo', '-y']);
    const [, attrs] = mockEmitCompleted.mock.calls[0]!;
    // Spec §9 / Task 9: auto-detection is for `add` only. For `remove`, the
    // wrapper must not auto-target agents because removal is destructive.
    expect(attrs.target_agents).toBeUndefined();
    expect(attrs.agent_selection_mode).toBeUndefined();
  });

  it('emits target_agents=explicit when user passes --agent', async () => {
    await parse(['remove', '-a', 'claude-code', '-y']);
    const [, attrs] = mockEmitCompleted.mock.calls[0]!;
    expect(attrs.target_agents).toEqual(['claude-code']);
    expect(attrs.agent_selection_mode).toBe('explicit');
  });

  it('combines positional skills with --skill list', async () => {
    await parse(['remove', 'pos1', '-s', 'opt1', '-y']);
    const [, attrs] = mockEmitCompleted.mock.calls[0]!;
    expect(attrs.skill_names).toEqual(['pos1', 'opt1']);
  });
});

describe('codemie skills list', () => {
  it('passes --json to upstream and forwards captured stdout', async () => {
    mockRunSkillsCli.mockResolvedValueOnce({
      code: 0,
      stdout: '[{"name":"foo"}]',
      stderr: '',
      signal: null,
    });

    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as never);

    try {
      await parse(['list', '--json']);
    } finally {
      stdoutSpy.mockRestore();
    }

    const [args, options] = mockRunSkillsCli.mock.calls[0]!;
    expect(args).toContain('--json');
    expect((options as { interactive?: boolean }).interactive).toBe(false);
    expect(writes.some((w) => w.includes('[{"name":"foo"}]'))).toBe(true);
  });

  it('runs interactively (stdio inherited) when --json is not passed', async () => {
    await parse(['list']);
    const [, options] = mockRunSkillsCli.mock.calls[0]!;
    expect((options as { interactive?: boolean }).interactive).toBe(true);
  });

  it('forwards --agent filter', async () => {
    await parse(['list', '--agent', 'claude-code']);
    const [args] = mockRunSkillsCli.mock.calls[0]!;
    expect(args).toEqual(['list', '--agent', 'claude-code']);
  });

  it('reports project scope by default and global when --global is set', async () => {
    await parse(['list']);
    expect(mockEmitCompleted.mock.calls[0]![1].scope).toBe('project');

    mockEmitCompleted.mockClear();
    await parse(['list', '--global']);
    expect(mockEmitCompleted.mock.calls[0]![1].scope).toBe('global');
  });
});

describe('auth gating across all subcommands (spec §7)', () => {
  it.each(['add', 'update', 'remove', 'list'])(
    'never spawns upstream when auth fails for `%s`',
    async (subcommand) => {
      mockRequireAuth.mockImplementation(() => {
        throw new Error('__EXIT__:1');
      });
      const argv = subcommand === 'add' ? [subcommand, 'owner/repo', '-y'] : [subcommand];
      await expect(parse(argv)).rejects.toThrow('__EXIT__:1');
      expect(mockRunSkillsCli).not.toHaveBeenCalled();
      // Per spec §7 metrics emission also depends on the authenticated context;
      // when auth blows up before emission, no events should have been sent.
      expect(mockEmitStarted).not.toHaveBeenCalled();
    }
  );
});
