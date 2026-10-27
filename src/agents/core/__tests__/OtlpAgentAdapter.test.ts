import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

const detectGitBranchMock = vi.fn();
const detectGitRemoteRepoMock = vi.fn();

vi.mock('@/utils/processes.js', () => ({
  detectGitBranch: detectGitBranchMock,
  detectGitRemoteRepo: detectGitRemoteRepoMock,
}));
const resolveHookCredentialsMock = vi.fn();
const resolveIdentityMock = vi.fn();
const getActiveProfileNameMock = vi.fn();
const configLoadMock = vi.fn();
const hasLocalConfigMock = vi.fn();
const getCurrentCliVersionMock = vi.fn();
const readPinnedProjectNameMock = vi.fn();
const pinProjectNameMock = vi.fn();

vi.mock('../hook-credentials.js', () => ({ resolveHookCredentials: resolveHookCredentialsMock }));
vi.mock('../identity-resolver.js', async () => ({
  ...(await vi.importActual<typeof import('../identity-resolver.js')>('../identity-resolver.js')),
  resolveIdentity: resolveIdentityMock,
}));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { getActiveProfileName: getActiveProfileNameMock, load: configLoadMock, hasLocalConfig: hasLocalConfigMock },
}));
vi.mock('@/utils/cli-updater.js', () => ({ getCurrentCliVersion: getCurrentCliVersionMock }));
vi.mock('../session-project-pin.js', () => ({
  readPinnedProjectName: readPinnedProjectNameMock,
  pinProjectName: pinProjectNameMock,
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
  sessionId?: string;
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
    return { cwd: input.cwd, prompt: input.prompt, sessionId: input.sessionId };
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
  protected async resolveAgentFields(): Promise<Record<string, unknown>> {
    return { platform: 'fake-platform' };
  }
  protected resolveEventType(event: Record<string, unknown>): string {
    return event['kind'] === 'start' ? 'fake.start' : 'fake.event';
  }
  /** Test-only deterministic id: `<type>:<session>:<sha256(payload + timestamp)>`. */
  protected buildEventId(
    event: Record<string, unknown>,
    payload: Record<string, unknown>,
    timestamp: string
  ): string {
    const hash = createHash('sha256').update(`${JSON.stringify(payload)}::${timestamp}`).digest('hex');
    return `${String(event['type'])}:${String(event['session_id'])}:${hash}`;
  }
}

/** A jwt-shaped access token carrying the given claims. */
const tokenWith = (claims: Record<string, unknown>): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('OtlpAgentAdapter.processOtlpEvent', () => {
  const ensureOtlpProxy = vi.fn(async () => {});
  const forwardToSpool = vi.fn(async () => true);
  const deps = { ensureOtlpProxy, forwardOtlpEventsToSpool: forwardToSpool };
  let adapter: FakeAdapter;

  const run = (input: Partial<FakeInput> = {}) =>
    adapter.processOtlpEvent(JSON.stringify({ cwd: '/repo', payload: [{ a: 1 }], ...input }), deps);
  /** Every event from the batch call(s), in send order. */
  const forwarded = () =>
    forwardToSpool.mock.calls.flatMap(([events]) => events as Record<string, unknown>[]);

  beforeEach(() => {
    vi.clearAllMocks();
    forwardToSpool.mockResolvedValue(true);
    adapter = new FakeAdapter();
    detectGitBranchMock.mockResolvedValue('main');
    detectGitRemoteRepoMock.mockResolvedValue('org/repo');
    resolveHookCredentialsMock.mockResolvedValue({
      cookies: { codemie_access_token: tokenWith({ email: 'dev@example.com' }) },
      apiUrl: 'https://api',
      timestamp: 0,
    });
    resolveIdentityMock.mockResolvedValue({ developerName: 'dev@example.com', identitySource: 'jwt' });
    getActiveProfileNameMock.mockResolvedValue('work');
    configLoadMock.mockResolvedValue({ codeMieProject: 'proj-1' });
    getCurrentCliVersionMock.mockResolvedValue('1.2.3');
    readPinnedProjectNameMock.mockResolvedValue(undefined);
    pinProjectNameMock.mockImplementation(async (_sessionId: string, project: string) => project);
    delete process.env['SDLC_ANALYTICS_STORY_ID'];
    delete process.env['CODEMIE_PROJECT'];
    delete process.env['CLAUDE_PROJECT_DIR'];
  });

  afterEach(() => {
    delete process.env['SDLC_ANALYTICS_STORY_ID'];
    delete process.env['CODEMIE_PROJECT'];
    delete process.env['CLAUDE_PROJECT_DIR'];
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

  it('swallows an ensureOtlpProxy failure, logs it, and still forwards the event', async () => {
    const { logger } = await import('@/utils/logger.js');
    ensureOtlpProxy.mockRejectedValueOnce(new Error('Daemon failed to start within 5 seconds'));
    await expect(run()).resolves.toBeUndefined();
    expect(forwardToSpool).toHaveBeenCalledTimes(1);
    expect(ensureOtlpProxy.mock.invocationCallOrder[0]).toBeLessThan(forwardToSpool.mock.invocationCallOrder[0]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[fake] ensureOtlpProxy failed (non-blocking): Daemon failed to start within 5 seconds')
    );
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
    expect(forwarded()).toHaveLength(2);
    expect(forwarded()[0]).toMatchObject({ a: 1, git_branch: 'main', repo_remote: 'org/repo', story_id: '', story_source: '', platform: 'fake-platform' });
    expect(forwarded()[1]).toMatchObject({ a: 2, git_branch: 'main', repo_remote: 'org/repo', story_id: '', story_source: '', platform: 'fake-platform' });
    expect(forwardToSpool.mock.calls.map(([, name]) => name)).toEqual(['fake']);
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

  it("re-derives the branch story for an event's own git_branch when it differs from the hook-time branch", async () => {
    detectGitBranchMock.mockResolvedValue('feature/BR-2'); // hook-time branch: ticketed
    await run({ payload: [{ git_branch: 'master' }] }); // event's own branch: untracked
    expect(forwarded()[0]).toMatchObject({ git_branch: 'master', story_id: '', story_source: '' });
  });

  it("re-derives a branch story for an event's own git_branch even when the hook-time branch has none", async () => {
    detectGitBranchMock.mockResolvedValue('master'); // hook-time branch: untracked
    await run({ payload: [{ git_branch: 'feature/BR-2' }] }); // event's own branch: ticketed
    expect(forwarded()[0]).toMatchObject({ git_branch: 'feature/BR-2', story_id: 'BR-2', story_source: 'branch' });
  });

  it('never overrides an explicit or marker story even when the event carries a different, ticketed git_branch', async () => {
    process.env['SDLC_ANALYTICS_STORY_ID'] = 'ABC-1';
    detectGitBranchMock.mockResolvedValue('master');
    await run({ payload: [{ git_branch: 'feature/BR-2' }] });
    expect(forwarded()[0]).toMatchObject({ git_branch: 'feature/BR-2', story_id: 'ABC-1', story_source: 'explicit' });
  });

  it("stamps '' on a detached HEAD, even when the record carries an empty value", async () => {
    detectGitBranchMock.mockResolvedValue(undefined);
    await run({ payload: [{ git_branch: '' }] });
    expect(forwarded()[0]['git_branch']).toBe('');
  });

  describe('context fields', () => {
    it('stamps identity, project and version on every event, resolved for the hook cwd', async () => {
      await run({ payload: [{ a: 1 }, { a: 2 }] });
      expect(getActiveProfileNameMock).toHaveBeenCalledWith('/repo');
      expect(configLoadMock).toHaveBeenCalledWith('/repo', { name: 'work' });
      expect(resolveIdentityMock).toHaveBeenCalledWith(expect.objectContaining({ apiUrl: 'https://api' }), '/repo');
      for (const record of forwarded()) {
        expect(record).toMatchObject({
          user_email: 'dev@example.com',
          developer_name: 'dev@example.com',
          identity_source: 'jwt',
          codemie_project_name: 'proj-1',
          codemie_cli_version: '1.2.3',
        });
      }
    });

    it('resolves the context once per invocation, not per event', async () => {
      await run({ payload: [{ a: 1 }, { a: 2 }, { a: 3 }] });
      expect(resolveHookCredentialsMock).toHaveBeenCalledTimes(1);
      expect(configLoadMock).toHaveBeenCalledTimes(1);
    });

    it('without credentials leaves the email empty and takes the identity from a lower tier', async () => {
      resolveHookCredentialsMock.mockResolvedValue(null);
      resolveIdentityMock.mockResolvedValue({ developerName: 'git-user@example.com', identitySource: 'git' });
      await run();
      expect(resolveIdentityMock).toHaveBeenCalledWith(null, '/repo');
      expect(forwarded()[0]).toMatchObject({ user_email: '', developer_name: 'git-user@example.com', identity_source: 'git' });
    });

    it('omits the profile selector when there is no active profile', async () => {
      getActiveProfileNameMock.mockResolvedValue(null);
      await run();
      expect(configLoadMock).toHaveBeenCalledWith('/repo', undefined);
    });

    it('prefers CODEMIE_PROJECT over the resolved config, without even loading it', async () => {
      process.env['CODEMIE_PROJECT'] = 'env-project';
      await run();
      expect(forwarded()[0]).toMatchObject({ codemie_project_name: 'env-project' });
      expect(configLoadMock).not.toHaveBeenCalled();
    });

    it('ignores a blank CODEMIE_PROJECT and falls back to the resolved config', async () => {
      process.env['CODEMIE_PROJECT'] = '   ';
      await run();
      expect(forwarded()[0]).toMatchObject({ codemie_project_name: 'proj-1' });
    });

    it('ignores a blank CLAUDE_PROJECT_DIR and resolves from the hook cwd instead', async () => {
      process.env['CLAUDE_PROJECT_DIR'] = '   ';
      await run();
      expect(getActiveProfileNameMock).toHaveBeenCalledWith('/repo');
      expect(hasLocalConfigMock).not.toHaveBeenCalled();
    });

    it('resolves the config from CLAUDE_PROJECT_DIR, not the hook cwd, when it is set', async () => {
      process.env['CLAUDE_PROJECT_DIR'] = '/workspace/project';
      hasLocalConfigMock.mockResolvedValue(true);
      await run({ cwd: '/workspace/project/src' });
      expect(getActiveProfileNameMock).toHaveBeenCalledWith('/workspace/project');
      expect(configLoadMock).toHaveBeenCalledWith('/workspace/project', { name: 'work' });
    });

    it('walks up from CLAUDE_PROJECT_DIR to the nearest ancestor with a local .codemie config', async () => {
      process.env['CLAUDE_PROJECT_DIR'] = '/workspace/mono/apps/web';
      hasLocalConfigMock.mockImplementation(async (dir: string) => dir === '/workspace/mono');
      await run();
      expect(getActiveProfileNameMock).toHaveBeenCalledWith('/workspace/mono');
    });

    it('falls back to CLAUDE_PROJECT_DIR itself when no ancestor has a local .codemie config', async () => {
      process.env['CLAUDE_PROJECT_DIR'] = '/workspace/project';
      hasLocalConfigMock.mockResolvedValue(false);
      await run();
      expect(getActiveProfileNameMock).toHaveBeenCalledWith('/workspace/project');
    });

    it('returns the pinned project for a session without re-resolving from cwd', async () => {
      readPinnedProjectNameMock.mockResolvedValue('pinned-project');
      await run({ sessionId: 's1' });
      expect(forwarded()[0]).toMatchObject({ codemie_project_name: 'pinned-project' });
      expect(getActiveProfileNameMock).not.toHaveBeenCalled();
    });

    it("pins a session's first resolved project for its later hooks to read back unchanged", async () => {
      await run({ sessionId: 's1' });
      expect(pinProjectNameMock).toHaveBeenCalledWith('s1', 'proj-1');
    });

    it('CODEMIE_PROJECT wins over a pinned project, and is never itself pinned', async () => {
      process.env['CODEMIE_PROJECT'] = 'env-project';
      await run({ sessionId: 's1' });
      expect(forwarded()[0]).toMatchObject({ codemie_project_name: 'env-project' });
      expect(readPinnedProjectNameMock).not.toHaveBeenCalled();
      expect(pinProjectNameMock).not.toHaveBeenCalled();
    });

    it('does not consult or write the pin for a hook with no sessionId', async () => {
      await run();
      expect(readPinnedProjectNameMock).not.toHaveBeenCalled();
      expect(pinProjectNameMock).not.toHaveBeenCalled();
    });

    it("uses this hook's own resolved value when it loses the pin race", async () => {
      pinProjectNameMock.mockResolvedValue('winner-project');
      await run({ sessionId: 's1' });
      expect(forwarded()[0]).toMatchObject({ codemie_project_name: 'winner-project' });
    });

    it('still forwards with empty identity fields when identity resolution fails, independent of project and version', async () => {
      resolveHookCredentialsMock.mockRejectedValue(new Error('boom'));
      await run();
      expect(forwarded()).toHaveLength(1);
      expect(forwarded()[0]).toMatchObject({
        user_email: '',
        developer_name: '',
        identity_source: '',
        codemie_project_name: 'proj-1',
        codemie_cli_version: '1.2.3',
        git_branch: 'main',
      });
    });

    it('uses an empty project name when the config cannot be loaded and an empty version when unknown', async () => {
      configLoadMock.mockRejectedValue(new Error('bad config'));
      getCurrentCliVersionMock.mockResolvedValue(null);
      await run();
      expect(forwarded()[0]).toMatchObject({ codemie_project_name: '', codemie_cli_version: '', developer_name: 'dev@example.com' });
    });
  });

  describe('built event', () => {
    it('stamps schema_version, a deterministic event_id, session_id and the repository identifier as cwd', async () => {
      await run({ payload: [{ session_id: 's1', n: 1 }, { session_id: 's1', n: 2 }] });
      const [first, second] = forwarded();
      expect(first).toMatchObject({ schema_version: 2, session_id: 's1', cwd: 'repo' });
      // `<type>:<session_id>:<sha256 of the record's canonical payload + timestamp>`.
      expect(String(first['event_id'])).toMatch(/^fake\.event:s1:[0-9a-f]{64}$/);
      expect(first['event_id']).not.toBe(second['event_id']);
    });

    it('re-derives the same event_id for identical content at the same timestamp', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-06T07:08:09.000Z'));
      try {
        await run({ payload: [{ session_id: 's1', n: 1 }] });
        await run({ payload: [{ session_id: 's1', n: 1 }] });
      } finally {
        vi.useRealTimers();
      }
      expect(forwarded()[1]['event_id']).toBe(forwarded()[0]['event_id']);
    });

    it('changes the id when the hook time changes', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-05-06T07:08:09.000Z'));
        await run({ payload: [{ session_id: 's1', n: 1 }] });
        vi.setSystemTime(new Date('2026-05-06T07:09:09.000Z'));
        await run({ payload: [{ session_id: 's1', n: 1 }] });
      } finally {
        vi.useRealTimers();
      }
      expect(forwarded()[1]['event_id']).not.toBe(forwarded()[0]['event_id']);
    });

    describe('cwd is the repository identifier, never an absolute path', () => {
      it.each([
        ['/Users/lika/Projects/qa-projects/pr609-preview-agents', 'qa-projects/pr609-preview-agents'],
        ['C:\\Projects\\qa-projects\\pr609-preview-agents', 'qa-projects/pr609-preview-agents'],
        [
          '/Users/alice/Library/Application Support/Claude-3p/local-agent-mode-sessions/abc/def/local_7fb4c6a0-a7b9-4121-960c-035d0e4830ff/outputs',
          'Cowork',
        ],
        ['/', 'unknown'],
      ])('stamps %s as %s on the event and raw', async (cwd, expected) => {
        await run({ cwd });
        const event = forwarded()[0];
        expect(event['cwd']).toBe(expected);
        expect((event['raw'] as Record<string, unknown>)['cwd']).toBe(expected);
        expect(String(event['cwd'])).not.toMatch(/^([/\\]|[A-Za-z]:)/);
      });

      it('keeps repo_remote empty when the remote is unknown', async () => {
        detectGitRemoteRepoMock.mockResolvedValue(undefined);
        await run({ cwd: '/Users/lika/Projects/qa-projects/pr609-preview-agents' });
        expect(forwarded()[0]).toMatchObject({ repo_remote: '', cwd: 'qa-projects/pr609-preview-agents' });
      });

      it('leaves a detected repo_remote unchanged', async () => {
        await run({ cwd: '/Users/lika/Projects/qa-projects/pr609-preview-agents' });
        expect(forwarded()[0]).toMatchObject({ repo_remote: 'org/repo', cwd: 'qa-projects/pr609-preview-agents' });
      });

      it('lets an event-supplied repo_remote override while cwd stays short', async () => {
        await run({ cwd: '/Users/lika/Projects/qa-projects/pr609-preview-agents', payload: [{ repo_remote: 'evt/remote' }] });
        expect(forwarded()[0]).toMatchObject({ repo_remote: 'evt/remote', cwd: 'qa-projects/pr609-preview-agents' });
      });
    });

    it('coerces a missing session_id to an empty string', async () => {
      await run({ payload: [{ a: 1 }] });
      expect(forwarded()[0]['session_id']).toBe('');
    });

    it('puts the hook cwd on derived events too, not the event\'s own', async () => {
      await run({ payload: [{ type: 'derived.event', session_id: 's1' }] });
      expect(forwarded()[0]['cwd']).toBe('repo');
    });

    it('resolves the type from resolveEventType and keeps an explicit one', async () => {
      await run({ payload: [{ kind: 'start' }, { kind: 'start', type: 'explicit.type' }, { type: '' }] });
      expect(forwarded().map((r) => r['type'])).toEqual(['fake.start', 'explicit.type', 'fake.event']);
    });

    it('truncates prompt and tool fields and derives prompt_body', async () => {
      await run({
        payload: [{
          prompt: 'p'.repeat(500),
          tool_input: { text: 'x'.repeat(500) },
          tool_response: 'r'.repeat(500),
          error: 'e'.repeat(500),
        }],
      });
      const record = forwarded()[0];
      expect(record['prompt']).toHaveLength(200);
      expect(record['prompt_body']).toBe('p'.repeat(200));
      expect(record['tool_input']).toHaveLength(300);
      expect(String(record['tool_input']).startsWith('{"text":"x')).toBe(true);
      expect(record['tool_response']).toHaveLength(300);
      expect(record['error']).toHaveLength(300);
    });

    it('normalizes effort objects to their level and omits malformed values', async () => {
      await run({
        payload: [
          { effort: { level: 'high' } },
          { effort: { unsupported: true } },
        ],
      });

      const [valid, malformed] = forwarded();
      expect(valid['effort']).toBe('high');
      expect((valid['raw'] as Record<string, unknown>)['effort']).toBe('high');
      expect(malformed).not.toHaveProperty('effort');
      expect(malformed).not.toHaveProperty('raw.effort');
    });

    it('does not add truncated fields to events that lack them, and prompt_body is empty', async () => {
      await run({ payload: [{ a: 1 }] });
      const record = forwarded()[0];
      expect(record).not.toHaveProperty('prompt');
      expect(record).not.toHaveProperty('tool_input');
      expect(record['prompt_body']).toBe('');
    });

    it('drops a nested raw from the event so it cannot bypass the limits', async () => {
      await run({ payload: [{ raw: { huge: 'x'.repeat(1000) }, a: 1 }] });
      const raw = forwarded()[0]['raw'] as Record<string, unknown>;
      expect(raw).not.toHaveProperty('raw');
      expect(JSON.stringify(forwarded()[0])).not.toContain('huge');
    });

    it('mirrors the full enriched event, context and event_id included, in raw', async () => {
      await run({ payload: [{ session_id: 's1', prompt: 'hi' }] });
      const record = forwarded()[0];
      const { raw, ...outer } = record;
      expect(raw).toEqual(outer);
      expect(raw).toMatchObject({
        event_id: record['event_id'],
        user_email: 'dev@example.com',
        codemie_project_name: 'proj-1',
        platform: 'fake-platform',
        schema_version: 2,
      });
    });

    it('keeps a valid event timestamp, normalised to ISO', async () => {
      await run({ payload: [{ timestamp: '2026-01-02T03:04:05+02:00' }] });
      expect(forwarded()[0]['timestamp']).toBe('2026-01-02T01:04:05.000Z');
    });

    it('falls back to one hook time shared by all events for a missing or invalid timestamp', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-06T07:08:09.000Z'));
      try {
        await run({ payload: [{ a: 1 }, { timestamp: 'not a date' }, { timestamp: '' }] });
      } finally {
        vi.useRealTimers();
      }
      expect(forwarded().map((r) => r['timestamp'])).toEqual(Array(3).fill('2026-05-06T07:08:09.000Z'));
    });

    it('serialises to identical bytes on a re-send, so the timestamp never changes between retries', async () => {
      await run({ payload: [{ a: 1 }] });
      const bytes = JSON.stringify(forwarded()[0]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(JSON.stringify(forwarded()[0])).toBe(bytes);
    });
  });

  describe('spool forwarding', () => {
    it('sends every event as one batch, in payload order', async () => {
      await run({ payload: [{ n: 1 }, { n: 2 }, { n: 3 }] });
      expect(forwardToSpool).toHaveBeenCalledTimes(1);
      expect(forwarded().map((r) => r['n'])).toEqual([1, 2, 3]);
    });

    it('does not resolve before the spool write has finished', async () => {
      let done = false;
      forwardToSpool.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        done = true;
        return true;
      });
      await run();
      expect(done).toBe(true);
    });

    it('does not retry a failed send when retryOnce is unset', async () => {
      forwardToSpool.mockResolvedValue(false);
      await run();
      expect(forwardToSpool).toHaveBeenCalledTimes(1);
    });

    it('resends the same built events once more when retryOnce is set and the first send failed', async () => {
      vi.spyOn(adapter as any, 'evaluate').mockResolvedValue({
        decision: 'forward',
        payload: [{ a: 1 }],
        retryOnce: true,
      });
      forwardToSpool.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await run();
      expect(forwardToSpool).toHaveBeenCalledTimes(2);
      const [firstEvents] = forwardToSpool.mock.calls[0] as [Record<string, unknown>[]];
      const [secondEvents] = forwardToSpool.mock.calls[1] as [Record<string, unknown>[]];
      expect(secondEvents[0]['event_id']).toBe(firstEvents[0]['event_id']);
    });

    it('does not retry a second time when the retry also fails', async () => {
      vi.spyOn(adapter as any, 'evaluate').mockResolvedValue({
        decision: 'forward',
        payload: [{ a: 1 }],
        retryOnce: true,
      });
      forwardToSpool.mockResolvedValue(false);
      await run();
      expect(forwardToSpool).toHaveBeenCalledTimes(2);
    });

    it('calls finalize(true) after an accepted send and finalize(false) after a failed one with no retryOnce', async () => {
      const finalize = vi.fn(async () => {});
      vi.spyOn(adapter as any, 'evaluate').mockResolvedValue({
        decision: 'forward',
        payload: [{ a: 1 }],
        finalize,
      });
      forwardToSpool.mockResolvedValueOnce(true);
      await run();
      expect(finalize).toHaveBeenCalledWith(true);

      finalize.mockClear();
      forwardToSpool.mockResolvedValueOnce(false);
      await run();
      expect(finalize).toHaveBeenCalledWith(false);
    });

    it('calls finalize(true) for an empty payload without resolving context or sending', async () => {
      const finalize = vi.fn(async () => {});
      vi.spyOn(adapter as any, 'evaluate').mockResolvedValue({
        decision: 'forward',
        payload: [],
        finalize,
      });
      await run();
      expect(forwardToSpool).not.toHaveBeenCalled();
      expect(detectGitBranchMock).not.toHaveBeenCalled();
      expect(finalize).toHaveBeenCalledWith(true);
    });
  });
});
