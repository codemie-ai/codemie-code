/**
 * Tests for the `agent.subagent.usage` builder: `findSubagentFiles`, `readSubagentMeta`,
 * `buildUsageTotals`, and `buildSubagentUsageEvent`.
 *
 * Fixture layout, built fresh per test under a temp dir:
 *   <tmpDir>/<sessionId>.jsonl                           — trivial main-transcript placeholder
 *   <tmpDir>/<sessionId>/subagents/agent-<id>.jsonl       — one subagent transcript per fixture
 *   <tmpDir>/<sessionId>/subagents/agent-<id>.meta.json   — sidecar (toolUseId/agentType/spawnDepth/description)
 *
 * Three subagents are used throughout:
 *   - "a1": sidecar OMITS spawnDepth (top-level subagent — spawn_depth must default to 0),
 *     two usage-bearing transcript lines (exercises summing across >1 request).
 *   - "a2": sidecar INCLUDES spawnDepth: 2 (nested subagent — pass-through), one usage line.
 *   - "a3": sidecar includes toolUseId/agentType/description, one usage line.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSubagentFiles,
  readSubagentMeta,
  buildUsageTotals,
  buildSubagentUsageEvent,
  type SubagentFile,
} from '../subagent-usage.js';
import { parseUsageLine, buildUsageRequestEvent } from '../usage-request.js';
import type { OpenUsageRequest } from '../parse-state.js';

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

/** Build one transcript JSONL usage line, mirroring the confirmed transcript shape. */
function usageLine(messageId: string, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    sessionId: 'session-subagent-1',
    gitBranch: 'main',
    cwd: '/repo',
    timestamp: '2026-10-01T00:00:00.000Z',
    version: '1.2.3',
    entrypoint: 'cli',
    uuid: `uuid-${messageId}`,
    parentUuid: null,
    isSidechain: true,
    userType: 'external',
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
        service_tier: 'standard',
        speed: 'standard',
        inference_geo: '',
        cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 1 },
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        iterations: [],
      },
    },
  });
}

interface FixtureMeta {
  toolUseId?: string;
  agentType?: string;
  spawnDepth?: number;
  description?: string;
}

