import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../claude-code-otlp.allowlist.js', () => ({
  readAllowlistState: vi.fn(async () => ({ kind: 'valid', paths: ['/proj'] })),
  isProjectTracked: vi.fn(),
}));
vi.mock('@/utils/processes.js', () => ({
  detectGitBranch: vi.fn(async () => 'main'),
  detectGitRemoteRepo: vi.fn(async () => 'org/repo'),
  detectGitHeadSha: vi.fn(async () => 'abc123def456'),
  detectGitCommitsByAuthor: vi.fn(async () => []),
}));
vi.mock('@/providers/plugins/sso/sso.auth-gate.js', () => ({ ensureCodeMieSsoAuth: vi.fn() }));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: vi.fn(async () => ({})), getActiveProfileName: vi.fn(async () => null) },
}));
vi.mock('@/agents/core/hook-credentials.js', () => ({ resolveHookCredentials: vi.fn(async () => null) }));
vi.mock('@/utils/cli-updater.js', () => ({ getCurrentCliVersion: vi.fn(async () => '9.9.9') }));
vi.mock('@/agents/core/identity-resolver.js', () => ({
  resolveGitEmail: vi.fn(async () => 'git@example.com'),
  resolveCodemieCliEmail: vi.fn(async () => 'cli@example.com'),
  resolveOsUser: vi.fn(() => 'osuser'),
  resolveIdentity: vi.fn(async () => ({ developerName: 'dev@example.com', identitySource: 'jwt' })),
  resolveEmailFromCredentials: vi.fn(() => 'dev@example.com'),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const resolveClientVersionMock = vi.fn();
const openMainTranscriptPassMock = vi.fn();
const openPostCompactPassMock = vi.fn();
const openSessionStartPassMock = vi.fn();
const openSessionEnvCheckPassMock = vi.fn();
const openSubagentPassMock = vi.fn();
const openSessionEndPassMock = vi.fn();
const readSubagentMetaMock = vi.fn();
const readForkedSkillMarkerMock = vi.fn();
const subagentFilePathMock = vi.fn((transcriptPath: string, agentId: string) => `${transcriptPath}:${agentId}`);
const resolveSessionEnvFieldsMock = vi.fn();

/** Mirrors `resolveSessionEnvFields`'s real "echo configured_model/permission_mode back" shape. */
const SESSION_ENV_FIELDS_STUB = {
  provider: 'anthropic',
  api_host: 'api.anthropic.com',
  effort: '',
  output_style: '',
  plugins: {},
  mcp_servers: [],
  os: 'linux',
  arch: 'x64',
  node_version: 'v20.0.0',
  timezone: 'UTC',
  hostname_hash: 'deadbeef',
};

vi.mock('../client-version-cache.js', () => ({
  resolveClientVersion: resolveClientVersionMock,
}));

vi.mock('../transcript/orchestrator.js', () => ({
  openMainTranscriptPass: openMainTranscriptPassMock,
  openPostCompactPass: openPostCompactPassMock,
  openSessionStartPass: openSessionStartPassMock,
  openSessionEnvCheckPass: openSessionEnvCheckPassMock,
  openSubagentPass: openSubagentPassMock,
  openSessionEndPass: openSessionEndPassMock,
  buildSessionEnvEvent: (sessionId: string, fields: Record<string, unknown>) => ({
    type: 'agent.session.env',
    session_id: sessionId,
    ...fields,
  }),
}));

vi.mock('../transcript/subagent-usage.js', () => ({
  readSubagentMeta: readSubagentMetaMock,
  readForkedSkillMarker: readForkedSkillMarkerMock,
  subagentFilePath: subagentFilePathMock,
}));

vi.mock('../event-fields/session-env-fields.js', () => ({
  resolveSessionEnvFields: resolveSessionEnvFieldsMock,
}));

import { isProjectTracked } from '../claude-code-otlp.allowlist.js';
import { ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';
import { detectGitHeadSha, detectGitCommitsByAuthor } from '@/utils/processes.js';

// Deferred past the mock-backing consts above: a static import of the plugin would be
// hoisted ahead of them (ESM import hoisting), tripping a TDZ error inside the
// transcript/orchestrator.js mock factory, which closes over those consts.
const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');

const forwardOtlpEventsToSpool = vi.fn(async (_events: Record<string, unknown>[], _agentName: string) => true);

const event = (name: string) => JSON.stringify({ session_id: 's', transcript_path: '', cwd: '/x', hook_event_name: name });

/** A pass with no derived events and a no-op finalize — the default "nothing to add" stub. */
function emptyPass(): { events: Record<string, unknown>[]; finalize: ReturnType<typeof vi.fn> } {
  return { events: [], finalize: vi.fn(async () => {}) };
}

/** `openSessionEnvCheckPass`'s "nothing changed" default — the common case for every test here
 *  that isn't specifically exercising env-change detection. */
function emptyEnvCheck(): { sessionEnvFields: null; finalize: ReturnType<typeof vi.fn> } {
  return { sessionEnvFields: null, finalize: vi.fn(async () => {}) };
}

/** `openSessionEndPass`'s own return shape also carries `gitHeadStart`/`sessionStartedAt`. */
function emptySessionEndPass(): {
  events: Record<string, unknown>[];
  finalize: ReturnType<typeof vi.fn>;
  gitHeadStart: string;
  sessionStartedAt: string;
} {
  return { ...emptyPass(), gitHeadStart: '', sessionStartedAt: '' };
}

/** The `SessionEnvCheckInput` every handler below derives from a hook payload with no
 *  `effort`/`permission_mode` of its own — the common case in this file's fixtures. */
const NO_ENV_CHECK = { cwd: '/repo', effort: '', permissionMode: '' };

/** Every event sent in the batch call (there is at most one call per processOtlpEvent). */
function forwardedEvents(): Record<string, unknown>[] {
  return vi.mocked(forwardOtlpEventsToSpool).mock.calls[0]?.[0] ?? [];
}

describe('ClaudeCodeOtlpPlugin.processOtlpEvent', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    forwardOtlpEventsToSpool.mockResolvedValue(true);
    openSessionStartPassMock.mockResolvedValue(emptyPass());
    resolveSessionEnvFieldsMock.mockImplementation(async (_cwd: string, model: string, permissionMode: string) => ({
      ...SESSION_ENV_FIELDS_STUB,
      configured_model: model,
      permission_mode: permissionMode,
    }));
  });

  it('does nothing for untracked projects, for every event', async () => {
    vi.mocked(isProjectTracked).mockResolvedValue(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      await plugin.processOtlpEvent(event(name), { ensureOtlpProxy, forwardOtlpEventsToSpool });
    }
    expect(ensureOtlpProxy).not.toHaveBeenCalled();
    expect(ensureCodeMieSsoAuth).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('ensures the proxy before forwarding for tracked projects', async () => {
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    await plugin.processOtlpEvent(event('SessionStart'), { ensureOtlpProxy, forwardOtlpEventsToSpool });
    expect(ensureOtlpProxy).toHaveBeenCalledTimes(1);
    expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ensureOtlpProxy).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(forwardOtlpEventsToSpool).mock.invocationCallOrder[0]
    );
  });
});

describe('ClaudeCodeOtlpPlugin hook-time enrichment', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});
  const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;

  function hookEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      session_id: 'sid-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/repo',
      hook_event_name: 'Stop',
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    forwardOtlpEventsToSpool.mockResolvedValue(true);
    openMainTranscriptPassMock.mockResolvedValue(emptyPass());
    openPostCompactPassMock.mockResolvedValue(emptyPass());
    openSessionStartPassMock.mockResolvedValue(emptyPass());
    openSessionEnvCheckPassMock.mockResolvedValue(emptyEnvCheck());
    openSubagentPassMock.mockResolvedValue(emptyPass());
    openSessionEndPassMock.mockResolvedValue(emptySessionEndPass());
    readSubagentMetaMock.mockResolvedValue({});
    readForkedSkillMarkerMock.mockResolvedValue({});
    resolveSessionEnvFieldsMock.mockImplementation(async (_cwd: string, model: string, permissionMode: string) => ({
      ...SESSION_ENV_FIELDS_STUB,
      configured_model: model,
      permission_mode: permissionMode,
    }));
  });

  afterEach(() => {
    if (originalEntrypoint === undefined) {
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    } else {
      process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint;
    }
  });

  it('enriches the forwarded event with platform, entrypoint, and client_version', async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const rawEvent = JSON.stringify(hookEvent());

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(1);
    const [forwarded] = forwardedEvents();
    expect(forwarded.platform).toBe('claude-code');
    expect(forwarded.entrypoint).toBe('cli');
    expect(forwarded.client_version).toBe('2.1.23');
  });

  it('stamps git_branch and repo_remote resolved at hook time', async () => {
    await plugin.processOtlpEvent(JSON.stringify(hookEvent()), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const [forwarded] = forwardedEvents();
    expect(forwarded.git_branch).toBe('main');
    expect(forwarded.repo_remote).toBe('org/repo');
  });

  it.each([
    ['Stop', 'agent.session.stop'],
    ['SessionEnd', 'agent.session.end'],
  ])('stamps git_head_end and git_branch on %s', async (hookEventName) => {
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: hookEventName }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const [forwarded] = forwardedEvents();
    expect(forwarded.git_head_end).toBe('abc123def456');
    expect(forwarded.git_branch).toBe('main');
    expect(forwarded).not.toHaveProperty('git_head_start');
  });

  it('sends an empty git_head_end when the HEAD lookup fails, without dropping the event', async () => {
    vi.mocked(detectGitHeadSha).mockRejectedValueOnce(new Error('not a git repo'));

    await plugin.processOtlpEvent(JSON.stringify(hookEvent({ hook_event_name: 'Stop' })), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    const [forwarded] = forwardedEvents();
    expect(forwarded.git_head_end).toBe('');
  });

  it('does not stamp git_head_end on other events (PreCompact)', async () => {
    await plugin.processOtlpEvent(JSON.stringify(hookEvent({ hook_event_name: 'PreCompact' })), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    const [forwarded] = forwardedEvents();
    expect(forwarded).not.toHaveProperty('git_head_end');
  });

  it('preserves agent_id/agent_type already present on the raw event (SubagentStop)', async () => {
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-1.jsonl',
        agent_id: 'sub-1',
        agent_type: 'explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const [forwarded] = forwardedEvents();
    expect(forwarded.agent_id).toBe('sub-1');
    expect(forwarded.agent_type).toBe('explore');
  });
});

