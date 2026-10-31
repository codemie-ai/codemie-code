/**
 * `codemie proxy analytics`: after include/enable (and in `status`) say why a project is or is not
 * collected and which command changes that — without ever changing a command's outcome.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('@/utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('@/utils/paths.js')>('@/utils/paths.js');
  return {
    ...actual,
    getCodemiePath: (...paths: string[]) => join(tempDir, ...paths),
    resolveHomeDir: (relativePath = '') => join(tempDir, 'home', relativePath),
  };
});

vi.mock('@/utils/project-root.js', () => ({
  resolveProjectRoot: () => join(tempDir, 'project-root'),
}));

describe('analytics advice', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codemie-analytics-advice-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  async function run(args: string[]): Promise<void> {
    const { createProxyAnalyticsCommand } = await import('../analytics-command.js');
    await createProxyAnalyticsCommand().parseAsync(args, { from: 'user' });
  }
  const out = (): string => logSpy.mock.calls.flat().join('\n');

  const claudeHooks = {
    UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'codemie hook --agent claude-code-otlp' }] }],
  };
  /** `connect` result for Claude Code: hooks installed, optionally with a Project-scope allowlist. */
  async function installClaudeHooks(allowlist?: string[]): Promise<void> {
    await mkdir(join(tempDir, 'home', '.claude'), { recursive: true });
    await writeFile(
      join(tempDir, 'home', '.claude', 'settings.json'),
      JSON.stringify({
        hooks: claudeHooks,
        ...(allowlist ? { env: { CODEMIE_ANALYTICS_PROJECT_FILTER: JSON.stringify(allowlist) } } : {}),
      }),
      'utf-8'
    );
  }
  async function writeClaudeAllowlist(paths: string[]): Promise<void> {
    await installClaudeHooks(paths);
  }
  async function writeCopilotScope(id: string, scope: unknown): Promise<void> {
    await mkdir(tempDir, { recursive: true });
    await writeFile(join(tempDir, 'copilot-connectors.json'), JSON.stringify({ version: 1, connectors: { [id]: scope } }), 'utf-8');
  }

  it('Claude: include on a project outside the Project-scope allowlist says so and names connect --scope project', async () => {
    await writeClaudeAllowlist(['/work/other']);
    await run(['include', '/work/a']);
    expect(out()).toContain('NOT tracked');
    expect(out()).toContain('Project-scope allowlist');
    expect(out()).toContain('codemie proxy connect --claude-code-otlp --scope project');
    expect(process.exitCode).toBeUndefined();
  });

  it('Claude: with no hooks installed, include does not claim the project is tracked and names connect', async () => {
    await run(['include', '/work/a']);
    expect(out()).toContain('NOT tracked');
    expect(out()).toContain('hooks are not installed');
    expect(out()).toContain('codemie proxy connect --claude-code-otlp');
    expect(out()).not.toMatch(/is tracked/);
    expect(process.exitCode).toBeUndefined();
  });

  it('Claude: include that really removes an exclusion confirms the project is tracked again', async () => {
    await installClaudeHooks();
    await run(['exclude', '/work/a']);
    logSpy.mockClear();
    await run(['include', '/work/a']);
    expect(out()).toContain('Saved to');
    expect(out()).toMatch(/is tracked/);
    expect(out()).not.toContain('NOT tracked');
  });

  it('Claude: include still covered by an excluded parent adds no advice (the existing message explains it)', async () => {
    await run(['exclude', '/work/a']);
    logSpy.mockClear();
    await run(['include', '/work/a/nested']);
    expect(out()).toContain('still excluded via');
    expect(out()).not.toContain('NOT tracked');
    expect(out()).not.toMatch(/is tracked/);
  });

  it('Claude: enable after disable also reports when the project is still not collected', async () => {
    await writeClaudeAllowlist(['/work/other']);
    await run(['disable']);
    logSpy.mockClear();
    await run(['enable']);
    expect(out()).toContain('Saved to');
    expect(out()).toContain('Project-scope allowlist');
  });

  it('Claude: enable that changes nothing still reports the effective state', async () => {
    await writeClaudeAllowlist(['/work/other']);
    await run(['enable']);
    expect(out()).toContain('Nothing to change.');
    expect(out()).toContain('Project-scope allowlist');
  });

  it('exclude and disable never print advice', async () => {
    await writeClaudeAllowlist(['/work/other']);
    logSpy.mockClear();
    await run(['exclude', '/work/a']);
    await run(['disable']);
    expect(out()).not.toContain('NOT tracked');
    expect(out()).not.toContain('Next step');
  });

  it('Copilot: include for a connector that is not connected says so and names connect for that connector', async () => {
    await run(['include', '/work/a', '--copilot-cli-otlp']);
    expect(out()).toContain('NOT tracked');
    expect(out()).toContain('not connected');
    expect(out()).toContain('codemie proxy connect --copilot-cli-otlp');
  });

  it("Copilot: include outside the connector's Project scope names connect --scope project", async () => {
    await writeCopilotScope('copilot-chat-otlp', { enabled: true, scope: 'project', paths: ['/work/other'] });
    await run(['include', '/work/a', '--copilot-chat-otlp']);
    expect(out()).toContain('Project scope');
    expect(out()).toContain('codemie proxy connect --copilot-chat-otlp --scope project');
  });

  it('Copilot: include inside a connected user scope confirms the project is tracked', async () => {
    await writeCopilotScope('copilot-cli-otlp', { enabled: true, scope: 'user' });
    await run(['exclude', '/work/a', '--copilot-cli-otlp']);
    logSpy.mockClear();
    await run(['include', '/work/a', '--copilot-cli-otlp']);
    expect(out()).toMatch(/is tracked/);
  });

  it('the advice never changes the outcome: a failing gate leaves the command successful and the file saved', async () => {
    vi.doMock('@/agents/core/copilot-analytics-gate.js', () => ({
      evaluateCopilotAnalyticsGate: async () => {
        throw new Error('boom');
      },
    }));
    await run(['exclude', '/work/a', '--copilot-cli-otlp']);
    logSpy.mockClear();
    await run(['include', '/work/a', '--copilot-cli-otlp']);
    expect(process.exitCode).toBeUndefined();
    expect(out()).toContain('Saved to');
    expect(out()).not.toContain('boom');
    vi.doUnmock('@/agents/core/copilot-analytics-gate.js');
  });

  it('status text carries a Hint line for an actionable reason; status --json keeps its shape', async () => {
    await writeClaudeAllowlist(['/work/other']);
    logSpy.mockClear();
    await run(['status']);
    expect(out()).toContain('Hint:');
    expect(out()).toContain('codemie proxy connect --claude-code-otlp --scope project');
    logSpy.mockClear();
    await run(['status', '--json']);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(Object.keys(parsed)).not.toContain('hint');
    expect(Object.keys(parsed)).not.toContain('advice');
  });

  it('status text has no Hint line when the current directory is tracked', async () => {
    logSpy.mockClear();
    await run(['status']);
    expect(out()).not.toContain('Hint:');
  });

  it('Copilot status text carries the Hint for a Project-scope miss and none when the connector is simply not connected (it already says so)', async () => {
    await writeCopilotScope('copilot-chat-otlp', { enabled: true, scope: 'project', paths: ['/work/other'] });
    logSpy.mockClear();
    await run(['status', '--copilot-chat-otlp']);
    expect(out()).toContain('Hint:');
    expect(out()).toContain('--scope project');
    logSpy.mockClear();
    await run(['status', '--copilot-cli-otlp']);
    expect(out()).toContain('codemie proxy connect --copilot-cli-otlp');
    expect(out()).not.toContain('Hint:');
  });
});
