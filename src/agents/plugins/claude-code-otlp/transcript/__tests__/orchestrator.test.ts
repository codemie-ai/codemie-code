/**
 * Tests for `collectMainTranscriptEvents` — the `Stop`/`PreCompact`/`SessionEnd` main-transcript
 * orchestrator.
 *
 * Neither `collectMainTranscriptEvents` nor `collectSubagentTranscriptEvents` writes to the spool itself —
 * each returns the raw JSON strings it wants forwarded, and the caller (the plugin's
 * `processOtlpEvent`) is the only place that actually forwards them. So these tests read the
 * returned array directly; no network/daemon mocking is needed. `CODEMIE_HOME` points at a fresh
 * temp directory per test so `loadParseState`/`saveParseState` never touch the real `~/.codemie`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let codemieHome: string;
let transcriptDir: string;

function usageLine(opts: {
  uuid: string;
  messageId: string;
  requestId?: string;
  outputTokens: number;
  gitBranch?: string;
  stopReason?: string;
  timestamp?: string;
}): string {
  return JSON.stringify({
    gitBranch: opts.gitBranch ?? 'main',
    cwd: '/repo',
    timestamp: opts.timestamp ?? '2026-10-01T00:00:00.000Z',
    uuid: opts.uuid,
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    message: {
      id: opts.messageId,
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: opts.stopReason ?? '',
      usage: {
        input_tokens: 100,
        output_tokens: opts.outputTokens,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 0,
        service_tier: 'standard',
        speed: 'standard',
        inference_geo: '',
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      },
    },
  });
}

function noUsageLine(uuid: string): string {
  return JSON.stringify({
    gitBranch: 'main',
    cwd: '/repo',
    timestamp: '2026-10-01T00:00:00.000Z',
    uuid,
    message: { role: 'user', content: 'hello' },
  });
}

beforeEach(() => {
  codemieHome = mkdtempSync(join(tmpdir(), 'codemie-home-'));
  process.env.CODEMIE_HOME = codemieHome;
  transcriptDir = mkdtempSync(join(tmpdir(), 'codemie-transcript-'));
});

afterEach(() => {
  delete process.env.CODEMIE_HOME;
  rmSync(codemieHome, { recursive: true, force: true });
  rmSync(transcriptDir, { recursive: true, force: true });
});

function writeTranscript(fileName: string, lines: string[]): string {
  const filePath = join(transcriptDir, fileName);
  writeFileSync(filePath, lines.map((l) => l + '\n').join(''), 'utf-8');
  return filePath;
}

type ForwardedEvent = Record<string, unknown>;

function parseAll(raw: ForwardedEvent[]): ForwardedEvent[] {
  return raw;
}

/**
 * Write a subagent fixture transcript (plus its sidecar `.meta.json`) under
 * `<transcriptDir>/<sessionId>/subagents/agent-<agentId>.jsonl`, matching
 * `findSubagentFiles()`'s own discovery convention. Returns the `SubagentFile` shape
 * `findSubagentFiles()` would discover for it.
 */
function writeSubagentFixture(
  sessionId: string,
  agentId: string,
  lines: string[],
  meta: Record<string, unknown> = {}
): { agentId: string; filePath: string } {
  const subagentsDir = join(transcriptDir, sessionId, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  const filePath = join(subagentsDir, `agent-${agentId}.jsonl`);
  writeFileSync(filePath, lines.map((l) => l + '\n').join(''), 'utf-8');
  writeFileSync(join(subagentsDir, `agent-${agentId}.meta.json`), JSON.stringify(meta), 'utf-8');
  return { agentId, filePath };
}

describe('collectMainTranscriptEvents — idempotent reparse', () => {
  it('returns agent.usage.request events with identical request_id/message_id/model triples across a crash-before-save re-parse', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');
    const { saveParseState, createParseState } = await import('../parse-state.js');

    const sessionId = 'session-idempotent';
    const transcriptPath = writeTranscript('transcript-idempotent.jsonl', [
      noUsageLine('uuid-0'),
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
      usageLine({ uuid: 'uuid-2', messageId: 'msg-2', outputTokens: 75, stopReason: 'end_turn' }),
    ]);

    const first = parseAll(await collectMainTranscriptEvents(sessionId, transcriptPath, 'Stop'));

    const firstPairs = first
      .filter((e) => e.type === 'agent.usage.request')
      .map((e) => `${e.request_id}::${e.message_id}::${e.model}`)
      .sort();

    expect(firstPairs).toHaveLength(2);

    // Simulate "a re-parse after a crash before state was saved": the transcript file is fully
    // there, but the persisted state is wound back to fresh (as if the first run's save never
    // happened).
    await saveParseState(sessionId, createParseState());

    const second = parseAll(await collectMainTranscriptEvents(sessionId, transcriptPath, 'Stop'));

    const secondPairs = second
      .filter((e) => e.type === 'agent.usage.request')
      .map((e) => `${e.request_id}::${e.message_id}::${e.model}`)
      .sort();

    expect(secondPairs).toHaveLength(2);
    expect(secondPairs).toEqual(firstPairs);
  });
});

