/**
 * Tests for evaluateCopilotAnalyticsGate — composes the new copilot-analytics preferences with
 * the existing CopilotConnectorScope tracked/untracked check.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadPrefs = vi.fn();
const mockIsExcluded = vi.fn();
const mockReadScope = vi.fn();
const mockIsTracked = vi.fn();

vi.mock('../copilot-analytics-preferences.js', () => ({
  readCopilotAnalyticsPreferences: mockReadPrefs,
  isCopilotAnalyticsProjectExcluded: mockIsExcluded,
}));

vi.mock('../copilot-connector-scope.js', () => ({
  readCopilotConnectorScope: mockReadScope,
  isCopilotProjectTracked: mockIsTracked,
}));

describe('evaluateCopilotAnalyticsGate', () => {
  beforeEach(() => {
    mockReadPrefs.mockReset();
    mockIsExcluded.mockReset().mockResolvedValue(false);
    mockReadScope.mockReset();
    mockIsTracked.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns preferences-corrupt when preferences are corrupt, before checking scope', async () => {
    const { evaluateCopilotAnalyticsGate } = await import('../copilot-analytics-gate.js');
    mockReadPrefs.mockResolvedValue({ kind: 'corrupt' });

    const decision = await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a');

    expect(decision).toEqual({ tracked: false, reason: 'preferences-corrupt' });
    expect(mockReadScope).not.toHaveBeenCalled();
  });

  it('returns analytics-disabled when preferences.enabled is false', async () => {
    const { evaluateCopilotAnalyticsGate } = await import('../copilot-analytics-gate.js');
    mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: false, excludedProjects: [] } });

    const decision = await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a');

    expect(decision).toEqual({ tracked: false, reason: 'analytics-disabled' });
    expect(mockReadScope).not.toHaveBeenCalled();
  });

  it('returns project-excluded when cwd is under an excluded project, even with scope fully open', async () => {
    const { evaluateCopilotAnalyticsGate } = await import('../copilot-analytics-gate.js');
    mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: true, excludedProjects: ['/work/a'] } });
    mockIsExcluded.mockResolvedValue(true);

    const decision = await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a');

    expect(decision).toEqual({ tracked: false, reason: 'project-excluded' });
    expect(mockReadScope).not.toHaveBeenCalled();
  });

  it('returns scope-corrupt when preferences are fine but connector scope is corrupt', async () => {
    const { evaluateCopilotAnalyticsGate } = await import('../copilot-analytics-gate.js');
    mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: true, excludedProjects: [] } });
    mockReadScope.mockResolvedValue({ kind: 'corrupt' });

    const decision = await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a');

    expect(decision).toEqual({ tracked: false, reason: 'scope-corrupt' });
    expect(mockIsTracked).not.toHaveBeenCalled();
  });

  it('returns scope-disabled when preferences are fine but the connector scope itself is disabled', async () => {
    const { evaluateCopilotAnalyticsGate } = await import('../copilot-analytics-gate.js');
    mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: true, excludedProjects: [] } });
    mockReadScope.mockResolvedValue({ kind: 'ok', value: { enabled: false } });

    const decision = await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a');

    expect(decision).toEqual({ tracked: false, reason: 'scope-disabled' });
    expect(mockIsTracked).not.toHaveBeenCalled();
  });

  it('returns scope-untracked when scope is enabled/project but cwd is outside its paths', async () => {
    const { evaluateCopilotAnalyticsGate } = await import('../copilot-analytics-gate.js');
    mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: true, excludedProjects: [] } });
    const scope = { kind: 'ok', value: { enabled: true, scope: 'project', paths: ['/work/b'] } };
    mockReadScope.mockResolvedValue(scope);
    mockIsTracked.mockResolvedValue(false);

    const decision = await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a');

    expect(decision).toEqual({ tracked: false, reason: 'scope-untracked' });
    expect(mockIsTracked).toHaveBeenCalledWith('/work/a', scope);
  });

  it('returns tracked:true when preferences allow it and scope tracks the project', async () => {
    const { evaluateCopilotAnalyticsGate } = await import('../copilot-analytics-gate.js');
    mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: true, excludedProjects: [] } });
    mockReadScope.mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'user' } });
    mockIsTracked.mockResolvedValue(true);

    const decision = await evaluateCopilotAnalyticsGate('copilot-cli-otlp', '/work/a');

    expect(decision).toEqual({ tracked: true });
  });

  it('falls through to scope-untracked (never throws) when cwd is undefined', async () => {
    const { evaluateCopilotAnalyticsGate } = await import('../copilot-analytics-gate.js');
    mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: true, excludedProjects: [] } });
    mockReadScope.mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'project', paths: ['/work/a'] } });
    mockIsTracked.mockResolvedValue(false);

    const decision = await evaluateCopilotAnalyticsGate('copilot-cli-otlp', undefined);

    expect(decision).toEqual({ tracked: false, reason: 'scope-untracked' });
  });

  it('passes the connectorId through to both preferences and scope reads', async () => {
    const { evaluateCopilotAnalyticsGate } = await import('../copilot-analytics-gate.js');
    mockReadPrefs.mockResolvedValue({ kind: 'ok', value: { enabled: true, excludedProjects: [] } });
    mockReadScope.mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'user' } });
    mockIsTracked.mockResolvedValue(true);

    await evaluateCopilotAnalyticsGate('copilot-chat-otlp', '/work/a');

    expect(mockReadPrefs).toHaveBeenCalledWith('copilot-chat-otlp');
    expect(mockReadScope).toHaveBeenCalledWith('copilot-chat-otlp');
  });
});
