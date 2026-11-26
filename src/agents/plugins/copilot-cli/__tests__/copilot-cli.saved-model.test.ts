import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySavedCopilotModel } from '../copilot-cli.saved-model.js';
import { resetModelOriginRecords, resolveModelEnvOrigin } from '../../../../utils/model-origin.js';

describe('applySavedCopilotModel', () => {
  beforeEach(() => {
    resetModelOriginRecords();
  });

  afterEach(() => {
    resetModelOriginRecords();
  });

  it('sets CODEMIE_MODEL to the saved pick and records it as saved', () => {
    const env: NodeJS.ProcessEnv = {};
    applySavedCopilotModel({}, 'claude-opus-4-8', env);

    expect(env.CODEMIE_MODEL).toBe('claude-opus-4-8');
    expect(resolveModelEnvOrigin(env)).toBe('saved');
  });

  it.each([
    ['--model <name>', { model: 'gpt-5' }],
    ['a valueless --model', { model: true }],
  ])('leaves CODEMIE_MODEL alone for %s', (_name, options) => {
    const env: NodeJS.ProcessEnv = {};
    applySavedCopilotModel(options, 'claude-opus-4-8', env);

    expect(env.CODEMIE_MODEL).toBeUndefined();
  });

  it('keeps a CODEMIE_MODEL that is already set, as a shell value', () => {
    const env: NodeJS.ProcessEnv = { CODEMIE_MODEL: 'gpt-5' };
    applySavedCopilotModel({}, 'claude-opus-4-8', env);

    expect(env.CODEMIE_MODEL).toBe('gpt-5');
    expect(resolveModelEnvOrigin(env)).toBe('shell');
  });

  it('does nothing without a saved pick', () => {
    const env: NodeJS.ProcessEnv = {};
    applySavedCopilotModel({}, undefined, env);

    expect(env.CODEMIE_MODEL).toBeUndefined();
  });
});