describe('collectMainTranscriptEvents — Stop trigger', () => {
  it('returns one agent.usage.request event per distinct request plus one incremental agent.session.summary', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-stop-basic';
    const transcriptPath = writeTranscript('transcript-stop.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
      usageLine({ uuid: 'uuid-2', messageId: 'msg-2', outputTokens: 75 }),
    ]);

    const raw = await collectMainTranscriptEvents(sessionId, transcriptPath, 'Stop');
    expect(raw).toHaveLength(3);

    const events = parseAll(raw);
    const usageEvents = events.filter((e) => e.type === 'agent.usage.request');
    const summaryEvents = events.filter((e) => e.type === 'agent.session.summary');

    expect(usageEvents).toHaveLength(2);
    expect(summaryEvents).toHaveLength(1);
    expect(summaryEvents[0].is_final).toBe(false);
    expect(summaryEvents[0].ended_at).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('collectMainTranscriptEvents — PreCompact trigger', () => {
  it('returns usage-request events but never a session summary', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-precompact';
    const transcriptPath = writeTranscript('transcript-precompact.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);

    const events = parseAll(await collectMainTranscriptEvents(sessionId, transcriptPath, 'PreCompact'));
    const usageEvents = events.filter((e) => e.type === 'agent.usage.request');
    const summaryEvents = events.filter((e) => e.type === 'agent.session.summary');

    expect(usageEvents).toHaveLength(1);
    expect(summaryEvents).toHaveLength(0);
  });
});

/** A `type: 'user'` transcript line on `gitBranch`, with optional extra fields. */
function userLine(content: unknown, extra: Record<string, unknown> = {}, gitBranch = 'feature'): string {
  return JSON.stringify({
    type: 'user',
    gitBranch,
    cwd: '/repo',
    timestamp: '2026-10-01T00:00:00.000Z',
    message: { role: 'user', content },
    ...extra,
  });
}

function commandText(name: string): string {
  return `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args></command-args>`;
}

describe('collectMainTranscriptEvents — compactions', () => {
  it('does not count PreCompact hook fires; compaction_count comes from compact_boundary lines', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-compaction-hook';
    const transcriptPath = writeTranscript('transcript-compaction-hook.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);

    await collectMainTranscriptEvents(sessionId, transcriptPath, 'PreCompact');
    await collectMainTranscriptEvents(sessionId, transcriptPath, 'PreCompact');
    const events = parseAll(await collectMainTranscriptEvents(sessionId, transcriptPath, 'Stop'));

    const summary = events.filter((e) => e.type === 'agent.session.summary')[0];
    expect(summary.compaction_count).toBe(0);
    expect(summary.compactions).toEqual([]);
  });

  it('reports a boundary line as a completed compaction on the next summary', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-compaction-boundary';
    const transcriptPath = writeTranscript('transcript-compaction-boundary.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-10-01T00:10:00.000Z',
        compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 300, durationMs: 60_000 },
      }),
    ]);

    const events = parseAll(await collectMainTranscriptEvents(sessionId, transcriptPath, 'Stop'));
    const summary = events.filter((e) => e.type === 'agent.session.summary')[0];

    expect(summary.compaction_count).toBe(1);
    expect(summary.compaction_pre_tokens).toBe(1000);
  });
});

