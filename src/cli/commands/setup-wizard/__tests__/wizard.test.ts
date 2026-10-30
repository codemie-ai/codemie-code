/**
 * Unit tests for the per-agent model setup wizard (EPMCDME-15641): the pure row builders
 * (src/cli/commands/setup-wizard/rows.ts) and the step flow (index.ts), driven through a
 * scripted screen runner instead of a TTY.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Identity chalk: styling calls return their text; color factories (rgb, bgRgb) return chalk again.
vi.mock('chalk', () => {
  const proxy: unknown = new Proxy(() => undefined, {
    get: () => proxy,
    apply: (_target, _this, args: unknown[]) => (typeof args[0] === 'string' ? args[0] : proxy),
  });
  return { default: proxy };
});

// Recommended ids first, then the rest, in input order; no extra decoration.
vi.mock('../../../../providers/integration/setup-ui.js', () => ({
  getAllModelChoices: (models: string[], _template: unknown, recommended?: Set<string>) =>
    [...models]
      .sort((a, b) => Number(recommended?.has(b) ?? false) - Number(recommended?.has(a) ?? false))
      .map(id => ({ name: id, value: id })),
}));

const agentRegistryMock = vi.hoisted(() => ({ getAgent: vi.fn(), getAllAgents: vi.fn() }));
vi.mock('../../../../agents/registry.js', () => ({ AgentRegistry: agentRegistryMock }));

import { classifyWithPredicate } from '../../../../agents/core/model-classify.js';
import {
  addExtraModels,
  buildActiveRows,
  buildAgentRows,
  buildCustomRow,
  buildModelRows,
  createDraft,
  finalizeDraft,
} from '../rows.js';
import { runAgentModelsWizard } from '../index.js';
import type { AgentDraft, AgentModelsWizardInput, ListScreenResult, ListScreenSpec } from '../types.js';

function agent(name: string, displayName: string, family?: RegExp, supportedProviders: string[] = []) {
  return {
    name,
    metadata: {
      name,
      displayName,
      supportedProviders,
      ...(family
        ? { classifyModel: (id: string, ctx?: { isRouter?: boolean }) => classifyWithPredicate(i => family.test(i), id, ctx) }
        : {}),
    },
  };
}

const agents = [
  agent('claude', 'Claude Code', /claude/i),
  agent('codex', 'Codex', /gpt/i, ['litellm']),
  agent('opencode', 'OpenCode'),
];

beforeEach(() => {
  agentRegistryMock.getAgent.mockImplementation((name: string) => agents.find(a => a.name === name));
  agentRegistryMock.getAllAgents.mockReturnValue(agents);
});

const catalog = ['claude-x', 'claude-y', 'gpt-5.4', 'sy-alias'];
const input = (overrides: Partial<AgentModelsWizardInput> = {}): AgentModelsWizardInput => ({
  models: catalog,
  provider: 'litellm',
  ...overrides,
});
const draft = (overrides: Partial<AgentDraft> = {}): AgentDraft => ({
  models: [],
  extra: [],
  confirmed: new Set(),
  ...overrides,
});

describe('buildAgentRows', () => {
  it('offers every agent, disabling those the provider cannot serve with the reason', () => {
    const rows = buildAgentRows(input({ provider: 'other', models: ['claude-x'] }));

    expect(rows.map(r => [r.id, r.disabled])).toEqual([
      ['claude', undefined],
      ['codex', 'not supported by other'],
      ['opencode', undefined],
    ]);
  });

  it('disables an agent with no compatible catalog model', () => {
    const rows = buildAgentRows(input({ models: ['claude-x'] }));

    expect(rows.find(r => r.id === 'codex')?.disabled).toBe('no compatible model on litellm');
  });

  it('without a catalog, only disables agents the provider does not support', () => {
    const rows = buildAgentRows(input({ models: [] }));

    expect(rows.every(r => !r.disabled)).toBe(true);
  });
});

describe('buildModelRows', () => {
  it('lists only the models the agent supports, tagging unverified routers', () => {
    const rows = buildModelRows('claude', input({ isRouter: id => id === 'sy-alias' }), draft());

    expect(rows.map(r => r.id)).toEqual(['claude-x', 'claude-y', 'sy-alias']);
    expect(rows.find(r => r.id === 'sy-alias')?.label).toContain('unverified');
  });

  it('lists every model for an agent without model rules', () => {
    expect(buildModelRows('opencode', input(), draft()).map(r => r.id)).toEqual(catalog);
  });

  it('includes typed ids, confirmed ones tagged unverified, and puts recommended ids first', () => {
    const rows = buildModelRows(
      'codex',
      input({ recommendedIds: new Set(['gpt-5.4']) }),
      draft({ extra: ['my-claude'], confirmed: new Set(['my-claude']) })
    );

    expect(rows.map(r => r.id)).toEqual(['gpt-5.4', 'my-claude']);
    expect(rows[1].label).toContain('unverified');
  });

  it('appends the search action row when the provider can search', () => {
    const rows = buildModelRows('opencode', input({ searchModel: async () => undefined }), draft());

    expect(rows[rows.length - 1]).toMatchObject({ id: '__search__', kind: 'action' });
  });
});

describe('buildCustomRow / addExtraModels', () => {
  it('offers a typed name, warning when the agent rules reject it', () => {
    expect(buildCustomRow('claude', input(), 'claude-new')).toMatchObject({ id: 'claude-new', detail: undefined });
    const row = buildCustomRow('claude', input(), 'gpt-x');
    expect(row?.detail).toContain('saved as unverified');
    expect(row?.addAs?.label).toContain('unverified');
    expect(buildCustomRow('claude', input(), '  ')).toBeUndefined();
  });

  it('records typed ids and confirms only those the agent rules reject', () => {
    const d = draft();

    addExtraModels('claude', input(), d, ['claude-new', 'gpt-x', 'claude-x']);

    expect(d.extra).toEqual(['claude-new', 'gpt-x']);
    expect([...d.confirmed]).toEqual(['gpt-x']);
  });
});

describe('createDraft / finalizeDraft / buildActiveRows', () => {
  it('starts from the existing per-agent set', () => {
    const d = createDraft('claude', input({
      existing: {
        provider: 'litellm',
        agentModels: { claude: { models: ['claude-x', 'typed'], model: 'typed', confirmedModels: ['typed'] } },
      },
    }));

    expect(d).toEqual({ models: ['claude-x', 'typed'], model: 'typed', extra: ['typed'], confirmed: new Set(['typed']) });
  });

  it('preselects a legacy active model only for agents that can use it', () => {
    const existing = { provider: 'litellm', model: 'claude-x' };

    expect(createDraft('claude', input({ existing })).models).toEqual(['claude-x']);
    expect(createDraft('codex', input({ existing })).models).toEqual([]);
  });

  it('starts empty when the update switches provider, even with an empty catalog', () => {
    const existing = {
      provider: 'ai-run-sso',
      model: 'claude-x',
      agentModels: { claude: { models: ['claude-x', 'typed'], model: 'claude-x' } },
    };

    expect(createDraft('claude', input({ existing, models: [] }))).toEqual({ models: [], extra: [], confirmed: new Set() });
    expect(createDraft('claude', input({ existing: { provider: 'ai-run-sso', model: 'claude-x' } })).models).toEqual([]);
  });

  it('falls back to the first model and confirms catalog routers the name rule rejects', () => {
    const set = finalizeDraft(
      'codex',
      input({ isRouter: id => id === 'sy-alias' }),
      draft({ models: ['gpt-5.4', 'sy-alias'], model: 'gone', confirmed: new Set(['dropped']) })
    );

    expect(set).toEqual({ models: ['gpt-5.4', 'sy-alias'], model: 'gpt-5.4', confirmedModels: ['sy-alias'] });
  });

  it('omits confirmedModels when nothing needed confirming', () => {
    expect(finalizeDraft('claude', input(), draft({ models: ['claude-x'], model: 'claude-x' })))
      .toEqual({ models: ['claude-x'], model: 'claude-x' });
  });

  it('offers the agent picked models as active-model rows', () => {
    const rows = buildActiveRows('codex', input(), draft({ models: ['gpt-5.4', 'my-claude'], confirmed: new Set(['my-claude']) }));

    expect(rows.map(r => r.id)).toEqual(['gpt-5.4', 'my-claude']);
    expect(rows[1].label).toContain('unverified');
  });
});

type Step = (spec: ListScreenSpec) => ListScreenResult;

/** Screen runner that answers each screen with the next scripted step and records the specs. */
function scripted(...steps: Step[]) {
  const specs: ListScreenSpec[] = [];
  const screen = async (spec: ListScreenSpec): Promise<ListScreenResult> => {
    specs.push(spec);
    const step = steps.shift();
    if (!step) throw new Error(`Unscripted screen: ${spec.title}`);
    return step(spec);
  };
  return { screen, specs };
}

