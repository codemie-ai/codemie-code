/**
 * Tests for reasoning-effort support on the OpenCode 2.x config path.
 *
 * OpenCode v2 removed `--variant` from `run`, so the central cli-flag
 * injection would fail every effort run with "Unrecognized flag" (exit 1).
 * Instead the v2 proxy branch declares per-model `variants` entries carrying
 * the effort as request-body overlays and suffixes the selected model
 * reference (`codemie-proxy/<id>#<level>`); the `shouldApply` gate then skips
 * `--variant` injection (quietly when the effort was honored, loudly otherwise).
 *
 * `CODEMIE_OPENCODE_CONFIG_VERSION=2` pins the schema so the assertions do not
 * depend on the binary installed on the machine running them. The live catalogue
 * is stubbed; everything else is real.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OpenCodeModelConfig } from '../opencode-model-configs.js';

const getHooksPluginFileUrl = vi.fn(() => 'file:///tmp/codemie-hooks/shell-hooks.ts');
const getHooksV2PluginDirUrl = vi.fn(() => 'file:///tmp/codemie-hooks/shell-hooks-v2');
const cleanupHooksPlugin = vi.fn();
const cleanupHooksV2Plugin = vi.fn();

vi.mock('../../../../cli/commands/hook.js', () => ({ processEvent: vi.fn() }));
vi.mock('../opencode.incremental-sync.js', () => ({
  startOpenCodeIncrementalSync: vi.fn(),
  stopOpenCodeIncrementalSync: vi.fn(),
}));
vi.mock('../opencode.paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../opencode.paths.js')>()),
  getOpenCodeDbPath: () => '/data/opencode/opencode.db',
  resolveOpenCodeDbPath: vi.fn(async () => '/data/opencode/opencode.db'),
}));
vi.mock('../../codemie-code-hooks/index.js', () => ({
  getHooksPluginFileUrl,
  cleanupHooksPlugin,
  getHooksV2PluginDirUrl,
  cleanupHooksV2Plugin,
}));
vi.mock('../opencode-dynamic-models.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../opencode-dynamic-models.js')>()),
  fetchDynamicModelConfigs: vi.fn(),
}));

const { fetchDynamicModelConfigs } = await import('../opencode-dynamic-models.js');
const { OpenCodePluginMetadata, resetOpenCodeConfigVersionCache } = await import('../opencode.plugin.js');

const EFFORT_MARKER = 'CODEMIE_OPENCODE_V2_EFFORT_APPLIED';
const RESOLVED_VERSION = 'CODEMIE_OPENCODE_RESOLVED_CONFIG_VERSION';
const MODEL_REF = 'CODEMIE_OPENCODE_V2_MODEL_REF';
const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const ORIGINAL_OVERRIDE = process.env.CODEMIE_OPENCODE_CONFIG_VERSION;

function modelConfig(id: string, extra: Partial<OpenCodeModelConfig> = {}): OpenCodeModelConfig {
  return {
    id,
    name: id,
    displayName: id,
    family: 'test',
    tool_call: true,
    reasoning: false,
    attachment: false,
    temperature: true,
    modalities: { input: ['text'], output: ['text'] },
    knowledge: '2026-01-01',
    release_date: '2026-01-01',
    last_updated: '2026-01-01',
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 128000, output: 4096 },
    ...extra,
  };
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    CODEMIE_SESSION_ID: 'codemie-uuid-1',
    CODEMIE_AGENT: 'opencode',
    CODEMIE_PROVIDER: 'ai-run-sso',
    CODEMIE_URL: 'https://sso.example.com',
    CODEMIE_CLI_VERSION: '9.9.9',
    CODEMIE_MODEL: 'chat-reasoner',
    CODEMIE_BASE_URL: 'http://localhost:1234',
  };
}

/** Run beforeRun and return the emitted v2 document. */
async function emitV2(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);
  return JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>;
}

function proxyModels(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const providers = config.providers as Record<string, Record<string, unknown>>;
  return providers['codemie-proxy'].models as Record<string, Record<string, unknown>>;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  resetOpenCodeConfigVersionCache();
  process.env.CODEMIE_OPENCODE_CONFIG_VERSION = '2';
  vi.stubEnv(RESOLVED_VERSION, 'v2');
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(fetchDynamicModelConfigs).mockResolvedValue({
    'chat-reasoner': modelConfig('chat-reasoner', { reasoning: true }),
    'resp-reasoner': modelConfig('resp-reasoner', { reasoning: true, use_responses_api: true }),
    'plain-model': modelConfig('plain-model'),
  });
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.unstubAllEnvs();
  if (ORIGINAL_OVERRIDE === undefined) {
    delete process.env.CODEMIE_OPENCODE_CONFIG_VERSION;
  } else {
    process.env.CODEMIE_OPENCODE_CONFIG_VERSION = ORIGINAL_OVERRIDE;
  }
});