describe('collectMainTranscriptEvents — summary transcript signals', () => {
  async function runFinalSummary(
    sessionId: string,
    lines: string[]
  ): Promise<ForwardedEvent> {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');
    const transcriptPath = writeTranscript(`${sessionId}.jsonl`, lines);
    const events = parseAll(await collectMainTranscriptEvents(sessionId, transcriptPath, 'SessionEnd'));
    return events.filter((e) => e.type === 'agent.session.summary')[0];
  }

  const editResult = userLine(
    [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
    { toolUseResult: { structuredPatch: [{ lines: [' ctx', '-old', '+new1', '+new2'] }] } }
  );

  it('derives lines, turns, commands, compactions, versions, title and branch from the transcript', async () => {
    const summary = await runFinalSummary('session-signals', [
      JSON.stringify({ type: 'ai-title', aiTitle: 'First title' }),
      userLine('hello', { version: '2.1.295' }),
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
      editResult,
      userLine(commandText('commit')),
      userLine(commandText('plan')),
      userLine(commandText('plan')),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-10-01T00:10:00.000Z',
        compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 300, durationMs: 60_000 },
      }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Latest title' }),
    ]);

    expect(summary.lines_added).toBe(2);
    expect(summary.lines_removed).toBe(1);
    // 'hello' + three command lines; the tool_result-only line is not a prompt.
    expect(summary.turns).toBe(4);
    expect(summary.commands).toEqual(['commit', 'plan', 'plan']);
    expect(summary.primary_command).toBe('commit');
    expect(summary.compaction_count).toBe(1);
    expect(summary.compactions).toEqual([
      {
        start: '2026-10-01T00:09:00.000Z',
        end: '2026-10-01T00:10:00.000Z',
        duration_ms: 60_000,
        trigger: 'auto',
        pre_tokens: 1000,
        post_tokens: 300,
        dropped_tokens: 700,
      },
    ]);
    expect(summary.client_versions).toEqual(['2.1.295']);
    expect(summary.title).toBe('Latest title');
    expect(summary.git_branch).toBe('feature');
  });

  it('leaves lines_* null when the transcript has no applied edit result', async () => {
    const summary = await runFinalSummary('session-no-edits', [
      userLine('hello'),
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);

    expect(summary.lines_added).toBeNull();
    expect(summary.lines_removed).toBeNull();
  });

  it('recomputes the signals from the whole file on a later pass (cumulative, not just new lines)', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-cumulative';
    const transcriptPath = writeTranscript('transcript-cumulative.jsonl', [userLine('first'), editResult]);
    await collectMainTranscriptEvents(sessionId, transcriptPath, 'Stop');

    writeFileSync(transcriptPath, [userLine('first'), editResult, userLine('second'), editResult].map((l) => l + '\n').join(''));
    const events = parseAll(await collectMainTranscriptEvents(sessionId, transcriptPath, 'SessionEnd'));
    const summary = events.filter((e) => e.type === 'agent.session.summary')[0];

    expect(summary.turns).toBe(2);
    expect(summary.lines_added).toBe(4);
    expect(summary.lines_removed).toBe(2);
  });
});

describe('collectMainTranscriptEvents — branch_counts', () => {
  it('counts user lines only, not assistant usage lines', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-branch-user-only';
    const transcriptPath = writeTranscript('transcript-branch-user-only.jsonl', [
      userLine('one', {}, 'feature'),
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50, gitBranch: 'main' }),
      usageLine({ uuid: 'uuid-2', messageId: 'msg-2', outputTokens: 50, gitBranch: 'main' }),
      userLine('two', {}, 'feature'),
    ]);

    const events = parseAll(await collectMainTranscriptEvents(sessionId, transcriptPath, 'Stop'));
    const summary = events.filter((e) => e.type === 'agent.session.summary')[0];

    expect(summary.branch_counts).toEqual({ feature: 2 });
    expect(summary.branch_dominant).toBe('feature');
  });

  it('resolves a tied branch_dominant to the later branch', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-branch-tie';
    const transcriptPath = writeTranscript('transcript-branch-tie.jsonl', [
      userLine('one', {}, 'main'),
      userLine('two', {}, 'feature'),
    ]);

    const events = parseAll(await collectMainTranscriptEvents(sessionId, transcriptPath, 'Stop'));
    const summary = events.filter((e) => e.type === 'agent.session.summary')[0];

    expect(summary.branch_dominant).toBe('feature');
  });
});