describe('ClaudeCodeOtlpPlugin.processOtlpEvent dispatch', () => {
  const ensureOtlpProxy = vi.fn(async () => {});

  function hookEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      session_id: 'sid-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/repo',
      hook_event_name: 'Stop',
      ...overrides,
    };
  }

  beforeEach(() => {
    openMainTranscriptPassMock.mockReset();
    openMainTranscriptPassMock.mockResolvedValue(emptyPass());
    openPostCompactPassMock.mockReset();
    openPostCompactPassMock.mockResolvedValue(emptyPass());
    openSessionStartPassMock.mockReset();
    openSessionStartPassMock.mockResolvedValue(emptyPass());
    openSessionEnvCheckPassMock.mockReset();
    openSessionEnvCheckPassMock.mockResolvedValue(emptyEnvCheck());
    openSubagentPassMock.mockReset();
    openSubagentPassMock.mockResolvedValue(emptyPass());
    openSessionEndPassMock.mockReset();
    openSessionEndPassMock.mockResolvedValue(emptySessionEndPass());
    readSubagentMetaMock.mockReset();
    readSubagentMetaMock.mockResolvedValue({});
    readForkedSkillMarkerMock.mockReset();
    readForkedSkillMarkerMock.mockResolvedValue({});
    subagentFilePathMock.mockClear();
    resolveClientVersionMock.mockReset();
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    resolveSessionEnvFieldsMock.mockReset();
    resolveSessionEnvFieldsMock.mockImplementation(async (_cwd: string, model: string, permissionMode: string) => ({
      ...SESSION_ENV_FIELDS_STUB,
      configured_model: model,
      permission_mode: permissionMode,
    }));
    vi.mocked(detectGitCommitsByAuthor).mockReset();
    vi.mocked(detectGitCommitsByAuthor).mockResolvedValue([]);
    forwardOtlpEventsToSpool.mockReset();
    forwardOtlpEventsToSpool.mockResolvedValue(true);
    vi.mocked(isProjectTracked).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['Stop', 'PreCompact', 'StopFailure'] as const)(
    'invokes openMainTranscriptPass with the extracted session/transcript/trigger on %s',
    async (hookEventName) => {
      const plugin = new ClaudeCodeOtlpPlugin();
      const parsedEvent = hookEvent({ hook_event_name: hookEventName });
      const rawEvent = JSON.stringify(parsedEvent);

      await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

      expect(openMainTranscriptPassMock).toHaveBeenCalledWith(
        'sid-1',
        '/tmp/transcript.jsonl',
        hookEventName,
        NO_ENV_CHECK
      );
      const [forwarded] = forwardedEvents();
      expect(forwarded).toMatchObject({ ...parsedEvent, cwd: 'repo' });
    }
  );

  it('invokes openPostCompactPass with the session/transcript on PostCompact, and forwards only its derived events', async () => {
    const compactDoneEvent = {
      type: 'agent.session.compact.done',
      session_id: 'sid-1',
      pre_tokens: 1000,
      post_tokens: 300,
      dropped_tokens: 700,
      duration_ms: 60_000,
      timestamp: '2026-10-01T00:10:00.000Z',
    };
    openPostCompactPassMock.mockResolvedValue({ events: [compactDoneEvent], finalize: vi.fn(async () => {}) });
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'PostCompact', trigger: 'auto' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openPostCompactPassMock).toHaveBeenCalledWith('sid-1', '/tmp/transcript.jsonl');
    const forwarded = forwardedEvents();
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject(compactDoneEvent);
    // The native PostCompact hook event itself is never forwarded.
    expect(forwarded[0].hook_event_name).toBeUndefined();
  });

  it('forwards nothing for PostCompact when openPostCompactPass finds no new compaction', async () => {
    openPostCompactPassMock.mockResolvedValue(emptyPass());
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'PostCompact', trigger: 'manual' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('invokes openSessionEndPass with the session/transcript/cwd on SessionEnd, and sets retryOnce', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    const parsedEvent = hookEvent({ hook_event_name: 'SessionEnd' });
    const rawEvent = JSON.stringify(parsedEvent);

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openSessionEndPassMock).toHaveBeenCalledWith('sid-1', '/tmp/transcript.jsonl', '/repo', NO_ENV_CHECK);
    const [forwarded] = forwardedEvents();
    expect(forwarded).toMatchObject({ ...parsedEvent, cwd: 'repo' });
  });

  it('resends the SessionEnd batch once more when the first send fails (retryOnce)', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    forwardOtlpEventsToSpool.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'SessionEnd' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(2);
  });

  it('does not retry Stop (no retryOnce) when the send fails', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    forwardOtlpEventsToSpool.mockResolvedValue(false);
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'Stop' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(1);
  });

  it('calls the pass finalize with the send outcome', async () => {
    const pass = emptyPass();
    openMainTranscriptPassMock.mockResolvedValue(pass);
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'Stop' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(pass.finalize).toHaveBeenCalledWith(true);
  });

  it('does not dispatch openMainTranscriptPass for unrelated hook events', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openMainTranscriptPassMock).not.toHaveBeenCalled();
  });

  it.each(['Edit', 'Write', 'MultiEdit'])(
    'stamps file_path on agent.tool.start/end for %s',
    async (toolName) => {
      const plugin = new ClaudeCodeOtlpPlugin();
      await plugin.processOtlpEvent(
        JSON.stringify(hookEvent({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { file_path: '/repo/a.ts' } })),
        { ensureOtlpProxy, forwardOtlpEventsToSpool }
      );
      expect(forwardedEvents()[0].file_path).toBe('/repo/a.ts');

      await plugin.processOtlpEvent(
        JSON.stringify(
          hookEvent({
            hook_event_name: 'PostToolUse',
            tool_name: toolName,
            tool_input: { file_path: '/repo/a.ts' },
            tool_response: {},
          })
        ),
        { ensureOtlpProxy, forwardOtlpEventsToSpool }
      );
      expect(forwardedEvents()[0].file_path).toBe('/repo/a.ts');
    }
  );

  it('stamps file_path from notebook_path on NotebookEdit', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    await plugin.processOtlpEvent(
      JSON.stringify(
        hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: '/repo/nb.ipynb' } })
      ),
      { ensureOtlpProxy, forwardOtlpEventsToSpool }
    );
    expect(forwardedEvents()[0].file_path).toBe('/repo/nb.ipynb');
  });

  it.each(['Agent', 'Task'])('stamps a bounded subagent description on agent.tool.start/end for %s', async (toolName) => {
    for (const hookEventName of ['PreToolUse', 'PostToolUse']) {
      vi.clearAllMocks();
      vi.mocked(isProjectTracked).mockResolvedValue(true);
      resolveClientVersionMock.mockResolvedValue('2.1.23');
      forwardOtlpEventsToSpool.mockResolvedValue(true);
      const plugin = new ClaudeCodeOtlpPlugin();
      const description = 'd'.repeat(350);
      await plugin.processOtlpEvent(
        JSON.stringify(
          hookEvent({
            hook_event_name: hookEventName,
            tool_name: toolName,
            tool_input: { subagent_type: 'Explore', description },
          })
        ),
        { ensureOtlpProxy, forwardOtlpEventsToSpool }
      );
      const [forwarded] = forwardedEvents();
      expect(forwarded.subagent_type).toBe('Explore');
      expect(forwarded.description).toBe('d'.repeat(300));
      expect(forwarded.raw.description).toBe('d'.repeat(300));
    }
  });

  it.each(['PreToolUse', 'PostToolUse'])('stamps skill_name on agent.tool.start/end for Skill (%s)', async (hookEventName) => {
    const plugin = new ClaudeCodeOtlpPlugin();
    await plugin.processOtlpEvent(
      JSON.stringify(hookEvent({ hook_event_name: hookEventName, tool_name: 'Skill', tool_input: { skill: 'codemie:msgraph' } })),
      { ensureOtlpProxy, forwardOtlpEventsToSpool }
    );
    expect(forwardedEvents()[0].skill_name).toBe('codemie:msgraph');
  });

  it('stamps lines_added/lines_removed on agent.tool.end from the Edit structuredPatch', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    await plugin.processOtlpEvent(
      JSON.stringify(
        hookEvent({
          hook_event_name: 'PostToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: '/repo/a.ts' },
          tool_response: { structuredPatch: [{ lines: ['+a', '+b', '-old'] }] },
        })
      ),
      { ensureOtlpProxy, forwardOtlpEventsToSpool }
    );
    const [forwarded] = forwardedEvents();
    expect(forwarded.lines_added).toBe(2);
    expect(forwarded.lines_removed).toBe(1);
  });

  it('does not stamp lines_added/lines_removed on agent.tool.start (not resolvable pre-execution)', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    await plugin.processOtlpEvent(
      JSON.stringify(hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/a.ts' } })),
      { ensureOtlpProxy, forwardOtlpEventsToSpool }
    );
    const [forwarded] = forwardedEvents();
    expect(forwarded.lines_added).toBeUndefined();
    expect(forwarded.lines_removed).toBeUndefined();
  });

  it('invokes openSubagentPass with the agent_id/tool_use_id/agent_type extracted from a SubagentStop payload', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-1.jsonl',
        agent_id: 'sub-1',
        tool_use_id: 'tu-1',
        agent_type: 'explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openSubagentPassMock).toHaveBeenCalledWith(
      'sid-1',
      {
        agentId: 'sub-1',
        filePath: '/tmp/agent-sub-1.jsonl',
        toolUseId: 'tu-1',
        agentType: 'explore',
        cwd: '/repo',
      },
      NO_ENV_CHECK
    );
  });

  it('derives agent_id from the sidecar filename on SubagentStop when agent_id is absent', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-2.jsonl',
        agent_type: 'explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openSubagentPassMock).toHaveBeenCalledWith(
      'sid-1',
      expect.objectContaining({ agentId: 'sub-2' }),
      NO_ENV_CHECK
    );
  });

  it('never derives an empty agentId, even from a degenerate transcript path with no agent_id (CR-001 regression)', async () => {
    // Both agent_id and the basename-stripped id are empty here — agentId must still fall back
    // to something non-empty (the full transcript path), never ''. An empty agentId would be
    // treated as main-thread by deriveMainEvents' api_calls filter, double-counting this
    // subagent's usage right back into the main session's count (EPMCDME-15968).
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/subagents/agent-.jsonl',
        agent_type: 'explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const call = openSubagentPassMock.mock.calls[0]?.[1] as { agentId?: string } | undefined;
    expect(call?.agentId).toBeTruthy();
  });

  it('fills tool_use_id/spawn_depth/description from the .meta.json sidecar on SubagentStop', async () => {
    readSubagentMetaMock.mockResolvedValue({ toolUseId: 'tu-sidecar', spawnDepth: 2, description: 'task' });
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-3.jsonl',
        agent_id: 'sub-3',
        agent_type: 'explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(readSubagentMetaMock).toHaveBeenCalledWith('/tmp/agent-sub-3.jsonl');
    expect(openSubagentPassMock).toHaveBeenCalledWith(
      'sid-1',
      {
        agentId: 'sub-3',
        filePath: '/tmp/agent-sub-3.jsonl',
        toolUseId: 'tu-sidecar',
        agentType: 'explore',
        spawnDepth: 2,
        description: 'task',
        cwd: '/repo',
      },
      NO_ENV_CHECK
    );
  });

  it('stamps description/tool_use_id/spawn_depth/worktree/started_at/duration_ms on the forwarded agent.subagent.stop event', async () => {
    readSubagentMetaMock.mockResolvedValue({ toolUseId: 'tu-sidecar', spawnDepth: 2, description: 'task' });
    openSubagentPassMock.mockResolvedValue({
      events: [{ type: 'agent.subagent.usage', started_at: '2026-10-01T00:00:00.000Z', duration_ms: 1500 }],
      finalize: vi.fn(async () => {}),
    });
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-3.jsonl',
        agent_id: 'sub-3',
        agent_type: 'explore',
        cwd: '/repo/worktrees/feature',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const [stopEvent] = forwardedEvents();
    expect(stopEvent).toMatchObject({
      description: 'task',
      tool_use_id: 'tu-sidecar',
      spawn_depth: 2,
      // The repository identifier, never the absolute cwd — same value the event's own `cwd` carries.
      worktree: 'worktrees/feature',
      started_at: '2026-10-01T00:00:00.000Z',
      duration_ms: 1500,
    });
    expect(stopEvent.cwd).toBe('worktrees/feature');
  });

  it('omits started_at/duration_ms/spawn_depth on agent.subagent.stop when they are unknown', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-5.jsonl',
        agent_id: 'sub-5',
        agent_type: 'explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const [stopEvent] = forwardedEvents();
    expect(stopEvent.started_at).toBeUndefined();
    expect(stopEvent.duration_ms).toBeUndefined();
    expect(stopEvent.spawn_depth).toBeUndefined();
  });

  it('skips openSubagentPass on SubagentStop when agent_transcript_path is missing', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'SubagentStop', agent_type: 'explore' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openSubagentPassMock).not.toHaveBeenCalled();
  });

  it('skips SubagentStop entirely (no forward, no derive) when agent_type is empty', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-4.jsonl',
        agent_type: '',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openSubagentPassMock).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('forwards skill_name on SubagentStop when the forked-skill marker sidecar names a skill', async () => {
    readSubagentMetaMock.mockResolvedValue({ spawnDepth: 1, description: '/code-review' });
    readForkedSkillMarkerMock.mockResolvedValue({ skillName: 'code-review' });
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-6.jsonl',
        agent_type: 'general-purpose',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardedEvents()[0]).toMatchObject({ skill_name: 'code-review' });
  });

  it('does not add skill_name on SubagentStop for a regular (non-skill) agent dispatch', async () => {
    readSubagentMetaMock.mockResolvedValue({ spawnDepth: 0, description: 'Explore the repo' });
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-7.jsonl',
        agent_type: 'Explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardedEvents()[0]).not.toHaveProperty('skill_name');
  });

  it('does not add skill_name on SubagentStop for a regular agent started with its own `name` (EPMCDME-15968 regression: `name` is the Agent tool\'s addressing field, not a skill marker)', async () => {
    readSubagentMetaMock.mockResolvedValue({ spawnDepth: 1, description: 'repo scout' });
    readForkedSkillMarkerMock.mockResolvedValue({}); // no forked-skill marker — this is a regular named agent
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-named.jsonl',
        agent_type: 'Explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardedEvents()[0]).not.toHaveProperty('skill_name');
  });

  it('forwards skill_name on SubagentStart when the forked-skill marker sidecar names a skill', async () => {
    readForkedSkillMarkerMock.mockResolvedValue({ skillName: 'code-review' });
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'sub-6',
        agent_type: 'general-purpose',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardedEvents()[0]).toMatchObject({ skill_name: 'code-review' });
  });

  it('does not add skill_name on SubagentStart for a regular agent (no forked-skill marker)', async () => {
    readForkedSkillMarkerMock.mockResolvedValue({});
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'sub-named',
        agent_type: 'Explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardedEvents()[0]).not.toHaveProperty('skill_name');
    expect(subagentFilePathMock).toHaveBeenCalledWith('/tmp/transcript.jsonl', 'sub-named');
  });

  it('skips SubagentStart entirely (no forward, no sidecar read) when agent_type is empty', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'sub-checkin',
        agent_type: '',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
    expect(subagentFilePathMock).not.toHaveBeenCalled();
    expect(readForkedSkillMarkerMock).not.toHaveBeenCalled();
  });

  it('forwards every event a pass returns (the raw event plus any derived events) as one batch, in order', async () => {
    const derivedUsageEvent = { type: 'agent.usage.request' };
    const derivedSummaryEvent = { type: 'agent.session.summary' };
    openMainTranscriptPassMock.mockResolvedValue({
      events: [derivedUsageEvent, derivedSummaryEvent],
      finalize: vi.fn(async () => {}),
    });

    const plugin = new ClaudeCodeOtlpPlugin();
    const parsedEvent = hookEvent({ hook_event_name: 'Stop' });
    const rawEvent = JSON.stringify(parsedEvent);

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    // openMainTranscriptPass never calls forwardOtlpEventsToSpool itself (it is mocked here to
    // just return data) — every event that reaches the mock arrived via one batch call from
    // processOtlpEvent.
    expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(1);
    expect(forwardedEvents()).toEqual([
      expect.objectContaining({ ...parsedEvent, cwd: 'repo' }),
      expect.objectContaining(derivedUsageEvent),
      expect.objectContaining(derivedSummaryEvent),
    ]);
  });

  it('rejects when rawEvent is malformed JSON', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();

    await expect(plugin.processOtlpEvent('not json', { ensureOtlpProxy, forwardOtlpEventsToSpool })).rejects.toThrow();
  });
});

