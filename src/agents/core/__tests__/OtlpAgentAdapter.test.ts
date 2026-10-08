import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const detectGitBranchMock = vi.fn();
const detectGitRemoteRepoMock = vi.fn();

vi.mock('@/utils/processes.js', () => ({
  detectGitBranch: detectGitBranchMock,
  detectGitRemoteRepo: detectGitRemoteRepoMock,
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { OtlpAgentAdapter } = await import('../OtlpAgentAdapter.js');
type Decision = import('../OtlpAgentAdapter.js').ForwardDecision;
type Context = import('../OtlpAgentAdapter.js').OtlpHookContext;

interface FakeInput {
  cwd: string;
  prompt?: string;
  payload: Record<string, unknown>[];
  block?: boolean;
}

class FakeAdapter extends OtlpAgentAdapter<FakeInput> {
  readonly name = 'fake';
  tracked = true;

  protected parseHookInput(raw: string): FakeInput | null {
    const parsed = JSON.parse(raw) as Partial<FakeInput>;
    return typeof parsed.cwd === 'string' ? (parsed as FakeInput) : null;
  }
  protected extractHookContext(input: FakeInput): Context {
    return { cwd: input.cwd, prompt: input.prompt };
  }
  protected async isTracked(): Promise<boolean> {
    return this.tracked;
  }
  protected async evaluate(input: FakeInput): Promise<Decision> {
    if (input.block) {
      return { decision: 'block', reason: 'nope', hookSpecificOutput: { x: 1 } };
    }
    return { decision: 'forward', payload: input.payload };
  }
  protected async resolveAgentCommonFields(): Promise<Record<string, unknown>> {
    return { platform: 'fake-platform' };
  }
}

describe('OtlpAgentAdapter.processOtlpEvent', () => {
  const ensureOtlpProxy = vi.fn(async () => {});
  const forwardToSpool = vi.fn(async () => {});
  const deps = { ensureOtlpProxy, forwardOtlpEventToSpool: forwardToSpool };
  let adapter: FakeAdapter;

  const run = (input: Partial<FakeInput> = {}) =>
    adapter.processOtlpEvent(JSON.stringify({ cwd: '/repo', payload: [{ a: 1 }], ...input }), deps);
  const forwarded = () => forwardToSpool.mock.calls.map(([record]) => record as Record<string, unknown>);

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new FakeAdapter();
    detectGitBranchMock.mockResolvedValue('main');
    detectGitRemoteRepoMock.mockResolvedValue('org/repo');
    delete process.env['SDLC_ANALYTICS_STORY_ID'];
  });

  afterEach(() => {
    delete process.env['SDLC_ANALYTICS_STORY_ID'];
    vi.restoreAllMocks();
  });

  it('gates on isTracked before ensureOtlpProxy and forwards nothing for untracked projects', async () => {
    adapter.tracked = false;
    await run();
    expect(ensureOtlpProxy).not.toHaveBeenCalled();
    expect(forwardToSpool).not.toHaveBeenCalled();
  });

  it('ignores a payload parseHookInput rejects', async () => {
    await adapter.processOtlpEvent(JSON.stringify({ nothing: true }), deps);
    expect(ensureOtlpProxy).not.toHaveBeenCalled();
    expect(forwardToSpool).not.toHaveBeenCalled();
  });

  it('still throws on malformed JSON', async () => {
    await expect(adapter.processOtlpEvent('not json', deps)).rejects.toThrow();
  });

  it('ensures the proxy before forwarding', async () => {
    await run();
    expect(ensureOtlpProxy).toHaveBeenCalledWith('fake');
    expect(ensureOtlpProxy.mock.invocationCallOrder[0]).toBeLessThan(forwardToSpool.mock.invocationCallOrder[0]);
  });

  it('prints the decision and forwards nothing on the block path', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run({ block: true });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ decision: 'block', reason: 'nope', hookSpecificOutput: { x: 1 } }));
    expect(forwardToSpool).not.toHaveBeenCalled();
  });

  it('merges the four common fields and agent fields into every record', async () => {
    await run({ payload: [{ a: 1 }, { a: 2 }] });
    expect(detectGitBranchMock).toHaveBeenCalledWith('/repo');
    expect(detectGitRemoteRepoMock).toHaveBeenCalledWith('/repo');
    expect(forwarded()).toEqual([
      { a: 1, git_branch: 'main', repo_remote: 'org/repo', story_id: '', story_source: '', platform: 'fake-platform' },
      { a: 2, git_branch: 'main', repo_remote: 'org/repo', story_id: '', story_source: '', platform: 'fake-platform' },
    ]);
    expect(forwardToSpool.mock.calls.map(([, name]) => name)).toEqual(['fake', 'fake']);
  });

  it("keeps a record's own non-empty value and does not let undefined / '' clobber the base value", async () => {
    await run({
      payload: [
        { git_branch: 'own-branch', repo_remote: 'own/remote' },
        { git_branch: '', repo_remote: undefined },
      ],
    });
    const [own, empty] = forwarded();
    expect(own).toMatchObject({ git_branch: 'own-branch', repo_remote: 'own/remote' });
    expect(empty).toMatchObject({ git_branch: 'main', repo_remote: 'org/repo' });
  });

  it('lets agent fields override everything else', async () => {
    await run({ payload: [{ platform: 'record-platform' }] });
    expect(forwarded()[0]['platform']).toBe('fake-platform');
  });

  it('reads the explicit story from the hook process env', async () => {
    process.env['SDLC_ANALYTICS_STORY_ID'] = 'ABC-1';
    await run();
    expect(forwarded()[0]).toMatchObject({ story_id: 'ABC-1', story_source: 'explicit' });
  });

  it('resolves marker story from the prompt, above the branch', async () => {
    detectGitBranchMock.mockResolvedValue('feature/BR-2');
    await run({ prompt: 'story: MK-3' });
    expect(forwarded()[0]).toMatchObject({ story_id: 'MK-3', story_source: 'marker' });
  });

  it('falls back to the branch story when there is no prompt', async () => {
    detectGitBranchMock.mockResolvedValue('feature/BR-2');
    await run();
    expect(forwarded()[0]).toMatchObject({ story_id: 'BR-2', story_source: 'branch' });
  });

  it("stamps '' on a detached HEAD, even when the record carries an empty value", async () => {
    detectGitBranchMock.mockResolvedValue(undefined);
    await run({ payload: [{ git_branch: '' }] });
    expect(forwarded()[0]['git_branch']).toBe('');
  });

  it('does not wait for forwardToSpool (fire-and-forget)', async () => {
    let resolveLate: () => void = () => {};
    forwardToSpool.mockImplementation(() => new Promise<void>((resolve) => { resolveLate = resolve; }));
    await run({ payload: [{ a: 1 }, { a: 2 }] });
    expect(forwardToSpool).toHaveBeenCalledTimes(2);
    resolveLate();
  });
});