describe('collectMainTranscriptEvents — api_calls', () => {
  it("surfaces the session's full agent.usage.request record count on the summary event", async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-api-calls';
    const transcriptPath = writeTranscript('transcript-api-calls.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
      usageLine({ uuid: 'uuid-2', messageId: 'msg-2', outputTokens: 75 }),
    ]);

    const events = parseAll(await collectMainTranscriptEvents(sessionId, transcriptPath, 'Stop'));
    const usageEvents = events.filter((e) => e.type === 'agent.usage.request');
    const summaryEvents = events.filter((e) => e.type === 'agent.session.summary');

    expect(summaryEvents).toHaveLength(1);
    expect(summaryEvents[0].api_calls).toBe(usageEvents.length);
    expect(summaryEvents[0].api_calls).toBe(2);
  });
});

describe('collectMainTranscriptEvents — SessionEnd trigger', () => {
  it('returns a final-phase summary with an ended_at key present', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-end';
    const transcriptPath = writeTranscript('transcript-end.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);

    const events = parseAll(await collectMainTranscriptEvents(sessionId, transcriptPath, 'SessionEnd'));
    const summaryEvents = events.filter((e) => e.type === 'agent.session.summary');

    expect(summaryEvents).toHaveLength(1);
    expect(summaryEvents[0].is_final).toBe(true);
    expect(typeof summaryEvents[0].ended_at).toBe('string');
  });
});

describe('collectMainTranscriptEvents — missing transcript file', () => {
  it('resolves cleanly to an empty array, for a trigger that never emits a summary', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');
    const { loadParseState } = await import('../parse-state.js');

    const sessionId = 'session-missing-file';
    const missingPath = join(transcriptDir, 'does-not-exist.jsonl');

    await expect(collectMainTranscriptEvents(sessionId, missingPath, 'PreCompact')).resolves.toEqual([]);

    const state = await loadParseState(sessionId);
    expect(state.mainOffset).toBe(0);
  });

  it('never throws even on Stop (which does attempt a full-file summary recompute)', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-missing-file-stop';
    const missingPath = join(transcriptDir, 'also-does-not-exist.jsonl');

    await expect(collectMainTranscriptEvents(sessionId, missingPath, 'Stop')).resolves.toBeInstanceOf(Array);
  });
});

describe('collectMainTranscriptEvents — tool-call accumulation', () => {
  it('counts Edit/Write tool_use blocks into files_written/files_edited/files_changed on the Stop summary', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-tools';
    const toolLine = JSON.stringify({
      gitBranch: 'main',
      timestamp: '2026-10-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: '/repo/a.ts' } },
          { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { file_path: '/repo/b.ts' } },
        ],
      },
    });
    const resultLine = JSON.stringify({
      gitBranch: 'main',
      timestamp: '2026-10-01T00:00:01.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', is_error: false },
          { type: 'tool_result', tool_use_id: 'tool-2', is_error: true },
        ],
      },
    });
    const transcriptPath = writeTranscript('transcript-tools.jsonl', [toolLine, resultLine]);

    const events = parseAll(await collectMainTranscriptEvents(sessionId, transcriptPath, 'Stop'));

    const summary = events.find((e) => e.type === 'agent.session.summary');
    expect(summary).toBeDefined();
    expect(summary?.files_written).toBe(1);
    expect(summary?.files_edited).toBe(1);
    expect(summary?.files_changed).toBe(2);
    const tools = summary?.tools as Record<string, { calls: number; errors: number }>;
    expect(tools.Write).toEqual({ calls: 1, errors: 0 });
    expect(tools.Edit).toEqual({ calls: 1, errors: 1 });
    expect(summary?.tool_calls).toBe(2);
    expect(summary?.tool_errors).toBe(1);
    expect(summary?.tool_results).toBe(2);
  });
});

