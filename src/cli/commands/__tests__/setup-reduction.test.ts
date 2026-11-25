import { describe, it, expect, vi, beforeEach } from 'vitest';

const prompt = vi.fn();
vi.mock('inquirer', () => ({ default: { prompt } }));
const readReductionFlag = vi.fn();
const writeProjectReductionFlag = vi.fn();
const writeGlobalReductionFlag = vi.fn();
const addOptedInProject = vi.fn();
const readOptedInProjects = vi.fn();
const removeOptedInProject = vi.fn();
vi.mock('../../../utils/analytics-reduction-setting.js', () => ({
  readReductionFlag, writeProjectReductionFlag, writeGlobalReductionFlag, addOptedInProject, readOptedInProjects, removeOptedInProject,
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

  it('Off with global off and this project on turns the project flag off and drops it from the opted-in list', async () => {
    readReductionFlag.mockImplementation(async (file: string) => (file.includes('.codemie') && !file.includes('/home') ? 'on' : 'off'));
    readReductionFlag.mockResolvedValueOnce('off').mockResolvedValueOnce('on');
    prompt.mockResolvedValueOnce({ reduction: 'off' });
    await runAnalyticsReductionStep();
    expect(writeGlobalReductionFlag).not.toHaveBeenCalled();
    expect(writeProjectReductionFlag).toHaveBeenCalledTimes(1);
    const [dir, on] = writeProjectReductionFlag.mock.calls[0] as [string, boolean];
    expect(on).toBe(false);
    expect(removeOptedInProject).toHaveBeenCalledWith(dir);
    expect(out).toContain('Turned off for');
  });

  it('Off with global off and the project already off changes nothing', async () => {
    prompt.mockResolvedValueOnce({ reduction: 'off' });
    await runAnalyticsReductionStep();
    expect(writeGlobalReductionFlag).not.toHaveBeenCalled();
    expect(writeProjectReductionFlag).not.toHaveBeenCalled();
    expect(removeOptedInProject).not.toHaveBeenCalled();
    expect(out).toContain('Already off');
  });

  it('offers no project choice when the project config is the global config (setup run from home)', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'setup-home-'));
    const previous = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = join(home, '.codemie');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(home);
    try {
      prompt.mockResolvedValueOnce({ reduction: 'off' });
      await runAnalyticsReductionStep();
      const q = prompt.mock.calls[0][0][0];
      expect(q.choices.map((c: { value: string }) => c.value)).toEqual(['off', 'global']);
      expect(out).toContain('no project setting of its own');
    } finally {
      cwd.mockRestore();
      if (previous === undefined) delete process.env.CODEMIE_HOME;
      else process.env.CODEMIE_HOME = previous;
    }
  });

  it('this project only writes the project before turning global off, and lists the projects that stay on', async () => {
    readReductionFlag.mockResolvedValue('on');
    readOptedInProjects.mockResolvedValue(['/work/billing-api']);
    const order: string[] = [];
    writeProjectReductionFlag.mockImplementation(async () => { order.push('project'); });
    writeGlobalReductionFlag.mockImplementation(async () => { order.push('global'); });
    prompt.mockResolvedValueOnce({ reduction: 'projectOnly' });
    await runAnalyticsReductionStep();
    expect(order).toEqual(['project', 'global']);
    expect(out).toContain('Still on for: billing-api');
  });

  it('a failed project write leaves global as it was when choosing this project only', async () => {
    readReductionFlag.mockResolvedValue('on');
    writeProjectReductionFlag.mockRejectedValueOnce(new Error('disk full'));
    prompt.mockResolvedValueOnce({ reduction: 'projectOnly' });
    await runAnalyticsReductionStep();
    expect(writeGlobalReductionFlag).not.toHaveBeenCalled();
    expect(out).toContain('disk full');
  });

  it('a cancelled reconnect prompt does not abort setup', async () => {
    isProtobuf.mockResolvedValue(true);
    prompt.mockResolvedValueOnce({ reduction: 'global' }).mockRejectedValueOnce(new Error('User force closed the prompt'));
    await expect(runAnalyticsReductionStep()).resolves.toBeUndefined();
    expect(connectTargets).not.toHaveBeenCalled();
    expect(out).toContain('Reconnect skipped');
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