const pick = (...selected: string[]): Step => () => ({ action: 'continue', selected, added: [] });
const back: Step = () => ({ action: 'back' });
const cancel: Step = () => ({ action: 'cancel' });

describe('runAgentModelsWizard', () => {
  it('walks agents, then each agent models and active model, then review', async () => {
    const { screen, specs } = scripted(
      pick('codex', 'claude'),
      pick('claude-y', 'claude-x'),
      pick('claude-y'),
      pick('gpt-5.4'),
      pick()
    );

    const result = await runAgentModelsWizard(input(), screen);

    expect(result).toEqual({
      claude: { models: ['claude-x', 'claude-y'], model: 'claude-y' },
      codex: { models: ['gpt-5.4'], model: 'gpt-5.4' },
    });
    expect(specs.map(s => s.title)).toEqual([
      'Which agents will use this profile?',
      'Claude Code · Models',
      'Claude Code · Active model',
      'Codex · Models',
      'Review',
    ]);
    expect(specs[1].stages).toEqual(['Agents', 'Claude Code', 'Codex', 'Review']);
    expect(specs[3].stageIndex).toBe(2);
    expect(specs[4].body?.join('\n')).toContain('claude-y (active)');
  });

  it('notes that a rule-free agent accepts any model', async () => {
    const { screen, specs } = scripted(pick('opencode'), pick('gpt-5.4'), pick());

    await runAgentModelsWizard(input(), screen);

    expect(specs[1].notes?.[0]).toContain('No model rules for OpenCode');
  });

  it('returns null on cancel and when stepping back out of the agents screen', async () => {
    expect(await runAgentModelsWizard(input(), scripted(pick('claude'), cancel).screen)).toBeNull();
    expect(await runAgentModelsWizard(input(), scripted(back).screen)).toBeNull();
  });

  it('steps back over a skipped active-model screen and keeps the draft', async () => {
    const { screen, specs } = scripted(
      pick('claude'),
      pick('claude-x'),
      back,
      pick('claude-x', 'claude-y'),
      pick('claude-y'),
      pick()
    );

    const result = await runAgentModelsWizard(input(), screen);

    expect(specs[3].title).toBe('Claude Code · Models');
    expect(specs[3].selected).toEqual(['claude-x']);
    expect(result).toEqual({ claude: { models: ['claude-x', 'claude-y'], model: 'claude-y' } });
  });

  it('rebuilds the steps when the agent selection changes after going back', async () => {
    const { screen } = scripted(
      pick('claude'),
      back,
      pick('codex'),
      pick('gpt-5.4'),
      pick()
    );

    expect(await runAgentModelsWizard(input(), screen)).toEqual({ codex: { models: ['gpt-5.4'], model: 'gpt-5.4' } });
  });

  it('confirms a typed model the agent rules reject', async () => {
    const { screen } = scripted(
      pick('claude'),
      () => ({ action: 'continue', selected: ['gpt-x'], added: ['gpt-x'] }),
      pick()
    );

    expect(await runAgentModelsWizard(input(), screen)).toEqual({
      claude: { models: ['gpt-x'], model: 'gpt-x', confirmedModels: ['gpt-x'] },
    });
  });

  it('runs the provider search from its action row and reopens the models screen with the result', async () => {
    const searchModel = vi.fn().mockResolvedValue('llama3');
    const { screen, specs } = scripted(
      pick('opencode'),
      () => ({ action: 'row', id: '__search__', selected: ['gpt-5.4'], added: [] }),
      pick('gpt-5.4', 'llama3'),
      pick('llama3'),
      pick()
    );

    const result = await runAgentModelsWizard(input({ searchModel }), screen);

    expect(searchModel).toHaveBeenCalledTimes(1);
    expect(specs[2].selected).toEqual(['gpt-5.4', 'llama3']);
    expect(specs[2].rows.map(r => r.id)).toContain('llama3');
    expect(result).toEqual({ opencode: { models: ['gpt-5.4', 'llama3'], model: 'llama3' } });
  });

  it('preselects the existing agents and models on an update', async () => {
    const existing = {
      provider: 'litellm',
      model: 'gpt-5.4',
      agentModels: { codex: { models: ['gpt-5.4'], model: 'gpt-5.4' } },
    };
    const { screen, specs } = scripted(pick('codex'), pick('gpt-5.4'), pick());

    await runAgentModelsWizard(input({ existing }), screen);

    expect(specs[0].selected).toEqual(['codex']);
    expect(specs[1].selected).toEqual(['gpt-5.4']);
  });

  it('keeps the agents but not the old models when the update switches to a provider with no catalog', async () => {
    const existing = {
      provider: 'ai-run-sso',
      model: 'gpt-5.4',
      agentModels: { codex: { models: ['gpt-5.4', 'gpt-6-luna'], model: 'gpt-5.4' } },
    };
    const { screen, specs } = scripted(pick('codex'), pick('gpt-x'), pick());

    await runAgentModelsWizard(input({ existing, models: [] }), screen);

    expect(specs[0].selected).toEqual(['codex']);
    expect(specs[1].selected).toEqual([]);
    expect(specs[1].rows.map(r => r.id)).toEqual([]);
  });

  it('validates that each screen has a selection', async () => {
    const { screen, specs } = scripted(pick('claude'), pick('claude-x'), pick());

    await runAgentModelsWizard(input(), screen);

    expect(specs[0].validate?.([])).toBe('Select at least one agent.');
    expect(specs[1].validate?.([])).toBe('Select at least one model for Claude Code.');
    expect(specs[1].validate?.(['claude-x'])).toBeUndefined();
  });
});

