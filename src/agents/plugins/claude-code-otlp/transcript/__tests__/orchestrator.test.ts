/**
 * Tests for the `Stop`/`PreCompact`/`SessionEnd`/`SubagentStop` transcript pass openers
 * (`openMainTranscriptPass`, `openSubagentPass`, `openSessionEndPass`).
 *
 * None of them forward anything to the spool themselves — each returns `{ events, finalize }`;
 * the caller (`OtlpAgentAdapter.processOtlpEvent`) sends `events` and only then calls
 * `finalize(accepted)`, which commits the parse state (and releases the lock) when `accepted` is
 * true. Most tests here only care about the derived `events`, so `mainEvents`/`subagentEvents`
 * below open a pass and immediately finalize it with `accepted: true` — the same thing a
 * successful send does — to keep the bulk of this file reading like the old
 * "collect and assert" shape. The commit-after-send contract itself (state unchanged on a
 * rejected send, lock released either way) has its own `finalize` describe block further down.
 *
 * `CODEMIE_HOME` points at a fresh temp directory per test so `loadParseState`/`saveParseState`
 * never touch the real `~/.codemie`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@/utils/logger.js';

const { resolveSessionEnvFieldsMock, resolveVolatileSessionEnvFieldsMock } = vi.hoisted(() => ({
  resolveSessionEnvFieldsMock: vi.fn(),
  resolveVolatileSessionEnvFieldsMock: vi.fn(),
}));

// Mocked so `openSessionEnvCheckPass` tests control exactly what a "full" vs. "cheap" recompute
// returns, instead of this file's real settings/plugin/MCP files leaking into the result.
vi.mock('../../event-fields/session-env-fields.js', () => ({
  resolveSessionEnvFields: resolveSessionEnvFieldsMock,
  resolveVolatileSessionEnvFields: resolveVolatileSessionEnvFieldsMock,
  sessionEnvFieldsEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
}));

import {
  openMainTranscriptPass,
  openPostCompactPass,
  openSessionStartPass,
  openSessionEnvCheckPass,
  openSubagentPass,
  openSessionEndPass,
  type MainTranscriptTrigger,
  type SubagentFile,
} from '../orchestrator.js';

/** Opens a main-transcript pass and commits it immediately, as a successful send would. */
async function mainEvents(
  sessionId: string,
  transcriptPath: string,
  trigger: MainTranscriptTrigger
): Promise<Record<string, unknown>[]> {
  const pass = await openMainTranscriptPass(sessionId, transcriptPath, trigger);
  await pass.finalize(true);
  return pass.events;
}

/** Opens a subagent pass and commits it immediately, as a successful send would. */
async function subagentEvents(
  sessionId: string,
  subagentFile: SubagentFile
): Promise<Record<string, unknown>[]> {
  const pass = await openSubagentPass(sessionId, subagentFile);
  await pass.finalize(true);
  return pass.events;
}

let codemieHome: string;
let transcriptDir: string;

function usageLine(opts: {
  uuid: string;
  messageId: string;
  requestId?: string;
  outputTokens: number;
  model?: string;
  isApiErrorMessage?: boolean;
  gitBranch?: string;
  stopReason?: string;
  timestamp?: string;
  requestedModel?: string;
  attributionSkill?: string;
}): string {
  return JSON.stringify({
    gitBranch: opts.gitBranch ?? 'main',
    cwd: '/repo',
    timestamp: opts.timestamp ?? '2026-10-01T00:00:00.000Z',
    uuid: opts.uuid,
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(opts.requestedModel ? { requestedModel: opts.requestedModel } : {}),
    ...(opts.attributionSkill ? { attributionSkill: opts.attributionSkill } : {}),
    ...(opts.isApiErrorMessage ? { isApiErrorMessage: opts.isApiErrorMessage } : {}),
    message: {
      id: opts.messageId,
      role: 'assistant',
      model: opts.model ?? 'claude-sonnet-4-5-20250929',
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

afterEach(async () => {
  delete process.env.CODEMIE_HOME;
  // Flush and close the singleton logger's write stream before deleting the temp
  // home: it opens the log file asynchronously, and Windows refuses to rmdir a
  // directory ('logs') that still holds an open handle (ENOTEMPTY).
  await logger.close();
  try { rmSync(codemieHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best-effort */ }
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

describe('openMainTranscriptPass — idempotent reparse', () => {
  it('returns agent.usage.request events with identical request_id/message_id/model triples across a crash-before-save re-parse', async () => {
    const { saveParseState, createParseState } = await import('../parse-state.js');

    const sessionId = 'session-idempotent';
    const transcriptPath = writeTranscript('transcript-idempotent.jsonl', [
      noUsageLine('uuid-0'),
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
      usageLine({ uuid: 'uuid-2', messageId: 'msg-2', outputTokens: 75, stopReason: 'end_turn' }),
    ]);

    const first = parseAll(await mainEvents(sessionId, transcriptPath, 'Stop'));

    const firstPairs = first
      .filter((e) => e.type === 'agent.usage.request')
      .map((e) => `${e.request_id}::${e.message_id}::${e.model}`)
      .sort();

    expect(firstPairs).toHaveLength(2);

    // Simulate "a re-parse after a crash before state was saved": the transcript file is fully
    // there, but the persisted state is wound back to fresh (as if the first run's save never
    // happened).
    await saveParseState(sessionId, createParseState());

    const second = parseAll(await mainEvents(sessionId, transcriptPath, 'Stop'));

    const secondPairs = second
      .filter((e) => e.type === 'agent.usage.request')
      .map((e) => `${e.request_id}::${e.message_id}::${e.model}`)
      .sort();

    expect(secondPairs).toHaveLength(2);
    expect(secondPairs).toEqual(firstPairs);
  });
});

describe('openMainTranscriptPass — Stop trigger', () => {
  it('flags API-error placeholders and excludes their synthetic model from the session summary', async () => {
    const sessionId = 'session-synthetic-model';
    const transcriptPath = writeTranscript('transcript-synthetic-model.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
      usageLine({
        uuid: 'uuid-2',
        messageId: 'msg-2',
        outputTokens: 0,
        model: '<synthetic>',
        isApiErrorMessage: true,
      }),
    ]);

    const events = parseAll(await mainEvents(sessionId, transcriptPath, 'Stop'));
    const usageEvents = events.filter((event) => event.type === 'agent.usage.request');
    const summary = events.find((event) => event.type === 'agent.session.summary');

    expect(usageEvents).toHaveLength(2);
    expect(usageEvents.find((event) => event.message_id === 'msg-2')?.is_api_error).toBe(true);
    expect(summary?.models).toEqual(['claude-sonnet-4-5-20250929']);
    expect(summary?.primary_model).toBe('claude-sonnet-4-5-20250929');
  });

  it('returns one agent.usage.request event per distinct request plus one incremental agent.session.summary', async () => {

    const sessionId = 'session-stop-basic';
    const transcriptPath = writeTranscript('transcript-stop.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
      usageLine({ uuid: 'uuid-2', messageId: 'msg-2', outputTokens: 75 }),
    ]);

    const raw = await mainEvents(sessionId, transcriptPath, 'Stop');
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

describe('openMainTranscriptPass — PreCompact trigger', () => {
  it('returns usage-request events but never a session summary', async () => {

    const sessionId = 'session-precompact';
    const transcriptPath = writeTranscript('transcript-precompact.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);

    const events = parseAll(await mainEvents(sessionId, transcriptPath, 'PreCompact'));
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

/** An assistant usage line, optionally invoking the `Skill` tool alongside its own usage. */
function skillAwareLine(opts: {
  uuid: string;
  messageId: string;
  outputTokens: number;
  skill?: string;
  requestedModel?: string;
  attributionSkill?: string;
}): string {
  const content: unknown[] = [{ type: 'text', text: 'ok' }];
  if (opts.skill) {
    content.push({ type: 'tool_use', id: `tool-${opts.uuid}`, name: 'Skill', input: { skill: opts.skill } });
  }
  return JSON.stringify({
    gitBranch: 'main',
    cwd: '/repo',
    timestamp: '2026-10-01T00:00:00.000Z',
    uuid: opts.uuid,
    ...(opts.requestedModel ? { requestedModel: opts.requestedModel } : {}),
    ...(opts.attributionSkill ? { attributionSkill: opts.attributionSkill } : {}),
    message: {
      id: opts.messageId,
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: '',
      content,
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

describe('openMainTranscriptPass — compactions', () => {
  it('does not count PreCompact hook fires; compaction_count comes from compact_boundary lines', async () => {

    const sessionId = 'session-compaction-hook';
    const transcriptPath = writeTranscript('transcript-compaction-hook.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);

    await mainEvents(sessionId, transcriptPath, 'PreCompact');
    await mainEvents(sessionId, transcriptPath, 'PreCompact');
    const events = parseAll(await mainEvents(sessionId, transcriptPath, 'Stop'));

    const summary = events.filter((e) => e.type === 'agent.session.summary')[0];
    expect(summary.compaction_count).toBe(0);
    expect(summary.compactions).toEqual([]);
  });

  it('reports a boundary line as a completed compaction on the next summary', async () => {

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

    const events = parseAll(await mainEvents(sessionId, transcriptPath, 'Stop'));
    const summary = events.filter((e) => e.type === 'agent.session.summary')[0];

    expect(summary.compaction_count).toBe(1);
    expect(summary.compaction_pre_tokens).toBe(1000);
  });

  it('surfaces a new boundary line as an agent.session.compact.done record, via openPostCompactPass only', async () => {
    const sessionId = 'session-compaction-done';
    const transcriptPath = writeTranscript('transcript-compaction-done.jsonl', [
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-10-01T00:10:00.000Z',
        compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 300, durationMs: 60_000 },
      }),
    ]);

    const pass = await openPostCompactPass(sessionId, transcriptPath, 2_000);
    await pass.finalize(true);

    expect(pass.events).toEqual([
      {
        type: 'agent.session.compact.done',
        session_id: sessionId,
        pre_tokens: 1000,
        post_tokens: 300,
        dropped_tokens: 700,
        duration_ms: 60_000,
        timestamp: '2026-10-01T00:10:00.000Z',
      },
    ]);
  });

  it('never surfaces agent.session.compact.done on Stop/PreCompact/StopFailure/SessionEnd — only openPostCompactPass derives it', async () => {
    const boundaryLine = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: '2026-10-01T00:10:00.000Z',
      compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 300, durationMs: 60_000 },
    });

    for (const trigger of ['Stop', 'PreCompact', 'StopFailure', 'SessionEnd'] as const) {
      const sessionId = `session-compaction-not-done-${trigger}`;
      const transcriptPath = writeTranscript(`transcript-compaction-not-done-${trigger}.jsonl`, [boundaryLine]);

      const pass = await openMainTranscriptPass(sessionId, transcriptPath, trigger);
      await pass.finalize(true);

      expect(pass.events.some((e) => e.type === 'agent.session.compact.done')).toBe(false);
    }
  });

  it('does not re-surface agent.session.compact.done for a boundary line already reported by an earlier PostCompact pass', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const debugSpy = vi.spyOn(logger, 'debug');
    try {
      const sessionId = 'session-compaction-done-once';
      const transcriptPath = writeTranscript('transcript-compaction-done-once.jsonl', [
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          timestamp: '2026-10-01T00:10:00.000Z',
          compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 300, durationMs: 60_000 },
        }),
      ]);

      const first = await openPostCompactPass(sessionId, transcriptPath, 2_000);
      await first.finalize(true);
      expect(first.events.some((e) => e.type === 'agent.session.compact.done')).toBe(true);

      const second = await openPostCompactPass(sessionId, transcriptPath, 2_000);
      await second.finalize(true);
      expect(second.events.some((e) => e.type === 'agent.session.compact.done')).toBe(false);
      // "Already accounted for" is not the same as "not found": only the latter is a warning.
      expect(
        warnSpy.mock.calls.some(([message]) => String(message).includes('compact_boundary not found'))
      ).toBe(false);
      expect(
        debugSpy.mock.calls.some(([message]) => String(message).includes('compact_boundary already accounted for'))
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it('reports a second, later compaction without re-reporting the first', async () => {
    const sessionId = 'session-compaction-twice';
    const transcriptPath = writeTranscript('transcript-compaction-twice.jsonl', [
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-10-01T00:10:00.000Z',
        compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 300, durationMs: 60_000 },
      }),
    ]);

    const first = await openPostCompactPass(sessionId, transcriptPath, 2_000);
    await first.finalize(true);
    expect(first.events.filter((e) => e.type === 'agent.session.compact.done')).toHaveLength(1);

    appendFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-10-01T00:20:00.000Z',
        compactMetadata: { trigger: 'auto', preTokens: 2000, postTokens: 500, durationMs: 30_000 },
      }) + '\n'
    );

    const second = await openPostCompactPass(sessionId, transcriptPath, 2_000);
    await second.finalize(true);
    const secondDone = second.events.filter((e) => e.type === 'agent.session.compact.done');
    expect(secondDone).toHaveLength(1);
    expect(secondDone[0].timestamp).toBe('2026-10-01T00:20:00.000Z');
  });

  it('collects each boundary once when another boundary lands during PostCompact with no saved marker', async () => {
    const sessionId = 'session-compaction-delayed-boundary';
    const transcriptPath = writeTranscript('transcript-compaction-delayed-boundary.jsonl', [
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-10-01T00:10:00.000Z',
        compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 300, durationMs: 60_000 },
      }),
    ]);

    const passPromise = openPostCompactPass(sessionId, transcriptPath, 250);
    await new Promise((resolve) => setTimeout(resolve, 50));
    appendFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-10-01T00:20:00.000Z',
        compactMetadata: { trigger: 'auto', preTokens: 2000, postTokens: 500, durationMs: 30_000 },
      }) + '\n'
    );

    const pass = await passPromise;
    await pass.finalize(true);

    const compactDone = pass.events.filter((event) => event.type === 'agent.session.compact.done');
    expect(compactDone).toHaveLength(2);
    expect(compactDone.map((event) => event.timestamp)).toEqual([
      '2026-10-01T00:10:00.000Z',
      '2026-10-01T00:20:00.000Z',
    ]);
  });

  it('waits (lock-free) past a compact_boundary line that lands just after PostCompact fires, rather than missing it', async () => {
    const sessionId = 'session-compaction-race';
    const transcriptPath = writeTranscript('transcript-compaction-race.jsonl', []);

    const passPromise = openPostCompactPass(sessionId, transcriptPath, 2_000);

    // The boundary line lands on disk shortly after the hook fires — after the pass's first,
    // immediate read already came up empty, but well inside the polling wait budget.
    await new Promise((resolve) => setTimeout(resolve, 50));
    appendFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-10-01T00:10:00.000Z',
        compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 300, durationMs: 60_000 },
      }) + '\n'
    );

    const pass = await passPromise;
    await pass.finalize(true);

    expect(pass.events).toEqual([
      {
        type: 'agent.session.compact.done',
        session_id: sessionId,
        pre_tokens: 1000,
        post_tokens: 300,
        dropped_tokens: 700,
        duration_ms: 60_000,
        timestamp: '2026-10-01T00:10:00.000Z',
      },
    ]);
  });

  it('gives up quietly — no synthetic/duplicate event — once the wait budget is exhausted with no boundary line ever appearing', async () => {
    const sessionId = 'session-compaction-never';
    const transcriptPath = writeTranscript('transcript-compaction-never.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);
    const warnSpy = vi.spyOn(logger, 'warn');

    try {
      // A tiny real budget — the boundary line never shows up in this test either way, so this just
      // keeps the test fast instead of waiting out the full production budget.
      const pass = await openPostCompactPass(sessionId, transcriptPath, 50);
      await pass.finalize(true);

      // The one usage line is still reported; no agent.session.compact.done shows up anywhere.
      expect(pass.events).toHaveLength(1);
      expect(pass.events.some((e) => e.type === 'agent.session.compact.done')).toBe(false);
      // A genuinely missing boundary is still the one case that warns.
      expect(
        warnSpy.mock.calls.some(([message]) => String(message).includes('compact_boundary not found'))
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns immediately instead of waiting out the budget when the transcript does not exist', async () => {
    const sessionId = 'session-compaction-missing-transcript';
    const transcriptPath = join(transcriptDir, 'no-such-transcript.jsonl');
    const started = Date.now();

    const pass = await openPostCompactPass(sessionId, transcriptPath, 5_000);
    await pass.finalize(true);

    // The budget is 5s — a missing file must short-circuit it rather than poll for the full time.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pass.events.some((e) => e.type === 'agent.session.compact.done')).toBe(false);
  });

  it('collects a boundary line whose trailing newline lands only after the first incremental read', async () => {
    const sessionId = 'session-compaction-partial-line';
    const transcriptPath = join(transcriptDir, 'transcript-compaction-partial-line.jsonl');
    const boundary = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: '2026-10-01T00:10:00.000Z',
      compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 300, durationMs: 60_000 },
    });
    // Written without its trailing newline: the first polls see an incomplete line, which the
    // incremental reader must not lose once the newline arrives.
    writeFileSync(transcriptPath, boundary, 'utf-8');

    const passPromise = openPostCompactPass(sessionId, transcriptPath, 1_500);
    // Past the first poll (t=0) and the one at ~500ms, so both read an incomplete line.
    await new Promise((resolve) => setTimeout(resolve, 600));
    appendFileSync(transcriptPath, '\n');

    const pass = await passPromise;
    await pass.finalize(true);

    expect(pass.events.filter((event) => event.type === 'agent.session.compact.done')).toHaveLength(1);
  });

  it('does not hold the per-session lock during the lock-free wait, so a sibling pass is never blocked by it', async () => {
    const sessionId = 'session-compaction-no-lock-contention';
    const transcriptPath = writeTranscript('transcript-compaction-no-lock-contention.jsonl', []);

    // No boundary line ever appears, so openPostCompactPass spends its whole wait budget
    // lock-free. A sibling openMainTranscriptPass for the same session must still complete
    // promptly instead of queueing behind it.
    const postCompactPromise = openPostCompactPass(sessionId, transcriptPath, 300);

    const siblingTranscriptPath = writeTranscript('transcript-compaction-no-lock-contention-sibling.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);
    const started = Date.now();
    const sibling = await openMainTranscriptPass(sessionId, siblingTranscriptPath, 'Stop');
    await sibling.finalize(true);
    const siblingDurationMs = Date.now() - started;

    expect(siblingDurationMs).toBeLessThan(300);
    expect(sibling.events.some((e) => e.type === 'agent.usage.request')).toBe(true);

    const postCompactPass = await postCompactPromise;
    await postCompactPass.finalize(true);
  });
});