describe('collectMainTranscriptEvents — request identity', () => {
  const usageEventsOf = (events: ForwardedEvent[]): ForwardedEvent[] =>
    events.filter((e) => e.type === 'agent.usage.request');

  it('direct shape: merges the rows of one response into one event carrying request_id and message_id', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const transcriptPath = writeTranscript('transcript-direct.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', requestId: 'req_a', outputTokens: 10 }),
      usageLine({ uuid: 'u2', messageId: 'msg_a', requestId: 'req_a', outputTokens: 40 }),
      usageLine({ uuid: 'u3', messageId: 'msg_b', requestId: 'req_b', outputTokens: 20 }),
    ]);

    const usage = usageEventsOf(await collectMainTranscriptEvents('session-direct', transcriptPath, 'Stop'));

    expect(usage.map((e) => [e.request_id, e.message_id]).sort()).toEqual([
      ['req_a', 'msg_a'],
      ['req_b', 'msg_b'],
    ]);
    expect(usage.find((e) => e.request_id === 'req_a')?.output_tokens).toBe(40);
  });

  it('proxy shape: distinct message ids stay distinct events with an empty request_id', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const transcriptPath = writeTranscript('transcript-proxy.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_bdrk_1', outputTokens: 10 }),
      usageLine({ uuid: 'u2', messageId: 'msg_bdrk_2', outputTokens: 20 }),
    ]);

    const usage = usageEventsOf(await collectMainTranscriptEvents('session-proxy', transcriptPath, 'Stop'));

    expect(usage).toHaveLength(2);
    expect(usage.every((e) => e.request_id === '')).toBe(true);
    expect(usage.map((e) => e.message_id).sort()).toEqual(['msg_bdrk_1', 'msg_bdrk_2']);
  });

  it('mixed transcript: a request with requestId and one without are not merged', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const transcriptPath = writeTranscript('transcript-mixed.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', requestId: 'req_a', outputTokens: 10 }),
      usageLine({ uuid: 'u2', messageId: 'msg_b', outputTokens: 20 }),
    ]);

    const usage = usageEventsOf(await collectMainTranscriptEvents('session-mixed', transcriptPath, 'Stop'));

    expect(usage.map((e) => [e.request_id, e.message_id]).sort()).toEqual([
      ['', 'msg_b'],
      ['req_a', 'msg_a'],
    ]);
  });

  it('direct shape: summary api_calls counts a multi-row response once', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');

    const transcriptPath = writeTranscript('transcript-direct-summary.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', requestId: 'req_a', outputTokens: 10 }),
      usageLine({ uuid: 'u2', messageId: 'msg_a', requestId: 'req_a', outputTokens: 40 }),
      usageLine({ uuid: 'u3', messageId: 'msg_b', requestId: 'req_b', outputTokens: 20 }),
    ]);

    const events = await collectMainTranscriptEvents('session-direct-summary', transcriptPath, 'Stop');
    const summary = events.find((e) => e.type === 'agent.session.summary');

    expect(summary?.api_calls).toBe(2);
    expect(summary?.models).toEqual(['claude-sonnet-4-5-20250929']);
  });

  it('direct shape: a reparse after a state reset yields the same request_id/message_id set', async () => {
    const { collectMainTranscriptEvents } = await import('../orchestrator.js');
    const { saveParseState, createParseState } = await import('../parse-state.js');

    const sessionId = 'session-direct-reparse';
    const transcriptPath = writeTranscript('transcript-direct-reparse.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', requestId: 'req_a', outputTokens: 10 }),
      usageLine({ uuid: 'u2', messageId: 'msg_a', requestId: 'req_a', outputTokens: 40 }),
      usageLine({ uuid: 'u3', messageId: 'msg_b', requestId: 'req_b', outputTokens: 20 }),
    ]);
    const idsOf = (events: ForwardedEvent[]): string[] =>
      usageEventsOf(events).map((e) => `${e.request_id}::${e.message_id}`).sort();

    const first = idsOf(await collectMainTranscriptEvents(sessionId, transcriptPath, 'Stop'));
    await saveParseState(sessionId, createParseState());
    const second = idsOf(await collectMainTranscriptEvents(sessionId, transcriptPath, 'Stop'));

    expect(first).toEqual(['req_a::msg_a', 'req_b::msg_b']);
    expect(second).toEqual(first);
  });
});

