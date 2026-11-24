import { describe, it, expect, vi, beforeEach } from 'vitest';

const prompt = vi.fn();
vi.mock('inquirer', () => ({ default: { prompt } }));
const readReductionFlag = vi.fn();
const writeProjectReductionFlag = vi.fn();
const writeGlobalReductionFlag = vi.fn();
const addOptedInProject = vi.fn();
vi.mock('../../../utils/analytics-reduction-setting.js', () => ({
  readReductionFlag, writeProjectReductionFlag, writeGlobalReductionFlag, addOptedInProject,
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
  isProtobuf.mockResolvedValue(false);
});

describe('runAnalyticsReductionStep', () => {
  it('discloses that conversation sync is not reduced and offers three choices, default off', async () => {
    prompt.mockResolvedValueOnce({ reduction: 'off' });
    await runAnalyticsReductionStep();
    expect(out).toContain('Conversation history sync is not reduced');
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
    expect(q.choices.map((c: { value: string }) => c.value)).toEqual(['keep', 'off']);
    expect(out).toContain('global setting applies');
    expect(writeGlobalReductionFlag).not.toHaveBeenCalled();
  });

  it('turning global off when it was on writes explicit false', async () => {
    readReductionFlag.mockResolvedValue('on');
    prompt.mockResolvedValueOnce({ reduction: 'off' });
    await runAnalyticsReductionStep();
    expect(writeGlobalReductionFlag).toHaveBeenCalledWith(false);
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