describe('ClaudeCodeOtlpPlugin wire type', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    forwardOtlpEventsToSpool.mockResolvedValue(true);
    openMainTranscriptPassMock.mockResolvedValue(emptyPass());
    openPostCompactPassMock.mockResolvedValue(emptyPass());
    openSessionStartPassMock.mockResolvedValue(emptyPass());
    openSessionEnvCheckPassMock.mockResolvedValue(emptyEnvCheck());
    openSubagentPassMock.mockResolvedValue(emptyPass());
    openSessionEndPassMock.mockResolvedValue(emptySessionEndPass());
    readSubagentMetaMock.mockResolvedValue({});
    readForkedSkillMarkerMock.mockResolvedValue({});
    resolveSessionEnvFieldsMock.mockImplementation(async (_cwd: string, model: string, permissionMode: string) => ({
      ...SESSION_ENV_FIELDS_STUB,
      configured_model: model,
      permission_mode: permissionMode,
    }));
    vi.mocked(detectGitCommitsByAuthor).mockResolvedValue([]);
  });

  const typeFor = async (name: string): Promise<unknown> => {
    // A SubagentStart/SubagentStop with no agent_type is Claude Code's own internal check-in,
    // never forwarded (see the `claude-code-otlp.plugin.ts` guards) — give it one here so this
    // generic wire-type matrix still exercises its mapping, like every other hook name.
    const raw =
      name === 'SubagentStart' || name === 'SubagentStop'
        ? JSON.stringify({ session_id: 's', transcript_path: '', cwd: '/x', hook_event_name: name, agent_type: 'explore' })
        : name === 'UserPromptExpansion'
          ? JSON.stringify({
              session_id: 's',
              transcript_path: '',
              cwd: '/x',
              hook_event_name: name,
              expansion_type: 'slash_command',
              command_name: 'example-skill',
            })
          : event(name);
    await plugin.processOtlpEvent(raw, { ensureOtlpProxy, forwardOtlpEventsToSpool });
    return forwardedEvents()[0]['type'];
  };

  it.each([
    ['SessionStart', 'agent.session.start'],
    ['Stop', 'agent.session.stop'],
    ['StopFailure', 'agent.turn.error'],
    ['SessionEnd', 'agent.session.end'],
    ['PreToolUse', 'agent.tool.start'],
    ['PostToolUse', 'agent.tool.end'],
    ['PostToolUseFailure', 'agent.tool.error'],
    ['SubagentStart', 'agent.subagent.start'],
    ['SubagentStop', 'agent.subagent.stop'],
    ['PreCompact', 'agent.session.compact'],
    ['Notification', 'agent.notification'],
    ['UserPromptExpansion', 'agent.skill.dispatch'],
  ])('maps %s to %s', async (hookName, expectedType) => {
    expect(await typeFor(hookName)).toBe(expectedType);
  });

  it('maps PostCompact to agent.session.compact.done only via its derived record, never the raw hook', async () => {
    openPostCompactPassMock.mockResolvedValue({
      events: [{ type: 'agent.session.compact.done', session_id: 's' }],
      finalize: vi.fn(async () => {}),
    });
    await plugin.processOtlpEvent(event('PostCompact'), { ensureOtlpProxy, forwardOtlpEventsToSpool });
    expect(forwardedEvents()[0]['type']).toBe('agent.session.compact.done');
  });

  it('maps UserPromptSubmit to agent.prompt.submit', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: true } as never);
    await plugin.processOtlpEvent(
      JSON.stringify({ session_id: 's', transcript_path: '', cwd: '/x', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
      { ensureOtlpProxy, forwardOtlpEventsToSpool }
    );
    expect(forwardedEvents()[0]['type']).toBe('agent.prompt.submit');
  });

  it('falls back to agent.event for an unmapped hook name', () => {
    const resolve = (plugin as unknown as { resolveEventType(e: Record<string, unknown>): string }).resolveEventType;
    expect(resolve.call(plugin, { hook_event_name: 'SomethingNew' })).toBe('agent.event');
    expect(resolve.call(plugin, {})).toBe('agent.event');
  });

  it('keeps the explicit type of a derived event', async () => {
    openMainTranscriptPassMock.mockResolvedValue({
      events: [{ type: 'agent.usage.request', session_id: 's' }],
      finalize: vi.fn(async () => {}),
    });
    await plugin.processOtlpEvent(event('Stop'), { ensureOtlpProxy, forwardOtlpEventsToSpool });
    const types = forwardedEvents().map((r) => r['type']);
    expect(types).toEqual(['agent.session.stop', 'agent.usage.request']);
  });
});

