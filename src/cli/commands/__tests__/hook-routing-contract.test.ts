/**
 * Contract regression tests for hook event ROUTING + VALIDATION in src/cli/commands/hook.ts.
 *
 * The routing (routeHookEvent) and validation (validateHookEvent) functions are private;
 * the public seam is the exported `processEvent(event, config)`, which validates then routes.
 * These tests drive that seam and pin today's behaviour by asserting the distinctive,
 * observable file-system side effect each handler produces via the real SessionStore, plus
 * a mock-agent spy to distinguish SubagentStop from Stop. Existing hook.lock.test.ts and
 * hook.session-origin.test.ts already cover PreCompact/PermissionRequest routing and the
 * basic missing-field validation matrix — this file adds the remaining event dispatch cases
 * and validation EDGE cases (optional-transcript events, transcript_paths array, empty-string
 * fields, ordering, unknown/unsupported events).
 *
 * Isolation: the vitest "unit" project sets CODEMIE_HOME to a per-pid tmp dir, so getSessionPath
 * / getCodemiePath resolve inside that sandbox and never touch the developer's real ~/.codemie.
 * No network: config uses a non-analytics provider (no ssoUrl/syncApiUrl, provider !== 'ai-run-sso'),
 * so metrics/SSO code paths return early without any HTTP call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { getCodemiePath } from '../../../utils/paths.js';
import { getSessionPath } from '../../../agents/core/session/session-config.js';
import type { BaseHookEvent } from '../../../agents/core/types.js';
import type { ProcessingContext } from '../../../agents/core/session/BaseProcessor.js';
import { createHookCommand, processEvent, type HookProcessingConfig } from '../hook.js';
import { AgentRegistry } from '../../../agents/registry.js';

const TMP = join(tmpdir(), `codemie-hook-routing-${process.pid}`);

// Non-analytics config: provider !== 'ai-run-sso' and no ssoUrl/syncApiUrl means every
// metrics/SSO/auth-gate branch short-circuits before any network I/O.
const baseConfig: Omit<HookProcessingConfig, 'sessionId'> = {
  agentName: 'claude',
  provider: 'jwt',
};

function completedPath(sessionId: string): string {
  return getCodemiePath('sessions', `completed_${sessionId}.json`);
}

function cleanupSession(sessionId: string, _claudeSessionId?: string): void {
  for (const p of [getSessionPath(sessionId), completedPath(sessionId)]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
  for (const suffix of ['_metrics.jsonl', '_conversation.jsonl']) {
    const p = getCodemiePath('sessions', `${sessionId}${suffix}`);
    if (existsSync(p)) rmSync(p, { force: true });
    const c = getCodemiePath('sessions', `completed_${sessionId}${suffix}`);
    if (existsSync(c)) rmSync(c, { force: true });
  }
  const sessions = getCodemiePath('sessions');
  if (existsSync(sessions)) {
    for (const f of readdirSync(sessions).filter((f) => f.endsWith('-codemie-marker.json') && f.includes(sessionId))) {
      rmSync(join(sessions, f), { force: true });
    }
  }
}

/** Write a minimal LIVE (active, no endTime) session record to disk. */
function writeActiveSession(sessionId: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    getSessionPath(sessionId),
    JSON.stringify({
      sessionId,
      agentName: 'claude',
      provider: 'jwt',
      startTime: Date.now() - 5000,
      workingDirectory: TMP,
      status: 'active',
      activeDurationMs: 0,
      correlation: { status: 'matched', retryCount: 0 },
      ...extra,
    })
  );
}

function transcriptFile(name: string): string {
  const p = join(TMP, `${name}.jsonl`);
  writeFileSync(p, '{"type":"user"}\n');
  return p;
}

