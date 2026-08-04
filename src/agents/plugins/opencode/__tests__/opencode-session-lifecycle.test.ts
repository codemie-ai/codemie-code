/**
 * Tests for the OpenCode plugin's session lifecycle wiring.
 *
 * The ordering guarded here is load-bearing: BaseAgentAdapter runs
 * onSessionStart (creating the real session record) before beforeRun (which
 * calls ensureSessionFile). ensureSessionFile writes a placeholder carrying
 * `status: 'completed'`, a fabricated startTime and `agentSessionId: 'unknown'`;
 * if it ever won the race, every tool-usage metric would ship
 * session_id "unknown" and a meaningless session_duration_ms.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const processEvent = vi.fn();
const startIncrementalSync = vi.fn();
const stopIncrementalSync = vi.fn();
const ensureSessionFile = vi.fn();

vi.mock('../../../../cli/commands/hook.js', () => ({ processEvent }));
vi.mock('../opencode.incremental-sync.js', () => ({
  startOpenCodeIncrementalSync: startIncrementalSync,
  stopOpenCodeIncrementalSync: stopIncrementalSync,
}));
vi.mock('../../../core/session/ensure-session.js', () => ({ ensureSessionFile }));
vi.mock('../opencode.paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../opencode.paths.js')>()),
  getOpenCodeDbPath: () => '/data/opencode/opencode.db',
}));
vi.mock('../../codemie-code-hooks/index.js', () => ({
  getHooksPluginFileUrl: () => 'file:///tmp/codemie-hooks/shell-hooks.ts',
  cleanupHooksPlugin: vi.fn(),
}));

const { OpenCodePluginMetadata } = await import('../opencode.plugin.js');

function baseEnv(): NodeJS.ProcessEnv {
  return {
    CODEMIE_SESSION_ID: 'codemie-uuid-1',
    CODEMIE_AGENT: 'opencode',
    CODEMIE_PROVIDER: 'ai-run-sso',
    CODEMIE_URL: 'https://sso.example.com',
    CODEMIE_CLI_VERSION: '9.9.9',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('OpenCode onSessionStart', () => {
  it('emits a SessionStart lifecycle event carrying the CodeMie session id', async () => {
    const env = baseEnv();

    await OpenCodePluginMetadata.lifecycle!.onSessionStart!('codemie-uuid-1', env);

    expect(processEvent).toHaveBeenCalledTimes(1);
    const [event, config] = processEvent.mock.calls[0];

    expect(event.hook_event_name).toBe('SessionStart');
    // OpenCode's own ses_* id does not exist yet; using it here would leave the
    // started and completed rows uncorrelatable.
    expect(event.session_id).toBe('codemie-uuid-1');
    expect(event.source).toBe('startup');
    expect(config.clientType).toBe('codemie-opencode');
    expect(config.sessionId).toBe('codemie-uuid-1');
  });

  it('starts the incremental sync failsafe', async () => {
    const env = baseEnv();

    await OpenCodePluginMetadata.lifecycle!.onSessionStart!('codemie-uuid-1', env);

    expect(startIncrementalSync).toHaveBeenCalledTimes(1);
    const options = startIncrementalSync.mock.calls[0][0];
    expect(options.sessionId).toBe('codemie-uuid-1');
    expect(options.cwd).toBe(process.cwd());
    expect(options.buildContext().clientType).toBe('codemie-opencode');
  });

  it('does not block startup when the lifecycle event fails', async () => {
    processEvent.mockRejectedValueOnce(new Error('network down'));

    await expect(
      OpenCodePluginMetadata.lifecycle!.onSessionStart!('codemie-uuid-1', baseEnv())
    ).resolves.toBeUndefined();

    // The failsafe timer must still start.
    expect(startIncrementalSync).toHaveBeenCalledTimes(1);
  });
});

describe('OpenCode beforeRun', () => {
  it('always registers the telemetry hooks and injects the plugin', async () => {
    const env = { ...baseEnv(), CODEMIE_BASE_URL: 'http://localhost:1234' };

    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);

    const hooks = JSON.parse(env.OPENCODE_HOOKS!).hooks;
    expect(Object.keys(hooks).sort()).toEqual(['Stop', 'UserPromptSubmit']);
    // Stop is detached: the plugin runs sync hooks with execSync, which would
    // otherwise stall OpenCode while the child re-parses SQLite.
    expect(hooks.Stop[0].hooks[0].async).toBe(true);

    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(config.plugin).toContain('file:///tmp/codemie-hooks/shell-hooks.ts');
  });

  it('registers the telemetry hooks even when the profile defines none', async () => {
    const env = { ...baseEnv(), CODEMIE_BASE_URL: 'http://localhost:1234' };
    delete env.CODEMIE_PROFILE_CONFIG;

    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);

    // The old guard injected the plugin only when the profile happened to
    // define hooks, so active-time tracking never ran for most users.
    expect(env.OPENCODE_HOOKS).toBeDefined();
    expect(Object.keys(JSON.parse(env.OPENCODE_HOOKS!).hooks).sort())
      .toEqual(['Stop', 'UserPromptSubmit']);
  });

  it('still exports the transcript path when no proxy config is produced', async () => {
    const env = baseEnv(); // no CODEMIE_BASE_URL — beforeRun returns early

    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);

    // Without a base URL no OpenCode config is written, so the plugin cannot be
    // injected and active-duration tracking is unavailable in that setup; the
    // in-process lifecycle metrics and sync timer still run.
    expect(env.CODEMIE_OPENCODE_TRANSCRIPT).toBe('/data/opencode/opencode.db');
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it('merges profile hooks on top of the defaults', async () => {
    const env = {
      ...baseEnv(),
      CODEMIE_BASE_URL: 'http://localhost:1234',
      CODEMIE_PROFILE_CONFIG: JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
      }),
    };

    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);

    const hooks = JSON.parse(env.OPENCODE_HOOKS!).hooks;
    expect(Object.keys(hooks).sort()).toEqual(['PreToolUse', 'Stop', 'UserPromptSubmit']);
  });

  it('exports the transcript path the hook needs to re-parse the session', async () => {
    const env = { ...baseEnv(), CODEMIE_BASE_URL: 'http://localhost:1234' };

    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);

    // performIncrementalSync bails out on any event without a transcript_path.
    expect(env.CODEMIE_OPENCODE_TRANSCRIPT).toBe('/data/opencode/opencode.db');
  });

  it('does not redirect XDG_DATA_HOME away from the user\'s own storage', async () => {
    const env = { ...baseEnv(), CODEMIE_BASE_URL: 'http://localhost:1234' };

    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);

    // Redirecting it would orphan the session history users already have.
    expect(env.XDG_DATA_HOME).toBeUndefined();
  });
});

describe('OpenCode onSessionEnd', () => {
  it('stops the timer and routes through the full SessionEnd pipeline', async () => {
    const env = baseEnv();

    await OpenCodePluginMetadata.lifecycle!.onSessionEnd!(0, env);

    expect(stopIncrementalSync).toHaveBeenCalledWith('codemie-uuid-1');

    const [event, config] = processEvent.mock.calls[0];
    expect(event.hook_event_name).toBe('SessionEnd');
    expect(event.session_id).toBe('codemie-uuid-1');
    expect(event.reason).toBe('exit');
    expect(config.clientType).toBe('codemie-opencode');
  });

  it('reports a non-zero exit code in the reason', async () => {
    await OpenCodePluginMetadata.lifecycle!.onSessionEnd!(3, baseEnv());

    expect(processEvent.mock.calls[0][0].reason).toBe('exit(3)');
  });

  it('skips entirely without a CodeMie session id', async () => {
    await OpenCodePluginMetadata.lifecycle!.onSessionEnd!(0, {});

    expect(processEvent).not.toHaveBeenCalled();
  });
});

describe('OpenCode telemetry metadata', () => {
  it('excludes shell errors using the lower-cased tool name', () => {
    // filterErrorTools does an exact match and the processor lower-cases tool
    // names, so the global ['Bash','Execute','Shell'] default never matches.
    expect(OpenCodePluginMetadata.metricsConfig?.excludeErrorsFromTools).toEqual(['bash']);
  });

  it('declares MCP and extension locations so the scans report non-zero', () => {
    expect(OpenCodePluginMetadata.mcpConfig?.project?.jsonPath).toBe('mcp');
    expect(OpenCodePluginMetadata.mcpConfig?.project?.path).toEqual([
      'opencode.json',
      'opencode.jsonc',
    ]);

    const extensions = OpenCodePluginMetadata.extensionsConfig!;
    expect(extensions.project).toBe('.opencode');
    expect(extensions.dirNames?.agents).toEqual(['agent', 'agents']);
    // OpenCode has no hooks/ directory; plugins occupy that metric slot.
    expect(extensions.dirNames?.hooks).toEqual(['plugin', 'plugins']);
    // ...and no rules/ concept at all, so rules_* stays at zero.
    expect(extensions.dirNames?.rules).toEqual([]);
  });
});
