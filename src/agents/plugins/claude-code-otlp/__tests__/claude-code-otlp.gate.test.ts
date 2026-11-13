/**
 * Tests for the single analytics gate combining preferences and the allowlist.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readClaudeAnalyticsPreferences = vi.fn();
const isProjectExcluded = vi.fn();
vi.mock('../claude-code-otlp.preferences.js', () => ({
  readClaudeAnalyticsPreferences,
  isProjectExcluded,
}));

const readAllowlistState = vi.fn();
const isProjectTracked = vi.fn();
vi.mock('../claude-code-otlp.allowlist.js', () => ({
  readAllowlistState,
  isProjectTracked,
}));

describe('evaluateClaudeAnalyticsGate', () => {
  beforeEach(() => {
    vi.resetModules();
    readClaudeAnalyticsPreferences.mockReset();
    isProjectExcluded.mockReset();
    readAllowlistState.mockReset();
    isProjectTracked.mockReset();

    readClaudeAnalyticsPreferences.mockResolvedValue({
      kind: 'ok',
      value: { version: 1, enabled: true, excludedProjects: [] },
    });
    isProjectExcluded.mockResolvedValue(false);
    readAllowlistState.mockResolvedValue({ kind: 'absent' });
    isProjectTracked.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns preferences-corrupt when the preferences file is corrupt', async () => {
    readClaudeAnalyticsPreferences.mockResolvedValue({ kind: 'corrupt' });
    const { evaluateClaudeAnalyticsGate } = await import('../claude-code-otlp.gate.js');
    expect(await evaluateClaudeAnalyticsGate('/proj')).toEqual({
      tracked: false,
      reason: 'preferences-corrupt',
    });
  });

  it('returns disabled when enabled is false', async () => {
    readClaudeAnalyticsPreferences.mockResolvedValue({
      kind: 'ok',
      value: { version: 1, enabled: false, excludedProjects: [] },
    });
    const { evaluateClaudeAnalyticsGate } = await import('../claude-code-otlp.gate.js');
    expect(await evaluateClaudeAnalyticsGate('/proj')).toEqual({ tracked: false, reason: 'disabled' });
  });

  it('returns project-excluded when the project is excluded', async () => {
    isProjectExcluded.mockResolvedValue(true);
    const { evaluateClaudeAnalyticsGate } = await import('../claude-code-otlp.gate.js');
    expect(await evaluateClaudeAnalyticsGate('/proj')).toEqual({ tracked: false, reason: 'project-excluded' });
  });

  it('returns not-in-allowlist when isProjectTracked is false', async () => {
    isProjectTracked.mockResolvedValue(false);
    const { evaluateClaudeAnalyticsGate } = await import('../claude-code-otlp.gate.js');
    expect(await evaluateClaudeAnalyticsGate('/proj')).toEqual({ tracked: false, reason: 'not-in-allowlist' });
  });

  it('returns tracked when nothing blocks it', async () => {
    const { evaluateClaudeAnalyticsGate } = await import('../claude-code-otlp.gate.js');
    expect(await evaluateClaudeAnalyticsGate('/proj')).toEqual({ tracked: true, reason: 'tracked' });
  });

  it('exclusion wins over an allowlist entry covering the same path', async () => {
    isProjectExcluded.mockResolvedValue(true);
    isProjectTracked.mockResolvedValue(true);
    const { evaluateClaudeAnalyticsGate } = await import('../claude-code-otlp.gate.js');
    expect(await evaluateClaudeAnalyticsGate('/proj')).toEqual({ tracked: false, reason: 'project-excluded' });
  });

  it('exclusion applies when the allowlist is absent (Global scope)', async () => {
    readAllowlistState.mockResolvedValue({ kind: 'absent' });
    isProjectTracked.mockResolvedValue(true);
    isProjectExcluded.mockResolvedValue(true);
    const { evaluateClaudeAnalyticsGate } = await import('../claude-code-otlp.gate.js');
    expect(await evaluateClaudeAnalyticsGate('/proj')).toEqual({ tracked: false, reason: 'project-excluded' });
  });

  it('is a strict superset of isProjectTracked when preferences are absent/default', async () => {
    const { evaluateClaudeAnalyticsGate } = await import('../claude-code-otlp.gate.js');
    isProjectTracked.mockResolvedValue(true);
    expect((await evaluateClaudeAnalyticsGate('/proj')).tracked).toBe(true);
    isProjectTracked.mockResolvedValue(false);
    expect((await evaluateClaudeAnalyticsGate('/proj')).tracked).toBe(false);
  });

  it('cwd undefined: the gate defers to isProjectExcluded, which fails closed when something is excluded', async () => {
    isProjectExcluded.mockResolvedValue(true);
    isProjectTracked.mockResolvedValue(true);
    const { evaluateClaudeAnalyticsGate } = await import('../claude-code-otlp.gate.js');
    expect(await evaluateClaudeAnalyticsGate(undefined)).toEqual({ tracked: false, reason: 'project-excluded' });
  });

  it('cwd undefined with nothing excluded falls through to the allowlist check (unchanged)', async () => {
    isProjectExcluded.mockResolvedValue(false);
    isProjectTracked.mockResolvedValue(true);
    const { evaluateClaudeAnalyticsGate } = await import('../claude-code-otlp.gate.js');
    expect(await evaluateClaudeAnalyticsGate(undefined)).toEqual({ tracked: true, reason: 'tracked' });
  });
});