describe('hook.ts routeHookEvent + validateHookEvent contract', () => {
  const createdSessions = new Set<[string, string?]>();

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    mkdirSync(getCodemiePath('sessions'), { recursive: true });
    process.exitCode = 0;
    createdSessions.clear();
    vi.restoreAllMocks();
    delete process.env.CODEMIE_SESSION_ORIGIN;
  });

  afterEach(() => {
    for (const [sid, cid] of createdSessions) cleanupSession(sid, cid);
    rmSync(TMP, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  // ---------------------------------------------------------------------------
  // validateHookEvent — EDGE cases beyond the existing basic matrix
  // ---------------------------------------------------------------------------
  describe('validateHookEvent edge cases (config mode → throws)', () => {
    it('treats empty-string session_id as missing', async () => {
      const event = {
        session_id: '',
        hook_event_name: 'Stop',
        transcript_path: '/x.json',
        permission_mode: 'default',
      } as BaseHookEvent;
      await expect(processEvent(event, { ...baseConfig, sessionId: 's1' })).rejects.toThrow(
        'Missing required field: session_id'
      );
    });

    it('treats empty-string hook_event_name as missing', async () => {
      const event = {
        session_id: 'agent-1',
        hook_event_name: '',
        transcript_path: '/x.json',
        permission_mode: 'default',
      } as BaseHookEvent;
      await expect(processEvent(event, { ...baseConfig, sessionId: 's2' })).rejects.toThrow(
        'Missing required field: hook_event_name'
      );
    });

    it('reports session_id first when both session_id and hook_event_name are missing (ordering)', async () => {
      const event = {
        transcript_path: '/x.json',
        permission_mode: 'default',
      } as BaseHookEvent;
      await expect(processEvent(event, { ...baseConfig, sessionId: 's3' })).rejects.toThrow(
        'Missing required field: session_id'
      );
    });

    it('accepts a non-optional event (Stop) when only transcript_paths[] is supplied (no transcript_path)', async () => {
      const sessionId = `route-paths-${process.pid}`;
      createdSessions.add([sessionId]);
      writeActiveSession(sessionId);
      const event = {
        session_id: 'agent-paths',
        hook_event_name: 'Stop',
        transcript_paths: [transcriptFile('paths-a')],
        permission_mode: 'default',
      } as BaseHookEvent;
      // Should pass validation (transcript_paths satisfies the transcript requirement) and not throw.
      await expect(processEvent(event, { ...baseConfig, sessionId })).resolves.not.toThrow();
    });

    it('does NOT require transcript_path for SessionStart (optional-transcript event)', async () => {
      const sessionId = `route-start-notrans-${process.pid}`;
      const claudeId = 'claude-start-notrans';
      createdSessions.add([sessionId, claudeId]);
      cleanupSession(sessionId, claudeId);
      const event = {
        session_id: claudeId,
        hook_event_name: 'SessionStart',
        permission_mode: 'default',
        cwd: TMP,
      } as unknown as BaseHookEvent;
      (event as unknown as { source: string }).source = 'startup';
      await expect(processEvent(event, { ...baseConfig, sessionId })).resolves.not.toThrow();
      // Routed to handleSessionStart → session record still created despite no transcript_path.
      expect(existsSync(getSessionPath(sessionId))).toBe(true);
    });

    it('does NOT require transcript_path for SessionEnd (optional-transcript event)', async () => {
      const sessionId = `route-end-notrans-${process.pid}`;
      createdSessions.add([sessionId]);
      writeActiveSession(sessionId);
      const event = {
        session_id: 'agent-end-notrans',
        hook_event_name: 'SessionEnd',
        permission_mode: 'default',
        cwd: TMP,
        reason: 'exit',
      } as unknown as BaseHookEvent;
      await expect(processEvent(event, { ...baseConfig, sessionId })).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // routeHookEvent — dispatch to the correct handler, asserted via distinctive
  // observable side effects of the real SessionStore.
  // ---------------------------------------------------------------------------
  describe('routeHookEvent dispatch', () => {
    it('SessionStart → handleSessionStart creates an active session record with matched correlation', async () => {
      const sessionId = `route-start-${process.pid}`;
      const claudeId = 'claude-start-1';
      createdSessions.add([sessionId, claudeId]);
      cleanupSession(sessionId, claudeId);
      const transcript = transcriptFile('start-1');

      const event = {
        session_id: claudeId,
        hook_event_name: 'SessionStart',
        transcript_path: transcript,
        permission_mode: 'default',
        cwd: TMP,
      } as unknown as BaseHookEvent;
      (event as unknown as { source: string }).source = 'startup';

      await processEvent(event, { ...baseConfig, sessionId });

      const saved = JSON.parse(readFileSync(getSessionPath(sessionId), 'utf-8'));
      expect(saved.status).toBe('active');
      expect(saved.agentName).toBe('claude');
      expect(saved.correlation.status).toBe('matched');
      expect(saved.correlation.agentSessionId).toBe(claudeId);
      expect(saved.correlation.agentSessionFile).toBe(transcript);
      // A new claude record skips whatever its transcript already holds before its own start.
      expect(saved.runtimeCheckpoint.baselineCutoffMs).toBe(saved.startTime);
    });

    async function startRecord(agentName: string) {
      const sessionId = `route-start-${agentName}-${process.pid}`;
      const agentSessionId = `${agentName}-start-1`;
      createdSessions.add([sessionId, agentSessionId]);
      cleanupSession(sessionId, agentSessionId);

      const event = {
        session_id: agentSessionId,
        hook_event_name: 'SessionStart',
        transcript_path: transcriptFile(`start-${agentName}`),
        permission_mode: 'default',
        cwd: TMP,
        source: 'startup',
      } as unknown as BaseHookEvent;

      await processEvent(event, { ...baseConfig, agentName, sessionId });
      return JSON.parse(readFileSync(getSessionPath(sessionId), 'utf-8'));
    }

    it('SessionStart for claude-acp → the record carries the baseline marker at its start', async () => {
      const saved = await startRecord('claude-acp');

      expect(saved.agentName).toBe('claude-acp');
      expect(saved.runtimeCheckpoint.baselineCutoffMs).toBe(saved.startTime);
    });

    it('SessionStart for a non-Claude agent → no baseline marker', async () => {
      const saved = await startRecord('gemini');

      expect(saved.agentName).toBe('gemini');
      expect(saved.runtimeCheckpoint?.baselineCutoffMs).toBeUndefined();
    });

    it('SessionEnd → handleSessionEnd marks completed and renames {id}.json → completed_{id}.json', async () => {
      const sessionId = `route-end-${process.pid}`;
      const claudeId = 'claude-end-1';
      createdSessions.add([sessionId, claudeId]);
      writeActiveSession(sessionId);
      const transcript = transcriptFile('end-1');

      const event = {
        session_id: claudeId,
        hook_event_name: 'SessionEnd',
        transcript_path: transcript,
        permission_mode: 'default',
        cwd: TMP,
        reason: 'logout',
      } as unknown as BaseHookEvent;

      await processEvent(event, { ...baseConfig, sessionId });

      // Original file renamed away; completed_ file present with terminal status + reason.
      expect(existsSync(getSessionPath(sessionId))).toBe(false);
      expect(existsSync(completedPath(sessionId))).toBe(true);
      const saved = JSON.parse(readFileSync(completedPath(sessionId), 'utf-8'));
      expect(saved.status).toBe('completed');
      expect(saved.reason).toBe('logout');
      expect(typeof saved.endTime).toBe('number');
    });

    it('SessionEnd → the final pass writes the trailing unanswered prompt as a prompts-only delta', async () => {
      const sessionId = `route-end-prompts-${process.pid}`;
      const claudeId = 'claude-end-prompts-1';
      createdSessions.add([sessionId, claudeId]);
      // The answered turn was emitted by an earlier run.
      writeActiveSession(sessionId, { startTime: Date.parse('2026-10-31T11:59:00.000Z'), sync: { metrics: { processedRecordIds: ['msg-a1'] } } });
      const line = (fields: Record<string, unknown>) => JSON.stringify({ sessionId: claudeId, cwd: TMP, ...fields });
      const transcript = join(TMP, 'end-prompts-1.jsonl');
      writeFileSync(transcript, [
        line({ type: 'user', uuid: 'u1', timestamp: '2026-10-31T12:00:00.000Z', message: { role: 'user', content: 'answered prompt' } }),
        line({
          type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-10-31T12:00:01.000Z',
          message: {
            id: 'msg-a1', role: 'assistant', model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 5 }
          }
        }),
        line({ type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-10-31T12:00:05.000Z', message: { role: 'user', content: 'unanswered prompt' } }),
      ].join('\n') + '\n');

      const event = {
        session_id: claudeId,
        hook_event_name: 'SessionEnd',
        transcript_path: transcript,
        permission_mode: 'default',
        cwd: TMP,
        reason: 'prompt_input_exit',
      } as unknown as BaseHookEvent;

      await processEvent(event, { ...baseConfig, sessionId });

      const metricsFile = getCodemiePath('sessions', `completed_${sessionId}_metrics.jsonl`);
      const deltas = existsSync(metricsFile)
        ? readFileSync(metricsFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l))
        : [];
      const promptsDelta = deltas.find(d => String(d.recordId).endsWith(':prompts'));
      expect(promptsDelta?.userPrompts).toEqual([{ count: 1, text: 'unanswered prompt' }]);
    });

    it('UserPromptSubmit → handleUserPromptSubmit starts activity tracking (sets activityStartedAt)', async () => {
      const sessionId = `route-ups-${process.pid}`;
      const claudeId = 'claude-ups-1';
      createdSessions.add([sessionId, claudeId]);
      writeActiveSession(sessionId); // no activityStartedAt yet
      const transcript = transcriptFile('ups-1');

      const before = JSON.parse(readFileSync(getSessionPath(sessionId), 'utf-8'));
      expect(before.activityStartedAt).toBeUndefined();

      const event = {
        session_id: claudeId,
        hook_event_name: 'UserPromptSubmit',
        transcript_path: transcript,
        permission_mode: 'default',
        cwd: TMP,
      } as BaseHookEvent;

      await processEvent(event, { ...baseConfig, sessionId });

      const after = JSON.parse(readFileSync(getSessionPath(sessionId), 'utf-8'));
      expect(typeof after.activityStartedAt).toBe('number');
    });

    it('Stop → handleStop accumulates active duration and clears activityStartedAt', async () => {
      const sessionId = `route-stop-${process.pid}`;
      const claudeId = 'claude-stop-1';
      createdSessions.add([sessionId, claudeId]);
      // Pre-set an in-progress active period so accumulateActiveDuration produces a positive delta.
      writeActiveSession(sessionId, { activityStartedAt: Date.now() - 1200, activeDurationMs: 0 });
      const transcript = transcriptFile('stop-1');

      const event = {
        session_id: claudeId,
        hook_event_name: 'Stop',
        transcript_path: transcript,
        permission_mode: 'default',
        cwd: TMP,
      } as BaseHookEvent;

      await processEvent(event, { ...baseConfig, sessionId });

      const after = JSON.parse(readFileSync(getSessionPath(sessionId), 'utf-8'));
      expect(after.activeDurationMs).toBeGreaterThan(0);
      // Cleared to mark idle — this is what distinguishes Stop from SubagentStop.
      expect(after.activityStartedAt).toBeUndefined();
    });

    it('SubagentStop → handleSubagentStop runs incremental sync but does NOT accumulate active duration', async () => {
      const sessionId = `route-sub-${process.pid}`;
      const claudeId = 'claude-sub-1';
      createdSessions.add([sessionId, claudeId]);
      const startedAt = Date.now() - 1200;
      writeActiveSession(sessionId, { activityStartedAt: startedAt, activeDurationMs: 0 });
      const transcript = transcriptFile('sub-1');

      // Mock agent so we can assert the SessionAdapter.processSession call (proves the event
      // was NOT silently ignored). Bare mock => no eventNameMapping and no hook transformer,
      // so normalize/transform leave the event untouched.
      const processSession = vi.fn().mockResolvedValue({
        success: true,
        totalRecords: 0,
        failedProcessors: [],
        processors: {},
      });
      const mockAgent = { getSessionAdapter: () => ({ processSession }) };
      vi.spyOn(AgentRegistry, 'getAgent').mockReturnValue(mockAgent as never);

      const event = {
        session_id: claudeId,
        hook_event_name: 'SubagentStop',
        transcript_path: transcript,
        permission_mode: 'default',
        cwd: TMP,
      } as BaseHookEvent;

      await processEvent(event, { ...baseConfig, sessionId });

      // Dispatched to a sync handler.
      expect(processSession).toHaveBeenCalledTimes(1);
      expect(processSession).toHaveBeenCalledWith(transcript, sessionId, expect.any(Object));

      // NOT handleStop: active period must remain open (no accumulation).
      const after = JSON.parse(readFileSync(getSessionPath(sessionId), 'utf-8'));
      expect(after.activityStartedAt).toBe(startedAt);
      expect(after.activeDurationMs).toBe(0);
    });

    it('unknown/unsupported event name is silently ignored (no throw, no session record written)', async () => {
      const sessionId = `route-unknown-${process.pid}`;
      const claudeId = 'claude-unknown-1';
      createdSessions.add([sessionId, claudeId]);
      cleanupSession(sessionId, claudeId);
      const transcript = transcriptFile('unknown-1');

      const event = {
        session_id: claudeId,
        hook_event_name: 'TotallyMadeUpEvent',
        transcript_path: transcript,
        permission_mode: 'default',
        cwd: TMP,
      } as BaseHookEvent;

      await expect(processEvent(event, { ...baseConfig, sessionId })).resolves.not.toThrow();
      // No handler ran, so no session record was created for this id.
      expect(existsSync(getSessionPath(sessionId))).toBe(false);
      expect(existsSync(completedPath(sessionId))).toBe(false);
    });
  });

  describe('the processor context carries the hook bounds', () => {
    const HOOK_ENV = ['CODEMIE_AGENT', 'CODEMIE_SESSION_ID', 'CODEMIE_PROVIDER', 'CODEMIE_SESSION_END_SYNC_BUDGET_MS', 'CODEMIE_WRAPPER_PID'];
    let savedEnv: Record<string, string | undefined>;
    let contexts: ProcessingContext[];

    beforeEach(() => {
      savedEnv = Object.fromEntries(HOOK_ENV.map((key) => [key, process.env[key]]));
      contexts = [];
      const processSession = vi.fn(async (_file: string, _sessionId: string, context: ProcessingContext) => {
        contexts.push({ ...context });
        return { success: true, totalRecords: 0, failedProcessors: [], processors: {} };
      });
      vi.spyOn(AgentRegistry, 'getAgent').mockReturnValue({ getSessionAdapter: () => ({ processSession }) } as never);
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    function hookEvent(name: 'Stop' | 'SessionEnd' | 'SubagentStop', claudeId: string): BaseHookEvent {
      return {
        session_id: claudeId,
        hook_event_name: name,
        transcript_path: transcriptFile(claudeId),
        permission_mode: 'default',
        cwd: TMP,
        reason: 'exit',
      } as unknown as BaseHookEvent;
    }

    /** A `codemie hook` process: the event on stdin, the session from the env the wrapper exported. */
    async function runHookProcess(event: BaseHookEvent, sessionId: string): Promise<void> {
      Object.assign(process.env, { CODEMIE_AGENT: 'claude', CODEMIE_SESSION_ID: sessionId, CODEMIE_PROVIDER: 'jwt', CODEMIE_SESSION_END_SYNC_BUDGET_MS: '700' });
      delete process.env.CODEMIE_WRAPPER_PID;
      const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
      Object.defineProperty(process, 'stdin', { value: Readable.from([JSON.stringify(event)]), configurable: true });
      try {
        await createHookCommand().parseAsync(['--agent', 'claude'], { from: 'user' });
      } finally {
        if (stdin) Object.defineProperty(process, 'stdin', stdin);
      }
    }

    for (const name of ['Stop', 'SessionEnd', 'SubagentStop'] as const) {
      it(`${name} in a hook process: hookProcess, its abort signal and the 700 ms sync budget`, async () => {
        const sessionId = `route-bounds-hook-${name}-${process.pid}`;
        const claudeId = `claude-bounds-hook-${name}`;
        createdSessions.add([sessionId, claudeId]);
        writeActiveSession(sessionId);

        const startedAt = Date.now();
        await runHookProcess(hookEvent(name, claudeId), sessionId);
        const endedAt = Date.now();

        expect(process.exitCode).toBe(0);
        expect(contexts).toHaveLength(1);
        expect(contexts[0].hookProcess).toBe(true);
        expect(contexts[0].abortSignal).toBeInstanceOf(AbortSignal);
        expect(contexts[0].syncDeadlineMs).toBeGreaterThanOrEqual(startedAt + 700);
        expect(contexts[0].syncDeadlineMs).toBeLessThanOrEqual(endedAt + 700);
      });
    }

    for (const name of ['Stop', 'SessionEnd'] as const) {
      it(`${name} in process with a deadline and an abort signal: bounded by those alone`, async () => {
        const sessionId = `route-bounds-caller-${name}-${process.pid}`;
        const claudeId = `claude-bounds-caller-${name}`;
        createdSessions.add([sessionId, claudeId]);
        writeActiveSession(sessionId);
        const abortSignal = new AbortController().signal;
        const deadlineMs = Date.now() + 60_000;

        await processEvent(hookEvent(name, claudeId), { ...baseConfig, sessionId, abortSignal, deadlineMs });

        expect(contexts).toHaveLength(1);
        expect(contexts[0].hookProcess).toBe(false);
        expect(contexts[0].abortSignal).toBe(abortSignal);
        expect(contexts[0].syncDeadlineMs).toBe(deadlineMs);
      });
    }
  });

  describe('SessionStart record owner and launch fields', () => {
    const OWNER_ENV = ['CODEMIE_AGENT', 'CODEMIE_SESSION_ID', 'CODEMIE_PROVIDER', 'CODEMIE_WRAPPER_PID', 'CODEMIE_WRAPPER_STARTED_AT'];
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = Object.fromEntries(OWNER_ENV.map((key) => [key, process.env[key]]));
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    function startEvent(claudeId: string): BaseHookEvent {
      const event = {
        session_id: claudeId,
        hook_event_name: 'SessionStart',
        transcript_path: transcriptFile(claudeId),
        permission_mode: 'default',
        cwd: TMP,
      } as unknown as BaseHookEvent;
      (event as unknown as { source: string }).source = 'startup';
      return event;
    }

    /** A `codemie hook` process: no config, everything from the env the wrapper exported. */
    async function startInHookProcess(sessionId: string, claudeId: string, wrapperEnv: Record<string, string>) {
      createdSessions.add([sessionId, claudeId]);
      cleanupSession(sessionId, claudeId);
      Object.assign(process.env, { CODEMIE_AGENT: 'claude', CODEMIE_SESSION_ID: sessionId, CODEMIE_PROVIDER: 'jwt' });
      delete process.env.CODEMIE_WRAPPER_PID;
      delete process.env.CODEMIE_WRAPPER_STARTED_AT;
      Object.assign(process.env, wrapperEnv);
      await processEvent(startEvent(claudeId));
      return JSON.parse(readFileSync(getSessionPath(sessionId), 'utf-8'));
    }

    it('a hook process stores ownerPid / ownerStartedAt from the wrapper env', async () => {
      const saved = await startInHookProcess(`owner-env-${process.pid}`, 'claude-owner-env', {
        CODEMIE_WRAPPER_PID: '4242',
        CODEMIE_WRAPPER_STARTED_AT: '1790000000000',
      });

      expect(saved.ownerPid).toBe(4242);
      expect(saved.ownerStartedAt).toBe(1790000000000);
    });

    it('a hook process with neither wrapper var stores no owner', async () => {
      const saved = await startInHookProcess(`owner-none-${process.pid}`, 'claude-owner-none', {});

      expect(saved).not.toHaveProperty('ownerPid');
      expect(saved).not.toHaveProperty('ownerStartedAt');
    });

    it('a hook process with CODEMIE_WRAPPER_PID but no start time stores no owner (both or none)', async () => {
      const saved = await startInHookProcess(`owner-half-${process.pid}`, 'claude-owner-half', {
        CODEMIE_WRAPPER_PID: '4242',
      });

      expect(saved).not.toHaveProperty('ownerPid');
      expect(saved).not.toHaveProperty('ownerStartedAt');
    });

    it('an in-process call stores the owner and launch fields passed in its config, not the process env', async () => {
      const sessionId = `owner-config-${process.pid}`;
      const claudeId = 'claude-owner-config';
      createdSessions.add([sessionId, claudeId]);
      cleanupSession(sessionId, claudeId);
      process.env.CODEMIE_WRAPPER_PID = '9999';
      process.env.CODEMIE_WRAPPER_STARTED_AT = '1';

      await processEvent(startEvent(claudeId), {
        ...baseConfig,
        sessionId,
        ownerPid: 4343,
        ownerStartedAt: 1790000000001,
        ssoUrl: 'https://codemie.example.invalid',
        clientType: 'codemie-codex',
        model: 'gpt-test',
      });

      const saved = JSON.parse(readFileSync(getSessionPath(sessionId), 'utf-8'));
      expect(saved.ownerPid).toBe(4343);
      expect(saved.ownerStartedAt).toBe(1790000000001);
      expect(saved.codemieUrl).toBe('https://codemie.example.invalid');
      expect(saved.clientType).toBe('codemie-codex');
      expect(saved.model).toBe('gpt-test');
    });

    it('an in-process call without owner or CodeMie URL stores neither', async () => {
      const sessionId = `owner-config-none-${process.pid}`;
      const claudeId = 'claude-owner-config-none';
      createdSessions.add([sessionId, claudeId]);
      cleanupSession(sessionId, claudeId);
      process.env.CODEMIE_WRAPPER_PID = '9999';
      process.env.CODEMIE_WRAPPER_STARTED_AT = '1';

      await processEvent(startEvent(claudeId), { ...baseConfig, sessionId });

      const saved = JSON.parse(readFileSync(getSessionPath(sessionId), 'utf-8'));
      expect(saved).not.toHaveProperty('ownerPid');
      expect(saved).not.toHaveProperty('codemieUrl');
    });
  });
});
