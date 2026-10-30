import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'cop-otlp-flow-'));
process.env.CODEMIE_HOME = join(root, 'codemie');
process.env.COPILOT_HOME = join(root, 'copilot');

import { isCopilotCliHookInput } from '../copilot-cli-otlp.types.js';
import { buildToolEvent, extractEndCall, extractStartCalls } from '../copilot-cli-otlp.tool-payload.js';
import { recordOpenStarts, resolveEndToolUseId } from '../copilot-cli-otlp.tool-correlation.js';
import { buildUsageRows, resolveCopilotBillableModel } from '../copilot-cli-otlp.request-usage.js';
import { buildStopPass } from '../copilot-cli-otlp.stop-pass.js';
import { buildDeferredUsageEvents } from '../copilot-cli-otlp.usage.js';
import { readSessionState, updateSessionState, withStateLock } from '../copilot-cli-otlp.state.js';

const SID = '11111111-2222-3333-4444-555555555555';

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('preToolUse payload', () => {
  const batched = {
    sessionId: SID,
    cwd: '/repo',
    codemieEventName: 'preToolUse',
    toolCalls: [
      { id: 'c1', name: 'view', args: { path: '/repo/a.ts' } },
      { id: 'c2', name: 'bash', args: '{"command":"ls"}' },
      { name: 'no-id', args: {} },
    ],
  };

  it('is accepted without a timestamp only for preToolUse with toolCalls', () => {
    expect(isCopilotCliHookInput(batched)).toBe(true);
    expect(isCopilotCliHookInput({ ...batched, codemieEventName: 'postToolUse' })).toBe(false);
    expect(isCopilotCliHookInput({ ...batched, toolCalls: undefined })).toBe(false);
    expect(isCopilotCliHookInput({ ...batched, timestamp: '2026-01-01' })).toBe(false);
  });

  it('extracts every call with a real id, parsing string args and dropping entries without id', () => {
    const calls = extractStartCalls(batched as never);
    expect(calls.map((c) => c.toolUseId)).toEqual(['c1', 'c2']);
    expect(calls[1].toolArgs).toEqual({ command: 'ls' });
  });

  describe('single toolName/toolArgs form', () => {
    const single = { sessionId: SID, cwd: '/repo', codemieEventName: 'preToolUse', toolName: 'bash', toolArgs: '{"command":"ls"}' };

    it('is accepted without a timestamp only when toolName is present', () => {
      expect(isCopilotCliHookInput(single)).toBe(true);
      expect(isCopilotCliHookInput({ ...single, toolName: undefined })).toBe(false);
      expect(isCopilotCliHookInput({ ...single, toolName: '' })).toBe(false);
      expect(isCopilotCliHookInput({ ...single, codemieEventName: 'postToolUse' })).toBe(false);
    });

    it('extracts one call with a synthesized id and parsed args', () => {
      const calls = extractStartCalls(single as never);
      expect(calls).toHaveLength(1);
      expect(calls[0].toolName).toBe('bash');
      expect(calls[0].toolArgs).toEqual({ command: 'ls' });
      expect(calls[0].toolUseId).toContain(`${SID}:pre:`);
    });

    it('prefers the provided toolCallId', () => {
      expect(extractStartCalls({ ...single, toolCallId: 'tc-1' } as never)[0].toolUseId).toBe('tc-1');
    });
  });

  it('adds file_path for file-writing tools only', () => {
    expect(buildToolEvent({}, 'edit', { path: '/repo/a.ts' }, { toolUseId: 'x' }).file_path).toBe('/repo/a.ts');
    expect(buildToolEvent({}, 'view', { path: '/repo/a.ts' }, { toolUseId: 'x' }).file_path).toBeUndefined();
  });

  it('adds skill_name for the skill tool only', () => {
    expect(buildToolEvent({}, 'skill', { skill: 'my-skill' }, { toolUseId: 'x' }).skill_name).toBe('my-skill');
    expect(buildToolEvent({}, 'skill', { skill: '  padded ' }, { toolUseId: 'x' }).skill_name).toBe('padded');
    expect(buildToolEvent({}, 'skill', {}, { toolUseId: 'x' }).skill_name).toBeUndefined();
    expect(buildToolEvent({}, 'skill', { skill: '' }, { toolUseId: 'x' }).skill_name).toBeUndefined();
    expect(buildToolEvent({}, 'bash', { skill: 'my-skill' }, { toolUseId: 'x' }).skill_name).toBeUndefined();
  });

  it('classifies failures from the event name or resultType', () => {
    const base = { sessionId: SID, cwd: '/', toolName: 'bash', toolArgs: '{"a":1}' };
    expect(extractEndCall({ ...base, codemieEventName: 'postToolUseFailure' } as never).success).toBe(false);
    expect(extractEndCall({ ...base, codemieEventName: 'postToolUse', toolResult: { resultType: 'failure' } } as never).success).toBe(false);
    expect(extractEndCall({ ...base, codemieEventName: 'postToolUse', toolResult: { resultType: 'success' } } as never).toolArgs).toEqual({ a: 1 });
    for (const resultType of ['denied', 'rejected']) {
      expect(extractEndCall({ ...base, codemieEventName: 'postToolUse', toolResult: { resultType } } as never).success).toBe(false);
    }
  });
});

