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
import { OPENCODE_MODEL_CONFIGS } from '../opencode-model-configs.js';

const processEvent = vi.fn();
const startIncrementalSync = vi.fn();
const stopIncrementalSync = vi.fn();
const ensureSessionFile = vi.fn();
// Real fetchDynamicModelConfigs would hit the network; mocked here to resolve
// synchronously with the same static catalogue it falls back to on a network
// error, so these tests match real behavior without a live proxy. The
// CODEMIE_PROFILE_MODELS narrowing integration tests below (CR-005) override
// this per-test with their own small catalogue via mockResolvedValueOnce.
const fetchDynamicModelConfigsMock = vi.fn().mockResolvedValue(OPENCODE_MODEL_CONFIGS);

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
  getHooksPluginDirUrl: () => 'file:///tmp/codemie-hooks/opencode-v2/',
  cleanupHooksPluginDir: vi.fn(),
}));
vi.mock('../opencode-dynamic-models.js', () => ({
  fetchDynamicModelConfigs: fetchDynamicModelConfigsMock,
}));

const { OpenCodePluginMetadata } = await import('../opencode.plugin.js');
const { OpenCodeSessionAdapter } = await import('../opencode.session.js');

function stubModelConfig(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    family: 'gpt-5',
    tool_call: true,
    reasoning: true,
    attachment: false,
    temperature: false,
    modalities: { input: ['text'], output: ['text'] },
    knowledge: '2025-08-31',
    release_date: '2025-12-11',
    last_updated: '2025-12-11',
    open_weights: false,
    cost: { input: 1, output: 1 },
    limit: { context: 1000, output: 1000 },
  };
}

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

  it('hands processEvent the wrapper owner and the sync URL from the env, so the record stores it and the hook can send', async () => {
    const env = {
      ...baseEnv(),
      CODEMIE_WRAPPER_PID: '4242',
      CODEMIE_WRAPPER_STARTED_AT: '1790000000000',
      CODEMIE_SYNC_API_URL: 'https://sync.example.com/code-assistant-api',
    };

    await OpenCodePluginMetadata.lifecycle!.onSessionStart!('codemie-uuid-1', env);

    const [, config] = processEvent.mock.calls[0];
    expect(config).toMatchObject({
      ownerPid: 4242,
      ownerStartedAt: 1_790_000_000_000,
      syncApiUrl: 'https://sync.example.com/code-assistant-api',
    });
  });

  it('with no started proxy and no sync URL, the failsafe gets no send path: CODEMIE_BASE_URL is the LLM host', async () => {
    await OpenCodePluginMetadata.lifecycle!.onSessionStart!('codemie-uuid-1', { ...baseEnv(), CODEMIE_BASE_URL: 'https://llm.example.com' });

    const options = startIncrementalSync.mock.calls[0][0];
    expect(options.syncApiUrl).toBeUndefined();
    expect(options.buildContext().apiBaseUrl).toBe('');
  });

  it('with the started proxy, the failsafe sends through it', async () => {
    const env = { ...baseEnv(), CODEMIE_BASE_URL: 'http://127.0.0.1:4000', CODEMIE_TARGET_API_URL: 'https://sso.example.com/code-assistant-api' };

    await OpenCodePluginMetadata.lifecycle!.onSessionStart!('codemie-uuid-1', env);

    const options = startIncrementalSync.mock.calls[0][0];
    expect(options.syncApiUrl).toBe('http://127.0.0.1:4000');
    expect(options.buildContext().apiBaseUrl).toBe('http://127.0.0.1:4000');
  });

  it('falls back to codemie-opencode when CODEMIE_CLIENT_TYPE is unset (unchanged plain-OpenCode behavior)', async () => {
    await OpenCodePluginMetadata.lifecycle!.onSessionStart!('codemie-uuid-1', baseEnv());

    const [, config] = processEvent.mock.calls[0];
    expect(config.clientType).toBe('codemie-opencode');

    const options = startIncrementalSync.mock.calls[0][0];
    expect(options.buildContext().clientType).toBe('codemie-opencode');
  });
});

const proxyEnv = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...baseEnv(),
  CODEMIE_BASE_URL: 'http://localhost:1234',
  ...extra,
});

describe('OpenCode reasoning effort', () => {
  const beforeRun = OpenCodePluginMetadata.lifecycle!.beforeRun!;

  it('writes the level as a variant of a Responses API model, clamped to xhigh', async () => {
    const env = proxyEnv({ CODEMIE_MODEL: 'gpt-5-2-2025-12-11', CODEMIE_REASONING_EFFORT: 'max' });

    await beforeRun(env, {} as never);

    // An unknown variant fails the OpenCode session, so the level must be one the provider has.
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(config.model).toBe('codemie-openai/gpt-5-2-2025-12-11#xhigh');
    // `opencode run` drops the configured variant; enrichArgs passes the selection as --model.
    expect(env.CODEMIE_OPENCODE_RUN_MODEL).toBe(config.model);
  });

  it('clamps to low…high for a chat-completions model', async () => {
    const env = proxyEnv({ CODEMIE_MODEL: 'claude-4-5-sonnet', CODEMIE_REASONING_EFFORT: 'minimal' });

    await beforeRun(env, {} as never);

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).model).toBe('codemie-proxy/claude-4-5-sonnet#low');
  });

  it('leaves the selection bare when no level is requested', async () => {
    const env = proxyEnv({ CODEMIE_MODEL: 'gpt-5-2-2025-12-11' });

    await beforeRun(env, {} as never);

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).model).toBe('codemie-openai/gpt-5-2-2025-12-11');
    expect(env.CODEMIE_OPENCODE_RUN_MODEL).toBeUndefined();
  });
});

