import { describe, it, expect } from 'vitest';
import { transformFlags } from '../../core/flag-transform.js';
import { applyReasoningEffort } from '../../core/reasoning-effort.js';
import { ClaudePluginMetadata } from '../claude/claude.plugin.js';
import { CodexPluginMetadata } from '../codex/codex.plugin.js';
import { OpenCodePluginMetadata } from '../opencode/opencode.plugin.js';
import { KimiPluginMetadata } from '../kimi/kimi.plugin.js';
import type { AgentConfig } from '../../core/types.js';

const mockConfig: AgentConfig = { provider: 'test', model: 'test-model' };

// ── claude ───────────────────────────────────────────────────────────────────

describe('claude plugin — reasoning effort', () => {
  it('appends --effort high after --task → -p transform', () => {
    const raw = ['--task', 'do the thing'];
    const afterTransform = transformFlags(raw, ClaudePluginMetadata.flagMappings!, mockConfig);
    const env: NodeJS.ProcessEnv = {};
    const { args } = applyReasoningEffort(
      afterTransform, env, ClaudePluginMetadata.reasoningEffort!, 'high', 'claude'
    );
    expect(args).toEqual(['-p', 'do the thing', '--effort', 'high']);
  });

  it('clamps minimal → low', () => {
    const afterTransform = ['-p', 'task'];
    const { args } = applyReasoningEffort(
      afterTransform, {}, ClaudePluginMetadata.reasoningEffort!, 'minimal', 'claude'
    );
    expect(args).toContain('low');
    expect(args).not.toContain('minimal');
  });
});

describe('claude plugin — --resume flag mapping', () => {
  it('maps --resume <id> to -r <id>', () => {
    const args = ['-p', 'do the thing', '--resume', 'abc-123'];
    const result = transformFlags(args, ClaudePluginMetadata.flagMappings!, mockConfig);
    expect(result).toEqual(['-p', 'do the thing', '-r', 'abc-123']);
  });
});

// ── codex ────────────────────────────────────────────────────────────────────

describe('codex plugin — reasoning effort', () => {
  it('prepends --config model_reasoning_effort="high" before exec', () => {
    const args = ['exec', 'do the thing'];
    const { args: result } = applyReasoningEffort(
      args, {}, CodexPluginMetadata.reasoningEffort!, 'high', 'codex'
    );
    expect(result[0]).toBe('--config');
    expect(result[1]).toBe('model_reasoning_effort="high"');
    expect(result.slice(2)).toEqual(['exec', 'do the thing']);
  });

  it('clamps max → xhigh for codex', () => {
    const args = ['exec', 'task'];
    const { args: result } = applyReasoningEffort(
      args, {}, CodexPluginMetadata.reasoningEffort!, 'max', 'codex'
    );
    expect(result[1]).toBe('model_reasoning_effort="xhigh"');
  });
});

describe('codex plugin — enrichArgs resume handling', () => {
  const enrichArgs = CodexPluginMetadata.lifecycle!.enrichArgs!;

  it('emits exec resume <id> <task> when --task and --resume are both present', () => {
    const args = ['--task', 'do the thing', '--resume', 'session-123'];
    const result = enrichArgs(args, mockConfig);
    const execIdx = result.indexOf('exec');
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(result[execIdx + 1]).toBe('resume');
    expect(result[execIdx + 2]).toBe('session-123');
    expect(result[result.length - 1]).toBe('do the thing');
    expect(result).not.toContain('--resume');
  });

  it('emits resume <id> when --resume present but no --task', () => {
    const args = ['--resume', 'session-456'];
    const result = enrichArgs(args, mockConfig);
    const resumeIdx = result.indexOf('resume');
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(result[resumeIdx + 1]).toBe('session-456');
    expect(result).not.toContain('--resume');
  });

  it('emits exec <task> (no resume) when only --task is present', () => {
    const args = ['--task', 'do the thing'];
    const result = enrichArgs(args, mockConfig);
    const execIdx = result.indexOf('exec');
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(result[execIdx + 1]).not.toBe('resume');
    expect(result[result.length - 1]).toBe('do the thing');
  });
});

// ── opencode ─────────────────────────────────────────────────────────────────

describe('opencode plugin — reasoning effort', () => {
  it('appends --variant high after enrichArgs produces run <task>', () => {
    const args = ['run', 'do the thing'];
    const env: NodeJS.ProcessEnv = {};
    const { args: result } = applyReasoningEffort(
      args, env, OpenCodePluginMetadata.reasoningEffort!, 'high', 'opencode'
    );
    expect(result).toEqual(['run', 'do the thing', '--variant', 'high']);
  });

  it('passes max through unchanged for opencode (all levels supported)', () => {
    const { args: result } = applyReasoningEffort(
      ['run', 'task'], {}, OpenCodePluginMetadata.reasoningEffort!, 'max', 'opencode'
    );
    expect(result).toContain('max');
  });
});

describe('opencode plugin — --resume flag mapping', () => {
  it('maps --resume <id> to -s <id>', () => {
    const args = ['run', 'task', '--resume', 'sess-abc'];
    const result = transformFlags(args, OpenCodePluginMetadata.flagMappings!, mockConfig);
    expect(result).toEqual(['run', 'task', '-s', 'sess-abc']);
  });
});

// ── kimi ─────────────────────────────────────────────────────────────────────

describe('kimi plugin — reasoning effort (env strategy)', () => {
  it('sets all four KIMI_MODEL_THINKING_* env vars', () => {
    const args = ['-p', 'do the thing'];
    const env: NodeJS.ProcessEnv = {};
    const { args: resultArgs } = applyReasoningEffort(
      args, env, KimiPluginMetadata.reasoningEffort!, 'high', 'kimi'
    );
    expect(resultArgs).toEqual(['-p', 'do the thing']);
    expect(env.KIMI_MODEL_THINKING_MODE).toBe('on');
    expect(env.KIMI_MODEL_THINKING_EFFORT).toBe('high');
    expect(env.KIMI_MODEL_CAPABILITIES).toBe('thinking');
    expect(env.KIMI_MODEL_DEFAULT_THINKING).toBe('true');
  });

  it('clamps minimal → low for kimi', () => {
    const env: NodeJS.ProcessEnv = {};
    applyReasoningEffort(['-p', 'task'], env, KimiPluginMetadata.reasoningEffort!, 'minimal', 'kimi');
    expect(env.KIMI_MODEL_THINKING_EFFORT).toBe('low');
  });
});

describe('kimi plugin — --resume flag mapping', () => {
  it('maps --resume <id> to -S <id>', () => {
    const args = ['-p', 'task', '--resume', 'sess-xyz'];
    const result = transformFlags(args, KimiPluginMetadata.flagMappings!, mockConfig);
    expect(result).toEqual(['-p', 'task', '-S', 'sess-xyz']);
  });
});