async function buildFixture(
  sessionId: string,
  subagents: Record<string, { lines: string[]; meta: FixtureMeta }>
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codemie-subagent-usage-'));
  const mainTranscriptPath = join(dir, `${sessionId}.jsonl`);
  await writeFile(mainTranscriptPath, '');

  const subagentsDir = join(dir, sessionId, 'subagents');
  await mkdir(subagentsDir, { recursive: true });

  for (const [agentId, { lines, meta }] of Object.entries(subagents)) {
    await writeFile(join(subagentsDir, `agent-${agentId}.jsonl`), `${lines.join('\n')}\n`);
    await writeFile(join(subagentsDir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  }

  return mainTranscriptPath;
}

function usageRequest(overrides: Partial<OpenUsageRequest> = {}): OpenUsageRequest {
  return {
    requestId: 'r1', messageId: 'm1', model: 'm', modelRaw: 'm-raw', timestamp: 't1',
    speed: 'standard', inferenceGeo: '', serviceTier: 'standard',
    inputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
    cacheReadTokens: 0, outputTokens: 0, webSearchRequests: 0, webFetchRequests: 0,
    scopeKind: 'agent', scopeName: '', agentId: 'a1',
    stopReason: 'end_turn', isApiError: false, gitBranch: 'main',
    ...overrides,
  };
}

describe('findSubagentFiles', () => {
  it('discovers all subagent files with their sidecar fields, defaulting spawnDepth to undefined when the sidecar omits it', async () => {
    const sessionId = 'session-subagent-1';
    const mainTranscriptPath = await buildFixture(sessionId, {
      a1: { lines: [usageLine('msg-a1-1', 100, 50)], meta: { toolUseId: 'tool-a1' } },
      a2: { lines: [usageLine('msg-a2-1', 10, 5)], meta: { agentType: 'reviewer', spawnDepth: 2 } },
      a3: {
        lines: [usageLine('msg-a3-1', 7, 3)],
        meta: { toolUseId: 'tool-a3', agentType: 'coder', description: 'Fix the bug' },
      },
    });
    tmpDir = join(mainTranscriptPath, '..');

    const files = await findSubagentFiles(mainTranscriptPath);

    expect(files).toHaveLength(3);

    const byId = (id: string): SubagentFile => {
      const found = files.find((f) => f.agentId === id);
      if (!found) throw new Error(`fixture missing ${id}`);
      return found;
    };

    const a1 = byId('a1');
    expect(a1.toolUseId).toBe('tool-a1');
    expect(a1.agentType).toBeUndefined();
    expect(a1.spawnDepth).toBeUndefined();
    expect(a1.description).toBeUndefined();

    const a2 = byId('a2');
    expect(a2.agentType).toBe('reviewer');
    expect(a2.spawnDepth).toBe(2);
    expect(a2.toolUseId).toBeUndefined();

    const a3 = byId('a3');
    expect(a3.toolUseId).toBe('tool-a3');
    expect(a3.agentType).toBe('coder');
    expect(a3.description).toBe('Fix the bug');
    expect(a3.spawnDepth).toBeUndefined();
  });

  it('returns [] when the subagents directory does not exist, without throwing', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codemie-subagent-usage-empty-'));
    const mainTranscriptPath = join(tmpDir, 'session-empty.jsonl');
    await writeFile(mainTranscriptPath, '');

    const files = await findSubagentFiles(mainTranscriptPath);

    expect(files).toEqual([]);
  });

  it('returns [] for a missing main transcript path, without throwing', async () => {
    const files = await findSubagentFiles('C:/nonexistent/path/session-missing.jsonl');
    expect(files).toEqual([]);
  });
});

describe('readSubagentMeta', () => {
  it('reads toolUseId/agentType/spawnDepth/description from the sidecar next to a given .jsonl path', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codemie-subagent-meta-'));
    const jsonlPath = join(tmpDir, 'agent-x1.jsonl');
    await writeFile(jsonlPath, '');
    await writeFile(
      join(tmpDir, 'agent-x1.meta.json'),
      JSON.stringify({ toolUseId: 'tool-x1', agentType: 'explore', spawnDepth: 1, description: 'Investigate' })
    );

    const meta = await readSubagentMeta(jsonlPath);

    expect(meta).toEqual({ toolUseId: 'tool-x1', agentType: 'explore', spawnDepth: 1, description: 'Investigate' });
  });

  it('resolves to {} when the sidecar is missing, without throwing', async () => {
    const meta = await readSubagentMeta('C:/nonexistent/agent-ghost.jsonl');
    expect(meta).toEqual({});
  });
});

describe('buildUsageTotals', () => {
  it('sums token/call fields per (model, speed, inference_geo, service_tier, scope_kind, scope_name) group', () => {
    const reqs: OpenUsageRequest[] = [
      usageRequest({ model: 'claude-haiku-4-5', inputTokens: 900, outputTokens: 2100 }),
      usageRequest({ model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 400 }),
      usageRequest({ model: 'claude-opus-5-5', speed: 'fast', inputTokens: 50, outputTokens: 10 }),
    ];

    const totals = buildUsageTotals(reqs);

    expect(totals).toHaveLength(2);
    const haiku = totals.find((t) => t.model === 'claude-haiku-4-5');
    expect(haiku).toMatchObject({ input_tokens: 1000, output_tokens: 2500, api_calls: 2 });
    const opus = totals.find((t) => t.model === 'claude-opus-5-5');
    expect(opus).toMatchObject({ speed: 'fast', input_tokens: 50, output_tokens: 10, api_calls: 1 });
  });

  it('returns [] for no usage requests', () => {
    expect(buildUsageTotals([])).toEqual([]);
  });
});

