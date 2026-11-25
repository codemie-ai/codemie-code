import { describe, it, expect, vi, beforeEach } from 'vitest';

const prompt = vi.fn();
vi.mock('inquirer', () => ({ default: { prompt } }));
const readReductionFlag = vi.fn();
const writeProjectReductionFlag = vi.fn();
const writeGlobalReductionFlag = vi.fn();
const addOptedInProject = vi.fn();
const readOptedInProjects = vi.fn();
vi.mock('../../../utils/analytics-reduction-setting.js', () => ({
  readReductionFlag, writeProjectReductionFlag, writeGlobalReductionFlag, addOptedInProject, readOptedInProjects,
}));
const isProtobuf = vi.fn();
vi.mock('../proxy/connectors/claude-code-otlp.js', () => ({ isClaudeCodeOtlpOnProtobuf: isProtobuf }));
const connectTargets = vi.fn();
vi.mock('../proxy/connect-orchestrator.js', () => ({ connectTargets }));

const { runAnalyticsReductionStep } = await import('../setup.js');

let out: string;
beforeEach(() => {
  vi.clearAllMocks();
  out = '';
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out += a.join(' ') + '\n'; });
  readReductionFlag.mockResolvedValue('off');
  readOptedInProjects.mockResolvedValue([]);
  isProtobuf.mockResolvedValue(false);
});

describe('runAnalyticsReductionStep', () => {
  it('discloses that conversation sync is not reduced and offers three choices, default off', async () => {
    prompt.mockResolvedValueOnce({ reduction: 'off' });
    await runAnalyticsReductionStep();
    expect(out).toContain('conversation history in CodeMie chat is not affected');
    const q = prompt.mock.calls[0][0][0];
    expect(q.choices.map((c: { value: string }) => c.value)).toEqual(['off', 'global', 'project']);
    expect(q.default).toBe('off');
    expect(writeGlobalReductionFlag).not.toHaveBeenCalled();
    expect(writeProjectReductionFlag).not.toHaveBeenCalled();
  });

  it('project choice writes only the project flag and the home list entry (absolute path)', async () => {
    prompt.mockResolvedValueOnce({ reduction: 'project' });
    await runAnalyticsReductionStep();
    expect(writeProjectReductionFlag).toHaveBeenCalledTimes(1);
    const dir = writeProjectReductionFlag.mock.calls[0][0] as string;
    expect(dir.startsWith('/')).toBe(true);
    expect(addOptedInProject).toHaveBeenCalledWith(dir);
    expect(writeGlobalReductionFlag).not.toHaveBeenCalled();
  });

  it('with global on, offers no project choice and says the global setting applies', async () => {
    readReductionFlag.mockResolvedValue('on');
    prompt.mockResolvedValueOnce({ reduction: 'keep' });
    await runAnalyticsReductionStep();
    const q = prompt.mock.calls[0][0][0];
    expect(q.choices.map((c: { value: string }) => c.value)).toEqual(['keep', 'off', 'projectOnly']);
    expect(out).toContain('Current: on for all projects');
    expect(writeGlobalReductionFlag).not.toHaveBeenCalled();
  });

  it('turning global off when it was on writes explicit false', async () => {
    readReductionFlag.mockResolvedValue('on');
    prompt.mockResolvedValueOnce({ reduction: 'off' });
    await runAnalyticsReductionStep();
    expect(writeGlobalReductionFlag).toHaveBeenCalledWith(false);
  });

  it('with global on, "off globally, on for this project" turns global off and writes the project flag and list entry', async () => {
    readReductionFlag.mockResolvedValue('on');
    prompt.mockResolvedValueOnce({ reduction: 'projectOnly' });
    await runAnalyticsReductionStep();
    expect(writeGlobalReductionFlag).toHaveBeenCalledWith(false);
    expect(writeProjectReductionFlag).toHaveBeenCalledTimes(1);
    const dir = writeProjectReductionFlag.mock.calls[0][0] as string;
    expect(addOptedInProject).toHaveBeenCalledWith(dir);
    expect(out).toContain('Turned off for all projects');
    expect(out).toContain('Prompts hidden in analytics for');
  });

  it('names the projects that stay on after turning global off, and skips ones already off', async () => {
    readReductionFlag.mockImplementation(async (file: string) => {
      if (file.includes('codemie-cli.config.json') && file.includes('billing-api')) return 'on';
      if (file.includes('old-project')) return 'off';
      return 'on';
    });
    readOptedInProjects.mockResolvedValue(['/work/billing-api', '/work/old-project']);
    prompt.mockResolvedValueOnce({ reduction: 'off' });
    await runAnalyticsReductionStep();
    expect(writeGlobalReductionFlag).toHaveBeenCalledWith(false);
    expect(out).toContain('Still on for: billing-api');
    expect(out).not.toContain('old-project');
  });

  it('shows a write failure and does not throw', async () => {
    writeProjectReductionFlag.mockRejectedValueOnce(new Error('unreadable config'));
    prompt.mockResolvedValueOnce({ reduction: 'project' });
    await expect(runAnalyticsReductionStep()).resolves.toBeUndefined();
    expect(out).toContain('unreadable config');
    expect(addOptedInProject).not.toHaveBeenCalled();
  });

  it('offers the reconnect for a protobuf connection and runs it when accepted', async () => {
    isProtobuf.mockResolvedValue(true);
    prompt.mockResolvedValueOnce({ reduction: 'global' }).mockResolvedValueOnce({ reconnect: true });
    await runAnalyticsReductionStep();
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(connectTargets).toHaveBeenCalledTimes(1);
    expect(connectTargets.mock.calls[0][0].aggregates).toEqual(['claude-otlp']);
  });

  it('does not offer the reconnect when reduction stays off', async () => {
    isProtobuf.mockResolvedValue(true);
    prompt.mockResolvedValueOnce({ reduction: 'off' });
    await runAnalyticsReductionStep();
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
