import { describe, it, expect, vi, beforeEach } from 'vitest';

const execSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}));

beforeEach(() => {
  execSyncMock.mockReset();
  execSyncMock.mockReturnValue('0.15.6');
});

interface MappedRecord {
  type: string;
  session_id: string;
  schema_version: number;
  event_id: string;
  codemie_cli_version: string;
  story_id?: string;
  story_source?: string;
  git_branch?: string;
  repo_remote?: string;
  prompt_body?: string;
  developer_name?: string;
  identity_source?: string;
  platform?: string;
  client_version?: string;
}

function buildHookRecord(
  hookEventName: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
  eventId: string = 'default-event-id'
): string {
  return JSON.stringify({
    agentName: 'claude',
    raw: JSON.stringify({
      hook_event_name: hookEventName,
      session_id: sessionId,
      cwd: '',
      event_id: eventId,
      ...extra,
    }),
    timestamp: Date.now(),
  });
}

describe('resolveCodemieCliVersion', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue('0.15.6');
  });

  it('reads the installed CLI version via `codemie --version` and strips the semver', async () => {
    const { resolveCodemieCliVersion } = await import('../forward-context.js');

    expect(resolveCodemieCliVersion()).toBe('0.15.6');
    expect(execSyncMock).toHaveBeenCalledWith('codemie --version', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('falls back to an empty string when `codemie --version` throws', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const { resolveCodemieCliVersion } = await import('../forward-context.js');
    expect(resolveCodemieCliVersion()).toBe('');
  });
});