describe('openMainTranscriptPass — summary transcript signals', () => {
  async function runFinalSummary(
    sessionId: string,
    lines: string[]
  ): Promise<ForwardedEvent> {
    const transcriptPath = writeTranscript(`${sessionId}.jsonl`, lines);
    const events = parseAll(await mainEvents(sessionId, transcriptPath, 'SessionEnd'));
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
      userLine([{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }], {
        toolUseResult: {
          type: 'create',
          structuredPatch: [],
          originalFile: null,
          content: 'one\ntwo\nthree\n',
        },
      }),
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

    // 2 from the Edit patch + 3 content lines of the created file.
    expect(summary.lines_added).toBe(5);
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

    const sessionId = 'session-cumulative';
    const transcriptPath = writeTranscript('transcript-cumulative.jsonl', [userLine('first'), editResult]);
    await mainEvents(sessionId, transcriptPath, 'Stop');

    writeFileSync(transcriptPath, [userLine('first'), editResult, userLine('second'), editResult].map((l) => l + '\n').join(''));
    const events = parseAll(await mainEvents(sessionId, transcriptPath, 'SessionEnd'));
    const summary = events.filter((e) => e.type === 'agent.session.summary')[0];

    expect(summary.turns).toBe(2);
    expect(summary.lines_added).toBe(4);
    expect(summary.lines_removed).toBe(2);
  });
});

describe('openMainTranscriptPass — branch_counts', () => {
  it('counts user lines only, not assistant usage lines', async () => {

    const sessionId = 'session-branch-user-only';
    const transcriptPath = writeTranscript('transcript-branch-user-only.jsonl', [
      userLine('one', {}, 'feature'),
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50, gitBranch: 'main' }),
      usageLine({ uuid: 'uuid-2', messageId: 'msg-2', outputTokens: 50, gitBranch: 'main' }),
      userLine('two', {}, 'feature'),
    ]);

    const events = parseAll(await mainEvents(sessionId, transcriptPath, 'Stop'));
    const summary = events.filter((e) => e.type === 'agent.session.summary')[0];

    expect(summary.branch_counts).toEqual({ feature: 2 });
    expect(summary.branch_dominant).toBe('feature');
  });

  it('resolves a tied branch_dominant to the later branch', async () => {

    const sessionId = 'session-branch-tie';
    const transcriptPath = writeTranscript('transcript-branch-tie.jsonl', [
      userLine('one', {}, 'main'),
      userLine('two', {}, 'feature'),
    ]);

    const events = parseAll(await mainEvents(sessionId, transcriptPath, 'Stop'));
    const summary = events.filter((e) => e.type === 'agent.session.summary')[0];

    expect(summary.branch_dominant).toBe('feature');
  });
});

describe('openMainTranscriptPass — api_calls', () => {
  it("surfaces the session's full agent.usage.request record count on the summary event", async () => {

    const sessionId = 'session-api-calls';
    const transcriptPath = writeTranscript('transcript-api-calls.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
      usageLine({ uuid: 'uuid-2', messageId: 'msg-2', outputTokens: 75 }),
    ]);

    const events = parseAll(await mainEvents(sessionId, transcriptPath, 'Stop'));
    const usageEvents = events.filter((e) => e.type === 'agent.usage.request');
    const summaryEvents = events.filter((e) => e.type === 'agent.session.summary');

    expect(summaryEvents).toHaveLength(1);
    expect(summaryEvents[0].api_calls).toBe(usageEvents.length);
    expect(summaryEvents[0].api_calls).toBe(2);
  });

  it('counts skill-scoped main-thread requests toward api_calls, same as plain main-thread ones', async () => {
    const sessionId = 'session-api-calls-skill';
    const transcriptPath = writeTranscript('transcript-api-calls-skill.jsonl', [
      skillAwareLine({ uuid: 'u1', messageId: 'msg-1', outputTokens: 10, skill: 'brainstorming' }),
      // Scoped 'skill' (brainstorming active since msg-1), but still a main-thread request.
      skillAwareLine({ uuid: 'u2', messageId: 'msg-2', outputTokens: 20 }),
    ]);

    const events = parseAll(await mainEvents(sessionId, transcriptPath, 'Stop'));
    const usageEvents = events.filter((e) => e.type === 'agent.usage.request');
    const summary = events.find((e) => e.type === 'agent.session.summary');

    expect(usageEvents.find((e) => e.message_id === 'msg-2')).toMatchObject({ scope_kind: 'skill' });
    expect(summary?.api_calls).toBe(usageEvents.length);
    expect(summary?.api_calls).toBe(2);
  });

  it('still excludes subagent-scoped (agent) requests from api_calls, even alongside skill-scoped main requests', async () => {
    const sessionId = 'session-api-calls-mixed-scopes';
    const mainTranscriptPath = writeTranscript(`${sessionId}.jsonl`, [
      skillAwareLine({ uuid: 'u1', messageId: 'msg-1', outputTokens: 10, skill: 'brainstorming' }),
      skillAwareLine({ uuid: 'u2', messageId: 'msg-2', outputTokens: 20 }),
    ]);
    writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'uuid-a1-1', messageId: 'msg-a1-1', outputTokens: 30 }),
    ]);

    const pass = await openSessionEndPass(sessionId, mainTranscriptPath, '/repo');
    await pass.finalize(true);

    const summary = pass.events.find((e) => e.type === 'agent.session.summary');
    // 2 main-thread requests (1 main + 1 skill); the subagent's request must not inflate this.
    expect(summary?.api_calls).toBe(2);
  });

  it('excludes a forked skill subagent\'s already-persisted requests from a later Stop summary (EPMCDME-15968 regression)', async () => {
    const sessionId = 'session-api-calls-forked-skill';
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'uuid-a1-1', messageId: 'msg-a1-1', outputTokens: 30 }),
      usageLine({ uuid: 'uuid-a1-2', messageId: 'msg-a1-2', outputTokens: 40 }),
      usageLine({ uuid: 'uuid-a1-3', messageId: 'msg-a1-3', outputTokens: 50 }),
    ]);
    // A forked skill's subagent — its usage is persisted as scope_kind='skill' (same as a
    // main-thread inline skill) via its own SubagentStop, *before* the main Stop below runs.
    const subagentPass = await subagentEvents(sessionId, { ...file, skillName: 'code-review' });
    expect(subagentPass.filter((e) => e.type === 'agent.usage.request')).toHaveLength(3);

    const mainTranscriptPath = writeTranscript(`${sessionId}.jsonl`, [
      usageLine({ uuid: 'u1', messageId: 'msg-1', outputTokens: 10 }),
      usageLine({ uuid: 'u2', messageId: 'msg-2', outputTokens: 20 }),
    ]);
    const events = await mainEvents(sessionId, mainTranscriptPath, 'Stop');
    const summary = events.find((e) => e.type === 'agent.session.summary');

    // 2 main-thread requests only; the forked skill's 3 already-persisted subagent requests
    // (scope_kind='skill', but with their own agentId) must not inflate this.
    expect(summary?.api_calls).toBe(2);
  });
});