describe('buildSubagentUsageEvent', () => {
  it('groups usageRequests into usage[], sums tool maps into flat totals plus a tools breakdown, and passes skills through verbatim', () => {
    const file: SubagentFile = { agentId: 'a1', filePath: '/tmp/agent-a1.jsonl', toolUseId: 'tool-a1' };
    const reqs: OpenUsageRequest[] = [
      usageRequest({
        requestId: 'r1', inputTokens: 100, cacheCreation5mTokens: 1, cacheCreation1hTokens: 2,
        cacheReadTokens: 3, outputTokens: 50, webSearchRequests: 1, webFetchRequests: 0,
      }),
      usageRequest({
        requestId: 'r2', inputTokens: 10, cacheCreation5mTokens: 4, cacheCreation1hTokens: 0,
        cacheReadTokens: 1, outputTokens: 5, webSearchRequests: 0, webFetchRequests: 2,
        stopReason: 'tool_use',
      }),
    ];
    const toolCalls = { Read: 3, Edit: 1 };
    const toolErrors = { Edit: 1 };
    const skills = { brainstorming: 1 };

    const event = buildSubagentUsageEvent(
      'session-1', file, reqs, toolCalls, toolErrors, 4, skills, '2026-10-01T00:00:00.000Z', '2026-10-01T00:05:00.000Z', 1500
    );

    expect(event).toEqual({
      type: 'agent.subagent.usage',
      session_id: 'session-1',
      agent_id: 'a1',
      tool_use_id: 'tool-a1',
      agent_type: '',
      description: '',
      workflow_run: '',
      spawn_depth: 0,
      worktree: '',
      started_at: '2026-10-01T00:00:00.000Z',
      ended_at: '2026-10-01T00:05:00.000Z',
      duration_ms: 1500,
      model: 'm',
      api_calls: 2,
      tool_calls: 4,
      tool_results: 4,
      tool_errors: 1,
      tools: { Read: { calls: 3, errors: 0 }, Edit: { calls: 1, errors: 1 } },
      skills,
      commands: [],
      compactions: [],
      usage: [
        {
          model: 'm', model_raw: 'm-raw', speed: 'standard', inference_geo: '', service_tier: 'standard',
          scope_kind: 'agent', scope_name: '',
          input_tokens: 110, cache_creation_5m_tokens: 5, cache_creation_1h_tokens: 2, cache_read_tokens: 4,
          output_tokens: 55, web_search_requests: 1, web_fetch_requests: 2, api_calls: 2,
        },
      ],
    });
  });

  it('passes a present spawn_depth through verbatim instead of defaulting to 0, and sources description from the sidecar-derived file field', () => {
    const file: SubagentFile = { agentId: 'a2', filePath: '/tmp/agent-a2.jsonl', spawnDepth: 2, description: 'Review the diff' };

    const event = buildSubagentUsageEvent('session-1', file, [], {}, {}, 0, {}, '', '', 0);

    expect(event.spawn_depth).toBe(2);
    expect(event.description).toBe('Review the diff');
    expect(event.api_calls).toBe(0);
    expect(event.usage).toEqual([]);
  });

  it('never fabricates agent_type/description/workflow_run/worktree — always empty string when absent', () => {
    const file: SubagentFile = { agentId: 'a3', filePath: '/tmp/agent-a3.jsonl' };

    const event = buildSubagentUsageEvent('session-1', file, [], {}, {}, 0, {}, '', '', 0);

    expect(event.agent_type).toBe('');
    expect(event.description).toBe('');
    expect(event.workflow_run).toBe('');
    expect(event.worktree).toBe('');
  });

  it('picks the usage[] row with the most api_calls as the top-level model', () => {
    const file: SubagentFile = { agentId: 'a1', filePath: '/tmp/agent-a1.jsonl' };
    const reqs: OpenUsageRequest[] = [
      usageRequest({ model: 'claude-haiku-4-5', requestId: 'r1' }),
      usageRequest({ model: 'claude-opus-5-5', requestId: 'r2' }),
      usageRequest({ model: 'claude-opus-5-5', requestId: 'r3' }),
    ];

    const event = buildSubagentUsageEvent('session-1', file, reqs, {}, {}, 0, {}, '', '', 0);

    expect(event.model).toBe('claude-opus-5-5');
  });
});

