/**
 * Reasoning-effort injection + flag pass-through/config-only filtering CONTRACT.
 *
 * WHY: This COMPLEMENTS (does not duplicate) flag-transform-contract.test.ts and
 * plugin-effort-resume.test.ts. Those pin the happy-path argv per agent and one
 * clamp each. This file pins the OTHER half of the contract that had no direct
 * assertion:
 *
 *  1. applyReasoningEffort SUPPRESSION + no-op paths — undefined / unrecognized
 *     level, case-insensitive normalization, and the strategy-aware
 *     userOverrideFlags guard (exact-or-`flag=` for cli-flag, substring for
 *     cli-config). A regression that dropped the override guard would silently
 *     double-inject the effort flag and override the user's explicit choice.
 *  2. transformFlags EDGE CASES not covered elsewhere — unknown flags pass
 *     through untouched, positional drops the flag but keeps the value, the
 *     subcommand `before`/`after`/default placement, undefined/empty mappings,
 *     a mapped flag with no following value, and a null-target fallback.
 *
 * All expected values were captured from the real compiled code (probe run
 * against dist/) — these are regression pins of today's behavior, not guesses.
 *
 * Pure and deterministic: applyReasoningEffort/transformFlags read only their
 * arguments (no FS/env/network). The real per-agent ReasoningEffortConfig is
 * imported from each plugin so the assertions track the shipped metadata.
 */

import { describe, it, expect } from 'vitest';
import { transformFlags } from '../../core/flag-transform.js';
import {
  applyReasoningEffort,
  normalizeReasoningEffort,
  clampToSupported,
} from '../../core/reasoning-effort.js';
import { ClaudePluginMetadata } from '../claude/claude.plugin.js';
import { CodexPluginMetadata } from '../codex/codex.plugin.js';
import { OpenCodePluginMetadata } from '../opencode/opencode.plugin.js';
import { KimiPluginMetadata } from '../kimi/kimi.plugin.js';
import type { AgentConfig, FlagMappings } from '../../core/types.js';

const cfg: AgentConfig = { provider: 'test', model: 'test-model' };

const claudeEffort = ClaudePluginMetadata.reasoningEffort!;
const codexEffort = CodexPluginMetadata.reasoningEffort!;
const opencodeEffort = OpenCodePluginMetadata.reasoningEffort!;
const kimiEffort = KimiPluginMetadata.reasoningEffort!;

// ── normalize / clamp primitives ─────────────────────────────────────────────

describe('reasoning-effort primitives', () => {
  it('normalizeReasoningEffort is case-insensitive', () => {
    expect(normalizeReasoningEffort('HIGH')).toBe('high');
    expect(normalizeReasoningEffort('Medium')).toBe('medium');
  });

  it('normalizeReasoningEffort returns undefined for an unknown level', () => {
    expect(normalizeReasoningEffort('ultra')).toBeUndefined();
    expect(normalizeReasoningEffort('')).toBeUndefined();
  });

  it('clampToSupported steps DOWN to the nearest supported level (minimal → low for claude)', () => {
    expect(clampToSupported('minimal', claudeEffort.supportedLevels)).toBe('low');
  });

  it('clampToSupported steps DOWN for codex (max → xhigh, codex tops out at xhigh)', () => {
    expect(clampToSupported('max', codexEffort.supportedLevels)).toBe('xhigh');
  });

  it('clampToSupported is identity when the level is already supported', () => {
    expect(clampToSupported('high', claudeEffort.supportedLevels)).toBe('high');
    expect(clampToSupported('minimal', codexEffort.supportedLevels)).toBe('minimal');
  });
});

// ── applyReasoningEffort: no-op / skip paths ─────────────────────────────────

describe('applyReasoningEffort — no-op paths', () => {
  it('returns args unchanged when no level is provided (undefined)', () => {
    const args = ['-p', 'task'];
    expect(applyReasoningEffort(args, {}, claudeEffort, undefined, 'claude').args).toEqual(args);
  });

  it('returns args unchanged for an unrecognized level (no flag injected)', () => {
    const args = ['-p', 'task'];
    const out = applyReasoningEffort(args, {}, claudeEffort, 'ultra', 'claude').args;
    expect(out).toEqual(['-p', 'task']);
    expect(out).not.toContain('--effort');
  });

  it('does NOT mutate the env for the env strategy when level is undefined', () => {
    const env: NodeJS.ProcessEnv = {};
    applyReasoningEffort(['-p', 'task'], env, kimiEffort, undefined, 'kimi');
    expect(env.KIMI_MODEL_THINKING_EFFORT).toBeUndefined();
    expect(Object.keys(env)).toHaveLength(0);
  });
});

// ── applyReasoningEffort: cli-flag (claude) ──────────────────────────────────

describe('applyReasoningEffort — cli-flag strategy (claude)', () => {
  it('normalizes case before injecting (HIGH → high)', () => {
    const out = applyReasoningEffort(['-p', 'task'], {}, claudeEffort, 'HIGH', 'claude').args;
    expect(out).toEqual(['-p', 'task', '--effort', 'high']);
  });

  it('passes max through unchanged (claude supports up to max)', () => {
    const out = applyReasoningEffort(['-p', 'task'], {}, claudeEffort, 'max', 'claude').args;
    expect(out).toEqual(['-p', 'task', '--effort', 'max']);
  });

  it('suppresses injection when the native --effort flag is already present', () => {
    const args = ['-p', 'task', '--effort', 'low'];
    const out = applyReasoningEffort(args, {}, claudeEffort, 'high', 'claude').args;
    // Untouched: the user override wins, no second --effort appended.
    expect(out).toEqual(['-p', 'task', '--effort', 'low']);
    expect(out.filter(a => a === '--effort')).toHaveLength(1);
  });

  it('suppresses injection for the "--effort=low" (equals) override form', () => {
    const args = ['-p', 'task', '--effort=low'];
    const out = applyReasoningEffort(args, {}, claudeEffort, 'high', 'claude').args;
    expect(out).toEqual(['-p', 'task', '--effort=low']);
    expect(out).not.toContain('high');
  });
});