describe('openMainTranscriptPass — skill scoping', () => {
  it('scopes the request that invokes a Skill tool as main, scopes subsequent requests as skill, and clears on the next genuine user turn', async () => {

    const sessionId = 'session-skill-scope';
    const transcriptPath = writeTranscript('transcript-skill-scope.jsonl', [
      // The invoking turn itself still belongs to whatever was active before it (main, here).
      skillAwareLine({ uuid: 'u1', messageId: 'msg-1', outputTokens: 10, skill: 'brainstorming' }),
      // Now inside the skill's context.
      skillAwareLine({ uuid: 'u2', messageId: 'msg-2', outputTokens: 20 }),
      skillAwareLine({ uuid: 'u3', messageId: 'msg-3', outputTokens: 30 }),
      // A fresh user prompt leaves the skill context.
      userLine('new unrelated prompt'),
      skillAwareLine({ uuid: 'u4', messageId: 'msg-4', outputTokens: 40 }),
    ]);

    const events = await mainEvents(sessionId, transcriptPath, 'Stop');
    const usage = events.filter((e) => e.type === 'agent.usage.request');
    const byMessageId = (id: string): Record<string, unknown> => {
      const found = usage.find((e) => e.message_id === id);
      if (!found) throw new Error(`missing usage event for ${id}`);
      return found;
    };

    expect(byMessageId('msg-1')).toMatchObject({ scope_kind: 'main', scope_name: '' });
    expect(byMessageId('msg-2')).toMatchObject({ scope_kind: 'skill', scope_name: 'brainstorming' });
    expect(byMessageId('msg-3')).toMatchObject({ scope_kind: 'skill', scope_name: 'brainstorming' });
    expect(byMessageId('msg-4')).toMatchObject({ scope_kind: 'main', scope_name: '' });
  });

  it('switches scope_name when a second, different Skill is invoked while already inside one', async () => {

    const sessionId = 'session-skill-switch';
    const transcriptPath = writeTranscript('transcript-skill-switch.jsonl', [
      skillAwareLine({ uuid: 'u1', messageId: 'msg-1', outputTokens: 10, skill: 'brainstorming' }),
      skillAwareLine({ uuid: 'u2', messageId: 'msg-2', outputTokens: 20, skill: 'code-review' }),
      skillAwareLine({ uuid: 'u3', messageId: 'msg-3', outputTokens: 30 }),
    ]);

    const events = await mainEvents(sessionId, transcriptPath, 'Stop');
    const usage = events.filter((e) => e.type === 'agent.usage.request');

    // msg-1 invokes 'brainstorming' but is itself scoped by whatever was active before it (main).
    expect(usage.find((e) => e.message_id === 'msg-1')).toMatchObject({ scope_kind: 'main', scope_name: '' });
    // msg-2 invokes 'code-review' but is itself still scoped under 'brainstorming' (active since msg-1).
    expect(usage.find((e) => e.message_id === 'msg-2')).toMatchObject({ scope_kind: 'skill', scope_name: 'brainstorming' });
    expect(usage.find((e) => e.message_id === 'msg-3')).toMatchObject({ scope_kind: 'skill', scope_name: 'code-review' });
  });

  it('persists activeSkill across hook invocations (fresh CLI process per hook)', async () => {

    const sessionId = 'session-skill-persisted';
    const transcriptPath = writeTranscript('transcript-skill-persisted.jsonl', [
      skillAwareLine({ uuid: 'u1', messageId: 'msg-1', outputTokens: 10, skill: 'brainstorming' }),
    ]);
    await mainEvents(sessionId, transcriptPath, 'Stop');

    writeFileSync(
      transcriptPath,
      skillAwareLine({ uuid: 'u2', messageId: 'msg-2', outputTokens: 20 }) + '\n',
      { flag: 'a' }
    );
    const events = await mainEvents(sessionId, transcriptPath, 'Stop');
    const usage = events.filter((e) => e.type === 'agent.usage.request');

    expect(usage.find((e) => e.message_id === 'msg-2')).toMatchObject({ scope_kind: 'skill', scope_name: 'brainstorming' });
  });

  it.each([
    ['an inline skill', 'probe-skill'],
    ['a command', 'probe-cmd'],
  ])('scopes %s run as a slash command by Claude Code\'s attributionSkill mark', async (_kind, name) => {
    const sessionId = `session-slash-${name}`;
    const transcriptPath = writeTranscript(`transcript-slash-${name}.jsonl`, [
      userLine(commandText(name)),
      skillAwareLine({
        uuid: 'u1',
        messageId: 'msg-1',
        outputTokens: 10,
        requestedModel: 'claude-sonnet-5-5',
        attributionSkill: name,
      }),
    ]);

    const usage = (await mainEvents(sessionId, transcriptPath, 'Stop')).filter((e) => e.type === 'agent.usage.request');

    expect(usage.find((e) => e.message_id === 'msg-1')).toMatchObject({ scope_kind: 'skill', scope_name: name });
  });

  it('scopes a Skill-tool inline skill by the mark: the invoking line and a later unmarked line stay main', async () => {
    const sessionId = 'session-skill-tool-marked';
    const transcriptPath = writeTranscript('transcript-skill-tool-marked.jsonl', [
      skillAwareLine({ uuid: 'u1', messageId: 'msg-1', outputTokens: 10, skill: 'probe-skill', requestedModel: 'claude-haiku-5-5' }),
      skillAwareLine({
        uuid: 'u2',
        messageId: 'msg-2',
        outputTokens: 20,
        requestedModel: 'claude-haiku-5-5',
        attributionSkill: 'probe-skill',
      }),
      skillAwareLine({ uuid: 'u3', messageId: 'msg-3', outputTokens: 30, requestedModel: 'claude-haiku-5-5' }),
    ]);

    const usage = (await mainEvents(sessionId, transcriptPath, 'Stop')).filter((e) => e.type === 'agent.usage.request');

    expect(usage.find((e) => e.message_id === 'msg-1')).toMatchObject({ scope_kind: 'main', scope_name: '' });
    expect(usage.find((e) => e.message_id === 'msg-2')).toMatchObject({ scope_kind: 'skill', scope_name: 'probe-skill' });
    expect(usage.find((e) => e.message_id === 'msg-3')).toMatchObject({ scope_kind: 'main', scope_name: '' });
  });

  it('scopes a marked line without requestedModel (Claude Code 2.1.278-2.1.294) by its mark', async () => {
    const sessionId = 'session-mark-no-requested-model';
    const transcriptPath = writeTranscript('transcript-mark-no-requested-model.jsonl', [
      userLine(commandText('probe-skill')),
      skillAwareLine({ uuid: 'u1', messageId: 'msg-1', outputTokens: 10, attributionSkill: 'probe-skill' }),
    ]);

    const usage = (await mainEvents(sessionId, transcriptPath, 'Stop')).filter((e) => e.type === 'agent.usage.request');

    expect(usage.find((e) => e.message_id === 'msg-1')).toMatchObject({ scope_kind: 'skill', scope_name: 'probe-skill' });
  });
});

describe('openMainTranscriptPass — SessionEnd trigger', () => {
  it('returns a final-phase summary with an ended_at key present', async () => {

    const sessionId = 'session-end';
    const transcriptPath = writeTranscript('transcript-end.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);

    const events = parseAll(await mainEvents(sessionId, transcriptPath, 'SessionEnd'));
    const summaryEvents = events.filter((e) => e.type === 'agent.session.summary');

    expect(summaryEvents).toHaveLength(1);
    expect(summaryEvents[0].is_final).toBe(true);
    expect(typeof summaryEvents[0].ended_at).toBe('string');
  });
});

describe('openMainTranscriptPass — missing transcript file', () => {
  it('resolves cleanly to an empty array, for a trigger that never emits a summary', async () => {
    const { loadParseState } = await import('../parse-state.js');

    const sessionId = 'session-missing-file';
    const missingPath = join(transcriptDir, 'does-not-exist.jsonl');

    await expect(mainEvents(sessionId, missingPath, 'PreCompact')).resolves.toEqual([]);

    const state = await loadParseState(sessionId);
    expect(state.mainOffset).toBe(0);
  });

  it('never throws even on Stop (which does attempt a full-file summary recompute)', async () => {

    const sessionId = 'session-missing-file-stop';
    const missingPath = join(transcriptDir, 'also-does-not-exist.jsonl');

    await expect(mainEvents(sessionId, missingPath, 'Stop')).resolves.toBeInstanceOf(Array);
  });
});

describe('openMainTranscriptPass — tool-call accumulation', () => {
  it('counts Edit/Write tool_use blocks into files_written/files_edited/files_changed on the Stop summary', async () => {

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

    const events = parseAll(await mainEvents(sessionId, transcriptPath, 'Stop'));

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

  it('counts MultiEdit (file_path) and NotebookEdit (notebook_path) toward files_edited/files_changed, not files_written', async () => {

    const sessionId = 'session-tools-multiedit-notebook';
    const toolLine = JSON.stringify({
      gitBranch: 'main',
      timestamp: '2026-10-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'MultiEdit', input: { file_path: '/repo/a.ts', edits: [] } },
          { type: 'tool_use', id: 'tool-2', name: 'NotebookEdit', input: { notebook_path: '/repo/nb.ipynb' } },
        ],
      },
    });
    const transcriptPath = writeTranscript('transcript-multiedit-notebook.jsonl', [toolLine]);

    const events = await mainEvents(sessionId, transcriptPath, 'Stop');
    const summary = events.find((e) => e.type === 'agent.session.summary');

    expect(summary?.files_written).toBe(0);
    expect(summary?.files_edited).toBe(2);
    expect(summary?.files_changed).toBe(2);
    const tools = summary?.tools as Record<string, { calls: number; errors: number }>;
    expect(tools.MultiEdit).toEqual({ calls: 1, errors: 0 });
    expect(tools.NotebookEdit).toEqual({ calls: 1, errors: 0 });
  });
});

describe('openMainTranscriptPass — request identity', () => {
  const usageEventsOf = (events: ForwardedEvent[]): ForwardedEvent[] =>
    events.filter((e) => e.type === 'agent.usage.request');

  it('direct shape: merges the rows of one response into one event carrying request_id and message_id', async () => {

    const transcriptPath = writeTranscript('transcript-direct.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', requestId: 'req_a', outputTokens: 10 }),
      usageLine({ uuid: 'u2', messageId: 'msg_a', requestId: 'req_a', outputTokens: 40 }),
      usageLine({ uuid: 'u3', messageId: 'msg_b', requestId: 'req_b', outputTokens: 20 }),
    ]);

    const usage = usageEventsOf(await mainEvents('session-direct', transcriptPath, 'Stop'));

    expect(usage.map((e) => [e.request_id, e.message_id]).sort()).toEqual([
      ['req_a', 'msg_a'],
      ['req_b', 'msg_b'],
    ]);
    expect(usage.find((e) => e.request_id === 'req_a')?.output_tokens).toBe(40);
  });

  it('proxy shape: distinct message ids stay distinct events with an empty request_id', async () => {

    const transcriptPath = writeTranscript('transcript-proxy.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_bdrk_1', outputTokens: 10 }),
      usageLine({ uuid: 'u2', messageId: 'msg_bdrk_2', outputTokens: 20 }),
    ]);

    const usage = usageEventsOf(await mainEvents('session-proxy', transcriptPath, 'Stop'));

    expect(usage).toHaveLength(2);
    expect(usage.every((e) => e.request_id === '')).toBe(true);
    expect(usage.map((e) => e.message_id).sort()).toEqual(['msg_bdrk_1', 'msg_bdrk_2']);
  });

  it('mixed transcript: a request with requestId and one without are not merged', async () => {

    const transcriptPath = writeTranscript('transcript-mixed.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', requestId: 'req_a', outputTokens: 10 }),
      usageLine({ uuid: 'u2', messageId: 'msg_b', outputTokens: 20 }),
    ]);

    const usage = usageEventsOf(await mainEvents('session-mixed', transcriptPath, 'Stop'));

    expect(usage.map((e) => [e.request_id, e.message_id]).sort()).toEqual([
      ['', 'msg_b'],
      ['req_a', 'msg_a'],
    ]);
  });

  it('direct shape: summary api_calls counts a multi-row response once', async () => {

    const transcriptPath = writeTranscript('transcript-direct-summary.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', requestId: 'req_a', outputTokens: 10 }),
      usageLine({ uuid: 'u2', messageId: 'msg_a', requestId: 'req_a', outputTokens: 40 }),
      usageLine({ uuid: 'u3', messageId: 'msg_b', requestId: 'req_b', outputTokens: 20 }),
    ]);

    const events = await mainEvents('session-direct-summary', transcriptPath, 'Stop');
    const summary = events.find((e) => e.type === 'agent.session.summary');

    expect(summary?.api_calls).toBe(2);
    expect(summary?.models).toEqual(['claude-sonnet-4-5-20250929']);
  });

  it('direct shape: a reparse after a state reset yields the same request_id/message_id set', async () => {
    const { saveParseState, createParseState } = await import('../parse-state.js');

    const sessionId = 'session-direct-reparse';
    const transcriptPath = writeTranscript('transcript-direct-reparse.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', requestId: 'req_a', outputTokens: 10 }),
      usageLine({ uuid: 'u2', messageId: 'msg_a', requestId: 'req_a', outputTokens: 40 }),
      usageLine({ uuid: 'u3', messageId: 'msg_b', requestId: 'req_b', outputTokens: 20 }),
    ]);
    const idsOf = (events: ForwardedEvent[]): string[] =>
      usageEventsOf(events).map((e) => `${e.request_id}::${e.message_id}`).sort();

    const first = idsOf(await mainEvents(sessionId, transcriptPath, 'Stop'));
    await saveParseState(sessionId, createParseState());
    const second = idsOf(await mainEvents(sessionId, transcriptPath, 'Stop'));

    expect(first).toEqual(['req_a::msg_a', 'req_b::msg_b']);
    expect(second).toEqual(first);
  });
});

