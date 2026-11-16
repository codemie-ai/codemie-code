import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const CONFIG = {} as never;

/** The argv omp is spawned with: `enrichArgs` first, `flagMappings` applied to its output (as BaseAgentAdapter does). */
async function buildOmpArgv(args: string[]): Promise<string[]> {
  const { OmpPluginMetadata, prepareOmpInvocation } = await import('../omp.plugin.js');
  const { transformFlags } = await import('../../../core/flag-transform.js');
  const enriched = await OmpPluginMetadata.lifecycle!.enrichArgs!(prepareOmpInvocation(args), CONFIG);
  return transformFlags(enriched, OmpPluginMetadata.flagMappings, CONFIG);
}

describe('omp argv composition', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.CODEMIE_MODEL = 'claude-sonnet-4-6';
    delete process.env.CODEMIE_PROVIDER;
    delete process.env.CODEMIE_OMP_LEDGER_EXTENSION;
    delete process.env.CODEMIE_OMP_PROVIDERS_EXTENSION;
    process.env.CODEMIE_SESSION_ID = 'codemie-session';
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('selects the model as <provider>/<id> and loads no extension that was not installed', async () => {
    expect(await buildOmpArgv([])).toEqual(['--model', 'codemie-anthropic/claude-sonnet-4-6']);
  });

  it('prepends -e for each installed CodeMie extension, ledger first', async () => {
    process.env.CODEMIE_OMP_LEDGER_EXTENSION = '/home/u/.codemie/omp/extensions/codemie-metrics/index.js';
    process.env.CODEMIE_OMP_PROVIDERS_EXTENSION = '/home/u/.codemie/omp/extensions/codemie-providers/index.js';

    expect(await buildOmpArgv(['--task', 'say hi'])).toEqual([
      '-e', '/home/u/.codemie/omp/extensions/codemie-metrics/index.js',
      '-e', '/home/u/.codemie/omp/extensions/codemie-providers/index.js',
      '--model', 'codemie-anthropic/claude-sonnet-4-6',
      '-p', 'say hi',
    ]);
  });

  it('routes non-Claude models through the codemie-proxy provider and Ollama through ollama', async () => {
    process.env.CODEMIE_MODEL = 'gpt-5.4-2026-03-05';
    expect(await buildOmpArgv([])).toEqual(['--model', 'codemie-proxy/gpt-5.4-2026-03-05']);

    process.env.CODEMIE_PROVIDER = 'ollama';
    process.env.CODEMIE_MODEL = 'qwen3:8b';
    expect(await buildOmpArgv([])).toEqual(['--model', 'ollama/qwen3:8b']);
  });

  it('never injects --session-id, which omp does not have', async () => {
    expect(await buildOmpArgv([])).not.toContain('--session-id');
    expect(await buildOmpArgv(['--continue'])).not.toContain('--session-id');
  });

  it('rewrites --task to omp\'s -p', async () => {
    const argv = await buildOmpArgv(['--task', 'say hi']);
    expect(argv).not.toContain('--task');
    expect(argv.slice(-2)).toEqual(['-p', 'say hi']);
  });

  it('translates CodeMie\'s --resume <id> to omp\'s --resume=<id>', async () => {
    const argv = await buildOmpArgv(['--resume', 'abc123']);
    expect(argv).toContain('--resume=abc123');
    expect(argv).not.toContain('abc123');
    expect(argv).not.toContain('--resume');
  });

  it('leaves a user-supplied --resume=<id>, a bare --resume and -c alone', async () => {
    const { prepareOmpInvocation } = await import('../omp.plugin.js');
    expect(prepareOmpInvocation(['--resume=abc123'])).toEqual(['--resume=abc123']);
    expect(prepareOmpInvocation(['--resume', '--no-skills'])).toEqual(['--resume', '--no-skills']);
    expect(prepareOmpInvocation(['--resume'])).toEqual(['--resume']);
    expect(prepareOmpInvocation(['-c'])).toEqual(['-c']);
  });

  it('keeps the other arguments around a translated --resume', async () => {
    const { prepareOmpInvocation } = await import('../omp.plugin.js');
    expect(prepareOmpInvocation(['--no-skills', '--resume', 'abc', 'hello'])).toEqual([
      '--no-skills', '--resume=abc', 'hello',
    ]);
  });

  it('fails clearly when no model is configured', async () => {
    delete process.env.CODEMIE_MODEL;
    await expect(buildOmpArgv([])).rejects.toThrow(/codemie-omp/);
  });
});
