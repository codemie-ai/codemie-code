/**
 * `confirmClaudeCodeOtlp`: when the work-consent question is put in project scope. Only the "no usable project"
 * `ConfigurationError` silently skips it; any other resolve failure is logged and also skips it without failing the connect.
 * @group unit
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const promptMock = vi.hoisted(() => vi.fn());
const projectMock = vi.hoisted(() => vi.fn());
const debugMock = vi.hoisted(() => vi.fn());

vi.mock('@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js', () => ({
  readAllowlistState: vi.fn(async () => ({ kind: 'absent' })),
}));
vi.mock('@/utils/project-root.js', () => ({ resolveProjectRoot: () => '/work/repo' }));
vi.mock('@/utils/processes.js', () => ({ resolveRepositoryName: vi.fn(async () => 'repo') }));
vi.mock('../connectors/claude-code-otlp.js', () => ({ writeClaudeCodeOtlpConfig: vi.fn() }));
vi.mock('../prompts/analytics-confirmation.js', () => ({
  buildAnalyticsDetailLines: vi.fn(() => []),
  promptAnalyticsConfirmation: promptMock,
}));
vi.mock('../consent-project.js', () => ({ resolveConsentProject: projectMock }));
vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: debugMock, warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const display = { profile: 'default' };

describe('confirmClaudeCodeOtlp work-consent question', () => {
  beforeEach(() => {
    promptMock.mockReset().mockResolvedValue('enable');
    projectMock.mockReset().mockResolvedValue('Project');
    debugMock.mockReset();
  });

  const questionAsked = (): boolean => 'workConsentQuestion' in (promptMock.mock.calls[0][0] as object);

  it('asks the question in project scope when the project resolves', async () => {
    const { confirmClaudeCodeOtlp } = await import('../claude-code-otlp-flow.js');
    await confirmClaudeCodeOtlp('project', false, false, display);
    expect(questionAsked()).toBe(true);
    expect(debugMock).not.toHaveBeenCalled();
  });

  it('skips the question without logging when no project resolves (ConfigurationError)', async () => {
    const { ConfigurationError } = await import('../../../../utils/errors.js');
    projectMock.mockRejectedValue(new ConfigurationError('No CodeMie project resolved for this folder.'));
    const { confirmClaudeCodeOtlp } = await import('../claude-code-otlp-flow.js');

    const result = await confirmClaudeCodeOtlp('project', false, false, display);

    expect(questionAsked()).toBe(false);
    expect(result).toEqual({ workConsent: false, deniedQuestion: false });
    expect(debugMock).not.toHaveBeenCalled();
  });

  it('logs any other resolve error at debug level, skips the question and keeps the connect going', async () => {
    projectMock.mockRejectedValue(new Error('EACCES: permission denied'));
    const { confirmClaudeCodeOtlp } = await import('../claude-code-otlp-flow.js');

    const result = await confirmClaudeCodeOtlp('project', false, false, display);

    expect(questionAsked()).toBe(false);
    expect(result).toEqual({ workConsent: false, deniedQuestion: false });
    expect(debugMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(debugMock.mock.calls[0])).toContain('EACCES');
  });

  it('does not resolve the project for the user scope', async () => {
    const { confirmClaudeCodeOtlp } = await import('../claude-code-otlp-flow.js');
    await confirmClaudeCodeOtlp('user', false, false, display);
    expect(questionAsked()).toBe(true);
    expect(projectMock).not.toHaveBeenCalled();
  });
});