describe('state lock', () => {
  it('returns undefined instead of throwing when the callback fails', async () => {
    const path = join(root, 'codemie', 'lock-fail.json');
    expect(await withStateLock(path, () => { throw new Error('ENOSPC'); })).toBeUndefined();
    expect(await withStateLock(path, () => 1)).toBe(1);
  });
});

describe('tool correlation', () => {
  beforeEach(() => {
    rmSync(join(root, 'codemie'), { recursive: true, force: true });
  });

  it('pairs ends with the oldest open start of the same name and args, never changing ids', async () => {
    await recordOpenStarts(SID, [
      { toolUseId: 'a', toolName: 'bash', toolArgs: { c: 1 } },
      { toolUseId: 'b', toolName: 'bash', toolArgs: { c: 2 } },
      { toolUseId: 'c', toolName: 'bash', toolArgs: { c: 1 } },
    ]);
    expect(await resolveEndToolUseId(SID, 'bash', { c: 2 })).toBe('b');
    expect(await resolveEndToolUseId(SID, 'bash', { c: 1 })).toBe('a');
    expect(await resolveEndToolUseId(SID, 'bash', { c: 1 })).toBe('c');
  });

  it('falls back to the name, then to the transcript tail, then to an orphan id', async () => {
    await recordOpenStarts(SID, [{ toolUseId: 'a', toolName: 'bash', toolArgs: { c: 1 } }]);
    expect(await resolveEndToolUseId(SID, 'bash', { other: true })).toBe('a');

    const stateRoot = join(root, 'state');
    mkdirSync(join(stateRoot, SID), { recursive: true });
    writeFileSync(
      join(stateRoot, SID, 'events.jsonl'),
      `${JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 'real', toolName: 'view', arguments: { path: 'p' } } })}\n`
    );
    expect(await resolveEndToolUseId(SID, 'view', { path: 'p' }, Date.now(), stateRoot)).toBe('real');
    expect(await resolveEndToolUseId(SID, 'view', { path: 'zz' }, Date.now(), stateRoot)).toMatch(/:orphan:/);
  });

  it('drops open starts older than 30 minutes', async () => {
    const old = Date.now() - 31 * 60 * 1000;
    await recordOpenStarts(SID, [{ toolUseId: 'stale', toolName: 'bash', toolArgs: {} }], old);
    expect(await resolveEndToolUseId(SID, 'bash', {}, Date.now(), join(root, 'none'))).toMatch(/:orphan:/);
  });
});

const ev = (type: string, data: unknown, ts: string, id?: string) => ({ type, data, timestamp: ts, id });