describe('openSubagentPass — request identity', () => {
  it('emits request_id and message_id on agent.usage.request events, merging rows of one response', async () => {

    const sessionId = 'session-sub-identity';
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', requestId: 'req_a', outputTokens: 10 }),
      usageLine({ uuid: 'u2', messageId: 'msg_a', requestId: 'req_a', outputTokens: 40 }),
      usageLine({ uuid: 'u3', messageId: 'msg_bdrk_b', outputTokens: 20 }),
    ]);

    const events = await subagentEvents(sessionId, file);
    const usage = events.filter((e) => e.type === 'agent.usage.request');

    expect(usage.map((e) => [e.request_id, e.message_id]).sort()).toEqual([
      ['', 'msg_bdrk_b'],
      ['req_a', 'msg_a'],
    ]);
  });

  it('carries the SubagentFile.agentType through onto every agent.usage.request event, as both agent_type and scope_name (EPMCDME-15783)', async () => {

    const sessionId = 'session-sub-agent-type';
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', outputTokens: 10 }),
    ]);

    const events = await subagentEvents(sessionId, { ...file, agentType: 'Explore' });
    const usage = events.filter((e) => e.type === 'agent.usage.request');

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ agent_type: 'Explore', scope_kind: 'agent', scope_name: 'Explore' });
  });

  it('defaults agent_type and scope_name to empty when the SubagentFile has none', async () => {

    const sessionId = 'session-sub-no-agent-type';
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', outputTokens: 10 }),
    ]);

    const events = await subagentEvents(sessionId, file);
    const usage = events.filter((e) => e.type === 'agent.usage.request');

    expect(usage[0]).toMatchObject({ agent_type: '', scope_kind: 'agent', scope_name: '' });
  });

  it('scopes a forked skill (SubagentFile.skillName set) as scope_kind=skill/scope_name=<skillName>, never scope_kind=agent (EPMCDME-15968)', async () => {

    const sessionId = 'session-sub-forked-skill';
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', outputTokens: 10 }),
    ]);

    const events = await subagentEvents(sessionId, { ...file, agentType: 'general-purpose', skillName: 'code-review' });
    const usage = events.filter((e) => e.type === 'agent.usage.request');
    const subagentUsage = events.find((e) => e.type === 'agent.subagent.usage');

    // agent_type is kept as-is (still informative) — only scope_kind/scope_name change.
    expect(usage[0]).toMatchObject({ agent_type: 'general-purpose', scope_kind: 'skill', scope_name: 'code-review' });
    expect(subagentUsage?.usage).toEqual([
      expect.objectContaining({ scope_kind: 'skill', scope_name: 'code-review' }),
    ]);
  });

  it('falls back to agentType for scope_name when SubagentFile.skillName is an empty string, keeping scope_kind=agent consistent with scope_name (EPMCDME-15968 regression)', async () => {

    const sessionId = 'session-sub-empty-skill-name';
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', outputTokens: 10 }),
    ]);

    const events = await subagentEvents(sessionId, { ...file, agentType: 'general-purpose', skillName: '' });
    const usage = events.filter((e) => e.type === 'agent.usage.request');

    expect(usage[0]).toMatchObject({ scope_kind: 'agent', scope_name: 'general-purpose' });
  });

  it('carries agentType onto agent.subagent.usage\'s usage[] rows as scope_name, matching the contract\'s (model, speed, inference_geo, service_tier, scope_kind, scope_name) grouping key (EPMCDME-15783)', async () => {

    const sessionId = 'session-sub-usage-scope-name';
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', outputTokens: 10 }),
    ]);

    const events = await subagentEvents(sessionId, { ...file, agentType: 'Explore' });
    const subagentUsage = events.find((e) => e.type === 'agent.subagent.usage');

    expect(subagentUsage?.usage).toEqual([
      expect.objectContaining({ scope_kind: 'agent', scope_name: 'Explore' }),
    ]);
  });
});

describe('openSessionEndPass — subagent backstop (three subagents, one pre-advanced)', () => {
  it('skips the subagent whose own SubagentStop already covered its file, and backstops the rest', async () => {
    const sessionId = 'session-backstop';
    const mainTranscriptPath = writeTranscript(`${sessionId}.jsonl`, [noUsageLine('uuid-main')]);

    const a1 = writeSubagentFixture(sessionId, 'a1', [
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
    await subagentEvents(sessionId, a1);

    const pass = await openSessionEndPass(sessionId, mainTranscriptPath, '/repo');
    await pass.finalize(true);

    const subagentUsageEvents = pass.events.filter((e) => e.type === 'agent.subagent.usage');
    // a1 is already covered, so it is never re-sent; a2 and a3 are backstopped. Never a
    // duplicate for a1, never a missing event for a2/a3.
    expect(subagentUsageEvents.map((e) => e.agent_id).sort()).toEqual(['a2', 'a3']);
  });
});

describe('openSubagentPass — no new bytes since last run', () => {
  it('returns zero new agent.usage.request events on a no-op reparse, but still exactly one agent.subagent.usage event summarizing unchanged cumulative usage', async () => {
    const { findSubagentFiles } = await import('../subagent-usage.js');

    const sessionId = 'session-no-new-bytes';
    const mainTranscriptPath = writeTranscript(`${sessionId}.jsonl`, [noUsageLine('uuid-main')]);
    writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'uuid-a1-1', messageId: 'msg-a1-1', outputTokens: 10 }),
      usageLine({ uuid: 'uuid-a1-2', messageId: 'msg-a1-2', outputTokens: 20 }),
    ]);

    const [file] = await findSubagentFiles(mainTranscriptPath);

    const firstEvents = parseAll(await subagentEvents(sessionId, file));
    expect(firstEvents.filter((e) => e.type === 'agent.usage.request')).toHaveLength(2);
    expect(firstEvents.filter((e) => e.type === 'agent.subagent.usage')).toHaveLength(1);

    // Re-run on the same subagent file with no new content appended since the last call (its
    // offset is now at EOF).
    const secondEvents = parseAll(await subagentEvents(sessionId, file));
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

describe('openSubagentPass — missing subagent transcript file (phantom guard)', () => {
  it('resolves without throwing and returns no agent.subagent.usage event — a missing transcript has nothing real to summarize', async () => {

    const sessionId = 'session-subagent-missing';
    const missingSubagentFile = {
      agentId: 'ghost',
      filePath: join(transcriptDir, sessionId, 'subagents', 'agent-ghost.jsonl'),
    };

    const events = parseAll(
      await subagentEvents(sessionId, missingSubagentFile)
    );
    const usageRequestEvents = events.filter((e) => e.type === 'agent.usage.request');
    const subagentUsageEvents = events.filter((e) => e.type === 'agent.subagent.usage');

    expect(usageRequestEvents).toHaveLength(0);
    expect(subagentUsageEvents).toHaveLength(0);
  });
});

describe('openSubagentPass — empty subagent transcript file (phantom guard)', () => {
  it('returns no agent.subagent.usage event for a file with no parseable lines', async () => {

    const sessionId = 'session-subagent-empty';
    const emptyFile = writeSubagentFixture(sessionId, 'empty', []);

    const events = parseAll(await subagentEvents(sessionId, emptyFile));

    expect(events.filter((e) => e.type === 'agent.subagent.usage')).toHaveLength(0);
  });
});

describe('openSessionEndPass — backstop skip decision', () => {
  it('includes a subagent never seen before (no persisted offset)', async () => {
    const sessionId = 'session-backstop-needed-unseen';
    const mainTranscriptPath = writeTranscript(`${sessionId}.jsonl`, [noUsageLine('uuid-main')]);
    writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'uuid-a1-1', messageId: 'msg-a1-1', outputTokens: 10 }),
    ]);

    const pass = await openSessionEndPass(sessionId, mainTranscriptPath, '/repo');
    await pass.finalize(true);

    expect(pass.events.filter((e) => e.type === 'agent.subagent.usage').map((e) => e.agent_id)).toEqual(['a1']);
  });

  it('excludes a subagent once a prior pass advanced its offset to the file\'s current size', async () => {
    const sessionId = 'session-backstop-already-reported';
    const mainTranscriptPath = writeTranscript(`${sessionId}.jsonl`, [noUsageLine('uuid-main')]);
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'uuid-a1-1', messageId: 'msg-a1-1', outputTokens: 10 }),
    ]);
    await subagentEvents(sessionId, file);

    const pass = await openSessionEndPass(sessionId, mainTranscriptPath, '/repo');
    await pass.finalize(true);

    expect(pass.events.filter((e) => e.type === 'agent.subagent.usage')).toHaveLength(0);
  });

  it('includes a subagent again once more content is appended after the last reported offset', async () => {
    const sessionId = 'session-backstop-grown';
    const mainTranscriptPath = writeTranscript(`${sessionId}.jsonl`, [noUsageLine('uuid-main')]);
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'uuid-a1-1', messageId: 'msg-a1-1', outputTokens: 10 }),
    ]);
    await subagentEvents(sessionId, file);

    writeFileSync(
      file.filePath,
      usageLine({ uuid: 'uuid-a1-2', messageId: 'msg-a1-2', outputTokens: 20 }) + '\n',
      { flag: 'a' }
    );

    const pass = await openSessionEndPass(sessionId, mainTranscriptPath, '/repo');
    await pass.finalize(true);

    expect(pass.events.filter((e) => e.type === 'agent.subagent.usage').map((e) => e.agent_id)).toEqual(['a1']);
  });
});

describe('commit-after-send: finalize(accepted)', () => {
  it('finalize(true) persists mainOffset and openRequests, so a second pass sees no new lines', async () => {
    const sessionId = 'session-finalize-accepted';
    const transcriptPath = writeTranscript('transcript-finalize-accepted.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);

    const first = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop');
    expect(first.events.filter((e) => e.type === 'agent.usage.request')).toHaveLength(1);
    await first.finalize(true);

    const second = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop');
    await second.finalize(true);

    // No new lines since the committed offset, so no agent.usage.request is re-derived.
    expect(second.events.filter((e) => e.type === 'agent.usage.request')).toHaveLength(0);
  });

  it('finalize(false) leaves the offset untouched, so the next pass re-derives the same events', async () => {
    const sessionId = 'session-finalize-rejected';
    const transcriptPath = writeTranscript('transcript-finalize-rejected.jsonl', [
      usageLine({ uuid: 'uuid-1', messageId: 'msg-1', outputTokens: 50 }),
    ]);

    const first = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop');
    const firstIds = first.events.filter((e) => e.type === 'agent.usage.request').map((e) => e.request_id);
    expect(firstIds).toHaveLength(1);
    await first.finalize(false); // the send failed — nothing committed

    const second = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop');
    const secondIds = second.events.filter((e) => e.type === 'agent.usage.request').map((e) => e.request_id);
    await second.finalize(true);

    // The same line is read and derived again, because the offset never moved.
    expect(secondIds).toEqual(firstIds);
  });

  it('releases the lock on both finalize(true) and finalize(false), so the next pass never waits for it', async () => {
    const { acquireParseStateLock } = await import('../parse-state.js');
    const sessionId = 'session-finalize-lock';
    const transcriptPath = writeTranscript('transcript-finalize-lock.jsonl', [noUsageLine('uuid-main')]);

    const rejected = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop');
    await rejected.finalize(false);
    const releaseAfterRejected = await acquireParseStateLock(sessionId); // would hang if still held
    await releaseAfterRejected();

    const accepted = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop');
    await accepted.finalize(true);
    const releaseAfterAccepted = await acquireParseStateLock(sessionId);
    await releaseAfterAccepted();
  });

  it('releases the lock even when finalize throws while saving (a disk error does not leak it)', async () => {
    const parseState = await import('../parse-state.js');
    const sessionId = 'session-finalize-save-throws';
    const transcriptPath = writeTranscript('transcript-finalize-save-throws.jsonl', [noUsageLine('uuid-main')]);

    const saveSpy = vi
      .spyOn(parseState, 'saveParseState')
      .mockRejectedValueOnce(new Error('disk full'));

    const pass = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop');
    await pass.finalize(true); // swallows the save error, never throws into the caller

    saveSpy.mockRestore();
    const release = await parseState.acquireParseStateLock(sessionId); // would hang if still held
    await release();
  });
});

describe('openSubagentPass — partial output_tokens (stop_reason null rows)', () => {
  it('flags requests that never received a stop_reason as partial and leaves finalized ones unflagged', async () => {
    const fixture = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcript-subagent-direct.jsonl'),
      'utf-8'
    ).trimEnd().split('\n');
    const sessionId = 'session-sub-partial';
    const file = writeSubagentFixture(sessionId, 'bg1', fixture);

    const events = await subagentEvents(sessionId, file);
    const usage = events.filter((e) => e.type === 'agent.usage.request');
    const byReq = Object.fromEntries(usage.map((e) => [e.request_id, e]));

    expect(byReq.req_s1).toMatchObject({ output_tokens: 3, output_tokens_partial: true });
    expect(byReq.req_s2).toMatchObject({ output_tokens: 8, output_tokens_partial: true });
    // streamed row (1) later finalized (300): max-merge keeps the final count, not partial.
    expect(byReq.req_s3).toMatchObject({ output_tokens: 300, output_tokens_partial: false });
    expect(byReq.req_s4).toMatchObject({ output_tokens: 457, output_tokens_partial: false });
    // a later row without stop_reason must not un-finalize a request that already has one.
    expect(byReq.req_s5).toMatchObject({ output_tokens: 50, output_tokens_partial: false });
    // API-error rows carry no stop_reason by nature and are not partial.
    expect(byReq.req_s6).toMatchObject({ is_api_error: true, output_tokens_partial: false });

    const summary = events.find((e) => e.type === 'agent.subagent.usage') as { usage: Array<Record<string, unknown>> };
    expect(summary.usage[0]).toMatchObject({ output_tokens: 818, output_tokens_partial: true });
  });
});