describe('cross-check: agent.subagent.usage usage[] totals vs agent.usage.request (scope_kind: agent)', () => {
  it('summing usage[] token fields across three agent.subagent.usage events equals summing the same fields across every agent.usage.request record derived from the same fixture', async () => {
    const sessionId = 'session-subagent-cross';
    const mainTranscriptPath = await buildFixture(sessionId, {
      a1: {
        lines: [usageLine('msg-a1-1', 100, 50), usageLine('msg-a1-2', 10, 5)],
        meta: { toolUseId: 'tool-a1' },
      },
      a2: {
        lines: [usageLine('msg-a2-1', 200, 80)],
        meta: { agentType: 'reviewer', spawnDepth: 2 },
      },
      a3: {
        lines: [usageLine('msg-a3-1', 30, 15)],
        meta: { toolUseId: 'tool-a3', agentType: 'coder' },
      },
    });
    tmpDir = join(mainTranscriptPath, '..');

    const files = await findSubagentFiles(mainTranscriptPath);
    expect(files).toHaveLength(3);

    const subagentUsageEvents: Array<Record<string, unknown>> = [];
    const usageRequestEvents: Array<Record<string, unknown>> = [];

    for (const file of files) {
      const raw = await import('node:fs/promises').then((m) => m.readFile(file.filePath, 'utf-8'));
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);

      const reqs: OpenUsageRequest[] = lines
        .map((line) => parseUsageLine(line, 'agent', '', file.agentId))
        .filter((r): r is OpenUsageRequest => r !== null);

      expect(reqs.length).toBeGreaterThan(0);
      reqs.forEach((r) => expect(r.scopeKind).toBe('agent'));

      subagentUsageEvents.push(
        buildSubagentUsageEvent(sessionId, file, reqs, {}, {}, 0, {}, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 0)
      );

      for (const req of reqs) {
        usageRequestEvents.push(buildUsageRequestEvent(sessionId, req));
      }
    }

    expect(subagentUsageEvents).toHaveLength(3);
    // 2 + 1 + 1 usage-bearing lines across the three subagent transcripts.
    expect(usageRequestEvents).toHaveLength(4);
    usageRequestEvents.forEach((e) => expect(e.scope_kind).toBe('agent'));

    const sumUsageField = (records: Array<Record<string, unknown>>, field: string): number =>
      records.reduce((total, r) => {
        const usage = r.usage as Array<Record<string, unknown>>;
        return total + usage.reduce((rowTotal, row) => rowTotal + Number(row[field] ?? 0), 0);
      }, 0);

    const sumField = (records: Array<Record<string, unknown>>, field: string): number =>
      records.reduce((total, r) => total + Number(r[field] ?? 0), 0);

    const tokenFieldPairs: Array<[string, string]> = [
      ['input_tokens', 'input_tokens'],
      ['output_tokens', 'output_tokens'],
      ['cache_creation_5m_tokens', 'cache_creation_5m_tokens'],
      ['cache_creation_1h_tokens', 'cache_creation_1h_tokens'],
      ['cache_read_tokens', 'cache_read_tokens'],
      ['web_search_requests', 'web_search_requests'],
      ['web_fetch_requests', 'web_fetch_requests'],
    ];

    for (const [subagentField, requestField] of tokenFieldPairs) {
      expect(sumUsageField(subagentUsageEvents, subagentField)).toBe(sumField(usageRequestEvents, requestField));
    }

    // api_calls across the three subagent.usage events equals the total number of
    // agent.usage.request records derived from the same fixture.
    expect(sumField(subagentUsageEvents, 'api_calls')).toBe(usageRequestEvents.length);

    // Known concrete totals: input 100+10+200+30=340, output 50+5+80+15=150.
    expect(sumUsageField(subagentUsageEvents, 'input_tokens')).toBe(340);
    expect(sumUsageField(subagentUsageEvents, 'output_tokens')).toBe(150);
  });
});