describe('usage rows', () => {
  it('Tier A: one row per usage_record keyed by apiCallId, sub-agent scoped to agent', () => {
    const events = [
      ev('session.usage_record', { usage: { model: 'claude-sonnet-4.6', apiCallId: 'api-1', inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 10, outputTokens: 5, reasoningTokens: 2, finishReason: 'tool_use', initiator: 'user' } }, '2026-01-01T00:00:01.000Z'),
      ev('session.usage_record', { usage: { model: 'gpt-5.3-codex', apiCallId: 'api-2', inputTokens: 10, outputTokens: 1, initiator: 'sub-agent' } }, '2026-01-01T00:00:02.000Z'),
    ];
    const { rows } = buildUsageRows(SID, events, 'full');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      request_id: 'api-1', model_raw: 'claude-sonnet-4.6', model: 'claude-sonnet-4-6',
      input_tokens: 50, cache_read_tokens: 40, cache_creation_5m_tokens: 10, output_tokens: 5,
      thinking_tokens: 2, stop_reason: 'tool_use', scope_kind: 'main',
    });
    expect(rows[1]).toMatchObject({ request_id: 'api-2', scope_kind: 'agent' });
    expect(buildUsageRows(SID, events, 'full').rows.map((r) => r.event_id)).toEqual(rows.map((r) => r.event_id));
  });

  const message = (n: number, out: number, model = 'gpt-5.3-codex') =>
    ev('assistant.message', { messageId: `m${n}`, model, outputTokens: out }, `2026-01-01T00:00:0${n}.000Z`);
  const shutdown = (count: number, input: number, out: number, cache = 0) =>
    ev('session.shutdown', { modelMetrics: { 'gpt-5.3-codex': { requests: { count }, usage: { inputTokens: input, outputTokens: out, cacheReadTokens: cache } } } }, '2026-01-01T01:00:00.000Z');

  it('Tier B: one row per message, totals attached to the segment’s last message', () => {
    const { rows, partial } = buildUsageRows(SID, [message(1, 10), message(2, 20), shutdown(2, 1000, 50, 400)], 'full');
    expect(partial).toBe(false);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ request_id: 'm1', input_tokens: 0, output_tokens: 10 });
    expect(rows[1]).toMatchObject({ request_id: 'm2', input_tokens: 600, cache_read_tokens: 400, output_tokens: 40 });
    expect(rows[1].event_id).not.toBe(buildUsageRows(SID, [message(1, 10), message(2, 20)], 'full').rows[1].event_id);
  });

  it('Tier B resume: cumulative totals are differenced, reset totals taken as is', () => {
    const cumulative = [message(1, 10), shutdown(1, 100, 10), message(2, 20), shutdown(2, 300, 30)];
    const cum = buildUsageRows(SID, cumulative, 'full').rows;
    expect(cum.map((r) => r.input_tokens)).toEqual([100, 200]);

    const reset = [message(1, 10), shutdown(1, 100, 10), message(2, 20), shutdown(1, 300, 20), message(3, 5), shutdown(1, 7, 5)];
    expect(buildUsageRows(SID, reset, 'full').rows.map((r) => r.input_tokens)).toEqual([100, 300, 7]);
  });

  it('Tier B: an unreconcilable segment is skipped and flagged partial', () => {
    const { rows, partial } = buildUsageRows(SID, [message(1, 10), shutdown(5, 999, 10)], 'full');
    expect(partial).toBe(true);
    expect(rows[0]).toMatchObject({ input_tokens: 0 });
  });

  it('incremental reads send per-message rows without totals', () => {
    const { rows } = buildUsageRows(SID, [message(1, 10), shutdown(1, 100, 10)], 'incremental');
    expect(rows[0]).toMatchObject({ input_tokens: 0 });
  });

  it('incremental slice without model_change or data.model uses the seeded model', () => {
    const unlabelled = ev('assistant.message', { messageId: 'm1', outputTokens: 10 }, '2026-01-01T00:00:01.000Z');
    const seeded = buildUsageRows(SID, [unlabelled], 'incremental', 'gpt-5.3-codex');
    expect(seeded.partial).toBe(false);
    expect(seeded.rows).toHaveLength(1);
    expect(seeded.rows[0]).toMatchObject({ request_id: 'm1', model: 'gpt-5.3-codex' });

    const unseeded = buildUsageRows(SID, [unlabelled], 'incremental');
    expect(unseeded.partial).toBe(true);
    expect(unseeded.rows).toHaveLength(0);
  });

  it('remembers the last model for the next incremental slice', () => {
    expect(buildUsageRows(SID, [message(1, 10, 'gpt-5.4')], 'incremental').lastModel).toBe('gpt-5.4');
  });

  it('a killed session (Tier B messages, no shutdown) is flagged partial in full mode', () => {
    expect(buildUsageRows(SID, [message(1, 10)], 'full').partial).toBe(true);
  });

  it('keeps non-claude names and dashes dotted claude versions', () => {
    expect(resolveCopilotBillableModel('claude-haiku-4.5')).toBe('claude-haiku-4-5');
    expect(resolveCopilotBillableModel('gpt-5.3-codex')).toBe('gpt-5.3-codex');
  });
});