const sessionEnvFixture = {
  provider: 'anthropic',
  api_host: 'api.anthropic.com',
  configured_model: 'claude-sonnet-5',
  effort: '',
  permission_mode: 'auto',
  output_style: '',
  plugins: {},
  mcp_servers: [] as string[],
  os: 'linux',
  arch: 'x64',
  node_version: 'v20.0.0',
  timezone: 'UTC',
  hostname_hash: 'deadbeef',
};

describe('openSessionStartPass', () => {
  it('derives no events of its own', async () => {
    const pass = await openSessionStartPass('session-start-no-events', 'sha-start', sessionEnvFixture);
    expect(pass.events).toEqual([]);
    expect(pass.gitHeadStart).toBe('sha-start');
    await pass.finalize(true);
  });

  it('finalize(true) persists git_head_start/sessionStartedAt so a later SessionEnd reads them back', async () => {
    const sessionId = 'session-start-accepted';
    const transcriptPath = writeTranscript('transcript-session-start-accepted.jsonl', [noUsageLine('uuid-main')]);

    const startPass = await openSessionStartPass(sessionId, 'sha-abc123', sessionEnvFixture);
    await startPass.finalize(true);

    const endPass = await openSessionEndPass(sessionId, transcriptPath, '/repo');
    expect(endPass.gitHeadStart).toBe('sha-abc123');
    expect(endPass.sessionStartedAt).not.toBe('');
    await endPass.finalize(true);
  });

  it('finalize(false) persists nothing, so a later SessionEnd falls back to empty start fields', async () => {
    const sessionId = 'session-start-rejected';
    const transcriptPath = writeTranscript('transcript-session-start-rejected.jsonl', [noUsageLine('uuid-main')]);

    const startPass = await openSessionStartPass(sessionId, 'sha-abc123', sessionEnvFixture);
    await startPass.finalize(false); // the send failed — nothing committed

    const endPass = await openSessionEndPass(sessionId, transcriptPath, '/repo');
    expect(endPass.gitHeadStart).toBe('');
    expect(endPass.sessionStartedAt).toBe('');
    await endPass.finalize(true);
  });

  it('a later SessionStart fire (e.g. source: compact/resume) does not overwrite the real session start', async () => {
    const sessionId = 'session-start-second-fire';
    const transcriptPath = writeTranscript('transcript-session-start-second-fire.jsonl', [noUsageLine('uuid-main')]);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const firstPass = await openSessionStartPass(sessionId, 'sha-real-start', sessionEnvFixture);
      await firstPass.finalize(true);

      // A later SessionStart fire for the SAME session (compact/resume) resolves a different
      // HEAD and a later wall-clock time — neither should replace what was recorded first.
      vi.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
      const secondPass = await openSessionStartPass(sessionId, 'sha-after-compact', sessionEnvFixture);
      expect(secondPass.gitHeadStart).toBe('sha-real-start');
      await secondPass.finalize(true);
    } finally {
      vi.useRealTimers();
    }

    const endPass = await openSessionEndPass(sessionId, transcriptPath, '/repo');
    expect(endPass.gitHeadStart).toBe('sha-real-start');
    expect(endPass.sessionStartedAt).toBe('2026-01-01T00:00:00.000Z');
    await endPass.finalize(true);
  });

  it('also records the sessionEnvFields baseline for a later openSessionEnvCheckPass to diff against', async () => {
    const sessionId = 'session-start-env-baseline';
    const startPass = await openSessionStartPass(sessionId, 'sha-abc123', sessionEnvFixture);
    await startPass.finalize(true);

    // Nothing changed relative to the baseline just recorded -> cheap check finds no diff.
    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: sessionEnvFixture.effort,
      permission_mode: sessionEnvFixture.permission_mode,
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });
    const check = await openSessionEnvCheckPass(sessionId, {
      effort: sessionEnvFixture.effort,
      permissionMode: sessionEnvFixture.permission_mode,
    });
    expect(check.sessionEnvFields).toBeNull();
    await check.finalize(true);
  });

  it('a later SessionStart fire merges onto the prior lastSessionEnvFields snapshot instead of overwriting it', async () => {
    const sessionId = 'session-start-env-merge';
    const firstFields = { ...sessionEnvFixture, effort: 'high', permission_mode: 'acceptEdits', configured_model: 'claude-opus-5' };
    const firstPass = await openSessionStartPass(sessionId, 'sha-1', firstFields);
    expect(firstPass.sessionEnvFields).toEqual(firstFields); // first fire: unchanged
    await firstPass.finalize(true);

    // Resume fire: fresh payload has empty effort/permission_mode/configured_model.
    const resumeFields = { ...sessionEnvFixture, effort: '', permission_mode: '', configured_model: '' };
    const secondPass = await openSessionStartPass(sessionId, 'sha-2', resumeFields);
    expect(secondPass.sessionEnvFields).toMatchObject({
      effort: 'high',
      permission_mode: 'acceptEdits',
      configured_model: 'claude-opus-5',
    });
    await secondPass.finalize(true);
  });

  it('a later SessionStart fire prefers its own non-empty permission_mode/configured_model over the prior snapshot', async () => {
    const sessionId = 'session-start-env-merge-prefers-own';
    const firstFields = { ...sessionEnvFixture, effort: 'high', permission_mode: 'acceptEdits', configured_model: 'claude-opus-5' };
    const firstPass = await openSessionStartPass(sessionId, 'sha-1', firstFields);
    await firstPass.finalize(true);

    const switchedFields = { ...sessionEnvFixture, effort: '', permission_mode: 'plan', configured_model: 'claude-sonnet-5' };
    const secondPass = await openSessionStartPass(sessionId, 'sha-2', switchedFields);
    expect(secondPass.sessionEnvFields).toMatchObject({
      effort: 'high', // still carried forward: SessionStart payload never has it
      permission_mode: 'plan', // fresh payload's own non-empty value wins
      configured_model: 'claude-sonnet-5',
    });
    await secondPass.finalize(true);
  });

  it('a Stop immediately after a compact/resume SessionStart finds no diff against the merged snapshot (no duplicate agent.session.env)', async () => {
    // End-to-end proof of ticket Expected-Result bullet 3: SessionStart's merge must leave the
    // baseline already correct, so the very next Stop's cheap check (openSessionEnvCheckPass,
    // no `full`) reports no change and therefore no second agent.session.env is ever built.
    const sessionId = 'session-start-env-merge-then-stop';
    const firstFields = { ...sessionEnvFixture, effort: 'high', permission_mode: 'acceptEdits', configured_model: 'claude-opus-5' };
    const firstPass = await openSessionStartPass(sessionId, 'sha-1', firstFields);
    await firstPass.finalize(true);

    // Compact/resume fire: fresh payload has empty effort/permission_mode/configured_model —
    // openSessionStartPass must merge these back onto `last` (same scenario as the first test above).
    const resumeFields = { ...sessionEnvFixture, effort: '', permission_mode: '', configured_model: '' };
    const secondPass = await openSessionStartPass(sessionId, 'sha-2', resumeFields);
    expect(secondPass.sessionEnvFields).toMatchObject({
      effort: 'high',
      permission_mode: 'acceptEdits',
      configured_model: 'claude-opus-5',
    });
    await secondPass.finalize(true);

    // Stop fires next, reporting the SAME real effort/permission_mode SessionStart's merge
    // already correctly captured — exactly what a genuine "nothing changed" Stop looks like.
    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: 'high',
      permission_mode: 'acceptEdits',
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });
    const stopCheck = await openSessionEnvCheckPass(sessionId, { effort: 'high', permissionMode: 'acceptEdits' });
    expect(stopCheck.sessionEnvFields).toBeNull(); // sessionEnvFieldsEqual found no diff: no second agent.session.env
    await stopCheck.finalize(true);
  });
});