// OpenCode titles a session with `small_model`, so it has to name a model the proxy serves.
describe('OpenCode title model', () => {
  const smallModelFor = async (haikuModel: string | undefined): Promise<string | undefined> => {
    const env = proxyEnv({ CODEMIE_MODEL: 'claude-4-5-sonnet', CODEMIE_HAIKU_MODEL: haikuModel });
    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);
    return JSON.parse(env.OPENCODE_CONFIG_CONTENT!).small_model;
  };

  it.each([
    ['a chat-completions model', 'claude-4-5-sonnet', 'codemie-proxy/claude-4-5-sonnet'],
    ['a Responses API model', 'gpt-5-2-2025-12-11', 'codemie-openai/gpt-5-2-2025-12-11'],
  ])('names %s under the provider that serves it', async (_kind, haikuModel, expected) => {
    expect(await smallModelFor(haikuModel)).toBe(expected);
  });

  it.each([
    ['unset', undefined],
    ['not in the catalog', 'not-a-catalog-model'],
  ])('leaves the choice to OpenCode when the haiku model is %s', async (_case, haikuModel) => {
    expect(await smallModelFor(haikuModel)).toBeUndefined();
  });
});

describe('OpenCode enrichArgs', () => {
  const enrichArgs = (args: string[]) => OpenCodePluginMetadata.lifecycle!.enrichArgs!(args, {} as never);

  // OpenCode v2's shared background service keeps the settings of the session that started it.
  it('runs the TUI and --task on a private server', () => {
    expect(enrichArgs([])).toEqual(['--standalone']);
    expect(enrichArgs(['--task', 'hi'])).toEqual(['run', 'hi', '--standalone']);
  });

  it('passes the variant selection to run', () => {
    vi.stubEnv('CODEMIE_OPENCODE_RUN_MODEL', 'codemie-openai/gpt-5-2-2025-12-11#high');

    expect(enrichArgs(['--task', 'hi']))
      .toEqual(['run', 'hi', '--model', 'codemie-openai/gpt-5-2-2025-12-11#high', '--standalone']);
  });

  it('keeps an explicit server choice and an unknown subcommand as given', () => {
    expect(enrichArgs(['run', 'hi', '--server', 'http://127.0.0.1:1'])).toEqual(['run', 'hi', '--server', 'http://127.0.0.1:1']);
    expect(enrichArgs(['models'])).toEqual(['models']);
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
    // OpenCode v2 loads a configured plugin only from a directory.
    expect(config.plugin).toContain('file:///tmp/codemie-hooks/opencode-v2/');
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

  // CR-005: pins the real call site (beforeRun's filterToAllowed wiring into
  // provider.models) rather than only the pure filterToAllowed helper in
  // isolation — a wrong env var, swapped argument, or mis-ordered call here
  // would previously ship with no test failing.
  it('limits provider.models to CODEMIE_PROFILE_MODELS, keeping the active model (CR-005 integration)', async () => {
    fetchDynamicModelConfigsMock.mockResolvedValueOnce({
      'model-a': stubModelConfig('model-a'),
      'model-b': stubModelConfig('model-b'),
      'model-c': stubModelConfig('model-c'),
    });
    const env = {
      ...baseEnv(),
      CODEMIE_BASE_URL: 'http://localhost:1234',
      CODEMIE_MODEL: 'model-a',
      CODEMIE_PROFILE_MODELS: 'model-a,model-b',
    };

    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);

    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    const modelIds = Object.keys(config.provider['codemie-proxy'].models);
    expect(modelIds.sort()).toEqual(['model-a', 'model-b']);
  });

  it('keeps the active model even when it is outside CODEMIE_PROFILE_MODELS (CR-005 integration)', async () => {
    fetchDynamicModelConfigsMock.mockResolvedValueOnce({
      'model-a': stubModelConfig('model-a'),
      'model-b': stubModelConfig('model-b'),
      'model-c': stubModelConfig('model-c'),
    });
    const env = {
      ...baseEnv(),
      CODEMIE_BASE_URL: 'http://localhost:1234',
      CODEMIE_MODEL: 'model-c',
      CODEMIE_PROFILE_MODELS: 'model-a,model-b',
    };

    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);

    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    const modelIds = Object.keys(config.provider['codemie-proxy'].models);
    expect(modelIds.sort()).toEqual(['model-a', 'model-b', 'model-c']);
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

  it('carries the CodeMie id and the located transcript, so processing takes every session of the run', async () => {
    const locate = vi.spyOn(OpenCodeSessionAdapter.prototype, 'locateSessionTranscript')
      .mockResolvedValue({ transcript: '/data/opencode/opencode.db', sessionIds: ['ses_run'] });
    try {
      await OpenCodePluginMetadata.lifecycle!.onSessionEnd!(0, baseEnv());
    } finally {
      locate.mockRestore();
    }

    const [event] = processEvent.mock.calls[0];
    expect(event.session_id).toBe('codemie-uuid-1');
    expect(event.transcript_path).toBe('/data/opencode/opencode.db');
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
    // OpenCode v2 renamed the tool to `shell`; `bash` stays for sessions recorded by v1.
    expect(OpenCodePluginMetadata.metricsConfig?.excludeErrorsFromTools).toEqual(['bash', 'shell']);
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
