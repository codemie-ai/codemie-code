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
const cleanupHooksPlugin = vi.fn();
const cleanupHooksV2Plugin = vi.fn();
const resolveDbPath = vi.fn(async () => '/data/opencode/opencode.db');
const discoverSessions = vi.fn();

vi.mock('../../../../cli/commands/hook.js', () => ({ processEvent }));
vi.mock('../opencode.incremental-sync.js', () => ({
  startOpenCodeIncrementalSync: startIncrementalSync,
  stopOpenCodeIncrementalSync: stopIncrementalSync,
}));
vi.mock('../../../core/session/ensure-session.js', () => ({ ensureSessionFile }));
vi.mock('../opencode.paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../opencode.paths.js')>()),
  getOpenCodeDbPath: () => '/data/opencode/opencode.db',
  resolveOpenCodeDbPath: resolveDbPath,
}));
vi.mock('../opencode.session.js', () => ({
  OpenCodeSessionAdapter: vi.fn(function () { return { discoverSessions }; }),
}));
vi.mock('../opencode-dynamic-models.js', () => ({
  fetchDynamicModelConfigs: vi.fn(async () => (await import('../opencode-model-configs.js')).OPENCODE_MODEL_CONFIGS),
}));
vi.mock('../../codemie-code-hooks/index.js', () => ({
  getHooksPluginFileUrl: () => 'file:///tmp/codemie-hooks/shell-hooks.ts',
  cleanupHooksPlugin,
  getHooksV2PluginDirUrl: () => 'file:///tmp/codemie-hooks/shell-hooks-v2',
  cleanupHooksV2Plugin,
}));

const { OpenCodePluginMetadata } = await import('../opencode.plugin.js');
const { OpenCodeSessionAdapter } = await import('../opencode.session.js');

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
  vi.stubEnv('CODEMIE_OPENCODE_CONFIG_VERSION', '1');
  resolveDbPath.mockReset().mockResolvedValue('/data/opencode/opencode.db');
  discoverSessions.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
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

  it('tags processEvent and buildContext with CODEMIE_CLIENT_TYPE when set (e.g. by opencode-acp)', async () => {
    // OpenCodeAcpPluginMetadata inherits onSessionStart verbatim and relies on
    // BaseAgentAdapter setting env.CODEMIE_CLIENT_TYPE from its own ssoConfig —
    // regression guard for the hardcoded OPENCODE_CLIENT_TYPE this replaced.
    const env = { ...baseEnv(), CODEMIE_CLIENT_TYPE: 'codemie-opencode-acp' };

    await OpenCodePluginMetadata.lifecycle!.onSessionStart!('codemie-uuid-1', env);

    const [, config] = processEvent.mock.calls[0];
    expect(config.clientType).toBe('codemie-opencode-acp');

    const options = startIncrementalSync.mock.calls[0][0];
    expect(options.buildContext().clientType).toBe('codemie-opencode-acp');
  });

  it('falls back to codemie-opencode when CODEMIE_CLIENT_TYPE is unset (unchanged plain-OpenCode behavior)', async () => {
    await OpenCodePluginMetadata.lifecycle!.onSessionStart!('codemie-uuid-1', baseEnv());

    const [, config] = processEvent.mock.calls[0];
    expect(config.clientType).toBe('codemie-opencode');

    const options = startIncrementalSync.mock.calls[0][0];
    expect(options.buildContext().clientType).toBe('codemie-opencode');
  });
});