describe('ClaudeCodeOtlpPlugin agent.skill.dispatch (UserPromptExpansion)', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    forwardOtlpEventsToSpool.mockResolvedValue(true);
  });

  it('copies command_name into skill_name for a slash-command expansion (ticket fields only)', async () => {
    const raw = JSON.stringify({
      session_id: 's',
      prompt_id: 'p-1',
      transcript_path: '',
      cwd: '/x',
      hook_event_name: 'UserPromptExpansion',
      expansion_type: 'slash_command',
      command_name: 'superpowers:brainstorming',
      command_args: 'how are you?',
      command_source: 'plugin',
      prompt: '/superpowers:brainstorming how are you?',
    });

    await plugin.processOtlpEvent(raw, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const [forwarded] = forwardedEvents();
    expect(forwarded.type).toBe('agent.skill.dispatch');
    expect(forwarded.prompt_id).toBe('p-1');
    expect(forwarded.raw.prompt_id).toBe('p-1');
    expect(forwarded.skill_name).toBe('superpowers:brainstorming');
    expect(forwarded.command_name).toBe('superpowers:brainstorming');
    expect(forwarded).not.toHaveProperty('command_args');
    expect(forwarded).not.toHaveProperty('prompt');
    expect(forwarded.raw).not.toHaveProperty('command_args');
    expect(forwarded.raw).not.toHaveProperty('prompt');
  });

  it('does not forward an mcp_prompt expansion as a skill dispatch', async () => {
    const raw = JSON.stringify({
      session_id: 's',
      transcript_path: '',
      cwd: '/x',
      hook_event_name: 'UserPromptExpansion',
      expansion_type: 'mcp_prompt',
      command_name: 'some-mcp-prompt',
      command_args: '',
      prompt: 'expanded text',
    });

    await plugin.processOtlpEvent(raw, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardedEvents()).toEqual([]);
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });
});