describe('openSessionEnvCheckPass', () => {
  beforeEach(() => {
    resolveSessionEnvFieldsMock.mockReset();
    resolveVolatileSessionEnvFieldsMock.mockReset();
  });

  it('returns null without recomputing anything when there is no baseline and no full input', async () => {
    const check = await openSessionEnvCheckPass('session-env-no-baseline', {
      effort: '',
      permissionMode: 'auto',
    });

    expect(check.sessionEnvFields).toBeNull();
    expect(resolveVolatileSessionEnvFieldsMock).not.toHaveBeenCalled();
    expect(resolveSessionEnvFieldsMock).not.toHaveBeenCalled();
    await check.finalize(true);
  });

  it('cheap path: merges a changed effort onto the baseline and persists only on finalize(true)', async () => {
    const sessionId = 'session-env-cheap-change';
    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: 'high',
      permission_mode: sessionEnvFixture.permission_mode,
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });

    const check = await openSessionEnvCheckPass(sessionId, { effort: 'high', permissionMode: sessionEnvFixture.permission_mode });
    expect(check.sessionEnvFields).toMatchObject({ effort: 'high', configured_model: sessionEnvFixture.configured_model });
    await check.finalize(true);

    // A later check against the SAME now-persisted value finds no further diff.
    const second = await openSessionEnvCheckPass(sessionId, { effort: 'high', permissionMode: sessionEnvFixture.permission_mode });
    expect(second.sessionEnvFields).toBeNull();
    await second.finalize(true);
  });

  it('cheap path: finalize(false) leaves the baseline untouched, so the next check still sees the old diff', async () => {
    const sessionId = 'session-env-cheap-rejected';
    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: 'high',
      permission_mode: sessionEnvFixture.permission_mode,
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });

    const first = await openSessionEnvCheckPass(sessionId, { effort: 'high', permissionMode: sessionEnvFixture.permission_mode });
    expect(first.sessionEnvFields).not.toBeNull();
    await first.finalize(false); // send failed — nothing committed

    const second = await openSessionEnvCheckPass(sessionId, { effort: 'high', permissionMode: sessionEnvFixture.permission_mode });
    expect(second.sessionEnvFields).not.toBeNull(); // still a diff against the un-updated baseline
    await second.finalize(true);
  });

  it('cheap path: an empty effort/permissionMode input (PreCompact/SessionEnd payload shape) keeps the baseline, not blanks it', async () => {
    const sessionId = 'session-env-cheap-empty-payload';
    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    // Mirrors resolveVolatileSessionEnvFields's real pass-through behavior for a payload
    // that carries neither field (PreCompact/SessionEnd never populate them).
    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: '',
      permission_mode: '',
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });

    const check = await openSessionEnvCheckPass(sessionId, { effort: '', permissionMode: '' });

    expect(check.sessionEnvFields).toBeNull();
    await check.finalize(true);
  });

  it('cheap path: an empty effort/permissionMode input still lets a genuinely changed volatile field through', async () => {
    const sessionId = 'session-env-cheap-empty-payload-other-change';
    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: '',
      permission_mode: '',
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: 'Antarctica/Troll', // genuinely changed, unrelated to effort/permission_mode
      hostname_hash: sessionEnvFixture.hostname_hash,
    });

    const check = await openSessionEnvCheckPass(sessionId, { effort: '', permissionMode: '' });

    expect(check.sessionEnvFields).toMatchObject({
      effort: sessionEnvFixture.effort,
      permission_mode: sessionEnvFixture.permission_mode,
      timezone: 'Antarctica/Troll',
    });
    await check.finalize(true);
  });

  it('full path: builds a fresh baseline even with no prior snapshot, and always emits it', async () => {
    resolveSessionEnvFieldsMock.mockResolvedValue({ ...sessionEnvFixture, configured_model: 'claude-opus-5' });

    const check = await openSessionEnvCheckPass('session-env-full-no-baseline', {
      effort: '',
      permissionMode: 'auto',
      full: { cwd: '/repo', configuredModel: 'claude-opus-5' },
    });

    expect(check.sessionEnvFields).toMatchObject({ configured_model: 'claude-opus-5' });
    expect(resolveSessionEnvFieldsMock).toHaveBeenCalledWith('/repo', 'claude-opus-5', 'auto');
    await check.finalize(true);
  });

  it('builds a full env baseline on the first lifecycle check when SessionStart was missed', async () => {
    const sessionId = 'session-env-late-baseline';
    resolveSessionEnvFieldsMock.mockResolvedValue({
      ...sessionEnvFixture,
      configured_model: '',
      permission_mode: 'acceptEdits',
    });

    const first = await openSessionEnvCheckPass(sessionId, {
      effort: '',
      permissionMode: 'acceptEdits',
      cwd: '/repo',
    });

    expect(first.sessionEnvFields).toMatchObject({
      provider: 'anthropic',
      permission_mode: 'acceptEdits',
      configured_model: '',
    });
    expect(resolveSessionEnvFieldsMock).toHaveBeenCalledWith('/repo', '', 'acceptEdits');
    await first.finalize(true);

    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: '',
      permission_mode: 'acceptEdits',
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });
    const next = await openSessionEnvCheckPass(sessionId, {
      effort: '',
      permissionMode: 'acceptEdits',
      cwd: '/repo',
    });

    expect(next.sessionEnvFields).toBeNull();
    await next.finalize(true);
  });

  it('full path: falls back to the last snapshot\'s configured_model when the trigger supplies none (ConfigChange)', async () => {
    const sessionId = 'session-env-full-fallback-model';
    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    resolveSessionEnvFieldsMock.mockResolvedValue({ ...sessionEnvFixture, output_style: 'concise' });

    const check = await openSessionEnvCheckPass(sessionId, {
      effort: '',
      permissionMode: sessionEnvFixture.permission_mode,
      full: { cwd: '/repo' }, // no configuredModel - ConfigChange doesn't carry one
    });

    expect(resolveSessionEnvFieldsMock).toHaveBeenCalledWith('/repo', sessionEnvFixture.configured_model, sessionEnvFixture.permission_mode);
    expect(check.sessionEnvFields).toMatchObject({ output_style: 'concise' });
    await check.finalize(true);
  });

  it('full path: an empty effort/permissionMode input (PostModelSwitch/ConfigChange payload shape) keeps the baseline, not blanks it', async () => {
    const sessionId = 'session-env-full-empty-payload';
    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    // ConfigChange/PostModelSwitch can fire with no effort/permission_mode in the hook payload;
    // the full recompute itself still surfaces some other genuinely changed field (output_style).
    resolveSessionEnvFieldsMock.mockResolvedValue({
      ...sessionEnvFixture,
      effort: '',
      permission_mode: '',
      output_style: 'concise',
    });

    const check = await openSessionEnvCheckPass(sessionId, {
      effort: '',
      permissionMode: '',
      full: { cwd: '/repo', configuredModel: sessionEnvFixture.configured_model },
    });

    expect(check.sessionEnvFields).toMatchObject({
      effort: sessionEnvFixture.effort,
      permission_mode: sessionEnvFixture.permission_mode,
      output_style: 'concise',
    });
    await check.finalize(true);
  });

  it('PostModelSwitch clears the previous effort when the new model has no effort level', async () => {
    const sessionId = 'session-env-model-switch-clears-effort';
    const startPass = await openSessionStartPass(sessionId, 'sha-1', {
      ...sessionEnvFixture,
      effort: 'high',
    });
    await startPass.finalize(true);

    resolveSessionEnvFieldsMock.mockResolvedValue({
      ...sessionEnvFixture,
      configured_model: 'claude-sonnet-5',
    });

    const check = await openSessionEnvCheckPass(sessionId, {
      effort: '',
      permissionMode: sessionEnvFixture.permission_mode,
      full: {
        cwd: '/repo',
        configuredModel: 'claude-sonnet-5',
        replaceEffort: true,
      },
    });

    expect(check.sessionEnvFields).toMatchObject({
      configured_model: 'claude-sonnet-5',
      effort: '',
    });
    await check.finalize(true);
  });

  it('full path: returns null when the full recompute matches the existing baseline exactly', async () => {
    const sessionId = 'session-env-full-unchanged';
    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    resolveSessionEnvFieldsMock.mockResolvedValue({ ...sessionEnvFixture, effort: '', permission_mode: sessionEnvFixture.permission_mode });

    const check = await openSessionEnvCheckPass(sessionId, {
      effort: '',
      permissionMode: sessionEnvFixture.permission_mode,
      full: { cwd: '/repo', configuredModel: sessionEnvFixture.configured_model },
    });

    expect(check.sessionEnvFields).toBeNull();
    await check.finalize(true);
  });
});

/**
 * Regression coverage: these hooks used to run their own pass and a separate
 * `openSessionEnvCheckPass` concurrently, both acquiring the same per-session lock from the same
 * process — the second acquisition always stalled for the full `LOCK_WAIT_BUDGET_MS`. The fix
 * folds the env-check into the sibling pass's own already-held lock via `envCheck`.
 */