describe('collectSubagentTranscriptEvents — request identity', () => {
  it('emits request_id and message_id on agent.usage.request events, merging rows of one response', async () => {
    const { collectSubagentTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-sub-identity';
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', requestId: 'req_a', outputTokens: 10 }),
      usageLine({ uuid: 'u2', messageId: 'msg_a', requestId: 'req_a', outputTokens: 40 }),
      usageLine({ uuid: 'u3', messageId: 'msg_bdrk_b', outputTokens: 20 }),
    ]);

    const events = await collectSubagentTranscriptEvents(sessionId, file);
    const usage = events.filter((e) => e.type === 'agent.usage.request');

    expect(usage.map((e) => [e.request_id, e.message_id]).sort()).toEqual([
      ['', 'msg_bdrk_b'],
      ['req_a', 'msg_a'],
    ]);
  });
});

describe('collectSubagentTranscriptEvents — SessionEnd backstop (three subagents, one pre-advanced)', () => {
  it('returns exactly three agent.subagent.usage events — one per subagent, including the one whose own SubagentStop already advanced its offset — never a fourth', async () => {
    const { collectSubagentTranscriptEvents } = await import('../orchestrator.js');
    const { findSubagentFiles } = await import('../subagent-usage.js');

    const sessionId = 'session-backstop';
    const mainTranscriptPath = writeTranscript(`${sessionId}.jsonl`, [noUsageLine('uuid-main')]);

    writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'uuid-a1-1', messageId: 'msg-a1-1', outputTokens: 10 }),
    ]);
    writeSubagentFixture(sessionId, 'a2', [
      usageLine({ uuid: 'uuid-a2-1', messageId: 'msg-a2-1', outputTokens: 20 }),
    ]);
    writeSubagentFixture(sessionId, 'a3', [
      usageLine({ uuid: 'uuid-a3-1', messageId: 'msg-a3-1', outputTokens: 30 }),
    ]);

    // Simulate a1's own SubagentStop having already fired and advanced its offset past its
    // content (and already forwarded its own agent.subagent.usage event once).
    const filesBeforeBackstop = await findSubagentFiles(mainTranscriptPath);
    const a1File = filesBeforeBackstop.find((f) => f.agentId === 'a1');
    if (!a1File) throw new Error('fixture missing a1');
    await collectSubagentTranscriptEvents(sessionId, a1File);

    // Exercise exactly what the plugin's SessionEnd branch does: discover every subagent file
    // for the session and re-run the subagent parse for each one, unconditionally — the
    // crashed/missed-hook backstop.
    const allFiles = await findSubagentFiles(mainTranscriptPath);
    expect(allFiles).toHaveLength(3);
    const backstopEvents: ForwardedEvent[] = [];
    for (const file of allFiles) {
      backstopEvents.push(...parseAll(await collectSubagentTranscriptEvents(sessionId, file)));
    }

    const subagentUsageEvents = backstopEvents.filter((e) => e.type === 'agent.subagent.usage');
    // Exactly three — a1 (already-advanced, re-summarized rather than skipped), a2, a3. Never a
    // fourth (no duplicate re-send for a1).
    expect(subagentUsageEvents).toHaveLength(3);

    const agentIds = subagentUsageEvents.map((e) => e.agent_id).sort();
    expect(agentIds).toEqual(['a1', 'a2', 'a3']);
  });
});