// ── applyReasoningEffort: cli-config (codex) ─────────────────────────────────

describe('applyReasoningEffort — cli-config strategy (codex)', () => {
  it('injects minimal without clamping (codex supports minimal)', () => {
    const out = applyReasoningEffort(['exec', 'task'], {}, codexEffort, 'minimal', 'codex').args;
    expect(out[0]).toBe('--config');
    expect(out[1]).toBe('model_reasoning_effort="minimal"');
    expect(out.slice(2)).toEqual(['exec', 'task']);
  });

  it('suppresses injection when model_reasoning_effort appears anywhere in a config arg (substring match)', () => {
    const args = ['--config', 'model_reasoning_effort="low"', 'exec', 'task'];
    const out = applyReasoningEffort(args, {}, codexEffort, 'high', 'codex').args;
    expect(out).toEqual(args);
    // Only the user's config pair survives — no second injected pair.
    expect(out.filter(a => a.includes('model_reasoning_effort'))).toHaveLength(1);
  });
});

// ── applyReasoningEffort: cli-flag (opencode) ────────────────────────────────

describe('applyReasoningEffort — cli-flag strategy (opencode)', () => {
  it('injects minimal without clamping (opencode supports the full range)', () => {
    const out = applyReasoningEffort(['run', 'task'], {}, opencodeEffort, 'minimal', 'opencode').args;
    expect(out).toEqual(['run', 'task', '--variant', 'minimal']);
  });

  it('suppresses injection when the native --variant flag is already present', () => {
    const args = ['run', 'task', '--variant', 'max'];
    const out = applyReasoningEffort(args, {}, opencodeEffort, 'high', 'opencode').args;
    expect(out).toEqual(['run', 'task', '--variant', 'max']);
    expect(out.filter(a => a === '--variant')).toHaveLength(1);
  });
});

// ── applyReasoningEffort: env (kimi) ─────────────────────────────────────────

describe('applyReasoningEffort — env strategy (kimi)', () => {
  it('leaves argv untouched and writes the mapped level plus the static env vars', () => {
    const env: NodeJS.ProcessEnv = {};
    const out = applyReasoningEffort(['-p', 'task'], env, kimiEffort, 'max', 'kimi').args;
    expect(out).toEqual(['-p', 'task']); // env strategy never rewrites args
    expect(env.KIMI_MODEL_THINKING_EFFORT).toBe('max'); // '%s' template → mapped level
    expect(env.KIMI_MODEL_THINKING_MODE).toBe('on'); // static template passes through verbatim
    expect(env.KIMI_MODEL_CAPABILITIES).toBe('thinking');
    expect(env.KIMI_MODEL_DEFAULT_THINKING).toBe('true');
  });
});

// ── transformFlags edge cases (not covered by contract/effort-resume tests) ──

describe('transformFlags — pass-through and mapping edge cases', () => {
  const taskFlag: FlagMappings = { '--task': { type: 'flag', target: '-p' } };

  it('passes unknown flags through untouched (no mapping key matches)', () => {
    expect(transformFlags(['--foo', 'bar', '--verbose'], taskFlag, cfg))
      .toEqual(['--foo', 'bar', '--verbose']);
  });

  it('returns args unchanged when mappings is undefined', () => {
    expect(transformFlags(['--x', 'y'], undefined, cfg)).toEqual(['--x', 'y']);
  });

  it('returns args unchanged when mappings is empty', () => {
    expect(transformFlags(['--x', 'y'], {}, cfg)).toEqual(['--x', 'y']);
  });

  it('positional mapping drops the flag and keeps only its value', () => {
    const mappings: FlagMappings = { '--task': { type: 'positional', target: null } };
    expect(transformFlags(['--task', 'hello'], mappings, cfg)).toEqual(['hello']);
  });

  it('flag mapping with a null target falls back to just the value', () => {
    const mappings: FlagMappings = { '--task': { type: 'flag', target: null } };
    expect(transformFlags(['--task', 'hello'], mappings, cfg)).toEqual(['hello']);
  });

  it('does NOT transform a mapped flag that has no following value (trailing flag)', () => {
    // No nextArg → the mapping is skipped and the flag is kept verbatim.
    expect(transformFlags(['--verbose', '--task'], taskFlag, cfg))
      .toEqual(['--verbose', '--task']);
  });
});

describe('transformFlags — subcommand placement', () => {
  const raw = ['--task', 't', '--json'];

  it('subcommand default (no position): target + value are prepended before other args', () => {
    const mappings: FlagMappings = { '--task': { type: 'subcommand', target: 'exec' } };
    expect(transformFlags(raw, mappings, cfg)).toEqual(['exec', 't', '--json']);
  });

  it('subcommand position "before" behaves like the default (target, value, then rest)', () => {
    const mappings: FlagMappings = { '--task': { type: 'subcommand', target: 'exec', position: 'before' } };
    expect(transformFlags(raw, mappings, cfg)).toEqual(['exec', 't', '--json']);
  });

  it('subcommand position "after": target first, other args next, value trailing', () => {
    const mappings: FlagMappings = { '--task': { type: 'subcommand', target: 'exec', position: 'after' } };
    expect(transformFlags(raw, mappings, cfg)).toEqual(['exec', '--json', 't']);
  });
});