describe('OpenCode v2 effort — variants emission (proxy)', () => {
  it('suffixes the model reference with the requested level and sets the marker', async () => {
    const env = { ...baseEnv(), CODEMIE_REASONING_EFFORT: 'high' };

    const config = await emitV2(env);

    expect(config.model).toBe('codemie-proxy/chat-reasoner#high');
    expect(env[EFFORT_MARKER]).toBe('1');
    // enrichArgs picks this up to pass `-m <ref>` on the argv — the channel
    // `run` actually resolves the variant through.
    expect(env['CODEMIE_OPENCODE_V2_MODEL_REF']).toBe('codemie-proxy/chat-reasoner#high');
  });

  it('declares body-overlay variants on reasoning-capable chat models', async () => {
    const config = await emitV2({ ...baseEnv(), CODEMIE_REASONING_EFFORT: 'high' });
    const models = proxyModels(config);

    expect(models['chat-reasoner'].variants).toEqual(
      EFFORT_LEVELS.map((level) => ({ id: level, body: { reasoning_effort: level } })),
    );
  });

  it('uses the Responses shape for Responses-API models', async () => {
    const config = await emitV2({ ...baseEnv(), CODEMIE_MODEL: 'resp-reasoner', CODEMIE_REASONING_EFFORT: 'max' });
    const models = proxyModels(config);

    expect(config.model).toBe('codemie-proxy/resp-reasoner#max');
    expect(models['resp-reasoner'].variants).toEqual(
      EFFORT_LEVELS.map((level) => ({ id: level, body: { reasoning: { effort: level } } })),
    );
  });

  it('declares no variants on non-reasoning models', async () => {
    const config = await emitV2({ ...baseEnv(), CODEMIE_REASONING_EFFORT: 'high' });

    expect(proxyModels(config)['plain-model'].variants).toBeUndefined();
  });

  it('warns once and skips the suffix when the selected model is not reasoning-capable', async () => {
    const env = { ...baseEnv(), CODEMIE_MODEL: 'plain-model', CODEMIE_REASONING_EFFORT: 'high' };

    const config = await emitV2(env);

    // Suffixing an undeclared variant would fail resolution with
    // VariantUnavailableError, so the reference stays plain. beforeRun stays
    // quiet on console (file log only); the gate below delivers the single
    // user-facing warning.
    expect(config.model).toBe('codemie-proxy/plain-model');
    expect(env[EFFORT_MARKER]).toBe('');
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    const gate = OpenCodePluginMetadata.reasoningEffort!.shouldApply!;
    await expect(gate(['run', 'hi'], env)).resolves.toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('could not be applied'));
  });

  it('publishes selectable variants without selecting startup effort', async () => {
    const env = { ...baseEnv() };

    const config = await emitV2(env);
    const models = proxyModels(config);

    expect(config.model).toBe('codemie-proxy/chat-reasoner');
    expect(models['chat-reasoner'].variants).toEqual(
      EFFORT_LEVELS.map(level => ({ id: level, body: { reasoning_effort: level } })),
    );
    expect(models['resp-reasoner'].variants).toEqual(
      EFFORT_LEVELS.map(level => ({ id: level, body: { reasoning: { effort: level } } })),
    );
    expect(models['plain-model'].variants).toBeUndefined();
    expect(env[EFFORT_MARKER]).toBe('');
    expect(env[MODEL_REF]).toBe('');
  });

  it('ignores an unrecognized level without a suffix or marker', async () => {
    const env = { ...baseEnv(), CODEMIE_REASONING_EFFORT: 'ultra' };

    const config = await emitV2(env);

    expect(config.model).toBe('codemie-proxy/chat-reasoner');
    expect(env[EFFORT_MARKER]).toBe('');
  });
});

