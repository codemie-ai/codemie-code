/**
 * OTEL analytics source tests.
 *
 * The OTEL loader reads a flattened otel-events.jsonl (the contract produced by the
 * codemie-claude-otel file sink) and maps native Claude Code events into the same
 * RawSessionData + SessionCostIndex the analytics pipeline consumes — so
 * `codemie analytics --source otel --report` produces the existing HTML (incl. session
 * detail: tools, timeline, skills, turns, title, net lines) from OTEL data.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseOtelJsonl,
  filterApiRequests,
  buildCostIndex,
  buildDispatches,
  lookupTranscriptCwd,
  loadOtelSessions,
  type OtelEvent,
} from '../otel-loader.js';

const FIXTURE = join(__dirname, 'fixtures', 'otel-events.sample.jsonl');
const TEXT = readFileSync(FIXTURE, 'utf-8');

const MAIN = '11111111-1111-1111-1111-111111111111';
const SUB = '22222222-2222-2222-2222-222222222222';

describe('parseOtelJsonl', () => {
  it('parses every JSONL line and skips malformed ones', () => {
    const events = parseOtelJsonl(TEXT + '\n{ not json\n');
    expect(events.length).toBe(18);
    expect(events.filter((e) => e.name === 'api_request')).toHaveLength(5);
  });
});

describe('filterApiRequests', () => {
  const events = parseOtelJsonl(TEXT);
  it('returns only api_request log events', () => {
    expect(filterApiRequests(events)).toHaveLength(5);
  });
  it('filters by user (matches user.email)', () => {
    expect(filterApiRequests(events, { user: 'dev@example.com' })).toHaveLength(5);
    expect(filterApiRequests(events, { user: 'nobody@x.io' })).toHaveLength(0);
  });
  it('filters by time window', () => {
    const since = new Date('2026-06-19T10:02:30.000Z');
    expect(filterApiRequests(events, { since })).toHaveLength(2);
  });
});

describe('buildCostIndex', () => {
  const { index, summary } = buildCostIndex(filterApiRequests(parseOtelJsonl(TEXT)));
  it('splits cost per session and totals correctly', () => {
    expect(index.size).toBe(2);
    expect(index.get(MAIN)!.costUSD).toBeCloseTo(0.0545, 6);
    expect(index.get(SUB)!.costUSD).toBeCloseTo(0.035, 6);
    expect(summary.totalCostUSD).toBeCloseTo(0.0895, 6);
    expect(summary.totalSessions).toBe(2);
  });
  it('sums token usage per session', () => {
    const m = index.get(MAIN)!.tokens;
    expect(m.input).toBe(2800);
    expect(m.output).toBe(1800);
    expect(m.cacheRead).toBe(54000);
    expect(m.cacheCreation).toBe(2000);
    expect(m.total).toBe(60600);
  });
  it('merges bedrock + native model spellings (normalization)', () => {
    // SUB used claude-sonnet-4-6 AND converse/eu.anthropic.claude-sonnet-4-6-v1:0
    const models = index.get(SUB)!.perModel.map((p) => p.model);
    expect(models).toEqual(['claude-sonnet-4-6']);
  });
});

describe('buildDispatches', () => {
  it('emits agent + skill dispatches (agent spans completion − duration)', () => {
    const mainEvents = parseOtelJsonl(TEXT).filter((e) => (e.attrs['session.id'] as string) === MAIN);
    const d = buildDispatches(mainEvents);
    // agent completes @10:01:00 with 120s duration → starts @09:59:00, before the skill @10:00:10
    expect(d.map((x) => x.kind)).toEqual(['agent', 'skill']);
    const agent = d.find((x) => x.kind === 'agent')!;
    expect(agent.name).toBe('tech-analyst');
    expect(agent.durationMs).toBe(120000);
    // no agent:* api_requests in MAIN's window → falls back to subagent_completed total_tokens
    expect(agent.tokens?.total).toBe(5000);
  });

  it('recovers dispatch cost + tokens from windowed agent:* api_requests', () => {
    const ev = (name: string, ts: string, extra: Record<string, unknown>): OtelEvent => ({
      _type: 'log',
      ts,
      name,
      attrs: { 'session.id': 'S', 'event.name': name, ...extra },
      resource: {},
    });
    const dispatches = buildDispatches([
      ev('subagent_completed', '2026-06-19T10:05:00.000Z', { agent_type: 'Explore', duration_ms: 200000, total_tokens: 999 }),
      // two subagent calls inside [10:01:40, 10:05:00]
      ev('api_request', '2026-06-19T10:02:00.000Z', { query_source: 'agent:builtin:Explore', cost_usd: 0.5, input_tokens: 100, output_tokens: 50 }),
      ev('api_request', '2026-06-19T10:04:00.000Z', { query_source: 'agent:builtin:Explore', cost_usd: 0.5, input_tokens: 200, output_tokens: 80 }),
      // a main call outside the agent attribution
      ev('api_request', '2026-06-19T10:03:00.000Z', { query_source: 'repl_main_thread', cost_usd: 9.9, input_tokens: 1 }),
    ]);
    const agent = dispatches.find((x) => x.kind === 'agent')!;
    expect(agent.costUSD).toBeCloseTo(1.0, 6); // windowed agent calls only, not the $9.9 main call
    expect(agent.tokens?.total).toBe(430); // 100+50+200+80
  });

  it('attributes each request to the narrowest containing window when subagent windows overlap', () => {
    const ev = (name: string, ts: string, extra: Record<string, unknown>): OtelEvent => ({
      _type: 'log',
      ts,
      name,
      attrs: { 'session.id': 'S', 'event.name': name, ...extra },
      resource: {},
    });
    const dispatches = buildDispatches([
      // WIDE window: [10:00:00, 10:02:00] (duration 120000ms).
      ev('subagent_completed', '2026-06-19T10:02:00.000Z', { agent_type: 'wide-agent', duration_ms: 120000 }),
      // NARROW window nested inside the wide one: [10:00:20, 10:01:00] (duration 40000ms).
      ev('subagent_completed', '2026-06-19T10:01:00.000Z', { agent_type: 'narrow-agent', duration_ms: 40000 }),
      // Falls inside BOTH windows — must go to the NARROW one, not "wide" just because wide's
      // subagent_completed event happens to be processed after narrow's in this event list.
      ev('api_request', '2026-06-19T10:00:30.000Z', { query_source: 'agent:narrow-agent', cost_usd: 0.7, input_tokens: 100 }),
      // Falls ONLY inside the wide window (after narrow's window has already ended).
      ev('api_request', '2026-06-19T10:01:30.000Z', { query_source: 'agent:wide-agent', cost_usd: 0.3, input_tokens: 50 }),
    ]);

    const narrow = dispatches.find((d) => d.name === 'narrow-agent')!;
    const wide = dispatches.find((d) => d.name === 'wide-agent')!;
    expect(narrow.costUSD).toBeCloseTo(0.7, 6);
    expect(narrow.tokens?.input).toBe(100);
    expect(wide.costUSD).toBeCloseTo(0.3, 6);
    expect(wide.tokens?.input).toBe(50);
  });

  it('attributes real cost + duration to skills via api_request.skill.name', () => {
    const ev = (name: string, ts: string, extra: Record<string, unknown>): OtelEvent => ({
      _type: 'log',
      ts,
      name,
      attrs: { 'session.id': 'S', 'event.name': name, ...extra },
      resource: {},
    });
    const dispatches = buildDispatches([
      ev('skill_activated', '2026-06-19T10:00:00.000Z', { 'skill.name': 'code-review' }),
      ev('api_request', '2026-06-19T10:00:05.000Z', { 'skill.name': 'code-review', cost_usd: 0.20, input_tokens: 100, output_tokens: 50, duration_ms: 3000 }),
      ev('api_request', '2026-06-19T10:00:10.000Z', { 'skill.name': 'code-review', cost_usd: 0.30, input_tokens: 200, output_tokens: 80, duration_ms: 2000 }),
      // unrelated request (different skill) must not be attributed:
      ev('api_request', '2026-06-19T10:00:07.000Z', { 'skill.name': 'other', cost_usd: 9.9, input_tokens: 1 }),
    ]);
    const skill = dispatches.find((x) => x.kind === 'skill')!;
    expect(skill.name).toBe('code-review');
    expect(skill.costUSD).toBeCloseTo(0.5, 6);       // 0.20 + 0.30, not the $9.9 "other"
    expect(skill.tokens?.total).toBe(430);            // 100+50+200+80
    expect(skill.durationMs).toBe(12000);             // last(10:00:10 + 2000ms) − start(10:00:00)
  });
});

describe('lookupTranscriptCwd', () => {
  it('recovers cwd + branch from a Claude Code transcript', () => {
    const projects = mkdtempSync(join(tmpdir(), 'cc-projects-'));
    const dir = join(projects, '-Users-dev-my-repo');
    mkdirSync(dir);
    const sid = 'aaaa1111-bbbb-2222-cccc-3333dddd4444';
    writeFileSync(
      join(dir, `${sid}.jsonl`),
      [JSON.stringify({ type: 'summary', sessionId: sid }), JSON.stringify({ type: 'user', cwd: '/Users/dev/my-repo', gitBranch: 'develop', sessionId: sid })].join('\n')
    );
    const info = lookupTranscriptCwd(sid, projects);
    expect(info).toEqual({ cwd: '/Users/dev/my-repo', branch: 'develop' });
    expect(lookupTranscriptCwd('no-such-session', projects)).toBeUndefined();
  });
});

describe('loadOtelSessions (full session detail)', () => {
  // Inject a no-op transcript lookup so the test exercises the plugin session.start
  // fallback deterministically (no dependency on the real ~/.claude/projects).
  const { rawSessions, costIndex } = loadOtelSessions({ file: FIXTURE, cwdLookup: () => undefined });
  const main = rawSessions.find((r) => r.sessionId === MAIN)!;
  const sub = rawSessions.find((r) => r.sessionId === SUB)!;

  it('produces one RawSessionData per owned session', () => {
    expect(rawSessions).toHaveLength(2);
  });

  it('derives turns from user_prompt events (one delta per prompt)', () => {
    expect(main.deltas).toHaveLength(2); // P1, P2
    expect(sub.deltas).toHaveLength(1); // P3
  });

  it('extracts the session title from the first prompt', () => {
    expect(main.deltas[0].userPrompts?.[0].text).toBe('Build the analytics loader');
  });

  it('aggregates tool calls with success/failure', () => {
    const t = main.deltas[0];
    expect(t.tools).toEqual({ Edit: 2, Bash: 1, Read: 1 });
    expect(t.toolStatus!.Edit).toEqual({ success: 2, failure: 0 });
    expect(t.toolStatus!.Read).toEqual({ success: 0, failure: 1 });
  });

  it('captures agent + skill invocations', () => {
    expect(main.deltas[0].agentInvocations).toEqual({ 'tech-analyst': 1 });
    expect(main.deltas[0].skillInvocations).toEqual({ 'superpowers:brainstorming': 1 });
  });

  it('recovers net lines from lines_of_code events', () => {
    expect(main.deltas[0].fileOperations).toEqual([{ type: 'edit', path: '<otel:aggregate>', linesAdded: 120, linesRemoved: 30 }]);
  });

  it('recovers project (cwd) and git branch from the plugin session.start join', () => {
    expect(main.startEvent!.data.workingDirectory).toBe('/Users/dev/projects/codemie-code');
    expect(main.deltas[0].gitBranch).toBe('feature/analytics-otel-source');
  });

  it('falls back to the project label when no plugin cwd is present', () => {
    expect(sub.startEvent!.data.workingDirectory).toBe('Unknown'); // SUB has no session.start event
  });

  it('attaches Timeline dispatches to the cost index', () => {
    expect(costIndex.get(MAIN)!.dispatches).toHaveLength(2);
    expect(costIndex.get(SUB)!.dispatches).toBeUndefined(); // SUB has no agent/skill events
  });
});