describe('OpenCode beforeRun', () => {
  it('resolves the transcript using the metadata command and not-yet-merged child environment', async () => {
    const env = { ...baseEnv(), XDG_DATA_HOME: '/child-data' };
    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);
    expect(resolveDbPath).toHaveBeenCalledWith(undefined, {
      command: OpenCodePluginMetadata.cliCommand, env,
    });
    expect(env.CODEMIE_OPENCODE_RESOLVED_CONFIG_VERSION).toBe('v1');
    expect(env.XDG_DATA_HOME).toBe('/child-data');
  });

  it('does not expose :memory: as a file transcript', async () => {
    resolveDbPath.mockResolvedValue(':memory:');
    const env = baseEnv();
    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);
    expect(env.CODEMIE_OPENCODE_TRANSCRIPT).toBe('');
  });

  it('always registers the telemetry hooks and injects the plugin', async () => {
    const env = { ...baseEnv(), CODEMIE_BASE_URL: 'http://localhost:1234' };

    // Pin the v1 schema: this test asserts the v1 emission shape (`plugin`,
    // singular) and must not depend on the binary installed on the machine
    // running it — without the pin, a v2 binary yields `plugins` instead.
    const previousOverride = process.env.CODEMIE_OPENCODE_CONFIG_VERSION;
    process.env.CODEMIE_OPENCODE_CONFIG_VERSION = '1';
    try {
      await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);
    } finally {
      if (previousOverride === undefined) delete process.env.CODEMIE_OPENCODE_CONFIG_VERSION;
      else process.env.CODEMIE_OPENCODE_CONFIG_VERSION = previousOverride;
    }

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
  it('passes the discovered source ID separately from lifecycle/output identity', async () => {
    discoverSessions.mockResolvedValue([{ sessionId: 'ses_exact', filePath: '/fixture/db' }]);
    const env = { ...baseEnv(), XDG_DATA_HOME: '/child-data' };
    await OpenCodePluginMetadata.lifecycle!.onSessionEnd!(0, env);
    expect(OpenCodeSessionAdapter).toHaveBeenCalledWith(OpenCodePluginMetadata, { env });
    expect(discoverSessions).toHaveBeenCalledWith({ maxAgeDays: 1, limit: 1, cwd: process.cwd() });
    const [event, config] = processEvent.mock.calls[0];
    expect(event.session_id).toBe('codemie-uuid-1');
    expect(event.transcript_path).toBe('/fixture/db');
    expect(config.sessionId).toBe('codemie-uuid-1');
    expect(config.sourceSessionId).toBe('ses_exact');
  });

  it('does not fabricate a transcript or source ID after failed discovery', async () => {
    discoverSessions.mockRejectedValueOnce(new Error('database unavailable'));
    await OpenCodePluginMetadata.lifecycle!.onSessionEnd!(0, baseEnv());
    expect(processEvent.mock.calls[0][0].transcript_path).toBe('');
    expect(processEvent.mock.calls[0][1].sourceSessionId).toBeUndefined();
    expect(cleanupHooksV2Plugin).toHaveBeenCalledOnce();
  });

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

  it('cleans up both hooks payloads', async () => {
    // The v2 payload is a directory written on every run; leaving it behind
    // relied solely on the process-exit cleanup, and the exported v2 cleanup was
    // never called from product code at all.
    await OpenCodePluginMetadata.lifecycle!.onSessionEnd!(0, baseEnv());

    expect(cleanupHooksPlugin).toHaveBeenCalledTimes(1);
    expect(cleanupHooksV2Plugin).toHaveBeenCalledTimes(1);
  });

  it('cleans up even when the SessionEnd pipeline fails', async () => {
    processEvent.mockRejectedValueOnce(new Error('network down'));

    await OpenCodePluginMetadata.lifecycle!.onSessionEnd!(0, baseEnv());

    expect(cleanupHooksV2Plugin).toHaveBeenCalledTimes(1);
  });
});

describe('OpenCode telemetry metadata', () => {
  it('excludes shell errors using the lower-cased tool name', () => {
    // filterErrorTools does an exact match and the processor lower-cases tool
    // names, so the global ['Bash','Execute','Shell'] default never matches.
    expect(OpenCodePluginMetadata.metricsConfig?.excludeErrorsFromTools).toEqual(['bash']);
  });

  it('declares MCP and extension locations so the scans report non-zero', () => {
    expect(OpenCodePluginMetadata.mcpConfig?.project?.jsonPath).toEqual(['mcp.servers', 'mcp']);
    expect(OpenCodePluginMetadata.mcpConfig?.local?.jsonPath).toEqual(['mcp.servers', 'mcp']);
    expect(OpenCodePluginMetadata.mcpConfig?.user?.jsonPath).toEqual(['mcp.servers', 'mcp']);
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