describe('envCheck fold-in — single lock acquisition (regression for the Stop/env-check deadlock)', () => {
  beforeEach(() => {
    resolveSessionEnvFieldsMock.mockReset();
    resolveVolatileSessionEnvFieldsMock.mockReset();
  });

  it('openMainTranscriptPass appends a changed agent.session.env record derived from envCheck, resolving almost instantly (no second lock wait)', async () => {
    const sessionId = 'session-envcheck-stop-changed';
    const transcriptPath = writeTranscript('transcript-envcheck-stop-changed.jsonl', [noUsageLine('uuid-main')]);

    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: 'high',
      permission_mode: sessionEnvFixture.permission_mode,
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });

    const started = Date.now();
    const pass = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop', {
      effort: 'high',
      permissionMode: sessionEnvFixture.permission_mode,
    });
    const elapsedMs = Date.now() - started;

    // The old double-lock-acquisition bug stalled for the full 10s LOCK_WAIT_BUDGET_MS on every
    // Stop; a single acquisition resolves immediately regardless of machine speed.
    expect(elapsedMs).toBeLessThan(2_000);

    const envEvent = pass.events.find((e) => e.type === 'agent.session.env');
    expect(envEvent).toMatchObject({ session_id: sessionId, effort: 'high' });

    await pass.finalize(true);

    const { acquireParseStateLock } = await import('../parse-state.js');
    const release = await acquireParseStateLock(sessionId); // would hang if the pass's lock leaked
    await release();
  });

  it('openMainTranscriptPass omits the agent.session.env record when envCheck finds nothing changed', async () => {
    const sessionId = 'session-envcheck-stop-unchanged';
    const transcriptPath = writeTranscript('transcript-envcheck-stop-unchanged.jsonl', [noUsageLine('uuid-main')]);

    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: sessionEnvFixture.effort,
      permission_mode: sessionEnvFixture.permission_mode,
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });

    const pass = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop', {
      effort: sessionEnvFixture.effort,
      permissionMode: sessionEnvFixture.permission_mode,
    });

    expect(pass.events.some((e) => e.type === 'agent.session.env')).toBe(false);
    await pass.finalize(true);
  });

  it('a hook fire with no envCheck argument (PostCompact-style callers) behaves exactly as before — no agent.session.env ever appended', async () => {
    const sessionId = 'session-envcheck-omitted';
    const transcriptPath = writeTranscript('transcript-envcheck-omitted.jsonl', [noUsageLine('uuid-main')]);

    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    const pass = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop');

    expect(pass.events.some((e) => e.type === 'agent.session.env')).toBe(false);
    expect(resolveVolatileSessionEnvFieldsMock).not.toHaveBeenCalled();
    await pass.finalize(true);
  });

  it('openSubagentPass folds envCheck into its own already-held lock and appends the changed record', async () => {
    const sessionId = 'session-envcheck-subagent';
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', outputTokens: 10 }),
    ]);

    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: 'high',
      permission_mode: sessionEnvFixture.permission_mode,
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });

    const started = Date.now();
    const pass = await openSubagentPass(sessionId, file, {
      effort: 'high',
      permissionMode: sessionEnvFixture.permission_mode,
    });
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(pass.events.find((e) => e.type === 'agent.session.env')).toMatchObject({ effort: 'high' });
    await pass.finalize(true);
  });

  it('openSessionEndPass folds envCheck into its own already-held lock and appends the changed record', async () => {
    const sessionId = 'session-envcheck-sessionend';
    const transcriptPath = writeTranscript('transcript-envcheck-sessionend.jsonl', [noUsageLine('uuid-main')]);

    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: 'high',
      permission_mode: sessionEnvFixture.permission_mode,
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });

    const started = Date.now();
    const pass = await openSessionEndPass(sessionId, transcriptPath, '/repo', {
      effort: 'high',
      permissionMode: sessionEnvFixture.permission_mode,
    });
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(pass.events.find((e) => e.type === 'agent.session.env')).toMatchObject({ effort: 'high' });
    await pass.finalize(true);
  });

  it('openSessionEndPass with an empty-payload envCheck (SessionEnd never carries effort/permission_mode) appends no agent.session.env record', async () => {
    const sessionId = 'session-envcheck-sessionend-empty-payload';
    const transcriptPath = writeTranscript('transcript-envcheck-sessionend-empty-payload.jsonl', [noUsageLine('uuid-main')]);

    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: '',
      permission_mode: '',
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });

    const pass = await openSessionEndPass(sessionId, transcriptPath, '/repo', {
      effort: '',
      permissionMode: '',
    });

    expect(pass.events.find((e) => e.type === 'agent.session.env')).toBeUndefined();
    await pass.finalize(true);
  });

  it('openSubagentPass with an empty-payload envCheck (SubagentStop may carry neither field) appends no agent.session.env record', async () => {
    const sessionId = 'session-envcheck-subagent-empty-payload';
    const file = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', outputTokens: 10 }),
    ]);

    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: '',
      permission_mode: '',
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });

    const pass = await openSubagentPass(sessionId, file, {
      effort: '',
      permissionMode: '',
    });

    expect(pass.events.find((e) => e.type === 'agent.session.env')).toBeUndefined();
    await pass.finalize(true);
  });

  it('finalize(false) leaves lastSessionEnvFields untouched, so the next check still sees the old diff (commit-after-send holds for the folded-in check too)', async () => {
    const sessionId = 'session-envcheck-rejected';
    const transcriptPath = writeTranscript('transcript-envcheck-rejected.jsonl', [noUsageLine('uuid-main')]);

    const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
    await startPass.finalize(true);

    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: 'high',
      permission_mode: sessionEnvFixture.permission_mode,
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });

    const first = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop', {
      effort: 'high',
      permissionMode: sessionEnvFixture.permission_mode,
    });
    expect(first.events.some((e) => e.type === 'agent.session.env')).toBe(true);
    await first.finalize(false); // the send failed — nothing committed

    const second = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop', {
      effort: 'high',
      permissionMode: sessionEnvFixture.permission_mode,
    });
    expect(second.events.some((e) => e.type === 'agent.session.env')).toBe(true); // still a diff
    await second.finalize(true);
  });

  it('ignores subagent models in the configured_model fallback until the main transcript provides a model', async () => {
    const sessionId = 'session-envcheck-model-fallback';
    const transcriptPath = writeTranscript('transcript-envcheck-model-fallback.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', outputTokens: 10, model: 'claude-opus-5' }),
    ]);
    const subagentFile = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'u2', messageId: 'msg_b', outputTokens: 5, model: 'claude-haiku-4-5-20251001' }),
    ]);

    const startPass = await openSessionStartPass(sessionId, 'sha-1', { ...sessionEnvFixture, configured_model: '' });
    await startPass.finalize(true);

    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: sessionEnvFixture.effort,
      permission_mode: sessionEnvFixture.permission_mode,
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });

    const subagentPass = await openSubagentPass(sessionId, { ...subagentFile, agentType: 'Explore' }, {
      effort: sessionEnvFixture.effort,
      permissionMode: sessionEnvFixture.permission_mode,
    });
    expect(subagentPass.events.find((e) => e.type === 'agent.session.env')).toBeUndefined();
    await subagentPass.finalize(true);

    const pass = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop', {
      effort: sessionEnvFixture.effort,
      permissionMode: sessionEnvFixture.permission_mode,
    });

    expect(pass.events.find((e) => e.type === 'agent.session.env')).toMatchObject({ configured_model: 'claude-opus-5' });
    await pass.finalize(true);

    // Persisted, so a later check against the same baseline finds no further diff.
    const next = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop', {
      effort: sessionEnvFixture.effort,
      permissionMode: sessionEnvFixture.permission_mode,
    });
    expect(next.events.some((e) => e.type === 'agent.session.env')).toBe(false);
    await next.finalize(true);
  });

  it('never falls back to the <synthetic> API-error placeholder model for configured_model', async () => {
    const sessionId = 'session-envcheck-model-fallback-synthetic';
    const transcriptPath = writeTranscript('transcript-envcheck-model-fallback-synthetic.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_a', outputTokens: 0, model: '<synthetic>', isApiErrorMessage: true }),
    ]);

    const startPass = await openSessionStartPass(sessionId, 'sha-1', { ...sessionEnvFixture, configured_model: '' });
    await startPass.finalize(true);

    resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
      effort: 'high', // force a genuine change so an env event is actually emitted to inspect
      permission_mode: sessionEnvFixture.permission_mode,
      os: sessionEnvFixture.os,
      arch: sessionEnvFixture.arch,
      node_version: sessionEnvFixture.node_version,
      timezone: sessionEnvFixture.timezone,
      hostname_hash: sessionEnvFixture.hostname_hash,
    });

    const pass = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop', {
      effort: 'high',
      permissionMode: sessionEnvFixture.permission_mode,
    });

    expect(pass.events.find((e) => e.type === 'agent.session.env')).toMatchObject({ configured_model: '' });
    await pass.finalize(true);
  });

  it.each([
    ['older', '2026-10-01T00:00:00.000Z'],
    ['newer', '2026-10-01T00:00:02.000Z'],
  ])('takes the main line\'s model over a %s fork\'s', async (order, forkTimestamp) => {
    const sessionId = `session-fallback-fork-${order}`;
    const transcriptPath = writeTranscript('transcript-fallback-fork.jsonl', [
      usageLine({
        uuid: 'u1',
        messageId: 'msg_main',
        outputTokens: 10,
        model: 'claude-opus-5-5',
        requestedModel: 'claude-opus-5-5',
        timestamp: '2026-10-01T00:00:01.000Z',
      }),
    ]);
    const fork = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'f1', messageId: 'msg_fork', outputTokens: 5, model: 'claude-haiku-5-5', timestamp: forkTimestamp }),
    ]);
    await startSessionWithoutModel(sessionId);
    const forkPass = await openSubagentPass(sessionId, { ...fork, agentType: 'general-purpose', skillName: 'probe-skill' });
    await forkPass.finalize(true);

    expect(await configuredModelAfterStop(sessionId, transcriptPath)).toBe('claude-opus-5-5');
  });

  it.each(['probe-skill', 'probe-cmd'])('ignores a newer %s line on its own model', async (mark) => {
    const sessionId = `session-fallback-marked-${mark}`;
    const transcriptPath = writeTranscript(`transcript-fallback-marked-${mark}.jsonl`, [
      usageLine({
        uuid: 'u1',
        messageId: 'msg_main',
        outputTokens: 10,
        model: 'claude-haiku-4-5-20251001',
        requestedModel: 'claude-haiku-5-5',
        timestamp: '2026-10-01T00:00:01.000Z',
      }),
      usageLine({
        uuid: 'u2',
        messageId: 'msg_skill',
        outputTokens: 10,
        model: 'claude-sonnet-4-5-20250929',
        requestedModel: 'claude-sonnet-5-5',
        attributionSkill: mark,
        timestamp: '2026-10-01T00:00:02.000Z',
      }),
    ]);
    await startSessionWithoutModel(sessionId);

    expect(await configuredModelAfterStop(sessionId, transcriptPath)).toBe('claude-haiku-5-5');
  });

  it('keeps configured_model empty while every request so far is skill-marked', async () => {
    const sessionId = 'session-fallback-only-marked';
    const transcriptPath = writeTranscript('transcript-fallback-only-marked.jsonl', [
      usageLine({
        uuid: 'u1',
        messageId: 'msg_skill',
        outputTokens: 10,
        model: 'claude-sonnet-4-5-20250929',
        requestedModel: 'claude-sonnet-5-5',
        attributionSkill: 'probe-skill',
      }),
    ]);
    await startSessionWithoutModel(sessionId);

    expect(await configuredModelAfterStop(sessionId, transcriptPath)).toBe('');
  });

  it('keeps configured_model empty on a resumed session whose only requests so far are a fork\'s', async () => {
    const sessionId = 'session-fallback-only-fork';
    const fork = writeSubagentFixture(sessionId, 'a1', [
      usageLine({ uuid: 'f1', messageId: 'msg_fork', outputTokens: 5, model: 'claude-sonnet-5-5' }),
    ]);
    await startSessionWithoutModel(sessionId);

    const forkPass = await openSubagentPass(
      sessionId,
      { ...fork, agentType: 'general-purpose', skillName: 'probe-skill' },
      forcedEnvCheck
    );
    await forkPass.finalize(true);

    expect(forkPass.events.find((e) => e.type === 'agent.session.env')).toMatchObject({ configured_model: '' });
  });

  it.each([
    ['claude-opus-5-5[1m]', 'claude-opus-5-5', 'claude-opus-5-5[1m]'],
    ['claude-haiku-4-5-20251001', 'anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5-20251001'],
    [undefined, 'claude-opus-5', 'claude-opus-5'],
  ])('takes requestedModel %s over model %s', async (requestedModel, model, expected) => {
    const sessionId = `session-fallback-form-${model.replace(/:/g, '-')}`;
    const transcriptPath = writeTranscript('transcript-fallback-form.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_main', outputTokens: 10, model, requestedModel }),
    ]);
    await startSessionWithoutModel(sessionId);

    expect(await configuredModelAfterStop(sessionId, transcriptPath)).toBe(expected);
  });

  it('reads a stored request without requestedModel as empty and falls back to its model', async () => {
    const sessionId = 'session-fallback-stored-record';
    const transcriptPath = writeTranscript('transcript-fallback-stored-record.jsonl', [
      usageLine({ uuid: 'u1', messageId: 'msg_main', outputTokens: 10, model: 'claude-opus-5' }),
    ]);
    await startSessionWithoutModel(sessionId);
    await mainEvents(sessionId, transcriptPath, 'Stop');
    const statePath = join(codemieHome, 'analytics', 'state', `${sessionId}.json`);
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      openRequests: Record<string, Record<string, unknown>>;
    };
    for (const req of Object.values(state.openRequests)) {
      delete req.requestedModel;
      delete req.attributionSkill;
    }
    writeFileSync(statePath, JSON.stringify(state), 'utf-8');

    expect(await configuredModelAfterStop(sessionId, transcriptPath)).toBe('claude-opus-5');
  });

  it('counts an old-format line the Skill tool scoped as skill', async () => {
    const sessionId = 'session-fallback-old-skill';
    const transcriptPath = writeTranscript('transcript-fallback-old-skill.jsonl', [
      skillToolUseLine('u1'),
      usageLine({ uuid: 'u2', messageId: 'msg_skill', outputTokens: 10, model: 'claude-sonnet-4-5-20250929' }),
    ]);
    await startSessionWithoutModel(sessionId);

    expect(await configuredModelAfterStop(sessionId, transcriptPath)).toBe('claude-sonnet-4-5-20250929');
  });

  it('takes a newer old-format skill-scoped line over an older plain main line', async () => {
    const sessionId = 'session-fallback-old-skill-newest';
    const transcriptPath = writeTranscript('transcript-fallback-old-skill-newest.jsonl', [
      usageLine({
        uuid: 'u1',
        messageId: 'msg_main',
        outputTokens: 10,
        model: 'claude-haiku-4-5-20251001',
        timestamp: '2026-10-01T00:00:01.000Z',
      }),
      skillToolUseLine('u2'),
      usageLine({
        uuid: 'u3',
        messageId: 'msg_skill',
        outputTokens: 10,
        model: 'claude-sonnet-4-5-20250929',
        timestamp: '2026-10-01T00:00:02.000Z',
      }),
    ]);
    await startSessionWithoutModel(sessionId);

    expect(await configuredModelAfterStop(sessionId, transcriptPath)).toBe('claude-sonnet-4-5-20250929');
  });

  it('takes the main line\'s model over a newer old-format fork\'s', async () => {
    const sessionId = 'session-fallback-old-fork';
    const transcriptPath = writeTranscript('transcript-fallback-old-fork.jsonl', [
      usageLine({
        uuid: 'u1',
        messageId: 'msg_main',
        outputTokens: 10,
        model: 'claude-opus-5',
        timestamp: '2026-10-01T00:00:01.000Z',
      }),
    ]);
    const fork = writeSubagentFixture(sessionId, 'a1', [
      usageLine({
        uuid: 'f1',
        messageId: 'msg_fork',
        outputTokens: 5,
        model: 'claude-haiku-4-5-20251001',
        timestamp: '2026-10-01T00:00:02.000Z',
      }),
    ]);
    await startSessionWithoutModel(sessionId);
    const forkPass = await openSubagentPass(sessionId, { ...fork, agentType: 'general-purpose', skillName: 'probe-skill' });
    await forkPass.finalize(true);

    expect(await configuredModelAfterStop(sessionId, transcriptPath)).toBe('claude-opus-5');
  });

  it('counts a stored skill-scoped request without attributionSkill and requestedModel', async () => {
    const sessionId = 'session-fallback-stored-skill';
    const transcriptPath = writeTranscript('transcript-fallback-stored-skill.jsonl', [
      skillToolUseLine('u1'),
      usageLine({ uuid: 'u2', messageId: 'msg_skill', outputTokens: 10, model: 'claude-sonnet-4-5-20250929' }),
    ]);
    await startSessionWithoutModel(sessionId);
    await mainEvents(sessionId, transcriptPath, 'Stop');
    const statePath = join(codemieHome, 'analytics', 'state', `${sessionId}.json`);
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      openRequests: Record<string, Record<string, unknown>>;
    };
    for (const req of Object.values(state.openRequests)) {
      expect(req.scopeKind).toBe('skill');
      delete req.requestedModel;
      delete req.attributionSkill;
    }
    writeFileSync(statePath, JSON.stringify(state), 'utf-8');

    expect(await configuredModelAfterStop(sessionId, transcriptPath)).toBe('claude-sonnet-4-5-20250929');
  });
});

/** An assistant line that only invokes the `Skill` tool, with no usage of its own. */
function skillToolUseLine(uuid: string): string {
  return JSON.stringify({
    type: 'assistant',
    gitBranch: 'main',
    cwd: '/repo',
    timestamp: '2026-10-01T00:00:00.000Z',
    uuid,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `tool-${uuid}`, name: 'Skill', input: { skill: 'probe-skill' } }],
    },
  });
}

/** Env-check input whose `effort` differs from the SessionStart baseline, so a snapshot is emitted. */
const forcedEnvCheck = { effort: 'high', permissionMode: sessionEnvFixture.permission_mode };

/** A SessionStart that carries no model, the way a session resumed without the plugin starts. */
async function startSessionWithoutModel(sessionId: string): Promise<void> {
  const startPass = await openSessionStartPass(sessionId, 'sha-1', { ...sessionEnvFixture, configured_model: '' });
  await startPass.finalize(true);
  resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
    effort: 'high',
    permission_mode: sessionEnvFixture.permission_mode,
    os: sessionEnvFixture.os,
    arch: sessionEnvFixture.arch,
    node_version: sessionEnvFixture.node_version,
    timezone: sessionEnvFixture.timezone,
    hostname_hash: sessionEnvFixture.hostname_hash,
  });
}

/** `configured_model` of the `agent.session.env` a `Stop` pass emits with {@link forcedEnvCheck}. */
async function configuredModelAfterStop(sessionId: string, transcriptPath: string): Promise<unknown> {
  const pass = await openMainTranscriptPass(sessionId, transcriptPath, 'Stop', forcedEnvCheck);
  await pass.finalize(true);
  return pass.events.find((e) => e.type === 'agent.session.env')?.configured_model;
}

