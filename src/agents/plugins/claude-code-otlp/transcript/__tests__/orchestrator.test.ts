/**
 * Tests for `runMainTranscriptParse` — the `Stop`/`PreCompact`/`SessionEnd` main-transcript
 * orchestrator.
 *
 * `forwardOtlpEventToSpool` (`@/agents/plugins/utils.js`) is mocked so no real network/daemon
 * call happens; `CODEMIE_HOME` points at a fresh temp directory per test so `loadParseState`/
 * `saveParseState` never touch the real `~/.codemie`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const forwardMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/agents/plugins/utils.js', () => ({
  forwardOtlpEventToSpool: forwardMock,
}));

let codemieHome: string;
let transcriptDir: string;

function usageLine(opts: {
  uuid: string;
  messageId: string;
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
  forwardMock.mockClear();
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

function forwardedEvents(): ForwardedEvent[] {
  return forwardMock.mock.calls.map(([raw]) => JSON.parse(raw as string) as ForwardedEvent);
}

/**
 * Write a subagent fixture transcript (plus its sidecar `.meta.json`) under
 * `<transcriptDir>/<sessionId>/subagents/agent-<agentId>.jsonl`, matching
 * `findSubagentFiles()`'s own discovery convention (Task 9). Returns the `SubagentFile` shape
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

describe('runMainTranscriptParse — idempotent reparse', () => {
  it('forwards agent.usage.request events with identical request_id/model pairs across a crash-before-save re-parse', async () => {
    const { runMainTranscriptParse } = await import('../orchestrator.js');
    const { saveParseState, createParseState } = await import('../parse-state.js');

    const sessionId = 'session-idempotent';
    const transcriptPath = writeTranscript('transcript-idempotent.jsonl', [
      noUsageLine('uuid-0'),
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
      usageLine({ uuid: 'uuid-2', messageId: 'msg-2', outputTokens: 75, stopReason: 'end_turn' }),
    ]);

    await runMainTranscriptParse(sessionId, transcriptPath, 'Stop');

    const firstPairs = forwardedEvents()
      .filter((e) => e.type === 'agent.usage.request')
      .map((e) => `${e.request_id}::${e.model}`)
      .sort();

    expect(firstPairs).toHaveLength(2);

    // Simulate "a re-parse after a crash before state was saved": the transcript file is fully
    // there, but the persisted state is wound back to fresh (as if the first run's save never
    // happened).
    await saveParseState(sessionId, createParseState());
    forwardMock.mockClear();

    await runMainTranscriptParse(sessionId, transcriptPath, 'Stop');

    const secondPairs = forwardedEvents()
      .filter((e) => e.type === 'agent.usage.request')
      .map((e) => `${e.request_id}::${e.model}`)
      .sort();

    expect(secondPairs).toHaveLength(2);
    expect(secondPairs).toEqual(firstPairs);
  });
});

describe('runMainTranscriptParse — Stop trigger', () => {
  it('forwards one agent.usage.request event per distinct request plus one incremental agent.session.summary', async () => {
    const { runMainTranscriptParse } = await import('../orchestrator.js');

    const sessionId = 'session-stop-basic';
    const transcriptPath = writeTranscript('transcript-stop.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
      usageLine({ uuid: 'uuid-2', messageId: 'msg-2', outputTokens: 75 }),
    ]);

    await runMainTranscriptParse(sessionId, transcriptPath, 'Stop');

    expect(forwardMock).toHaveBeenCalledTimes(3);

    const events = forwardedEvents();
    const usageEvents = events.filter((e) => e.type === 'agent.usage.request');
    const summaryEvents = events.filter((e) => e.type === 'agent.session.summary');

    expect(usageEvents).toHaveLength(2);
    expect(summaryEvents).toHaveLength(1);
    expect(summaryEvents[0].phase).toBe('incremental');
    expect(summaryEvents[0]).not.toHaveProperty('ended_at');
  });
});

describe('runMainTranscriptParse — PreCompact trigger', () => {
  it('forwards usage-request events but never a session summary', async () => {
    const { runMainTranscriptParse } = await import('../orchestrator.js');

    const sessionId = 'session-precompact';
    const transcriptPath = writeTranscript('transcript-precompact.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);

    await runMainTranscriptParse(sessionId, transcriptPath, 'PreCompact');

    const events = forwardedEvents();
    const usageEvents = events.filter((e) => e.type === 'agent.usage.request');
    const summaryEvents = events.filter((e) => e.type === 'agent.session.summary');

    expect(usageEvents).toHaveLength(1);
    expect(summaryEvents).toHaveLength(0);
  });
});

describe('runMainTranscriptParse — compaction_count', () => {
  it('persists one increment per PreCompact trigger and surfaces the cumulative count on a later summary', async () => {
    const { runMainTranscriptParse } = await import('../orchestrator.js');

    const sessionId = 'session-compaction';
    const transcriptPath = writeTranscript('transcript-compaction.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);

    await runMainTranscriptParse(sessionId, transcriptPath, 'PreCompact');
    await runMainTranscriptParse(sessionId, transcriptPath, 'PreCompact');
    forwardMock.mockClear();
    await runMainTranscriptParse(sessionId, transcriptPath, 'Stop');

    const summaryEvents = forwardedEvents().filter((e) => e.type === 'agent.session.summary');
    expect(summaryEvents).toHaveLength(1);
    expect(summaryEvents[0].compaction_count).toBe(2);
  });
});

describe('runMainTranscriptParse — api_calls', () => {
  it("surfaces the session's full agent.usage.request record count on the summary event", async () => {
    const { runMainTranscriptParse } = await import('../orchestrator.js');

    const sessionId = 'session-api-calls';
    const transcriptPath = writeTranscript('transcript-api-calls.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
      usageLine({ uuid: 'uuid-2', messageId: 'msg-2', outputTokens: 75 }),
    ]);

    await runMainTranscriptParse(sessionId, transcriptPath, 'Stop');

    const events = forwardedEvents();
    const usageEvents = events.filter((e) => e.type === 'agent.usage.request');
    const summaryEvents = events.filter((e) => e.type === 'agent.session.summary');

    expect(summaryEvents).toHaveLength(1);
    expect(summaryEvents[0].api_calls).toBe(usageEvents.length);
    expect(summaryEvents[0].api_calls).toBe(2);
  });
});

describe('runMainTranscriptParse — SessionEnd trigger', () => {
  it('forwards a final-phase summary with an ended_at key present', async () => {
    const { runMainTranscriptParse } = await import('../orchestrator.js');

    const sessionId = 'session-end';
    const transcriptPath = writeTranscript('transcript-end.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);

    await runMainTranscriptParse(sessionId, transcriptPath, 'SessionEnd');

    const events = forwardedEvents();
    const summaryEvents = events.filter((e) => e.type === 'agent.session.summary');

    expect(summaryEvents).toHaveLength(1);
    expect(summaryEvents[0].phase).toBe('final');
    expect(summaryEvents[0]).toHaveProperty('ended_at');
    expect(typeof summaryEvents[0].ended_at).toBe('string');
  });
});

describe('runMainTranscriptParse — missing transcript file', () => {
  it('resolves cleanly without ever forwarding anything, for a trigger that never emits a summary', async () => {
    const { runMainTranscriptParse } = await import('../orchestrator.js');
    const { loadParseState } = await import('../parse-state.js');

    const sessionId = 'session-missing-file';
    const missingPath = join(transcriptDir, 'does-not-exist.jsonl');

    await expect(runMainTranscriptParse(sessionId, missingPath, 'PreCompact')).resolves.toBeUndefined();

    expect(forwardMock).not.toHaveBeenCalled();

    const state = await loadParseState(sessionId);
    expect(state.mainOffset).toBe(0);
  });

  it('never throws even on Stop (which does attempt a full-file summary recompute)', async () => {
    const { runMainTranscriptParse } = await import('../orchestrator.js');

    const sessionId = 'session-missing-file-stop';
    const missingPath = join(transcriptDir, 'also-does-not-exist.jsonl');

    await expect(runMainTranscriptParse(sessionId, missingPath, 'Stop')).resolves.toBeUndefined();
  });
});

describe('runMainTranscriptParse — tool-call accumulation', () => {
  it('counts Edit/Write tool_use blocks into files_changed/files_written on the Stop summary', async () => {
    const { runMainTranscriptParse } = await import('../orchestrator.js');

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

    await runMainTranscriptParse(sessionId, transcriptPath, 'Stop');

    const summary = forwardedEvents().find((e) => e.type === 'agent.session.summary');
    expect(summary).toBeDefined();
    expect(summary?.files_written).toEqual(['/repo/a.ts']);
    expect(summary?.files_changed).toEqual(['/repo/b.ts']);
    expect((summary?.tool_calls as Record<string, number>).Write).toBe(1);
    expect((summary?.tool_calls as Record<string, number>).Edit).toBe(1);
    expect((summary?.tool_errors as Record<string, number>).Edit).toBe(1);
    expect((summary?.tool_errors as Record<string, number>).Write).toBe(0);
  });
});

describe('runSubagentTranscriptParse — SessionEnd backstop (three subagents, one pre-advanced)', () => {
  it('forwards exactly three agent.subagent.usage events — one per subagent, including the one whose own SubagentStop already advanced its offset — never a fourth', async () => {
    const { runSubagentTranscriptParse } = await import('../orchestrator.js');
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
    await runSubagentTranscriptParse(sessionId, mainTranscriptPath, a1File);

    // Clear the setup call's forwards so they don't pollute the backstop assertion below.
    forwardMock.mockClear();

    // Exercise exactly what the plugin's SessionEnd branch does: discover every subagent file
    // for the session and re-run the subagent parse for each one, unconditionally — the
    // crashed/missed-hook backstop.
    const allFiles = await findSubagentFiles(mainTranscriptPath);
    expect(allFiles).toHaveLength(3);
    for (const file of allFiles) {
      await runSubagentTranscriptParse(sessionId, mainTranscriptPath, file);
    }

    const subagentUsageEvents = forwardedEvents().filter((e) => e.type === 'agent.subagent.usage');
    // Exactly three — a1 (already-advanced, re-summarized rather than skipped), a2, a3. Never a
    // fourth (no duplicate re-send for a1).
    expect(subagentUsageEvents).toHaveLength(3);

    const agentIds = subagentUsageEvents.map((e) => e.agent_id).sort();
    expect(agentIds).toEqual(['a1', 'a2', 'a3']);
  });
});

describe('runSubagentTranscriptParse — no new bytes since last run', () => {
  it('forwards zero new agent.usage.request events on a no-op reparse, but still forwards exactly one agent.subagent.usage event summarizing unchanged cumulative usage', async () => {
    const { runSubagentTranscriptParse } = await import('../orchestrator.js');
    const { findSubagentFiles } = await import('../subagent-usage.js');

    const sessionId = 'session-no-new-bytes';
    const mainTranscriptPath = writeTranscript(`${sessionId}.jsonl`, [noUsageLine('uuid-main')]);
    writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'uuid-a1-1', messageId: 'msg-a1-1', outputTokens: 10 }),
      usageLine({ uuid: 'uuid-a1-2', messageId: 'msg-a1-2', outputTokens: 20 }),
    ]);

    const [file] = await findSubagentFiles(mainTranscriptPath);

    await runSubagentTranscriptParse(sessionId, mainTranscriptPath, file);

    const firstEvents = forwardedEvents();
    expect(firstEvents.filter((e) => e.type === 'agent.usage.request')).toHaveLength(2);
    expect(firstEvents.filter((e) => e.type === 'agent.subagent.usage')).toHaveLength(1);

    forwardMock.mockClear();

    // Re-run on the same subagent file with no new content appended since the last call (its
    // offset is now at EOF).
    await runSubagentTranscriptParse(sessionId, mainTranscriptPath, file);

    const secondEvents = forwardedEvents();
    const secondUsageRequests = secondEvents.filter((e) => e.type === 'agent.usage.request');
    const secondSubagentUsage = secondEvents.filter((e) => e.type === 'agent.subagent.usage');

    // No new lines means no new/touched openRequests keys at the agent.usage.request layer.
    expect(secondUsageRequests).toHaveLength(0);
    // But the agent.subagent.usage event is still forwarded exactly once, summarizing the same
    // cumulative (unchanged) usage.
    expect(secondSubagentUsage).toHaveLength(1);
    expect(secondSubagentUsage[0].output_tokens).toBe(30);
    expect(secondSubagentUsage[0].api_calls).toBe(2);
  });
});

describe('runSubagentTranscriptParse — missing subagent transcript file', () => {
  it('resolves without throwing and still forwards one empty-usage agent.subagent.usage event, with no agent.usage.request events', async () => {
    const { runSubagentTranscriptParse } = await import('../orchestrator.js');

    const sessionId = 'session-subagent-missing';
    const mainTranscriptPath = writeTranscript(`${sessionId}.jsonl`, [noUsageLine('uuid-main')]);
    const missingSubagentFile = {
      agentId: 'ghost',
      filePath: join(transcriptDir, sessionId, 'subagents', 'agent-ghost.jsonl'),
    };

    await expect(
      runSubagentTranscriptParse(sessionId, mainTranscriptPath, missingSubagentFile)
    ).resolves.toBeUndefined();

    const events = forwardedEvents();
    const usageRequestEvents = events.filter((e) => e.type === 'agent.usage.request');
    const subagentUsageEvents = events.filter((e) => e.type === 'agent.subagent.usage');

    expect(usageRequestEvents).toHaveLength(0);
    expect(subagentUsageEvents).toHaveLength(1);
    expect(subagentUsageEvents[0].api_calls).toBe(0);
    expect(subagentUsageEvents[0].input_tokens).toBe(0);
    expect(subagentUsageEvents[0].started_at).toBe('');
    expect(subagentUsageEvents[0].duration_ms).toBe(0);
  });
});