describe('agentStop pass and final pass', () => {
  const stateRoot = join(root, 'copilot', 'session-state');
  const file = join(stateRoot, SID, 'events.jsonl');
  const line = (e: unknown) => `${JSON.stringify(e)}\n`;

  beforeEach(() => {
    rmSync(join(root, 'codemie'), { recursive: true, force: true });
    mkdirSync(join(stateRoot, SID), { recursive: true });
  });

  it('reads incrementally from the cursor and re-derives nothing already committed', async () => {
    writeFileSync(file, line(ev('session.start', { startTime: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:00.000Z'))
      + line(ev('session.usage_record', { usage: { model: 'gpt-5.3-codex', apiCallId: 'a1', inputTokens: 5, outputTokens: 1 } }, '2026-01-01T00:00:01.000Z')));
    const first = buildStopPass(SID);
    expect(first?.events.map((e) => e.type)).toEqual(['agent.usage.request', 'agent.session.summary']);
    await first?.commit();

    expect(readSessionState(SID).usageCursor?.counters.apiCalls).toBe(1);
    writeFileSync(file, line(ev('session.usage_record', { usage: { model: 'gpt-5.3-codex', apiCallId: 'a2', inputTokens: 5, outputTokens: 1 } }, '2026-01-01T00:00:02.000Z')), { flag: 'a' });

    const second = buildStopPass(SID);
    expect(second?.events.filter((e) => e.type === 'agent.usage.request').map((e) => e.request_id)).toEqual(['a2']);
    expect(second?.events.at(-1)).toMatchObject({ is_final: false, api_calls: 2 });
  });

  it('a rejected spool write leaves the cursor untouched, so the next pass re-derives the rows', () => {
    writeFileSync(file, line(ev('session.usage_record', { usage: { model: 'm', apiCallId: 'a1', inputTokens: 1 } }, '2026-01-01T00:00:01.000Z')));
    buildStopPass(SID); // never committed
    expect(buildStopPass(SID)?.events.some((e) => e.request_id === 'a1')).toBe(true);
  });

  it('the stateless final pass yields every row plus a final summary with api_calls excluding sub-agents', () => {
    const events = [
      ev('session.start', { startTime: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:00.000Z'),
      ev('user.message', { text: 'hi' }, '2026-01-01T00:00:00.500Z'),
      ev('session.usage_record', { usage: { model: 'gpt-5.3-codex', apiCallId: 'a1', inputTokens: 5, outputTokens: 1 } }, '2026-01-01T00:00:01.000Z'),
      ev('session.usage_record', { usage: { model: 'gpt-5.3-codex', apiCallId: 'a2', initiator: 'sub-agent', inputTokens: 5, outputTokens: 1 } }, '2026-01-01T00:00:02.000Z'),
      ev('tool.execution_start', { toolCallId: 't1', toolName: 'create', arguments: { path: 'x.ts' } }, '2026-01-01T00:00:03.000Z'),
      ev('tool.execution_complete', { toolCallId: 't1', success: true }, '2026-01-01T00:00:04.000Z'),
      ev('session.shutdown', { codeChanges: { linesAdded: 3, linesRemoved: 1, filesModified: ['y.ts'] }, modelMetrics: {} }, '2026-01-01T00:00:05.000Z'),
    ];
    const wire = buildDeferredUsageEvents({ session_id: SID, platform: 'copilot-cli', entrypoint: 'managed' }, events as never, '1.0.92');
    const summary = wire.at(-1) as Record<string, unknown>;
    expect(wire.filter((e) => e.type === 'agent.usage.request')).toHaveLength(2);
    expect(summary).toMatchObject({
      is_final: true, api_calls: 1, turns: 1, tool_calls: 1, tool_errors: 0, lines_added: 3, lines_removed: 1,
      files_written: 1, files_edited: 1, files_changed: 2, ended_at: '2026-01-01T00:00:05.000Z',
      client_version: '1.0.92', entrypoint: 'managed',
    });
    expect(summary.tools).toEqual({ create: { calls: 1, errors: 0 } });
  });

  it('a truncated transcript yields usage rows but no tail-only final summary', () => {
    const events = [
      ev('session.usage_record', { usage: { model: 'gpt-5.3-codex', apiCallId: 'a1', inputTokens: 5, outputTokens: 1 } }, '2026-01-01T00:00:01.000Z'),
      ev('session.shutdown', { modelMetrics: {} }, '2026-01-01T00:00:05.000Z'),
    ];
    const wire = buildDeferredUsageEvents({ session_id: SID }, events as never, '', true);
    expect(wire.map((e) => e.type)).toEqual(['agent.usage.request']);
  });

  it('persists session state atomically under the lock', async () => {
    expect(await updateSessionState(SID, { clientVersion: '1.0.92' })).toBe(true);
    expect(readSessionState(SID).clientVersion).toBe('1.0.92');
  });
});
