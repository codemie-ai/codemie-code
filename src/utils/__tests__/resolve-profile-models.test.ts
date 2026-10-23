/**
 * Unit tests for the per-agent model helpers (src/utils/config.ts).
 *
 * resolveProfileModels normalizes a profile's model list at read time: a
 * legacy profile (no `agentModels`) is read as `[model]`, and a per-agent
 * profile yields one agent's own models, or the union of every agent's.
 */

import { describe, it, expect } from 'vitest';
import { resolveAgentModelSet, resolveProfileModels, withAgentModelView } from '../config.js';

const perAgent = {
  model: 'claude-x',
  agentModels: {
    claude: { models: ['claude-x', 'claude-y'], model: 'claude-x' },
    codex: { models: ['gpt-5.4'], model: 'gpt-5.4', confirmedModels: ['gpt-5.4'] },
    opencode: { models: ['claude-y', 'gpt-5.4'], model: 'gpt-5.4' },
  },
};

describe('resolveProfileModels', () => {
  it('falls back to [model] for a legacy profile', () => {
    expect(resolveProfileModels({ model: 'a' })).toEqual(['a']);
  });

  it('returns an empty array when no model is set', () => {
    expect(resolveProfileModels({})).toEqual([]);
  });

  it('returns the union of every agent model, in agent order, without an agent', () => {
    expect(resolveProfileModels(perAgent)).toEqual(['claude-x', 'claude-y', 'gpt-5.4']);
  });

  it('returns only the agent own models, folding ACP variants', () => {
    expect(resolveProfileModels(perAgent, 'claude')).toEqual(['claude-x', 'claude-y']);
    expect(resolveProfileModels(perAgent, 'codex-acp')).toEqual(['gpt-5.4']);
  });

  it('reads an agent the profile does not configure as [model]', () => {
    expect(resolveProfileModels(perAgent, 'pi')).toEqual(['claude-x']);
  });

  it('ignores the agent on a legacy profile', () => {
    expect(resolveProfileModels({ model: 'a' }, 'claude')).toEqual(['a']);
  });
});

describe('resolveAgentModelSet', () => {
  it('returns the agent set, folding ACP variants, or undefined', () => {
    expect(resolveAgentModelSet(perAgent, 'opencode-acp')?.model).toBe('gpt-5.4');
    expect(resolveAgentModelSet(perAgent, 'pi')).toBeUndefined();
    expect(resolveAgentModelSet({}, 'claude')).toBeUndefined();
  });
});

describe('withAgentModelView', () => {
  it('narrows the profile to the agent active model and own list', () => {
    const view = withAgentModelView(perAgent, 'opencode');
    expect(view.model).toBe('gpt-5.4');
    expect(resolveProfileModels(view)).toEqual(['claude-y', 'gpt-5.4']);
    expect(Object.keys(view.agentModels ?? {})).toEqual(['opencode']);
  });

  it('keeps the top-level model and an empty map for an agent the profile does not configure', () => {
    const view = withAgentModelView(perAgent, 'pi');
    expect(view.model).toBe('claude-x');
    expect(view.agentModels).toEqual({});
    expect(resolveProfileModels(view)).toEqual(['claude-x']);
  });

  it('returns a legacy profile unchanged', () => {
    const legacy = { model: 'a' };
    expect(withAgentModelView(legacy, 'claude')).toBe(legacy);
  });

  it('does not mutate the source profile', () => {
    withAgentModelView(perAgent, 'codex');
    expect(perAgent.model).toBe('claude-x');
    expect(Object.keys(perAgent.agentModels)).toHaveLength(3);
  });
});
