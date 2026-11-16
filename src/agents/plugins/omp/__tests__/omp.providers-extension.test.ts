/**
 * The providers extension (`../extension/index.js`) runs inside omp, where a throw can end the
 * user's session. Drives the real file against a hand-rolled omp API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Registered {
  name: string;
  config: Record<string, unknown>;
}

let dir: string;

async function activate(...custom: [unknown?]): Promise<Registered[]> {
  const module = await import('../extension/index.js');
  const registered: Registered[] = [];
  const pi = custom.length > 0 ? custom[0] : { registerProvider: (name: string, config: Registered['config']) => registered.push({ name, config }) };
  (module.default as (pi: unknown) => void)(pi);
  return registered;
}

function writeConfig(content: unknown): string {
  const path = join(dir, 'providers.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  process.env.CODEMIE_OMP_PROVIDERS = path;
  return path;
}

const model = { id: 'gpt-5.4', name: 'GPT 5.4', input: ['text'], contextWindow: 1000, maxTokens: 100, reasoning: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omp-providers-'));
  delete process.env.CODEMIE_OMP_PROVIDERS;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CODEMIE_OMP_PROVIDERS;
});

describe('providers extension', () => {
  it('registers every provider from the JSON file', async () => {
    writeConfig({
      providers: {
        'codemie-proxy': { baseUrl: 'http://127.0.0.1:4000/v1', api: 'openai-completions', apiKey: 'k', models: [model] },
        'codemie-anthropic': { baseUrl: 'http://127.0.0.1:4000', api: 'anthropic-messages', apiKey: 'k', authHeader: true, models: [{ ...model, id: 'claude-x' }] },
      },
    });

    const registered = await activate();

    expect(registered.map((r) => r.name)).toEqual(['codemie-proxy', 'codemie-anthropic']);
    expect(registered[0].config).toEqual({
      baseUrl: 'http://127.0.0.1:4000/v1', apiKey: 'k', api: 'openai-completions', models: [model],
    });
    expect(registered[1].config.authHeader).toBe(true);
  });

  it('hands omp only the model fields it understands', async () => {
    writeConfig({
      providers: {
        p: { baseUrl: 'http://x/v1', api: 'openai-completions', models: [{ ...model, thinkingLevelMap: { off: null }, unknown: 1 }] },
      },
    });

    const [{ config }] = await activate();

    expect((config.models as unknown[])[0]).toEqual(model);
    expect(config.apiKey).toBe('proxy-handled');
  });

  it('forwards provider-level and model-level compat when it is a plain object', async () => {
    writeConfig({
      providers: {
        p: {
          baseUrl: 'http://x/v1', api: 'openai-completions', compat: { supportsReasoningEffort: true },
          models: [{ ...model, compat: { forceAdaptiveThinking: true } }, { ...model, id: 'b', compat: [1] }, { ...model, id: 'c' }],
        },
        bad: { baseUrl: 'http://x/v1', api: 'openai-completions', compat: 'nope', models: [model] },
      },
    });

    const [{ config }, { config: bad }] = await activate();
    const models = config.models as Record<string, unknown>[];

    expect(config.compat).toEqual({ supportsReasoningEffort: true });
    expect(models[0].compat).toEqual({ forceAdaptiveThinking: true });
    expect(models[1]).toEqual({ ...model, id: 'b' });
    expect(models[2]).toEqual({ ...model, id: 'c' });
    expect(bad).not.toHaveProperty('compat');
  });

  it.each([
    ['no env var', undefined],
    ['a missing file', '/nonexistent/providers.json'],
    ['invalid JSON', '{{{ not json'],
    ['a non-object root', '[1,2]'],
    ['no providers key', '{}'],
    ['providers that is not an object', '{"providers": 3}'],
  ])('registers nothing and does not throw for %s', async (_label, input) => {
    if (input === undefined) delete process.env.CODEMIE_OMP_PROVIDERS;
    else if (input.startsWith('/')) process.env.CODEMIE_OMP_PROVIDERS = input;
    else writeConfig(input);

    expect(await activate()).toEqual([]);
  });

  it('skips malformed providers and models without costing the valid ones', async () => {
    writeConfig({
      providers: {
        junk: 'x',
        noUrl: { api: 'openai-completions', models: [model] },
        noModels: { baseUrl: 'http://x', api: 'openai-completions', models: [] },
        badModels: { baseUrl: 'http://x', api: 'openai-completions', models: [null, 4, { name: 'no id' }] },
        good: { baseUrl: 'http://x', api: 'openai-completions', models: [null, model] },
      },
    });

    const registered = await activate();

    expect(registered.map((r) => r.name)).toEqual(['good']);
    expect(registered[0].config.models).toEqual([model]);
  });

  it('keeps registering after one provider\'s registration throws', async () => {
    writeConfig({
      providers: {
        first: { baseUrl: 'http://x', api: 'openai-completions', models: [model] },
        second: { baseUrl: 'http://y', api: 'openai-completions', models: [model] },
      },
    });
    const names: string[] = [];
    const api = {
      registerProvider: (name: string) => {
        if (name === 'first') throw new Error('rejected');
        names.push(name);
      },
    };

    await activate(api);

    expect(names).toEqual(['second']);
  });

  it('does not throw when the omp API is hostile or absent', async () => {
    writeConfig({ providers: { p: { baseUrl: 'http://x', api: 'openai-completions', models: [model] } } });

    await expect(activate({})).resolves.toEqual([]);
    await expect(activate(null)).resolves.toEqual([]);
    await expect(activate({ get registerProvider(): never { throw new Error('boom'); } })).resolves.toEqual([]);
  });
});
