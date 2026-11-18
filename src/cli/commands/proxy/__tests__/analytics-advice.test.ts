/**
 * `codemie proxy analytics`: after include/enable (and in `status`) say why a project is or is not
 * collected and which command changes that — without ever changing a command's outcome.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

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

vi.mock('../connectors/desktop.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/desktop.js')>()),
  readDesktopGateway: vi.fn(async () => null),
}));

describe('analytics advice', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Canonical like the code's paths: on Windows tmpdir() may be the 8.3 short form (RUNNER~1).
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'codemie-analytics-advice-')));
    vi.stubEnv('CODEMIE_HOME', tempDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(async () => {
    // Release the logger's file in the temp home first (before resetModules swaps the instance): Windows cannot delete an open file.
    await (await import('@/utils/logger.js')).logger.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.exitCode = undefined;
  });

  async function run(args: string[]): Promise<void> {
    const { createProxyAnalyticsCommand } = await import('../analytics-command.js');
    await createProxyAnalyticsCommand().parseAsync(args, { from: 'user' });
  }
  const out = (): string => stripVTControlCharacters(logSpy.mock.calls.flat().join('\n'));

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

  it('Claude: include on a project outside the Project-scope allowlist adds it to the list and confirms it is tracked (D13)', async () => {
    await writeClaudeAllowlist(['/work/other']);
    await run(['include', '/work/a', '--claude-code-otlp']);
    expect(out()).toContain('Added');
    expect(out()).toMatch(/is tracked/);
    expect(out()).not.toContain('NOT tracked');
    expect(process.exitCode).toBeUndefined();
  });

  it('Claude: with no hooks installed, include does not claim the project is tracked and names connect', async () => {
    await run(['include', '/work/a', '--claude-code-otlp']);
    expect(out()).toContain('NOT tracked');
    expect(out()).toContain('hooks are not installed');
    expect(out()).toContain('codemie proxy connect --claude-otlp');
    expect(out()).not.toMatch(/is tracked/);
    expect(process.exitCode).toBeUndefined();
  });

  it('Claude: include that really removes an exclusion confirms the project is tracked again', async () => {
    await installClaudeHooks();
    await run(['exclude', '/work/a', '--claude-code-otlp']);
    logSpy.mockClear();
    await run(['include', '/work/a', '--claude-code-otlp']);
    expect(out()).toContain('Saved to');
    expect(out()).toMatch(/is tracked/);
    expect(out()).not.toContain('NOT tracked');
  });

  it('Claude: include still covered by an excluded parent adds no advice (the existing message explains it)', async () => {
    await run(['exclude', '/work/a', '--claude-code-otlp']);
    logSpy.mockClear();
    await run(['include', '/work/a/nested', '--claude-code-otlp']);
    expect(out()).toContain('still excluded via');
    expect(out()).not.toContain('NOT tracked');
    expect(out()).not.toMatch(/is tracked/);
  });

  it('Claude: enable after disable also reports when the project is still not collected', async () => {
    await writeClaudeAllowlist(['/work/other']);
    await run(['disable', '--claude-code-otlp']);
    logSpy.mockClear();
    await run(['enable', '--claude-code-otlp']);
    expect(out()).toContain('Saved to');
    expect(out()).toContain('Project-scope allowlist');
  });

  it('Claude: enable that changes nothing still reports the effective state', async () => {
    await writeClaudeAllowlist(['/work/other']);
    await run(['enable', '--claude-code-otlp']);
    expect(out()).toContain('Nothing to change.');
    expect(out()).toContain('Project-scope allowlist');
  });

  it('disable and exclude state the coverage boundary, per connector (CR-005)', async () => {
    await run(['disable', '--claude-code-otlp']);
    expect(out()).toContain('Controls the hook pipeline only');
    expect(out()).toContain('session sync that `codemie claude` runs itself');
    logSpy.mockClear();
    await run(['exclude', '/work/a', '--claude-code-otlp']);
    expect(out()).toContain('Controls the hook pipeline only');
    logSpy.mockClear();
    await run(['disable', '--copilot-cli-otlp']);
    expect(out()).toContain('managed `codemie copilot-cli` launches');
    logSpy.mockClear();
    await run(['exclude', '/work/a', '--copilot-chat-otlp']);
    expect(out()).toContain('not affected: the daily analytics collector.');
  });

  it('an exclude that changes nothing prints no coverage note', async () => {
    await run(['exclude', '/work/a', '--claude-code-otlp']);
    logSpy.mockClear();
    await run(['exclude', '/work/a', '--claude-code-otlp']);
    expect(out()).toContain('Nothing to change');
    expect(out()).not.toContain('Controls the hook pipeline only');
  });

  it('enable and include that really change something warn that transcript usage is reported on resume (CR-002)', async () => {
    await installClaudeHooks();
    await run(['disable', '--claude-code-otlp']);
    logSpy.mockClear();
    await run(['enable', '--claude-code-otlp']);
    expect(out()).toContain('may be reported now that it is back on');
    logSpy.mockClear();
    await run(['exclude', '/work/a', '--claude-code-otlp']);
    logSpy.mockClear();
    await run(['include', '/work/a', '--claude-code-otlp']);
    expect(out()).toContain('may be reported now that it is back on');
    logSpy.mockClear();
    await run(['enable', '--claude-code-otlp']);
    expect(out()).toContain('Nothing to change.');
    expect(out()).not.toContain('may be reported');
  });

  it('Copilot CLI gets the whole-session note on resume; Copilot Chat gets none', async () => {
    await run(['disable', '--copilot-cli-otlp']);
    logSpy.mockClear();
    await run(['enable', '--copilot-cli-otlp']);
    expect(out()).toContain('whole-session usage');
    await run(['disable', '--copilot-chat-otlp']);
    logSpy.mockClear();
    await run(['enable', '--copilot-chat-otlp']);
    expect(out()).not.toContain('usage');
  });

  it('status text ends with a plain sentence naming the channels these settings do not control; --json carries no such text', async () => {
    const lastLine = (): string => out().split('\n').find((l) => l.includes('These settings do not affect')) as string;
    await run(['status']);
    expect(lastLine()).toBe(
      '  These settings do not affect the daily analytics collector and the session sync that `codemie claude` runs itself.'
    );
    logSpy.mockClear();
    await run(['status', '--copilot-cli-otlp']);
    expect(lastLine()).toBe(
      '  These settings do not affect managed `codemie copilot-cli` launches and the daily analytics collector.'
    );
    logSpy.mockClear();
    await run(['status', '--copilot-chat-otlp']);
    expect(lastLine()).toBe('  These settings do not affect the daily analytics collector.');
    expect(out()).not.toContain('Not affected');
    logSpy.mockClear();
    await run(['status', '--json']);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(JSON.stringify(parsed)).not.toContain('do not affect');
  });

  it('status offers connect when no hooks are installed', async () => {
    await run(['status', '--json']);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.connectors[0].hooksInstalled).toBe(false);
    expect(parsed.connectors[0]).not.toHaveProperty('current');
    logSpy.mockClear();
    await run(['status']);
    expect(out()).toContain('      Not connected — run: codemie proxy connect --claude-otlp');
    expect(out().match(/run:/g)).toHaveLength(2); // connect + the doctor pointer
    expect(out()).not.toContain('Hint:');
  });

  it('exclude and disable never print advice', async () => {
    await writeClaudeAllowlist(['/work/other']);
    logSpy.mockClear();
    await run(['exclude', '/work/a', '--claude-code-otlp']);
    await run(['disable', '--claude-code-otlp']);
    expect(out()).not.toContain('NOT tracked');
    expect(out()).not.toContain('Next step');
  });

  it('Copilot: include for a connector that is not connected says so and names connect for that connector', async () => {
    await run(['include', '/work/a', '--copilot-cli-otlp']);
    expect(out()).toContain('NOT tracked');
    expect(out()).toContain('not connected');
    expect(out()).toContain('codemie proxy connect --copilot-otlp');
  });

  it("Copilot: include outside the connector's Project scope adds it to the connector's own list (D13)", async () => {
    await writeCopilotScope('copilot-chat-otlp', { enabled: true, scope: 'project', paths: ['/work/other'] });
    await run(['include', '/work/a', '--copilot-chat-otlp']);
    expect(out()).toContain('Added');
    expect(out()).toMatch(/is tracked/);
    expect(out()).not.toContain('NOT tracked');
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

  it('Copilot status text offers connect only when the connector is not connected', async () => {
    await writeCopilotScope('copilot-chat-otlp', { enabled: true, scope: 'project', paths: ['/work/other'] });
    logSpy.mockClear();
    await run(['status', '--copilot-chat-otlp']);
    expect(out()).not.toContain('Hint:');
    expect(out().match(/run:/g)).toHaveLength(1); // only the doctor pointer
    logSpy.mockClear();
    await run(['status', '--copilot-cli-otlp']);
    expect(out()).toContain('      Not connected — run: codemie proxy connect --copilot-otlp');
    expect(out().match(/run:/g)).toHaveLength(2);
    expect(out()).not.toContain('Hint:');
  });
});