describe('mapHookRecords', () => {
  it('stamps schema_version, event_id, and codemie_cli_version on every mapped record', async () => {
    const { mapHookRecords } = await import('../forwarder.js');

    const ctx = {
      credentials: { token: '', apiUrl: '' },
      baseUrl: '',
      projectName: 'proj',
      userEmail: 'user@example.com',
    };

    const record1 = buildHookRecord('SessionStart', 'sid1', {}, 'event-id-1');
    const record2 = buildHookRecord('Stop', 'sid1', {}, 'event-id-2');

    const payload = await mapHookRecords([record1, record2], ctx);
    const lines = payload.ndjson
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as MappedRecord);

    expect(lines).toHaveLength(2);
    expect(lines[0].schema_version).toBe(2);
    expect(lines[1].schema_version).toBe(2);
    expect(lines[0].event_id).not.toBe(lines[1].event_id);
    expect(typeof lines[0].codemie_cli_version).toBe('string');
    expect(lines[0].codemie_cli_version.length).toBeGreaterThan(0);
    expect(lines[0].codemie_cli_version).toBe(lines[1].codemie_cli_version);
  });

  it('passes the event_id already stamped at spool-write time straight through unchanged', async () => {
    const { mapHookRecords } = await import('../forwarder.js');

    const ctx = {
      credentials: { token: '', apiUrl: '' },
      baseUrl: '',
      projectName: 'proj',
      userEmail: '',
    };

    const record = buildHookRecord('SessionStart', 'sid1', {}, 'stamped-event-id-abc');

    const payload = await mapHookRecords([record], ctx);
    const line = JSON.parse(payload.ndjson.trim()) as MappedRecord;

    expect(line.event_id).toBe('stamped-event-id-abc');
  });

  it('prefers an explicit hookEvent.type over the HOOK_EVENT_TYPE_MAP lookup', async () => {
    const { mapHookRecords } = await import('../forwarder.js');

    const ctx = {
      credentials: { token: '', apiUrl: '' },
      baseUrl: '',
      projectName: 'proj',
      userEmail: '',
    };

    // PostToolUse normally maps to 'agent.tool.end', but an explicit `type`
    // field on the raw hook payload (as a later-task synthetic record would
    // carry) must win.
    const record = buildHookRecord('PostToolUse', 'sid1', { type: 'agent.custom.synthetic' });

    const payload = await mapHookRecords([record], ctx);
    const line = JSON.parse(payload.ndjson.trim()) as MappedRecord;

    expect(line.type).toBe('agent.custom.synthetic');
  });

  it('leaves existing-event type resolution unchanged when type is absent', async () => {
    const { mapHookRecords } = await import('../forwarder.js');

    const ctx = {
      credentials: { token: '', apiUrl: '' },
      baseUrl: '',
      projectName: 'proj',
      userEmail: '',
    };

    const record = buildHookRecord('PostToolUse', 'sid1');

    const payload = await mapHookRecords([record], ctx);
    const line = JSON.parse(payload.ndjson.trim()) as MappedRecord;

    expect(line.type).toBe('agent.tool.end');
  });

  it('passes git_branch/repo_remote/story_id/story_source through from the incoming record', async () => {
    const { mapHookRecords } = await import('../forwarder.js');

    const ctx = {
      credentials: { token: '', apiUrl: '' },
      baseUrl: '',
      projectName: 'proj',
      userEmail: '',
    };

    const record = buildHookRecord('UserPromptSubmit', 'sid1', {
      prompt: 'story: ABC-1 is ignored here, the forwarder does not resolve stories',
      git_branch: 'feature/x',
      repo_remote: 'org/repo',
      story_id: 'EPMCDME-999',
      story_source: 'marker',
    });

    const payload = await mapHookRecords([record], ctx);
    const line = JSON.parse(payload.ndjson.trim()) as MappedRecord;

    expect(line.git_branch).toBe('feature/x');
    expect(line.repo_remote).toBe('org/repo');
    expect(line.story_id).toBe('EPMCDME-999');
    expect(line.story_source).toBe('marker');
  });

  it("defaults git_branch/repo_remote/story_id/story_source to '' and never resolves them from the daemon env", async () => {
    const { mapHookRecords } = await import('../forwarder.js');
    vi.stubEnv('SDLC_ANALYTICS_STORY_ID', 'FROM-DAEMON-1');

    const ctx = {
      credentials: { token: '', apiUrl: '' },
      baseUrl: '',
      projectName: 'proj',
      userEmail: '',
    };

    try {
      const payload = await mapHookRecords([buildHookRecord('UserPromptSubmit', 'sid1', { prompt: 'story: ABC-1' })], ctx);
      const line = JSON.parse(payload.ndjson.trim()) as MappedRecord;

      expect(line.git_branch).toBe('');
      expect(line.repo_remote).toBe('');
      expect(line.story_id).toBe('');
      expect(line.story_source).toBe('');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('passes agent-baked common fields (platform/client_version) through onto the mapped record without any agent-specific lookup', async () => {
    const { mapHookRecords } = await import('../forwarder.js');

    const ctx = {
      credentials: { token: '', apiUrl: '' },
      baseUrl: '',
      projectName: 'proj',
      userEmail: '',
    };

    // Simulates what the plugin now bakes in hook-side before ever reaching the spool —
    // the forwarder needs no agent-specific knowledge to pass these through, just the
    // `...limited` spread like every other hook-native field.
    const record = JSON.stringify({
      agentName: 'claude-code-otlp',
      raw: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'sid1',
        cwd: '',
        platform: 'claude-code',
        client_version: '1.2.3',
      }),
      timestamp: Date.now(),
    });

    const payload = await mapHookRecords([record], ctx);
    const line = JSON.parse(payload.ndjson.trim()) as MappedRecord;

    expect(line.platform).toBe('claude-code');
    expect(line.client_version).toBe('1.2.3');
  });

  it('carries ctx.identity through onto developer_name/identity_source for a non-jwt tier', async () => {
    const { mapHookRecords } = await import('../forwarder.js');

    // Pre-seeding ctx.identity (mimicking what the per-tick identity cache would look like once resolved)
    // with a non-jwt tier result proves the wiring from ctx.identity onto the mapped record,
    // independent of the identity-chain's own resolution logic (covered by identity.test.ts).
    const ctx = {
      credentials: { token: '', apiUrl: '' },
      baseUrl: '',
      projectName: 'proj',
      userEmail: '',
      identity: { developerName: 'git-user@example.com', identitySource: 'git' as const },
    };

    const record = buildHookRecord('Stop', 'sid1');

    const payload = await mapHookRecords([record], ctx);
    const line = JSON.parse(payload.ndjson.trim()) as MappedRecord;

    expect(line.developer_name).toBe('git-user@example.com');
    expect(line.identity_source).toBe('git');
  });
});
