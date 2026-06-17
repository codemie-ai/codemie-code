/**
 * Unit tests for named invocation extraction in the Claude MetricsProcessor.
 * Tests the skill/agent/command extraction logic via the full process() path
 * using a temp CODEMIE_HOME directory (mirrors codex.metrics-processor.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(),
  },
}));

vi.mock('../../../../../utils/security.js', () => ({
  sanitizeLogArgs: (...args: unknown[]) => args,
}));

const SESSION_ID = 'test-session-names';
const AGENT_SESSION_ID = 'agent-session-names';

function makeToolUseMsg(id: string, name: string, input: Record<string, unknown>) {
  return {
    uuid: id,
    type: 'assistant',
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id: `tool-${id}`, name, input }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
    },
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
  };
}

function makeToolResultMsg(toolId: string, isError = false) {
  return {
    uuid: `result-${toolId}`,
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `tool-${toolId}`, content: 'ok', is_error: isError }],
    },
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
  };
}

function makeUserMsg(id: string, text: string) {
  return {
    uuid: id,
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
  };
}

describe('MetricsProcessor — named invocation extraction', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'claude-names-test-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;

    // Pre-create the session record so SessionStore.loadSession returns metadata.
    const sessionsDir = join(tempHome, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${SESSION_ID}.json`),
      JSON.stringify({
        sessionId: SESSION_ID,
        agentName: 'claude',
        provider: 'ai-run-sso',
        startTime: Date.now(),
        workingDirectory: '/tmp/work',
        status: 'active',
        activeDurationMs: 0,
        sync: { metrics: { processedRecordIds: [] } },
      })
    );

    vi.resetModules();
  });

  afterEach(() => {
    // Windows deletes files asynchronously, so a recursive rmSync can hit ENOTEMPTY/EBUSY right
    // after removing children (force only suppresses ENOENT). Retry, and treat cleanup as
    // best-effort — the OS reclaims the temp dir and a teardown failure must not fail the suite.
    try {
      rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* ignore temp-dir cleanup races */
    }
    if (originalCodemieHome !== undefined) {
      process.env.CODEMIE_HOME = originalCodemieHome;
    } else {
      delete process.env.CODEMIE_HOME;
    }
  });

  function buildSession(messages: unknown[]) {
    return {
      sessionId: SESSION_ID,
      agentName: 'claude',
      agentSessionId: AGENT_SESSION_ID,
      messages,
    } as unknown as import('../../../../core/session/BaseSessionAdapter.js').ParsedSession;
  }

  async function runProcessor(messages: unknown[]) {
    const { MetricsProcessor } = await import('../claude.metrics-processor.js');
    const session = buildSession(messages);
    await new MetricsProcessor().process(session, {} as never);

    // Read the written deltas from the JSONL file
    const metricsPath = join(tempHome, 'sessions', `${SESSION_ID}_metrics.jsonl`);
    if (!existsSync(metricsPath)) {
      return [];
    }
    return readFileSync(metricsPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it('extracts skill name from Skill tool_use block', async () => {
    const msgs = [
      makeUserMsg('u1', 'invoke a skill'),
      makeToolUseMsg('t1', 'Skill', { skill: 'codemie:msgraph', args: 'get calendar' }),
      makeToolResultMsg('t1'),
    ];
    const deltas = await runProcessor(msgs);
    expect(deltas.length).toBeGreaterThan(0);
    const delta = deltas[0] as Record<string, unknown>;
    expect(delta.skillInvocations).toEqual({ 'codemie:msgraph': 1 });
  });

  it('extracts agent subtype from Task tool_use block', async () => {
    const msgs = [
      makeUserMsg('u2', 'run an agent'),
      makeToolUseMsg('t2', 'Task', { subagent_type: 'Explore', description: 'find files' }),
      makeToolResultMsg('t2'),
    ];
    const deltas = await runProcessor(msgs);
    expect(deltas.length).toBeGreaterThan(0);
    const delta = deltas[0] as Record<string, unknown>;
    expect(delta.agentInvocations).toEqual({ 'Explore': 1 });
  });

  it('extracts slash command from a genuine CLI command wrapper in a user message', async () => {
    const msgs = [
      makeUserMsg('u3', '<command-name>/tech-lead</command-name>\n<command-message>tech-lead</command-message>\n<command-args>go</command-args>'),
      makeToolUseMsg('t3', 'Bash', { command: 'ls' }),
      makeToolResultMsg('t3'),
    ];
    const deltas = await runProcessor(msgs);
    expect(deltas.length).toBeGreaterThan(0);
    const delta = deltas[0] as Record<string, unknown>;
    expect(delta.commandInvocations).toEqual({ 'tech-lead': 1 });
  });

  it('does NOT extract <command-name> mentions that lack the command-message sibling (prose)', async () => {
    const msgs = [
      makeUserMsg('u5', 'docs say slash commands look like <command-name>/cmd-name</command-name> in text'),
      makeToolUseMsg('t5', 'Bash', { command: 'ls' }),
      makeToolResultMsg('t5'),
    ];
    const deltas = await runProcessor(msgs);
    const delta = deltas[0] as Record<string, unknown>;
    expect(delta.commandInvocations).toBeUndefined();
  });

  it('omits skillInvocations when no Skill tools were used', async () => {
    const msgs = [
      makeUserMsg('u4', 'just bash'),
      makeToolUseMsg('t4', 'Bash', { command: 'pwd' }),
      makeToolResultMsg('t4'),
    ];
    const deltas = await runProcessor(msgs);
    expect(deltas.length).toBeGreaterThan(0);
    const delta = deltas[0] as Record<string, unknown>;
    expect(delta.skillInvocations).toBeUndefined();
  });

  it('attaches session-wide named invocations to the FIRST delta only (dedup invariant)', async () => {
    // Two assistant message-id groups → two deltas. Named invocations are session-wide and must
    // land on exactly ONE delta, or the aggregator (which sums across deltas) inflates the counts.
    const msgs = [
      makeUserMsg('u1', 'do two things'),
      makeToolUseMsg('t1', 'Skill', { skill: 'codemie:msgraph', args: 'x' }),
      makeToolResultMsg('t1'),
      makeToolUseMsg('t2', 'Bash', { command: 'ls' }),
      makeToolResultMsg('t2'),
    ];
    const deltas = await runProcessor(msgs);
    expect(deltas.length).toBe(2);
    expect((deltas[0] as Record<string, unknown>).skillInvocations).toEqual({ 'codemie:msgraph': 1 });
    // The second delta must NOT repeat the session-wide count.
    expect((deltas[1] as Record<string, unknown>).skillInvocations).toBeUndefined();
  });
});