describe('collectSubagentTranscriptEvents — no new bytes since last run', () => {
  it('returns zero new agent.usage.request events on a no-op reparse, but still exactly one agent.subagent.usage event summarizing unchanged cumulative usage', async () => {
    const { collectSubagentTranscriptEvents } = await import('../orchestrator.js');
    const { findSubagentFiles } = await import('../subagent-usage.js');

    const sessionId = 'session-no-new-bytes';
    const mainTranscriptPath = writeTranscript(`${sessionId}.jsonl`, [noUsageLine('uuid-main')]);
    writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'uuid-a1-1', messageId: 'msg-a1-1', outputTokens: 10 }),
      usageLine({ uuid: 'uuid-a1-2', messageId: 'msg-a1-2', outputTokens: 20 }),
    ]);

    const [file] = await findSubagentFiles(mainTranscriptPath);

    const firstEvents = parseAll(await collectSubagentTranscriptEvents(sessionId, file));
    expect(firstEvents.filter((e) => e.type === 'agent.usage.request')).toHaveLength(2);
    expect(firstEvents.filter((e) => e.type === 'agent.subagent.usage')).toHaveLength(1);

    // Re-run on the same subagent file with no new content appended since the last call (its
    // offset is now at EOF).
    const secondEvents = parseAll(await collectSubagentTranscriptEvents(sessionId, file));
    const secondUsageRequests = secondEvents.filter((e) => e.type === 'agent.usage.request');
    const secondSubagentUsage = secondEvents.filter((e) => e.type === 'agent.subagent.usage');

    // No new lines means no new/touched openRequests keys at the agent.usage.request layer.
    expect(secondUsageRequests).toHaveLength(0);
    // But the agent.subagent.usage event is still returned exactly once, summarizing the same
    // cumulative (unchanged) usage — the file itself is non-empty, so this is not a phantom.
    expect(secondSubagentUsage).toHaveLength(1);
    const usage = secondSubagentUsage[0].usage as Array<Record<string, unknown>>;
    expect(usage[0].output_tokens).toBe(30);
    expect(secondSubagentUsage[0].api_calls).toBe(2);
  });
});

describe('collectSubagentTranscriptEvents — missing subagent transcript file (phantom guard)', () => {
  it('resolves without throwing and returns no agent.subagent.usage event — a missing transcript has nothing real to summarize', async () => {
    const { collectSubagentTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-subagent-missing';
    const missingSubagentFile = {
      agentId: 'ghost',
      filePath: join(transcriptDir, sessionId, 'subagents', 'agent-ghost.jsonl'),
    };

    const events = parseAll(
      await collectSubagentTranscriptEvents(sessionId, missingSubagentFile)
    );
    const usageRequestEvents = events.filter((e) => e.type === 'agent.usage.request');
    const subagentUsageEvents = events.filter((e) => e.type === 'agent.subagent.usage');

    expect(usageRequestEvents).toHaveLength(0);
    expect(subagentUsageEvents).toHaveLength(0);
  });
});

describe('collectSubagentTranscriptEvents — empty subagent transcript file (phantom guard)', () => {
  it('returns no agent.subagent.usage event for a file with no parseable lines', async () => {
    const { collectSubagentTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-subagent-empty';
    const emptyFile = writeSubagentFixture(sessionId, 'empty', []);

    const events = parseAll(await collectSubagentTranscriptEvents(sessionId, emptyFile));

    expect(events.filter((e) => e.type === 'agent.subagent.usage')).toHaveLength(0);
  });
});

describe('subagentNeedsBackstop', () => {
  it('is true for an agent never seen before (no persisted offset)', async () => {
    const { subagentNeedsBackstop } = await import('../orchestrator.js');

    const sessionId = 'session-backstop-needed-unseen';
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'uuid-a1-1', messageId: 'msg-a1-1', outputTokens: 10 }),
    ]);

    expect(await subagentNeedsBackstop(sessionId, file)).toBe(true);
  });

  it('is false once a prior pass advanced the offset to the file\'s current size', async () => {
    const { subagentNeedsBackstop, collectSubagentTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-backstop-already-reported';
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'uuid-a1-1', messageId: 'msg-a1-1', outputTokens: 10 }),
    ]);

    await collectSubagentTranscriptEvents(sessionId, file);

    expect(await subagentNeedsBackstop(sessionId, file)).toBe(false);
  });

  it('is true again once more content is appended after the last reported offset', async () => {
    const { subagentNeedsBackstop, collectSubagentTranscriptEvents } = await import('../orchestrator.js');

    const sessionId = 'session-backstop-grown';
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'uuid-a1-1', messageId: 'msg-a1-1', outputTokens: 10 }),
    ]);
    await collectSubagentTranscriptEvents(sessionId, file);

    writeFileSync(
      file.filePath,
      usageLine({ uuid: 'uuid-a1-2', messageId: 'msg-a1-2', outputTokens: 20 }) + '\n',
      { flag: 'a' }
    );

    expect(await subagentNeedsBackstop(sessionId, file)).toBe(true);
  });
});
