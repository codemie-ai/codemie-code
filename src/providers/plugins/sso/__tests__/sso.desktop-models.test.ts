/**
 * Claude Desktop model list tests
 * @group unit
 */
import { describe, expect, it } from 'vitest';
import {
  desktopExtraModelAlias,
  desktopModelDisplayName,
  resolveDesktopExtraModelId,
  withDesktopExtraModels,
  selectDesktopClaudeModels,
  toDesktopModels,
  type DesktopCatalogEntry,
} from '../sso.desktop-models.js';

const CLAUDE_TIERS = {
  simple: { model: 'claude-haiku-5-5' },
  medium: { model: 'claude-haiku-5-5' },
  complex: { model: 'claude-sonnet-5' },
  reasoning: { model: 'claude-sonnet-5' },
};

describe('toDesktopModels', () => {
  it('keeps a router whose tiers are all Claude, whatever its ID', () => {
    const models = toDesktopModels([
      { base_name: 'sy-signal-claude-v1', label: 'SY Signal Claude v1', is_router: true, tiers: CLAUDE_TIERS },
      { base_name: 'claude-router-standard', label: 'Claude Router Standard v1', is_router: true, tiers: CLAUDE_TIERS },
    ]);
    expect(models).toEqual([
      { id: 'sy-signal-claude-v1', label: 'SY Signal Claude v1', isRouter: true },
      { id: 'claude-router-standard', label: 'Claude Router Standard v1', isRouter: true },
    ]);
  });

  it('reads the tiers of a declared LiteLLM auto-router', () => {
    const models = toDesktopModels([
      { base_name: 'smart-router', litellm_router: { is_router: true, tiers: CLAUDE_TIERS } },
    ]);
    expect(models).toEqual([{ id: 'smart-router', label: undefined, isRouter: true }]);
  });

  it('drops a router that routes to a non-Claude model, even when its ID starts with claude-', () => {
    const entries: DesktopCatalogEntry[] = [
      { base_name: 'sy-signal-gpt-v1', is_router: true, tiers: { simple: { model: 'gpt-5-mini' } } },
      {
        base_name: 'claude-router-mixed',
        is_router: true,
        tiers: { simple: { model: 'gpt-5-mini' }, complex: { model: 'claude-sonnet-5' } },
      },
    ];
    expect(toDesktopModels(entries)).toEqual([]);
  });

  it('falls back to the ID when a router carries no tiers', () => {
    expect(toDesktopModels([{ id: 'claude-router-premium' }, { id: 'gpt-router' }]))
      .toEqual([{ id: 'claude-router-premium', label: undefined, isRouter: true }]);
  });

  it('skips disabled entries and non-Claude models, and prefers canonical over vertex IDs', () => {
    const models = toDesktopModels([
      { base_name: 'claude-sonnet-5', label: 'Bedrock Claude Sonnet 5' },
      { base_name: 'claude-sonnet-5-vertex' },
      { base_name: 'claude-opus-5', enabled: false },
      { base_name: 'gpt-5' },
    ]);
    expect(models).toEqual([{ id: 'claude-sonnet-5', label: 'Bedrock Claude Sonnet 5', isRouter: false }]);
  });
});

describe('selectDesktopClaudeModels', () => {
  it('puts the curated pick first, then routers, then every other model', () => {
    const selected = selectDesktopClaudeModels(toDesktopModels([
      { base_name: 'claude-opus-5', label: 'Bedrock Claude Opus 5' },
      { base_name: 'claude-opus-5-5', label: 'Bedrock Claude Opus 5.5' },
      { base_name: 'claude-sonnet-5' },
      { base_name: 'sy-signal-claude-v1', label: 'SY Signal Claude v1', is_router: true, tiers: CLAUDE_TIERS },
    ]));
    expect(selected).toEqual([
      { id: 'claude-opus-5-5', label: 'Bedrock Claude Opus 5.5', isRouter: false },
      { id: 'claude-sonnet-5', label: undefined, isRouter: false },
      { id: 'sy-signal-claude-v1', label: 'SY Signal Claude v1', isRouter: true },
      { id: 'claude-opus-5', label: 'Bedrock Claude Opus 5', isRouter: false },
    ]);
  });
});

