/**
 * Deterministic render test for renderModelSwitchSelectionUI
 * (src/cli/commands/models-switch-prompt.ts).
 *
 * CR-005: the models-switch-prompt.ts UI was previously fully mocked out in
 * its only consuming test (models-switch.test.ts mocks promptModelSwitchSelection
 * entirely), so a regression in the render itself - wrong model marked active,
 * cursor on the wrong row, a dropped model - would ship with no test failing.
 * This pins the pure render function's actual output shape.
 */

import { describe, it, expect } from 'vitest';
import { renderModelSwitchSelectionUI } from '../models-switch-prompt.js';
import { SYMBOL } from '../shared/selection/constants.js';

describe('renderModelSwitchSelectionUI', () => {
  const models = ['gpt-5-codex', 'gpt-5-mini', 'claude-sonnet-4-5'];

  it('renders every model exactly once, in order', () => {
    const output = renderModelSwitchSelectionUI({
      message: 'Select a model to switch to:',
      models,
      activeModel: 'gpt-5-mini',
      cursorIndex: 0,
    });

    expect(output).toContain('Select a model to switch to:');
    for (const id of models) {
      expect(output.split(id)).toHaveLength(2); // exactly one occurrence
    }

    const indices = models.map(id => output.indexOf(id));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it('marks only the active model row with the filled-circle marker', () => {
    const output = renderModelSwitchSelectionUI({
      message: 'Select a model to switch to:',
      models,
      activeModel: 'gpt-5-mini',
      cursorIndex: 0,
    });

    // buildSingleChoiceRow (shared/selection/ui.ts) marks a selected row with
    // the literal '●' glyph (not the SYMBOL.CIRCLE_FILLED constant, which is
    // a different glyph used by the unrelated buildSelectionRow).
    const lines = output.split('\n');
    const filledLines = lines.filter(l => l.includes('●'));
    expect(filledLines).toHaveLength(1);
    expect(filledLines[0]).toContain('gpt-5-mini');
  });

  it('puts the cursor indicator only on the row at cursorIndex', () => {
    const output = renderModelSwitchSelectionUI({
      message: 'Select a model to switch to:',
      models,
      activeModel: 'gpt-5-mini',
      cursorIndex: 2,
    });

    const lines = output.split('\n');
    const cursorLines = lines.filter(l => l.includes(SYMBOL.CURSOR_INDICATOR));
    expect(cursorLines).toHaveLength(1);
    expect(cursorLines[0]).toContain('claude-sonnet-4-5');
  });

  it('is deterministic - identical input renders identical output', () => {
    const options = { message: 'm', models, activeModel: 'gpt-5-mini', cursorIndex: 1 };
    expect(renderModelSwitchSelectionUI(options)).toBe(renderModelSwitchSelectionUI(options));
  });

  it('annotates each row with the agents using it when labels are given', () => {
    const output = renderModelSwitchSelectionUI({
      message: 'Select a model to switch to:',
      models: ['claude-x', 'gpt-5.4'],
      activeModel: 'claude-x',
      cursorIndex: 0,
      agentLabels: { 'claude-x': ['claude'], 'gpt-5.4': ['codex', 'opencode'] },
    });

    const lines = output.split('\n');
    expect(lines.find(l => l.includes('claude-x'))).toContain('[claude]');
    expect(lines.find(l => l.includes('gpt-5.4'))).toContain('[codex, opencode]');
  });

  it('renders no annotation without labels (legacy profile)', () => {
    const output = renderModelSwitchSelectionUI({
      message: 'Select a model to switch to:',
      models: ['claude-x'],
      activeModel: 'claude-x',
      cursorIndex: 0,
    });

    expect(output).not.toMatch(/\[claude/);
    expect(output).not.toContain('claude-x]');
  });

  it('renders custom row labels and title (agent picker)', () => {
    const output = renderModelSwitchSelectionUI({
      title: 'Agents',
      message: 'Select the agent whose active model to switch:',
      models: ['claude', 'codex'],
      activeModel: '',
      cursorIndex: 1,
      rowLabel: id => (id === 'claude' ? 'Claude Code' : 'OpenAI Codex CLI'),
    });

    expect(output).toContain('Agents');
    expect(output).toContain('Claude Code');
    const cursorLines = output.split('\n').filter(l => l.includes(SYMBOL.CURSOR_INDICATOR));
    expect(cursorLines).toHaveLength(1);
    expect(cursorLines[0]).toContain('OpenAI Codex CLI');
  });
});