describe('ClaudeCodeOtlpPlugin agent.session.env (SessionStart)', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    forwardOtlpEventsToSpool.mockResolvedValue(true);
    // Default: openSessionStartPass echoes back whatever sessionEnvFields it was given, as if
    // there were no prior snapshot to merge onto — matches real first-fire behavior and keeps
    // the pre-existing tests in this block (which assert against the raw resolved fields)
    // passing unchanged.
    openSessionStartPassMock.mockImplementation(async (_sessionId: string, gitHeadStart: string, fields: unknown) => ({
      ...emptyPass(),
      sessionEnvFields: fields,
      gitHeadStart,
    }));
    resolveSessionEnvFieldsMock.mockImplementation(async (_cwd: string, model: string, permissionMode: string) => ({
      ...SESSION_ENV_FIELDS_STUB,
      configured_model: model,
      permission_mode: permissionMode,
    }));
  });

  it('forwards agent.session.env as a second record alongside agent.session.start, carrying every resolved field', async () => {
    const raw = JSON.stringify({
      session_id: 's',
      transcript_path: '',
      cwd: '/x',
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-opus-5',
      permission_mode: 'acceptEdits',
    });

    await plugin.processOtlpEvent(raw, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const forwarded = forwardedEvents();
    expect(forwarded).toHaveLength(2);
    expect(forwarded[0].type).toBe('agent.session.start');
    expect(forwarded[0]).toMatchObject({
      os: process.platform,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
      git_email: 'git@example.com',
      codemie_cli_email: 'cli@example.com',
      os_user: 'osuser',
      git_head_start: 'abc123def456',
    });
    // The payload's `model` is only an input to the env snapshot's `configured_model`; the backend
    // does not read `model` on session.start.
    expect(forwarded[0]).not.toHaveProperty('model');
    expect(forwarded[1]).toMatchObject({
      type: 'agent.session.env',
      session_id: 's',
      configured_model: 'claude-opus-5',
      permission_mode: 'acceptEdits',
      ...SESSION_ENV_FIELDS_STUB,
    });
  });

  it('gives a changed SessionStart snapshot a new agent.session.env event_id', async () => {
    const raw = JSON.stringify({
      session_id: 's',
      transcript_path: '',
      cwd: '/x',
      hook_event_name: 'SessionStart',
      source: 'resume',
    });

    resolveSessionEnvFieldsMock.mockResolvedValueOnce({
      ...SESSION_ENV_FIELDS_STUB,
      configured_model: 'model-a',
      permission_mode: '',
    });
    await plugin.processOtlpEvent(raw, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    resolveSessionEnvFieldsMock.mockResolvedValueOnce({
      ...SESSION_ENV_FIELDS_STUB,
      configured_model: 'model-b',
      permission_mode: '',
    });
    // A later snapshot must be stored, not dropped as a duplicate of the earlier id.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await plugin.processOtlpEvent(raw, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const envIds = vi
      .mocked(forwardOtlpEventsToSpool)
      .mock.calls.map(([events]) => events.find((e) => e.type === 'agent.session.env')?.['event_id']);
    expect(envIds).toHaveLength(2);
    expect(envIds[0]).not.toBe(envIds[1]);
    expect(String(envIds[0])).toMatch(/^agent\.session\.env:s:[0-9a-f]{64}$/);
  });

  it('passes the hook cwd and model into resolveSessionEnvFields', async () => {
    await plugin.processOtlpEvent(
      JSON.stringify({
        session_id: 's',
        transcript_path: '',
        cwd: '/repo',
        hook_event_name: 'SessionStart',
        model: 'claude-sonnet-5',
      }),
      { ensureOtlpProxy, forwardOtlpEventsToSpool }
    );

    expect(resolveSessionEnvFieldsMock).toHaveBeenCalledWith('/repo', 'claude-sonnet-5', '');
  });

  it('opens the SessionStart pass with the resolved git_head_start and wires its finalize into the ForwardDecision', async () => {
    const pass = emptyPass();
    openSessionStartPassMock.mockResolvedValue({ ...pass, gitHeadStart: 'persisted-start-sha' });

    await plugin.processOtlpEvent(event('SessionStart'), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openSessionStartPassMock).toHaveBeenCalledWith(
      's',
      'abc123def456',
      expect.objectContaining({ configured_model: '', permission_mode: '' })
    );
    expect(forwardedEvents()[0].git_head_start).toBe('persisted-start-sha');
    expect(pass.finalize).toHaveBeenCalledWith(true);
  });

  it("sends the SessionStart pass's merged sessionEnvFields, not the raw resolveSessionEnvFields output", async () => {
    const mergedFields = {
      ...SESSION_ENV_FIELDS_STUB,
      configured_model: 'claude-opus-5',
      effort: 'high', // carried forward by openSessionStartPass; never in the raw payload
      permission_mode: 'acceptEdits',
    };
    openSessionStartPassMock.mockResolvedValue({ events: [], finalize: vi.fn(async () => {}), sessionEnvFields: mergedFields });
    resolveSessionEnvFieldsMock.mockResolvedValue({ ...SESSION_ENV_FIELDS_STUB, configured_model: '', permission_mode: '' });

    await plugin.processOtlpEvent(
      JSON.stringify({ session_id: 's', transcript_path: '', cwd: '/x', hook_event_name: 'SessionStart', source: 'resume' }),
      { ensureOtlpProxy, forwardOtlpEventsToSpool }
    );

    const forwarded = forwardedEvents();
    const envEvent = forwarded.find((e) => e.type === 'agent.session.env');
    expect(envEvent).toMatchObject({ configured_model: 'claude-opus-5', effort: 'high', permission_mode: 'acceptEdits' });
  });
});