describe('OpenCode enrichArgs — effort model reference', () => {
  const REF_ENV = 'CODEMIE_OPENCODE_V2_MODEL_REF';
  const REF = 'codemie-proxy/chat-reasoner#high';
  const enrichArgs = OpenCodePluginMetadata.lifecycle!.enrichArgs!;
  let originalRef: string | undefined;

  beforeEach(() => {
    originalRef = process.env[REF_ENV];
    delete process.env[REF_ENV];
  });

  afterEach(() => {
    if (originalRef === undefined) delete process.env[REF_ENV];
    else process.env[REF_ENV] = originalRef;
  });

  it('appends -m <ref> on the run path when beforeRun honored the effort', () => {
    process.env[REF_ENV] = REF;

    expect(enrichArgs(['run', 'hi'], {} as never)).toEqual(['run', '--standalone', 'hi', '-m', REF]);
  });

  it('appends -m <ref> after --task mapping', () => {
    process.env[REF_ENV] = REF;

    expect(enrichArgs(['--task', 'hi'], {} as never)).toEqual(['run', '--standalone', 'hi', '-m', REF]);
  });

  it('leaves args otherwise untouched when no effort was honored', () => {
    expect(enrichArgs(['run', 'hi'], {} as never)).toEqual(['run', '--standalone', 'hi']);
  });

  it('never touches non-run invocations, even with a ref set', () => {
    process.env[REF_ENV] = REF;

    // An explicit `-m` upstream means --model; appending ours would break
    // subcommands that accept no such flag. `--standalone` is a separate
    // concern and is asserted in its own describe block below.
    expect(enrichArgs(['version'], {} as never)).toEqual(['version']);
    expect(enrichArgs(['hi'], {} as never)).toEqual(['hi']);
  });

  it('does not duplicate an explicit user -m/--model', () => {
    process.env[REF_ENV] = REF;

    expect(enrichArgs(['run', 'hi', '-m', 'other/model'], {} as never)).toEqual(['run', '--standalone', 'hi', '-m', 'other/model']);
    expect(enrichArgs(['run', 'hi', '--model=x/y'], {} as never)).toEqual(['run', '--standalone', 'hi', '--model=x/y']);
  });
});

/**
 * CodeMie injects its provider config through OPENCODE_CONFIG_CONTENT, which
 * OpenCode 2.x reads only on the path where it starts the server itself. Without
 * an isolated server the CLI attaches to whatever managed service happens to be
 * running, and a server started by a plain `opencode` launch keeps its own
 * catalogue — the session then serves models no profile configured.
 */
describe('OpenCode enrichArgs — isolated server', () => {
  const enrichArgs = OpenCodePluginMetadata.lifecycle!.enrichArgs!;

  it.each(['v1', ''])('does not inject a v2-only flag for resolved version %s', version => {
    vi.stubEnv(RESOLVED_VERSION, version);
    expect(enrichArgs([], {} as never)).toEqual([]);
    expect(enrichArgs(['run', 'hi'], {} as never)).toEqual(['run', 'hi']);
    expect(enrichArgs(['--task', 'hi'], {} as never)).toEqual(['run', 'hi']);
  });

  it('adds --standalone to the bare TUI invocation', () => {
    expect(enrichArgs([], {} as never)).toEqual(['--standalone']);
    expect(enrichArgs(['--print-logs'], {} as never)).toEqual(['--print-logs', '--standalone']);
  });

  it('adds --standalone to server-backed subcommands, right after the subcommand', () => {
    expect(enrichArgs(['run', 'hi'], {} as never)).toEqual(['run', '--standalone', 'hi']);
    expect(enrichArgs(['mini'], {} as never)).toEqual(['mini', '--standalone']);
  });

  it('adds --standalone to the run that --task expands into', () => {
    expect(enrichArgs(['--task', 'hi'], {} as never)).toEqual(['run', '--standalone', 'hi']);
  });

  it('leaves subcommands that never reach a server alone', () => {
    for (const subcommand of ['config', 'init', 'help', 'version']) {
      expect(enrichArgs([subcommand], {} as never)).toEqual([subcommand]);
    }
  });

  it('never duplicates a user-supplied --standalone', () => {
    expect(enrichArgs(['--standalone'], {} as never)).toEqual(['--standalone']);
    expect(enrichArgs(['run', '--standalone', 'hi'], {} as never)).toEqual(['run', '--standalone', 'hi']);
  });

  it('stands aside for an explicit --server, which v2 refuses to combine with --standalone', () => {
    expect(enrichArgs(['run', '--server', 'http://127.0.0.1:1234', 'hi'], {} as never))
      .toEqual(['run', '--server', 'http://127.0.0.1:1234', 'hi']);
    expect(enrichArgs(['--server=http://127.0.0.1:1234'], {} as never))
      .toEqual(['--server=http://127.0.0.1:1234']);
  });
});

