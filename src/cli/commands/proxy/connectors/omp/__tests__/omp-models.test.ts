import { describe, expect, it } from 'vitest';
import type { LlmModel } from '@/providers/plugins/sso/sso.http-client.js';
import { buildOmpModelRoster } from '../omp-models.js';

function model(overrides: Partial<LlmModel>): LlmModel {
  return {
    base_name: 'model',
    deployment_name: 'model',
    label: 'Model',
    enabled: true,
    ...overrides,
  };
}

describe('buildOmpModelRoster', () => {
  it.each([
    ['claude-sonnet-5', 'anthropic'],
    ['anthropic.claude-opus-4-7', 'anthropic'],
    ['us.anthropic.claude-haiku-4-5', 'anthropic'],
    ['gpt-5.6-sol-2026-07-09', 'openai'],
    ['gpt-4.1', 'openai'],
  ] as const)('routes %s to %s with the matching wire API', (id, provider) => {
    const roster = buildOmpModelRoster([model({ base_name: id, deployment_name: id })]);
    const rows = roster[provider];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      api: provider === 'anthropic'
        ? 'anthropic-messages'
        : id.startsWith('gpt-5') ? 'openai-responses' : 'openai-completions',
    });
    expect(roster[provider === 'anthropic' ? 'openai' : 'anthropic']).toHaveLength(0);
  });

  it('routes homogeneous Claude routers to Anthropic and mixed-family routers to OpenAI', () => {
    const roster = buildOmpModelRoster([
      model({ base_name: 'claude-router', deployment_name: 'claude-router', tiers: {
        simple: { model: 'claude-haiku-4-5' }, medium: { model: 'claude-sonnet-5' },
        complex: { model: 'claude-sonnet-5' }, reasoning: { model: 'claude-opus-4-7' },
      } }),
      model({ base_name: 'mixed-router', deployment_name: 'mixed-router', tiers: {
        simple: { model: 'claude-haiku-4-5' }, medium: { model: 'gpt-5.6-luna' },
        complex: { model: 'claude-sonnet-5' }, reasoning: { model: 'gpt-6-luna' },
      } }),
    ]);
    expect(roster.anthropic.map(({ id }) => id)).toEqual(['claude-router']);
    expect(roster.openai.map(({ id }) => id)).toEqual(['mixed-router']);
  });

  it('uses the router name when its tier targets are missing', () => {
    const roster = buildOmpModelRoster([model({ base_name: 'sy-signal-claude-v2', deployment_name: 'sy-signal-claude-v2' })]);
    expect(roster.anthropic.map(({ id }) => id)).toEqual(['sy-signal-claude-v2']);
  });

  it('filters image, embedding, disabled, duplicate and nameless catalog rows', () => {
    const roster = buildOmpModelRoster([
      model({ deployment_name: 'image-gen', supports_image_generation: true }),
      model({ base_name: 'text-embedding-3-large', deployment_name: 'text-embedding-3-large' }),
      model({ deployment_name: 'disabled', enabled: false }),
      model({ deployment_name: 'duplicate' }),
      model({ deployment_name: 'duplicate', label: 'Second' }),
      model({ base_name: '', deployment_name: '' }),
    ]);
    expect(roster.openai.map(({ id }) => id)).toEqual(['duplicate']);
  });

  it('converts costs and uses catalog limits with router tier caps', () => {
    const roster = buildOmpModelRoster([
      model({ deployment_name: 'cost', cost: { input: 1e-7, output: 3e-6 }, max_input_tokens: 64000, max_output_tokens: 8192 }),
      model({ deployment_name: 'default' }),
      model({ deployment_name: 'small-cap', max_output_tokens: 128000 }),
      model({ deployment_name: 'large-cap', max_output_tokens: 64000 }),
      model({ deployment_name: 'known-cap', max_output_tokens: 100000 }),
      model({ base_name: 'router-min', deployment_name: 'router-min', tiers: {
        simple: { model: 'small-cap' }, medium: { model: 'large-cap' },
        complex: { model: 'small-cap' }, reasoning: { model: 'large-cap' },
      } }),
      model({ base_name: 'router-unknown', deployment_name: 'router-unknown', tiers: {
        simple: { model: 'unknown-a' }, medium: { model: 'unknown-b' },
        complex: { model: 'unknown-a' }, reasoning: { model: 'unknown-b' },
      } }),
      model({ base_name: 'router-partial', deployment_name: 'router-partial', tiers: {
        simple: { model: 'known-cap' }, medium: { model: 'unknown' },
        complex: { model: 'unknown' }, reasoning: { model: 'unknown' },
      } }),
    ]);
    expect(roster.openai.find(({ id }) => id === 'cost')).toMatchObject({
      cost: { input: 0.1, output: 3, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 8192,
    });
    expect(roster.openai.find(({ id }) => id === 'default')).toMatchObject({ contextWindow: 128000, maxTokens: 32000 });
    expect(roster.openai.find(({ id }) => id === 'router-min')?.maxTokens).toBe(64000);
    expect(roster.openai.find(({ id }) => id === 'router-unknown')?.maxTokens).toBe(32000);
    expect(roster.openai.find(({ id }) => id === 'router-partial')?.maxTokens).toBe(100000);
  });

  it('marks reasoning only for the supported families and homogeneous reasoning routers', () => {
    const ids = ['claude-sonnet-5', 'gpt-5-2025-08-07', 'gpt-6-luna', 'openai.gpt-6-luna', 'o1', 'o3-mini', 'o4-mini-2025-04-16', 'gemini-3.1-pro', 'gpt-4.1', 'qwen.qwen3-coder-30b-a3b-v1', 'grok-4.6', 'deepseek-v4-pro'];
    const roster = buildOmpModelRoster(ids.map(id => model({ base_name: id, deployment_name: id })));
    const byId = new Map([...roster.openai, ...roster.anthropic].map(row => [row.id, row.reasoning]));
    for (const id of ids.slice(0, 8)) expect(byId.get(id), id).toBe(true);
    for (const id of ids.slice(8)) expect(byId.get(id), id).toBe(false);
    const routers = buildOmpModelRoster([
      model({ deployment_name: 'gpt-router', tiers: {
        simple: { model: 'gpt-5.6-luna' }, medium: { model: 'gpt-6-luna' },
        complex: { model: 'gpt-5.6-luna' }, reasoning: { model: 'gpt-6-luna' },
      } }),
      model({ deployment_name: 'gpt4-router', tiers: {
        simple: { model: 'gpt-4.1' }, medium: { model: 'gpt-4.1' },
        complex: { model: 'gpt-4.1' }, reasoning: { model: 'gpt-4.1' },
      } }),
    ]);
    expect(routers.openai.map(({ reasoning }) => reasoning)).toEqual([true, false]);
  });
});