describe('desktopModelDisplayName', () => {
  it('uses the CodeMie name for models and routers alike', () => {
    expect(desktopModelDisplayName({ id: 'claude-opus-5-5', label: 'Bedrock Claude Opus 5.5', isRouter: false }))
      .toBe('Bedrock Claude Opus 5.5');
    expect(desktopModelDisplayName({ id: 'claude-router-standard', label: 'Claude Router Standard v1', isRouter: true }))
      .toBe('Claude Router Standard v1');
  });

  it('derives a router name from its ID when CodeMie gives none', () => {
    expect(desktopModelDisplayName({ id: 'claude-router-premium', isRouter: true })).toBe('Router Premium');
  });

  it('leaves a nameless model to Desktop\'s own display name', () => {
    expect(desktopModelDisplayName({ id: 'claude-sonnet-5', label: '  ', isRouter: false })).toBeUndefined();
  });
});

describe('Desktop extra models (claude-x- alias)', () => {
  const grok = { base_name: 'grok-4.6', deployment_name: 'grok-4.6', label: 'Grok 4.6', enabled: true };
  const gemini = { base_name: 'gemini-3.1-pro', deployment_name: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', enabled: true };
  const lineup = [{ id: 'claude-router-standard', label: 'Claude Router Standard v1', isRouter: true }];

  describe('desktopExtraModelAlias', () => {
    it('is claude-x- followed by 10 hex characters, so it never names another model family', () => {
      expect(desktopExtraModelAlias('grok-4.6')).toMatch(/^claude-x-[0-9a-f]{10}$/);
    });

    it('is stable for the same model and differs between models', () => {
      expect(desktopExtraModelAlias('grok-4.6')).toBe(desktopExtraModelAlias('grok-4.6'));
      expect(desktopExtraModelAlias('grok-4.6')).not.toBe(desktopExtraModelAlias('gemini-3.1-pro'));
    });
  });

  describe('resolveDesktopExtraModelId', () => {
    it('maps an alias back to the extra model it was made from', () => {
      const alias = desktopExtraModelAlias('gemini-3.1-pro');
      expect(resolveDesktopExtraModelId(alias, ['grok-4.6', 'gemini-3.1-pro'])).toBe('gemini-3.1-pro');
    });

    it('returns undefined for an alias of a model the profile no longer lists', () => {
      expect(resolveDesktopExtraModelId(desktopExtraModelAlias('grok-4.6'), ['gemini-3.1-pro'])).toBeUndefined();
    });

    it('returns undefined for an ID that is not an alias', () => {
      expect(resolveDesktopExtraModelId('claude-sonnet-5', ['claude-sonnet-5'])).toBeUndefined();
    });
  });

  describe('withDesktopExtraModels', () => {
    it('appends extra models after the lineup under their alias, with the real name', () => {
      expect(withDesktopExtraModels(lineup, [grok, gemini], ['grok-4.6'])).toEqual([
        ...lineup,
        { id: desktopExtraModelAlias('grok-4.6'), label: 'Grok 4.6', isRouter: false },
      ]);
    });

    it('keeps the stored order and skips IDs the catalog no longer serves', () => {
      const ids = withDesktopExtraModels([], [grok, gemini], ['gemini-3.1-pro', 'gone-model', 'grok-4.6']).map((m) => m.id);
      expect(ids).toEqual([desktopExtraModelAlias('gemini-3.1-pro'), desktopExtraModelAlias('grok-4.6')]);
    });

    it('does not list a model twice when it is stored under two of its names', () => {
      expect(withDesktopExtraModels([], [grok], ['grok-4.6', 'Grok 4.6'])).toHaveLength(1);
    });

    it('leaves the lineup as is when nothing is selected', () => {
      expect(withDesktopExtraModels(lineup, [grok], [])).toEqual(lineup);
    });
  });
});