describe('runAgentModelsWizard — agents that always run on their active model', () => {
  const gemini = {
    ...agent('gemini', 'Gemini CLI', /gemini/i),
    metadata: { ...agent('gemini', 'Gemini CLI', /gemini/i).metadata, activeModelOnly: true },
  };
  const withGemini = [...agents, gemini];
  const geminiCatalog = [...catalog, 'gemini-3', 'gemini-3-flash'];

  beforeEach(() => {
    agentRegistryMock.getAgent.mockImplementation((name: string) => withGemini.find(a => a.name === name));
    agentRegistryMock.getAllAgents.mockReturnValue(withGemini);
  });

  it('asks only for the active model, picked from the models the agent supports', async () => {
    const { screen, specs } = scripted(pick('claude', 'gemini'), pick('claude-x'), pick('gemini-3-flash'), pick());

    const result = await runAgentModelsWizard(input({ models: geminiCatalog }), screen);

    expect(specs.map(s => s.title)).toEqual([
      'Which agents will use this profile?',
      'Claude Code · Models',
      'Gemini CLI · Active model',
      'Review',
    ]);
    expect(specs[2]).toMatchObject({ mode: 'single', searchable: true });
    expect(specs[2].rows.map(r => r.id)).toEqual(['gemini-3', 'gemini-3-flash']);
    expect(specs[2].notes?.[0]).toContain('no in-session model menu');
    expect(specs[2].notes?.[0]).toContain('codemie models switch --agent gemini');
    expect(specs[2].validate?.([])).toBe('Select the active model for Gemini CLI.');
    expect(result).toEqual({
      claude: { models: ['claude-x'], model: 'claude-x' },
      gemini: { models: ['gemini-3-flash'], model: 'gemini-3-flash' },
    });
  });

  it('saves a typed model as the only model, confirming one the agent rules reject', async () => {
    const { screen } = scripted(
      pick('gemini'),
      () => ({ action: 'continue', selected: ['my-model'], added: ['my-model'] }),
      pick()
    );

    expect(await runAgentModelsWizard(input({ models: geminiCatalog }), screen)).toEqual({
      gemini: { models: ['my-model'], model: 'my-model', confirmedModels: ['my-model'] },
    });
  });

  it('runs the provider search from its action row and preselects the result', async () => {
    const searchModel = vi.fn().mockResolvedValue('gemini-local');
    const { screen, specs } = scripted(
      pick('gemini'),
      () => ({ action: 'row', id: '__search__', selected: [], added: [] }),
      pick('gemini-local'),
      pick()
    );

    const result = await runAgentModelsWizard(input({ models: geminiCatalog, searchModel }), screen);

    expect(specs[2].selected).toEqual(['gemini-local']);
    expect(specs[2].rows.map(r => r.id)).toContain('gemini-local');
    expect(result).toEqual({ gemini: { models: ['gemini-local'], model: 'gemini-local' } });
  });

  it('keeps only the active model of an existing set on an update', async () => {
    const existing = {
      provider: 'litellm',
      model: 'gemini-3',
      agentModels: { gemini: { models: ['gemini-3', 'gemini-3-flash'], model: 'gemini-3' } },
    };

    expect(createDraft('gemini', input({ models: geminiCatalog, existing }))).toEqual({
      models: ['gemini-3'],
      model: 'gemini-3',
      extra: [],
      confirmed: new Set(),
    });
  });
});
