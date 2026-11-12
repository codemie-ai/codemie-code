/**
 * Claude Desktop model list tests
 * @group unit
 */
import { describe, expect, it } from 'vitest';
import {
  desktopModelDisplayName,
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
  it('keeps one model per family plus every router, with their names', () => {
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