describe('api-request-blob lines', () => {
  const blob = (role: string, content: unknown): string =>
    JSON.stringify({ type: 'api-request-blob', sessionId: 'blob-session', hash: 'h', message: { role, content } });
  const typed = (type: 'user' | 'assistant', uuid: string, content: unknown): string =>
    JSON.stringify({
      type,
      uuid,
      gitBranch: 'feature',
      cwd: '/repo',
      timestamp: '2026-10-01T00:00:00.000Z',
      message: { role: type, content },
    });
  const asAssistant = (line: string): string => JSON.stringify({ type: 'assistant', ...JSON.parse(line) });
  const boundary = JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    timestamp: '2026-10-01T00:10:00.000Z',
    compactMetadata: { trigger: 'manual', preTokens: 1000, postTokens: 300, durationMs: 1000 },
  });

  const skillUse = { type: 'tool_use', id: 'toolu_skill', name: 'Skill', input: { skill: 'probe-skill' } };
  const skillResult = { type: 'tool_result', tool_use_id: 'toolu_skill', content: 'Launching skill: probe-skill' };
  const u1 = typed('user', 'u1', commandText('probe-skill'));
  const a1 = typed('assistant', 'a1', [{ type: 'text', text: 'ok' }]);
  const u2 = typed('user', 'u2', commandText('probe-cmd'));
  const a2 = typed('assistant', 'a2', [skillUse]);
  const u3 = typed('user', 'u3', [skillResult]);
  const head = [
    u1,
    blob('user', commandText('probe-skill')),
    a1,
    u2,
    blob('user', commandText('probe-cmd')),
    a2,
    blob('assistant', [skillUse]),
    u3,
    blob('user', [skillResult]),
  ];

  const summaryOf = (events: ForwardedEvent[]): ForwardedEvent => {
    const summary = events.find((e) => e.type === 'agent.session.summary');
    if (!summary) throw new Error('missing agent.session.summary');
    return summary;
  };

  it('counts each slash command, Skill call and tool result once on the Stop summary', async () => {
    const transcriptPath = writeTranscript('transcript-blob-main.jsonl', head);

    const summary = summaryOf(await mainEvents('session-blob-main', transcriptPath, 'Stop'));

    expect(summary.commands).toEqual(['probe-skill', 'probe-cmd']);
    expect(summary.skills).toEqual({ 'probe-skill': 1 });
    expect(summary.tool_calls).toBe(1);
    expect(summary.tool_results).toBe(1);
  });

  it('keeps the first copy of head lines re-written with the same uuid after a compaction', async () => {
    const transcriptPath = writeTranscript('transcript-blob-rewrite.jsonl', [...head, boundary, u1, a1, a2, u3]);

    const summary = summaryOf(await mainEvents('session-blob-rewrite', transcriptPath, 'Stop'));

    expect(summary.commands).toEqual(['probe-skill', 'probe-cmd']);
    expect(summary.primary_command).toBe('probe-skill');
    expect(summary.skills).toEqual({ 'probe-skill': 1 });
    expect(summary.tool_calls).toBe(1);
    expect(summary.tool_results).toBe(1);
  });

  it('skips re-written head lines arriving in a later incremental pass', async () => {
    const sessionId = 'session-blob-incremental';
    const first = userLine('first prompt', { uuid: 'p1' });
    const invoke = asAssistant(skillAwareLine({ uuid: 'r1', messageId: 'msg-1', outputTokens: 10, skill: 'probe-skill' }));
    const transcriptPath = writeTranscript('transcript-blob-incremental.jsonl', [
      first,
      invoke,
      asAssistant(skillAwareLine({ uuid: 'r2', messageId: 'msg-2', outputTokens: 20 })),
    ]);
    await mainEvents(sessionId, transcriptPath, 'Stop');

    appendFileSync(
      transcriptPath,
      [
        boundary,
        userLine('second prompt', { uuid: 'p2' }),
        first,
        invoke,
        asAssistant(skillAwareLine({ uuid: 'r3', messageId: 'msg-3', outputTokens: 30 })),
      ].map((l) => l + '\n').join(''),
      'utf-8'
    );
    const events = await mainEvents(sessionId, transcriptPath, 'Stop');

    expect(summaryOf(events).branch_counts).toEqual({ feature: 2 });
    const usage = events.filter((e) => e.type === 'agent.usage.request');
    expect(usage.map((e) => e.message_id)).toEqual(['msg-3']);
    expect(usage[0]).toMatchObject({ scope_kind: 'main', scope_name: '' });
  });

  it('leaves the summary unchanged on a second Stop pass with no new bytes', async () => {
    const sessionId = 'session-blob-noop';
    const transcriptPath = writeTranscript('transcript-blob-noop.jsonl', [...head, boundary, u1]);
    const first = summaryOf(await mainEvents(sessionId, transcriptPath, 'Stop'));

    const second = summaryOf(await mainEvents(sessionId, transcriptPath, 'Stop'));

    expect(first.commands).toEqual(['probe-skill', 'probe-cmd']);
    expect(first.branch_counts).toEqual({ feature: 3 });
    for (const field of ['commands', 'skills', 'tool_calls', 'tool_results', 'branch_counts']) {
      expect(second[field]).toEqual(first[field]);
    }
  });

  describe('a parse state saved before seenMessageUuids existed', () => {
    const headUser = userLine('first prompt', { uuid: 'u1' });
    const headSkill = asAssistant(
      skillAwareLine({ uuid: 'a1', messageId: 'msg-1', outputTokens: 10, skill: 'probe-skill' })
    );
    const tail = [
      boundary,
      headUser,
      headSkill,
      userLine('second prompt', { uuid: 'u2' }),
      asAssistant(skillAwareLine({ uuid: 'a2', messageId: 'msg-2', outputTokens: 20 })),
    ];

    it('seeds the seen uuids from the bytes before mainOffset', async () => {
      const { loadParseState, saveParseState } = await import('../parse-state.js');
      const sessionId = 'session-blob-legacy-state';
      const transcriptPath = writeTranscript('transcript-blob-legacy-state.jsonl', [headUser, headSkill]);
      await mainEvents(sessionId, transcriptPath, 'Stop');
      const { seenMessageUuids: _dropped, ...legacy } = await loadParseState(sessionId);
      expect(legacy.branchCounts).toEqual({ feature: 1 });
      await saveParseState(sessionId, legacy);
      appendFileSync(transcriptPath, tail.map((l) => l + '\n').join(''), 'utf-8');

      const events = await mainEvents(sessionId, transcriptPath, 'Stop');

      expect(summaryOf(events).branch_counts).toEqual({ feature: 2 });
      const usage = events.filter((e) => e.type === 'agent.usage.request');
      expect(usage.map((e) => e.message_id)).toEqual(['msg-2']);
      expect(usage[0]).toMatchObject({ scope_kind: 'main', scope_name: '' });
    });

    it('does not let a copied Skill call scope the next request as skill', async () => {
      const { loadParseState, saveParseState } = await import('../parse-state.js');
      const sessionId = 'session-blob-legacy-skill';
      const transcriptPath = writeTranscript('transcript-blob-legacy-skill.jsonl', [
        headUser,
        headSkill,
        userLine('third prompt', { uuid: 'u3' }),
        asAssistant(skillAwareLine({ uuid: 'a3', messageId: 'msg-3', outputTokens: 30 })),
      ]);
      await mainEvents(sessionId, transcriptPath, 'Stop');
      const { seenMessageUuids: _dropped, ...legacy } = await loadParseState(sessionId);
      expect(legacy.activeSkill).toBe('');
      await saveParseState(sessionId, legacy);
      const answer = asAssistant(skillAwareLine({ uuid: 'a4', messageId: 'msg-4', outputTokens: 40 }));
      appendFileSync(
        transcriptPath,
        [boundary, headUser, headSkill, answer].map((l) => l + '\n').join(''),
        'utf-8'
      );

      const events = await mainEvents(sessionId, transcriptPath, 'Stop');

      const usage = events.filter((e) => e.type === 'agent.usage.request');
      expect(usage.map((e) => e.message_id)).toEqual(['msg-4']);
      expect(usage[0]).toMatchObject({ scope_kind: 'main', scope_name: '' });
    });

    it('seeds nothing when the transcript is now shorter than mainOffset', async () => {
      const { loadParseState, saveParseState } = await import('../parse-state.js');
      const sessionId = 'session-blob-legacy-shrunk';
      const transcriptPath = writeTranscript('transcript-blob-legacy-shrunk.jsonl', [headUser, headSkill, ...tail]);
      await mainEvents(sessionId, transcriptPath, 'Stop');
      const { seenMessageUuids: _dropped, ...legacy } = await loadParseState(sessionId);
      expect(legacy.branchCounts).toEqual({ feature: 2 });
      await saveParseState(sessionId, legacy);
      writeTranscript('transcript-blob-legacy-shrunk.jsonl', [
        userLine('new prompt', { uuid: 'u-new' }),
        asAssistant(skillAwareLine({ uuid: 'a-new', messageId: 'msg-new', outputTokens: 5 })),
      ]);

      const events = await mainEvents(sessionId, transcriptPath, 'Stop');

      expect(summaryOf(events).branch_counts).toEqual({ feature: 3 });
      const usage = events.filter((e) => e.type === 'agent.usage.request');
      expect(usage.map((e) => e.message_id)).toEqual(['msg-new']);
    });

    it('seeds again on the pass after one that could not read the transcript', async () => {
      const { loadParseState, saveParseState } = await import('../parse-state.js');
      const sessionId = 'session-blob-legacy-missing';
      const transcriptPath = writeTranscript('transcript-blob-legacy-missing.jsonl', [headUser, headSkill]);
      await mainEvents(sessionId, transcriptPath, 'Stop');
      const { seenMessageUuids: _dropped, ...legacy } = await loadParseState(sessionId);
      expect(legacy.branchCounts).toEqual({ feature: 1 });
      await saveParseState(sessionId, legacy);
      rmSync(transcriptPath);

      await mainEvents(sessionId, transcriptPath, 'Stop');

      expect((await loadParseState(sessionId)).seenMessageUuids).toBeUndefined();
      writeTranscript('transcript-blob-legacy-missing.jsonl', [headUser, headSkill, ...tail]);

      const events = await mainEvents(sessionId, transcriptPath, 'Stop');

      expect(summaryOf(events).branch_counts).toEqual({ feature: 2 });
      const usage = events.filter((e) => e.type === 'agent.usage.request');
      expect(usage.map((e) => e.message_id)).toEqual(['msg-2']);
    });

    it('starts from an empty set at mainOffset 0', async () => {
      const { saveParseState, createParseState } = await import('../parse-state.js');
      const sessionId = 'session-blob-legacy-zero';
      await saveParseState(sessionId, createParseState());
      const transcriptPath = writeTranscript('transcript-blob-legacy-zero.jsonl', [headUser, headSkill, ...tail]);

      const events = await mainEvents(sessionId, transcriptPath, 'Stop');

      expect(summaryOf(events).branch_counts).toEqual({ feature: 2 });
      const usage = events.filter((e) => e.type === 'agent.usage.request');
      expect(usage.map((e) => e.message_id)).toEqual(['msg-1', 'msg-2']);
      expect(usage[1]).toMatchObject({ scope_kind: 'main', scope_name: '' });
    });
  });

  it('treats a stored non-array seen-uuid value as empty', async () => {
    const { saveParseState, createParseState } = await import('../parse-state.js');
    const sessionId = 'session-blob-bad-state';
    await saveParseState(sessionId, { ...createParseState(), seenMessageUuids: 42 as unknown as string[] });
    const line = userLine('prompt', { uuid: 'p1' });
    const transcriptPath = writeTranscript('transcript-blob-bad-state.jsonl', [line, line]);

    const summary = summaryOf(await mainEvents(sessionId, transcriptPath, 'Stop'));

    expect(summary.branch_counts).toEqual({ feature: 1 });
  });

  const readUse = { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/repo/a.ts' } };
  const readResult = { type: 'tool_result', tool_use_id: 'toolu_read', content: 'file' };

  const subagentUsageOf = (events: ForwardedEvent[]): ForwardedEvent[] =>
    events.filter((e) => e.type === 'agent.subagent.usage');

  it('counts a subagent tool call once when a blob copies its tool_use', async () => {
    const sessionId = 'session-blob-fork';
    const file = writeSubagentFixture(sessionId, 'fork1', [
      typed('assistant', 's1', [readUse]),
      blob('assistant', [readUse]),
      typed('user', 's2', [readResult]),
      blob('user', [readResult]),
    ]);

    const [usage] = subagentUsageOf(await subagentEvents(sessionId, file));

    expect(usage).toMatchObject({ tool_calls: 1, tool_results: 1 });
  });

  it('treats a subagent file holding only blob lines as empty', async () => {
    const sessionId = 'session-blob-only';
    const file = writeSubagentFixture(sessionId, 'blobs', [blob('assistant', [readUse]), blob('user', [readResult])]);

    expect(subagentUsageOf(await subagentEvents(sessionId, file))).toHaveLength(0);
  });

  it('counts a re-written subagent assistant line once', async () => {
    const sessionId = 'session-blob-sub-rewrite';
    const toolLine = typed('assistant', 's1', [readUse]);
    const file = writeSubagentFixture(sessionId, 'rewrite', [toolLine, typed('user', 's2', [readResult]), toolLine]);

    const [usage] = subagentUsageOf(await subagentEvents(sessionId, file));

    expect(usage).toMatchObject({ tool_calls: 1 });
  });

  it('derives the same agent.usage.request records when blob lines are interleaved', async () => {
    const fixture = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcript-subagent-direct.jsonl'),
      'utf-8'
    ).trimEnd().split('\n');
    const sessionId = 'session-blob-partial';
    const file = writeSubagentFixture(
      sessionId,
      'bg-blob',
      fixture.flatMap((line) => [line, blob('assistant', [{ type: 'text', text: 'copy' }])])
    );

    const events = await subagentEvents(sessionId, file);
    const usage = events.filter((e) => e.type === 'agent.usage.request');
    const byReq = Object.fromEntries(usage.map((e) => [e.request_id, e]));

    expect(usage).toHaveLength(6);
    expect(byReq.req_s1).toMatchObject({ output_tokens: 3, output_tokens_partial: true });
    expect(byReq.req_s2).toMatchObject({ output_tokens: 8, output_tokens_partial: true });
    expect(byReq.req_s3).toMatchObject({ output_tokens: 300, output_tokens_partial: false });
    expect(byReq.req_s4).toMatchObject({ output_tokens: 457, output_tokens_partial: false });
    expect(byReq.req_s5).toMatchObject({ output_tokens: 50, output_tokens_partial: false });
    expect(byReq.req_s6).toMatchObject({ is_api_error: true, output_tokens_partial: false });
  });
});