describe('OpenCode v2 effort — shouldApply gate', () => {
  const gate = OpenCodePluginMetadata.reasoningEffort!.shouldApply!;

  it('allows injection on a v1 binary', async () => {
    process.env.CODEMIE_OPENCODE_CONFIG_VERSION = '1';

    await expect(gate(['run', 'hi'], {} as NodeJS.ProcessEnv)).resolves.toBe(true);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it.each(['-m', '--model', '--model='])('skips quietly only for the final matching %s reference', async flag => {
    const ref = 'codemie-proxy/chat-reasoner#high';
    const env = { [EFFORT_MARKER]: '1', [MODEL_REF]: ref };
    const args = flag.endsWith('=') ? ['run', `${flag}${ref}`, 'hi'] : ['run', flag, ref, 'hi'];

    await expect(gate(args, env)).resolves.toBe(false);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it.each(['-m', '--model', '--model='])('warns when an explicit different %s wins', async flag => {
    const env = { [EFFORT_MARKER]: '1', [MODEL_REF]: 'codemie-proxy/chat-reasoner#high' };
    const args = flag.endsWith('=') ? ['run', `${flag}other/model`] : ['run', flag, 'other/model'];
    await expect(gate(args, env)).resolves.toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('did not override'));
  });

  it('does not accept a marker without a reference as delivery', async () => {
    await gate(['run', 'hi'], { [EFFORT_MARKER]: '1' });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('could not be applied'));
  });

  it('does not read a model flag from positional prompt content after --', async () => {
    const ref = 'codemie-proxy/chat-reasoner#high';
    await gate(['run', '--', '--model', ref], { [EFFORT_MARKER]: '1', [MODEL_REF]: ref });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('did not override'));
  });

  it('uses the last effective model flag rather than an earlier matching flag', async () => {
    const ref = 'codemie-proxy/chat-reasoner#high';
    await gate(['run', '-m', ref, '--model=other/model'], { [EFFORT_MARKER]: '1', [MODEL_REF]: ref });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('did not override'));
  });

  it('warns for a bare TUI even when a configured effort marker is present', async () => {
    await gate([], { [EFFORT_MARKER]: '1', [MODEL_REF]: 'codemie-proxy/chat-reasoner#high' });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('In the TUI'));
  });

  it('prioritizes an unsupported explicit --variant warning over matching markers', async () => {
    const ref = 'codemie-proxy/chat-reasoner#high';
    await gate(['run', '-m', ref, '--variant=high'], { [EFFORT_MARKER]: '1', [MODEL_REF]: ref });
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('--variant is not supported'));
  });

  it.each([undefined, 'invalid-url'])('clears stale markers before early return for %s', async baseUrl => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(), CODEMIE_BASE_URL: baseUrl,
      [EFFORT_MARKER]: '1', [MODEL_REF]: 'old/model#max',
    };
    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);
    expect(env[EFFORT_MARKER]).toBe('');
    expect(env[MODEL_REF]).toBe('');
    expect(env[RESOLVED_VERSION]).toBe('v2');
  });

  it.each(['chat-reasoner', 'resp-reasoner'])('preserves per-million pricing for %s', async id => {
    vi.mocked(fetchDynamicModelConfigs).mockResolvedValue({
      [id]: modelConfig(id, {
        reasoning: true, use_responses_api: id === 'resp-reasoner',
        cost: { input: 2.5, output: 12, cache_read: 0 },
      }),
    });
    const emitted = proxyModels(await emitV2({ ...baseEnv(), CODEMIE_MODEL: id }));
    expect(emitted[id].cost).toEqual({ input: 2.5, output: 12, cache: { read: 0 } });
  });

  it('does not invent cache pricing when a model has only input/output rates', async () => {
    const emitted = proxyModels(await emitV2(baseEnv()));
    expect(emitted['chat-reasoner'].cost).toEqual({ input: 0, output: 0 });
    expect(emitted['resp-reasoner'].cost).toEqual({ input: 0, output: 0 });
  });

  it('skips loudly when the effort was not honored', async () => {
    await expect(gate(['run', 'hi'], {} as NodeJS.ProcessEnv)).resolves.toBe(false);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('could not be applied'));
  });

  it('warns specifically about a user-passed --variant flag on v2', async () => {
    await expect(gate(['run', 'hi', '--variant', 'high'], {} as NodeJS.ProcessEnv)).resolves.toBe(false);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('--variant is not supported'));
  });
});
