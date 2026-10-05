import { describe, it, expect } from 'vitest';

interface MappedRecord {
  type: string;
  session_id: string;
  schema_version: number;
  event_id: string;
  codemie_cli_version: string;
  story_id?: string;
  story_source?: string;
  prompt_body?: string;
}

function buildHookRecord(hookEventName: string, sessionId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agentName: 'claude',
    raw: JSON.stringify({
      hook_event_name: hookEventName,
      session_id: sessionId,
      cwd: '',
      ...extra,
    }),
    timestamp: Date.now(),
  });
}

describe('mapHookRecords', () => {
  it('stamps schema_version, event_id, and codemie_cli_version on every mapped record', async () => {
    const { mapHookRecords } = await import('../forwarder.js');

    const ctx = {
      credentials: { token: '', apiUrl: '' },
      baseUrl: '',
      projectName: 'proj',
      userEmail: 'user@example.com',
      git: {},
    };

    const record1 = buildHookRecord('SessionStart', 'sid1');
    const record2 = buildHookRecord('Stop', 'sid1');

    const payload = await mapHookRecords([record1, record2], ctx, 0);
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

  it('derives event_id from the running byte offset seeded by startOffset', async () => {
    const { mapHookRecords } = await import('../forwarder.js');

    const ctx = {
      credentials: { token: '', apiUrl: '' },
      baseUrl: '',
      projectName: 'proj',
      userEmail: '',
      git: {},
    };

    const record = buildHookRecord('SessionStart', 'sid1');

    const payloadAtZero = await mapHookRecords([record], ctx, 0);
    const payloadAtOffset = await mapHookRecords([record], { ...ctx, git: {} }, 500);

    const lineAtZero = JSON.parse(payloadAtZero.ndjson.trim()) as MappedRecord;
    const lineAtOffset = JSON.parse(payloadAtOffset.ndjson.trim()) as MappedRecord;

    expect(lineAtZero.event_id).toBe('sid1:agent.session.start:0');
    expect(lineAtOffset.event_id).toBe('sid1:agent.session.start:500');
  });

  it('prefers an explicit hookEvent.type over the HOOK_EVENT_TYPE_MAP lookup', async () => {
    const { mapHookRecords } = await import('../forwarder.js');

    const ctx = {
      credentials: { token: '', apiUrl: '' },
      baseUrl: '',
      projectName: 'proj',
      userEmail: '',
      git: {},
    };

    // PostToolUse normally maps to 'agent.tool.end', but an explicit `type`
    // field on the raw hook payload (as a later-task synthetic record would
    // carry) must win.
    const record = buildHookRecord('PostToolUse', 'sid1', { type: 'agent.custom.synthetic' });

    const payload = await mapHookRecords([record], ctx, 0);
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
      git: {},
    };

    const record = buildHookRecord('PostToolUse', 'sid1');

    const payload = await mapHookRecords([record], ctx, 0);
    const line = JSON.parse(payload.ndjson.trim()) as MappedRecord;

    expect(line.type).toBe('agent.tool.end');
  });

  it(
    "overrides a UserPromptSubmit record's story_id/story_source with a prompt marker " +
      'even when the per-tick branch tier would otherwise resolve to a different ticket, ' +
      'and never leaks the raw prompt text onto the emitted record',
    async () => {
      const { mapHookRecords } = await import('../forwarder.js');

      // Branch carries a DIFFERENT ticket than the prompt marker, so this
      // test proves the marker tier wins over the already-cached branch tier.
      const ctx = {
        credentials: { token: '', apiUrl: '' },
        baseUrl: '',
        projectName: 'proj',
        userEmail: '',
        git: { branch: 'feature/ABC-1-unrelated-branch' },
      };

      // Longer than MAX_PROMPT_CHARS (200) so every bounded copy on the
      // mapped record is truncated and none of them equals this full text —
      // which is what actually proves "the raw prompt is never present"
      // rather than merely proving a short prompt survives truncation whole.
      const rawPrompt =
        `Please implement this feature. story: EPMCDME-999 is the ticket to reference. ` +
        'x'.repeat(200) +
        ' end-of-prompt-marker-that-must-not-appear-anywhere-in-the-output';
      const record = buildHookRecord('UserPromptSubmit', 'sid1', { prompt: rawPrompt });

      const payload = await mapHookRecords([record], ctx, 0);
      const line = JSON.parse(payload.ndjson.trim()) as MappedRecord;

      expect(line.story_id).toBe('EPMCDME-999');
      expect(line.story_source).toBe('marker');

      // The raw prompt text must never appear verbatim anywhere on the
      // emitted record — only the truncated `prompt_body` and the resolved
      // short `story_id` string are allowed to carry prompt-derived content.
      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain(rawPrompt);
      expect(serialized).not.toContain('end-of-prompt-marker-that-must-not-appear-anywhere-in-the-output');
      expect(line.prompt_body).toBe(rawPrompt.slice(0, 200));
    }
  );

  it(
    'falls back to the per-tick branch result for a UserPromptSubmit record whose prompt ' +
      'has no marker and no bare ticket mention',
    async () => {
      const { mapHookRecords } = await import('../forwarder.js');

      const ctx = {
        credentials: { token: '', apiUrl: '' },
        baseUrl: '',
        projectName: 'proj',
        userEmail: '',
        git: { branch: 'feature/epmcdme-15301-foo' },
      };

      const rawPrompt = 'please just fix the thing, no ticket reference here';
      const record = buildHookRecord('UserPromptSubmit', 'sid1', { prompt: rawPrompt });

      const payload = await mapHookRecords([record], ctx, 0);
      const line = JSON.parse(payload.ndjson.trim()) as MappedRecord;

      expect(line.story_id).toBe('EPMCDME-15301');
      expect(line.story_source).toBe('branch');
    }
  );

  it(
    'falls back to the mention tier for a UserPromptSubmit record whose prompt has a bare ' +
      'ticket mention and the branch carries no ticket',
    async () => {
      const { mapHookRecords } = await import('../forwarder.js');

      const ctx = {
        credentials: { token: '', apiUrl: '' },
        baseUrl: '',
        projectName: 'proj',
        userEmail: '',
        git: { branch: 'just-some-branch-name' },
      };

      const rawPrompt = 'can you look into ABC-42 when you get a chance';
      const record = buildHookRecord('UserPromptSubmit', 'sid1', { prompt: rawPrompt });

      const payload = await mapHookRecords([record], ctx, 0);
      const line = JSON.parse(payload.ndjson.trim()) as MappedRecord;

      expect(line.story_id).toBe('ABC-42');
      expect(line.story_source).toBe('mention');
    }
  );
});
