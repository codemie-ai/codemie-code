/**
 * Launch-time project prompt outcomes (EPMCDME-15411, AC4).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promptProfileProject, type ProjectPromptDeps } from '../launch-project-prompt.js';

vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const cookieAuth = { apiUrl: 'https://a.example.com/code-assistant-api', cookies: { session: 'c' } };

function scriptedPrompt(answers: Array<Record<string, unknown>>) {
  const calls: Array<Array<Record<string, unknown>>> = [];
  const prompt = vi.fn(async (questions: Array<Record<string, unknown>>) => {
    calls.push(questions);
    const next = answers.shift();
    if (!next) throw new Error('no scripted answer');
    return next;
  });
  return { prompt: prompt as unknown as NonNullable<ProjectPromptDeps['prompt']>, calls };
}

describe('promptProfileProject', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preselects the shared project and labels it as possibly another profile\'s', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { prompt, calls } = scriptedPrompt([{ project: 'mtlx-csd' }]);
    const outcome = await promptProfileProject(
      { profileName: 'mtlx-csd', sharedProject: 'mtlx-amsd', auth: cookieAuth, canStayOff: false, requiresIntegration: false },
      { fetchProjects: async () => ['mtlx-amsd', 'mtlx-csd'], prompt }
    );
    expect(outcome).toEqual({ kind: 'picked', project: 'mtlx-csd' });
    const list = calls[0][0] as { default: string; choices: Array<{ name: string; value: string }> };
    expect(list.default).toBe('mtlx-amsd');
    expect(list.choices[0].name).toContain('last saved by setup, possibly for another profile');
    expect(list.choices[1].name).toBe('mtlx-csd');
  });

  it('picking the shared project asks a named confirmation; No returns to the list', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { prompt, calls } = scriptedPrompt([
      { project: 'mtlx-amsd' },
      { confirmed: false },
      { project: 'mtlx-amsd' },
      { confirmed: true },
    ]);
    const outcome = await promptProfileProject(
      { profileName: 'solo', sharedProject: 'mtlx-amsd', auth: cookieAuth, canStayOff: false, requiresIntegration: false },
      { fetchProjects: async () => ['mtlx-amsd', 'other'], prompt }
    );
    expect(outcome).toEqual({ kind: 'picked', project: 'mtlx-amsd' });
    expect(calls).toHaveLength(4);
    expect(String(calls[1][0].message)).toContain('"mtlx-amsd"');
    expect(String(calls[1][0].message)).toContain('"solo"');
    expect(calls[1][0].default).toBe(false);
  });

  it('offers "Keep this profile off CodeMie" only when the provider can stay off', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { prompt, calls } = scriptedPrompt([{ project: undefined }]);
    // Select the last (off) row by returning its value from the choices
    (prompt as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async (questions: Array<Record<string, unknown>>) => {
      calls.push(questions);
      const choices = questions[0].choices as Array<{ name?: string; value?: unknown }>;
      const off = choices.find((c) => c.name === 'Keep this profile off CodeMie');
      return { project: off?.value };
    });
    const outcome = await promptProfileProject(
      { profileName: 'personal', sharedProject: 'client', auth: cookieAuth, canStayOff: true, requiresIntegration: false },
      { fetchProjects: async () => ['client'], prompt }
    );
    expect(outcome).toEqual({ kind: 'off' });

    const { prompt: prompt2, calls: calls2 } = scriptedPrompt([{ project: 'client' }, { confirmed: true }]);
    await promptProfileProject(
      { profileName: 'sso', sharedProject: 'client', auth: cookieAuth, canStayOff: false, requiresIntegration: false },
      { fetchProjects: async () => ['client'], prompt: prompt2 }
    );
    const names = (calls2[0][0].choices as Array<{ name?: string }>).map((c) => c.name);
    expect(names).not.toContain('Keep this profile off CodeMie');
  });

  it('selects the integration for the picked project as setup does', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { prompt } = scriptedPrompt([{ project: 'p2' }]);
    const selectIntegration = vi.fn(async () => ({ id: 'i2', alias: 'two' }));
    const outcome = await promptProfileProject(
      { profileName: 'x', auth: cookieAuth, canStayOff: false, requiresIntegration: true },
      { fetchProjects: async () => ['p1', 'p2'], prompt, selectIntegration }
    );
    expect(selectIntegration).toHaveBeenCalledWith(cookieAuth.apiUrl, cookieAuth.cookies, 'p2');
    expect(outcome).toEqual({ kind: 'picked', project: 'p2', integration: { id: 'i2', alias: 'two' } });
  });

  it('a project with no integrations is picked without one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { prompt } = scriptedPrompt([{ project: 'p1' }]);
    const outcome = await promptProfileProject(
      { profileName: 'x', auth: cookieAuth, canStayOff: false, requiresIntegration: true },
      { fetchProjects: async () => ['p1'], prompt, selectIntegration: async () => undefined }
    );
    expect(outcome).toEqual({ kind: 'picked', project: 'p1', integration: undefined });
  });

  it('an integration fetch error is unavailable (nothing saved, warning path)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { prompt } = scriptedPrompt([{ project: 'p1' }]);
    const outcome = await promptProfileProject(
      { profileName: 'x', auth: cookieAuth, canStayOff: false, requiresIntegration: true },
      { fetchProjects: async () => ['p1'], prompt, selectIntegration: async () => { throw new Error('timeout'); } }
    );
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'integration-list-failed' });
  });

  it('a failed or empty project list is unavailable without prompting', async () => {
    const { prompt } = scriptedPrompt([]);
    expect(await promptProfileProject(
      { profileName: 'x', auth: cookieAuth, canStayOff: false, requiresIntegration: false },
      { fetchProjects: async () => { throw new Error('ECONNREFUSED'); }, prompt }
    )).toEqual({ kind: 'unavailable', reason: 'project-list-failed' });
    expect(await promptProfileProject(
      { profileName: 'x', auth: cookieAuth, canStayOff: false, requiresIntegration: false },
      { fetchProjects: async () => [], prompt }
    )).toEqual({ kind: 'unavailable', reason: 'project-list-empty' });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('Ctrl-C (SIGINT) at the prompt exits 130 and the listener is removed afterwards', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.fn() as unknown as (code: number) => never;
    const before = process.listenerCount('SIGINT');
    const prompt = vi.fn(async () => {
      process.emit('SIGINT');
      return { project: 'p1' };
    }) as unknown as NonNullable<ProjectPromptDeps['prompt']>;
    await promptProfileProject(
      { profileName: 'x', auth: cookieAuth, canStayOff: false, requiresIntegration: false },
      { fetchProjects: async () => ['p1'], prompt, exit }
    );
    expect(exit).toHaveBeenCalledWith(130);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('strips control characters from project names shown in the list', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { prompt, calls } = scriptedPrompt([{ project: 'ok' }]);
    await promptProfileProject(
      { profileName: 'x', auth: cookieAuth, canStayOff: false, requiresIntegration: false },
      { fetchProjects: async () => ['ok', 'evil\u001b[31mred'], prompt }
    );
    const names = (calls[0][0].choices as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain('evil[31mred');
  });
});
