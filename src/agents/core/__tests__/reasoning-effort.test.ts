import { describe, it, expect } from 'vitest';
import type { CanonicalReasoningEffort } from '../types.js';
import {
  CANONICAL_EFFORT_ORDER,
  normalizeReasoningEffort,
  clampToSupported,
  applyReasoningEffort,
} from '../reasoning-effort.js';
import type { ReasoningEffortConfig } from '../types.js';

describe('CANONICAL_EFFORT_ORDER', () => {
  it('lists all six levels weakest to strongest', () => {
    expect(CANONICAL_EFFORT_ORDER).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('normalizeReasoningEffort', () => {
  it('accepts lowercase canonical values', () => {
    expect(normalizeReasoningEffort('high')).toBe('high');
    expect(normalizeReasoningEffort('minimal')).toBe('minimal');
    expect(normalizeReasoningEffort('max')).toBe('max');
  });

  it('normalizes uppercase input to lowercase canonical', () => {
    expect(normalizeReasoningEffort('HIGH')).toBe('high');
    expect(normalizeReasoningEffort('Medium')).toBe('medium');
    expect(normalizeReasoningEffort('XHIGH')).toBe('xhigh');
  });

  it('returns undefined for unknown values', () => {
    expect(normalizeReasoningEffort('ultra')).toBeUndefined();
    expect(normalizeReasoningEffort('')).toBeUndefined();
    expect(normalizeReasoningEffort('thinking')).toBeUndefined();
  });
});

describe('clampToSupported', () => {
  const claudeSupported: CanonicalReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  const codexSupported: CanonicalReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
  const kimiSupported: CanonicalReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

  it('returns the same level when it is supported', () => {
    expect(clampToSupported('high', claudeSupported)).toBe('high');
    expect(clampToSupported('minimal', codexSupported)).toBe('minimal');
    expect(clampToSupported('max', kimiSupported)).toBe('max');
  });

  it('clamps minimal → low for claude (minimal not supported)', () => {
    expect(clampToSupported('minimal', claudeSupported)).toBe('low');
  });

  it('clamps minimal → low for kimi (minimal not supported)', () => {
    expect(clampToSupported('minimal', kimiSupported)).toBe('low');
  });

  it('clamps max → xhigh for codex (max not supported)', () => {
    expect(clampToSupported('max', codexSupported)).toBe('xhigh');
  });

  it('opencode supports all six levels — no clamping needed', () => {
    const opencodeSupported: CanonicalReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    for (const level of CANONICAL_EFFORT_ORDER) {
      expect(clampToSupported(level, opencodeSupported)).toBe(level);
    }
  });
});

describe('applyReasoningEffort — cli-flag strategy (claude)', () => {
  const claudeConfig: ReasoningEffortConfig = {
    strategy: 'cli-flag',
    flag: '--effort',
    placement: 'append',
    supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    userOverrideFlags: ['--effort'],
  };

  it('appends --effort <level> to args', () => {
    const args = ['-p', 'do the thing'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, claudeConfig, 'high', 'claude');
    expect(result.args).toEqual(['-p', 'do the thing', '--effort', 'high']);
  });

  it('clamps minimal → low and appends', () => {
    const args = ['-p', 'do the thing'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, claudeConfig, 'minimal', 'claude');
    expect(result.args).toEqual(['-p', 'do the thing', '--effort', 'low']);
  });

  it('skips injection when --effort already present in args (exact match)', () => {
    const args = ['-p', 'task', '--effort', 'low'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, claudeConfig, 'high', 'claude');
    expect(result.args).toEqual(['-p', 'task', '--effort', 'low']);
  });

  it('skips injection when --effort=<val> present in args', () => {
    const args = ['-p', 'task', '--effort=low'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, claudeConfig, 'high', 'claude');
    expect(result.args).toEqual(['-p', 'task', '--effort=low']);
  });

  it('returns unchanged args when rawLevel is undefined', () => {
    const args = ['-p', 'task'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, claudeConfig, undefined, 'claude');
    expect(result.args).toEqual(['-p', 'task']);
  });
});

describe('applyReasoningEffort — cli-flag strategy (opencode, prepend)', () => {
  const opencodeConfig: ReasoningEffortConfig = {
    strategy: 'cli-flag',
    flag: '--variant',
    placement: 'prepend',
    supportedLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    userOverrideFlags: ['--variant'],
  };

  it('prepends --variant <level> to args', () => {
    const args = ['run', 'do the thing'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, opencodeConfig, 'medium', 'opencode');
    expect(result.args).toEqual(['--variant', 'medium', 'run', 'do the thing']);
  });
});

describe('applyReasoningEffort — cli-config strategy (codex)', () => {
  const codexConfig: ReasoningEffortConfig = {
    strategy: 'cli-config',
    configFlag: '--config',
    configKey: 'model_reasoning_effort',
    placement: 'prepend',
    supportedLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    userOverrideFlags: ['model_reasoning_effort'],
  };

  it('prepends --config model_reasoning_effort="<level>" to args', () => {
    const args = ['exec', 'do the thing'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, codexConfig, 'high', 'codex');
    expect(result.args).toEqual(['--config', 'model_reasoning_effort="high"', 'exec', 'do the thing']);
  });

  it('clamps max → xhigh for codex', () => {
    const args = ['exec', 'task'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, codexConfig, 'max', 'codex');
    expect(result.args).toEqual(['--config', 'model_reasoning_effort="xhigh"', 'exec', 'task']);
  });

  it('skips injection when model_reasoning_effort already in args', () => {
    const args = ['--config', 'model_reasoning_effort="low"', 'exec', 'task'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, codexConfig, 'high', 'codex');
    expect(result.args).toEqual(['--config', 'model_reasoning_effort="low"', 'exec', 'task']);
  });
});

describe('applyReasoningEffort — env strategy (kimi)', () => {
  const kimiConfig: ReasoningEffortConfig = {
    strategy: 'env',
    envVars: {
      KIMI_MODEL_THINKING_MODE: 'on',
      KIMI_MODEL_THINKING_EFFORT: '%s',
      KIMI_MODEL_CAPABILITIES: 'thinking',
      KIMI_MODEL_DEFAULT_THINKING: 'true',
    },
    supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  };

  it('sets all four env vars with level substituted into %s', () => {
    const args = ['-p', 'task'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, kimiConfig, 'high', 'kimi');
    expect(result.args).toEqual(['-p', 'task']);
    expect(env.KIMI_MODEL_THINKING_MODE).toBe('on');
    expect(env.KIMI_MODEL_THINKING_EFFORT).toBe('high');
    expect(env.KIMI_MODEL_CAPABILITIES).toBe('thinking');
    expect(env.KIMI_MODEL_DEFAULT_THINKING).toBe('true');
  });

  it('clamps minimal → low for kimi before setting env var', () => {
    const env: NodeJS.ProcessEnv = {};
    applyReasoningEffort(['-p', 'task'], env, kimiConfig, 'minimal', 'kimi');
    expect(env.KIMI_MODEL_THINKING_EFFORT).toBe('low');
  });
});
