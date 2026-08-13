import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const CONFIG = {} as never;

/**
 * Reproduce the argv Pi is actually spawned with. `BaseAgentAdapter` runs the
 * `enrichArgs` hook first and applies `flagMappings` to its output, so testing
 * either half alone would miss the bug this file guards against: `--task` was
 * consumed by `enrichArgs`, leaving nothing for the mapping to rewrite.
 */
async function buildPiArgv(args: string[]): Promise<string[]> {
  const { PiPluginMetadata } = await import('../pi.plugin.js');
  const { transformFlags } = await import('../../../core/flag-transform.js');
  const enriched = await PiPluginMetadata.lifecycle!.enrichArgs!(args, CONFIG);
  return transformFlags(enriched, PiPluginMetadata.flagMappings, CONFIG);
}

describe('pi argv composition', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.CODEMIE_MODEL = 'claude-sonnet-4-6';
    delete process.env.CODEMIE_SESSION_ID;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('rewrites --task to Pi\'s non-interactive -p, keeping the prompt adjacent', async () => {
    const argv = await buildPiArgv(['--task', 'say hi']);

    // Pi's parser only adopts the prompt as a message when it directly follows -p.
    expect(argv).toContain('-p');
    expect(argv[argv.indexOf('-p') + 1]).toBe('say hi');
    expect(argv).not.toContain('--task');
  });

  it('never leaves the prompt as a bare positional', async () => {
    process.env.CODEMIE_SESSION_ID = 'codemie-session';
    const argv = await buildPiArgv(['--task', 'say hi']);

    // A trailing positional is Pi's "interactive session with an opening prompt",
    // which takes over the terminal and never exits — the bug this guards.
    expect(argv[argv.length - 1]).not.toBe('say hi');
    expect(argv.indexOf('-p')).toBe(argv.indexOf('say hi') - 1);
  });

  it('keeps -p and its prompt adjacent when a session id is injected', async () => {
    process.env.CODEMIE_SESSION_ID = 'codemie-session';
    const argv = await buildPiArgv(['--task', 'say hi']);

    expect(argv[argv.indexOf('-p') + 1]).toBe('say hi');
    expect(argv).toContain('--session-id');
    expect(argv[argv.indexOf('--session-id') + 1]).toBe('codemie-session');
  });

  it('leaves an interactive run without -p', async () => {
    const argv = await buildPiArgv([]);

    expect(argv).not.toContain('-p');
    expect(argv).toEqual(['--provider', 'codemie-anthropic', '--model', 'claude-sonnet-4-6']);
  });

  it('suppresses --session-id when argv already selects a session', async () => {
    process.env.CODEMIE_SESSION_ID = 'codemie-session';
    const argv = await buildPiArgv(['--continue', '--task', 'say hi']);

    expect(argv).not.toContain('--session-id');
    expect(argv[argv.indexOf('-p') + 1]).toBe('say hi');
  });

  it('forwards a resolved session directory', async () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = '/tmp/pi-sessions';
    const argv = await buildPiArgv(['--task', 'say hi']);

    expect(argv[argv.indexOf('--session-dir') + 1]).toBe('/tmp/pi-sessions');
  });

  it('fails loudly when no model is configured', async () => {
    delete process.env.CODEMIE_MODEL;
    await expect(buildPiArgv(['--task', 'say hi'])).rejects.toThrow(/model/i);
  });
});