describe('ClaudeCodeOtlpPlugin agent.session.env (PostModelSwitch/ConfigChange)', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});

  const hook = (hookEventName: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ session_id: 's', transcript_path: '', cwd: '/x', hook_event_name: hookEventName, ...extra });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    forwardOtlpEventsToSpool.mockResolvedValue(true);
    openSessionEnvCheckPassMock.mockResolvedValue(emptyEnvCheck());
  });

  it('forwards only the derived agent.session.env for PostModelSwitch and fully re-resolves the model', async () => {
    const finalize = vi.fn(async () => {});
    openSessionEnvCheckPassMock.mockResolvedValue({
      sessionEnvFields: { ...SESSION_ENV_FIELDS_STUB, configured_model: 'claude-opus-5' },
      finalize,
    });

    await plugin.processOtlpEvent(hook('PostModelSwitch', { to_model: 'claude-opus-5' }), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    expect(openSessionEnvCheckPassMock).toHaveBeenCalledWith('s', {
      effort: '',
      permissionMode: '',
      full: { cwd: '/x', configuredModel: 'claude-opus-5', replaceEffort: true },
    });
    expect(forwardedEvents()).toEqual([
      expect.objectContaining({ type: 'agent.session.env', configured_model: 'claude-opus-5' }),
    ]);
    expect(finalize).toHaveBeenCalledWith(true);
  });

  it('forwards nothing when the PostModelSwitch env check finds no change', async () => {
    const finalize = vi.fn(async () => {});
    openSessionEnvCheckPassMock.mockResolvedValue({ sessionEnvFields: null, finalize });

    await plugin.processOtlpEvent(hook('PostModelSwitch', { to_model: 'claude-opus-5' }), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith(true);
  });

  it('re-resolves env for a ConfigChange on settings, without a configured model', async () => {
    openSessionEnvCheckPassMock.mockResolvedValue({
      sessionEnvFields: { ...SESSION_ENV_FIELDS_STUB, configured_model: 'claude-sonnet-5' },
      finalize: vi.fn(async () => {}),
    });

    await plugin.processOtlpEvent(hook('ConfigChange', { source: 'user_settings' }), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    expect(openSessionEnvCheckPassMock).toHaveBeenCalledWith('s', {
      effort: '',
      permissionMode: '',
      full: { cwd: '/x' },
    });
    expect(forwardedEvents()[0]).toMatchObject({ type: 'agent.session.env', configured_model: 'claude-sonnet-5' });
  });

  it('skips a ConfigChange for source=skills before touching the pass', async () => {
    await plugin.processOtlpEvent(hook('ConfigChange', { source: 'skills' }), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    expect(openSessionEnvCheckPassMock).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });
});

describe('ClaudeCodeOtlpPlugin agent.git.snapshot (SessionEnd)', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    forwardOtlpEventsToSpool.mockResolvedValue(true);
    openSessionEndPassMock.mockResolvedValue({
      events: [],
      finalize: vi.fn(async () => {}),
      gitHeadStart: 'sha-start-111',
      sessionStartedAt: '2026-10-01T00:00:00.000Z',
    });
    openSessionEnvCheckPassMock.mockResolvedValue(emptyEnvCheck());
    vi.mocked(detectGitCommitsByAuthor).mockResolvedValue([]);
  });

  const sessionEndEvent = () =>
    JSON.stringify({ session_id: 's', transcript_path: '', cwd: '/repo', hook_event_name: 'SessionEnd', reason: 'other' });

  it('forwards agent.git.snapshot with git_head_start/end and git_commits, alongside agent.session.end', async () => {
    vi.mocked(detectGitCommitsByAuthor).mockResolvedValue([
      { sha: 'c1', time: '2026-10-01T01:00:00.000Z', files: 2, added: 10, removed: 1 },
    ]);

    await plugin.processOtlpEvent(sessionEndEvent(), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const forwarded = forwardedEvents();
    expect(forwarded[0].type).toBe('agent.session.end');
    const snapshot = forwarded.find((e) => e.type === 'agent.git.snapshot');
    expect(snapshot).toMatchObject({
      type: 'agent.git.snapshot',
      session_id: 's',
      git_head_start: 'sha-start-111',
      git_head_end: 'abc123def456',
      git_commits: [{ sha: 'c1', time: '2026-10-01T01:00:00.000Z', files: 2, added: 10, removed: 1 }],
    });
    expect(snapshot?.git_email).toBe('git@example.com');
    // Deterministic id from the snapshot's own natural key.
    expect(snapshot?.event_id).toBe('agent.git.snapshot:s:git-snapshot:abc123def456');
  });

  it('passes the pass-opener session start time into detectGitCommitsByAuthor', async () => {
    await plugin.processOtlpEvent(sessionEndEvent(), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(detectGitCommitsByAuthor).toHaveBeenCalledWith('/repo', '2026-10-01T00:00:00.000Z', 'git@example.com');
  });

  it('falls back to an empty git_head_start when SessionStart never persisted one', async () => {
    openSessionEndPassMock.mockResolvedValue(emptySessionEndPass());

    await plugin.processOtlpEvent(sessionEndEvent(), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const snapshot = forwardedEvents().find((e) => e.type === 'agent.git.snapshot');
    expect(snapshot?.git_head_start).toBe('');
  });
});

describe('ClaudeCodeOtlpPlugin agent.prompt.submit enrichment', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});

  const promptEvent = (prompt: string, overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: 's',
      transcript_path: '',
      cwd: '/x',
      hook_event_name: 'UserPromptSubmit',
      prompt,
      ...overrides,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: true } as never);
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    forwardOtlpEventsToSpool.mockResolvedValue(true);
    openMainTranscriptPassMock.mockResolvedValue(emptyPass());
    openSessionEnvCheckPassMock.mockResolvedValue(emptyEnvCheck());
  });

  it('stamps command_name, story_marker, ticket_mentions and prompt_length', async () => {
    await plugin.processOtlpEvent(promptEvent('/sdlc-factory:sdlc-standard story: abc-12 and see XYZ-3, abc-12'), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    const [forwarded] = forwardedEvents();
    expect(forwarded['command_name']).toBe('sdlc-factory:sdlc-standard');
    expect(forwarded['story_marker']).toBe('ABC-12');
    expect(forwarded['ticket_mentions']).toEqual(['ABC-12', 'XYZ-3']);
    expect(forwarded['prompt_length']).toBe('/sdlc-factory:sdlc-standard story: abc-12 and see XYZ-3, abc-12'.length);
  });

  it('derives prompt_length from the full prompt, not the 200-char prompt_body', async () => {
    await plugin.processOtlpEvent(promptEvent('x'.repeat(500)), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const [forwarded] = forwardedEvents();
    expect(forwarded['prompt_length']).toBe(500);
    expect(String(forwarded['prompt_body'])).toHaveLength(200);
  });

  it('finds a ticket mention that sits beyond the 200-char cut', async () => {
    await plugin.processOtlpEvent(promptEvent(`${'x '.repeat(150)}see ABC-99`), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    expect(forwardedEvents()[0]['ticket_mentions']).toEqual(['ABC-99']);
  });

  it('emits empty values for a plain prompt and for a pasted path', async () => {
    await plugin.processOtlpEvent(promptEvent('/Users/foo/bar is broken'), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const [forwarded] = forwardedEvents();
    expect(forwarded['command_name']).toBe('');
    expect(forwarded['story_marker']).toBe('');
    expect(forwarded['ticket_mentions']).toEqual([]);
  });

  it('handles an empty prompt', async () => {
    await plugin.processOtlpEvent(promptEvent(''), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const [forwarded] = forwardedEvents();
    expect(forwarded['prompt_length']).toBe(0);
    expect(forwarded['command_name']).toBe('');
  });

  it('lets a resolved value win over a same-named key in the hook payload', async () => {
    await plugin.processOtlpEvent(promptEvent('hello', { prompt_length: 999, command_name: 'evil' }), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    const [forwarded] = forwardedEvents();
    expect(forwarded['prompt_length']).toBe(5);
    expect(forwarded['command_name']).toBe('');
  });

  it('does not stamp the prompt fields on other events', async () => {
    await plugin.processOtlpEvent(event('Stop'), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const [forwarded] = forwardedEvents();
    for (const key of ['command_name', 'story_marker', 'ticket_mentions', 'prompt_length']) {
      expect(forwarded).not.toHaveProperty(key);
    }
  });

  it('emits no event when the SSO gate blocks the prompt', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: false, reason: 'expired' } as never);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await plugin.processOtlpEvent(promptEvent('/simplify ABC-1'), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
    stdout.mockRestore();
  });
});
