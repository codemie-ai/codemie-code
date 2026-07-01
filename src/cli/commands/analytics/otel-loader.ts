/**
 * OTEL analytics source.
 *
 * Reads a flattened `otel-events.jsonl` (the contract produced by the
 * codemie-claude-otel file sink / collector fan-out) and maps native Claude Code
 * telemetry into the same {@link RawSessionData} + {@link SessionCostIndex} the rest
 * of the analytics pipeline consumes, so `codemie analytics --source otel` renders the
 * existing HTML report (incl. session detail) from OTEL data instead of local sessions.
 *
 * What each OTEL event contributes:
 *   - api_request        → tokens + cost (authoritative `cost_usd`) + per-model rollup
 *   - tool_result        → per-tool calls / success / failure
 *   - subagent_completed → agent dispatches (Timeline) + agentInvocations
 *   - skill_activated    → skill dispatches (Timeline) + skillInvocations
 *   - user_prompt        → turn count + session title (first prompt)
 *   - lines_of_code.count → net lines added/removed
 *   - claude.session.start (this plugin's own event) → cwd + git branch (Project/Branch)
 *
 * NOTE: native Claude Code emits NO cwd or git branch. Project/Branch are only available
 * for sessions recorded with the codemie-claude-otel plugin active (joined by session id);
 * native-only sessions fall back to "Unknown".
 */

import { readFileSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { RawSessionData, SessionStartEvent, SessionEndEvent } from './data-loader.js';
import type { MetricDelta } from '../../../agents/core/metrics/types.js';
import type {
  SessionCost,
  SessionCostIndex,
  CostSummary,
  TokenUsage,
  ModelCost,
  CostSeriesPoint,
  DispatchEvent,
} from './cost/types.js';
import { MAX_SERIES_POINTS, MAX_DISPATCHES } from './cost/types.js';
import { normalizeModelName } from './model-normalizer.js';

/** One flattened OTEL event line (see the contract in codemie-claude-otel/plugin/README.md). */
export interface OtelEvent {
  _type: 'log' | 'metric';
  ts: string;
  scope?: string;
  name: string;
  attrs: Record<string, unknown>;
  resource: Record<string, unknown>;
  value?: unknown;
  kind?: string;
}

export interface OtelFilter {
  /** Match against native user.email or user.id (goal #3: a particular user). */
  user?: string;
  since?: Date;
  until?: Date;
}

interface CwdInfo {
  cwd?: string;
  branch?: string;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function attr(e: OtelEvent, k: string): unknown {
  return (e.attrs || {})[k];
}

function sessionOf(e: OtelEvent): string {
  return String(attr(e, 'session.id') || attr(e, 'session_id') || '');
}

function userKey(e: OtelEvent): string {
  return String(attr(e, 'user.email') || attr(e, 'user.id') || '');
}

function isApiRequest(e: OtelEvent): boolean {
  return e._type === 'log' && (e.name === 'api_request' || attr(e, 'event.name') === 'api_request');
}

/** Parse flattened JSONL text into events, skipping malformed lines. */
export function parseOtelJsonl(text: string): OtelEvent[] {
  const out: OtelEvent[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as OtelEvent;
      if (e && typeof e === 'object' && e.name) out.push(e);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Select `api_request` log events, optionally filtered by user and time window. */
export function filterApiRequests(events: OtelEvent[], filter: OtelFilter = {}): OtelEvent[] {
  const sinceMs = filter.since ? filter.since.getTime() : -Infinity;
  const untilMs = filter.until ? filter.until.getTime() : Infinity;
  return events.filter((e) => {
    if (!isApiRequest(e)) return false;
    if (filter.user && userKey(e) !== filter.user) return false;
    const ms = Date.parse(e.ts);
    if (Number.isFinite(ms) && (ms < sinceMs || ms > untilMs)) return false;
    return true;
  });
}

function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, total: 0 };
}

function addTokens(t: TokenUsage, e: OtelEvent): void {
  t.input += num(attr(e, 'input_tokens'));
  t.output += num(attr(e, 'output_tokens'));
  t.cacheRead += num(attr(e, 'cache_read_tokens'));
  t.cacheCreation += num(attr(e, 'cache_creation_tokens'));
  t.total = t.input + t.output + t.cacheRead + t.cacheCreation;
}

/** Build the cost index + run summary directly from native api_request events. */
export function buildCostIndex(apiRequests: OtelEvent[]): {
  index: SessionCostIndex;
  summary: CostSummary;
} {
  const index: SessionCostIndex = new Map();
  const perModelMap = new Map<string, Map<string, { tokens: TokenUsage; costUSD: number }>>();
  const seriesPts = new Map<string, Array<{ t: number; cost: number; tokens: number }>>();

  for (const e of apiRequests) {
    const sid = sessionOf(e);
    if (!sid) continue;
    if (!index.has(sid)) {
      index.set(sid, { sessionId: sid, tokens: emptyTokens(), costUSD: 0, perModel: [], priced: true, hadLog: true });
      perModelMap.set(sid, new Map());
      seriesPts.set(sid, []);
    }
    const sc = index.get(sid)!;
    addTokens(sc.tokens, e);
    const cost = num(attr(e, 'cost_usd'));
    sc.costUSD += cost;

    // Normalize so bedrock/converse spellings collapse onto the canonical model.
    const model = normalizeModelName(String(attr(e, 'model') || '(unknown)'));
    const mm = perModelMap.get(sid)!;
    if (!mm.has(model)) mm.set(model, { tokens: emptyTokens(), costUSD: 0 });
    const mc = mm.get(model)!;
    addTokens(mc.tokens, e);
    mc.costUSD += cost;

    const ms = Date.parse(e.ts);
    seriesPts.get(sid)!.push({
      t: Number.isFinite(ms) ? ms : 0,
      cost,
      tokens: num(attr(e, 'input_tokens')) + num(attr(e, 'output_tokens')) + num(attr(e, 'cache_read_tokens')) + num(attr(e, 'cache_creation_tokens')),
    });
  }

  for (const [sid, sc] of index) {
    const mm = perModelMap.get(sid)!;
    sc.perModel = [...mm.entries()]
      .map(([model, r]): ModelCost => ({ model, tokens: r.tokens, costUSD: r.costUSD, unpriced: false }))
      .sort((a, b) => b.costUSD - a.costUSD);
    sc.costSeries = downsampleSeries(seriesPts.get(sid)!);
  }

  const summary: CostSummary = {
    totalCostUSD: [...index.values()].reduce((s, c) => s + c.costUSD, 0),
    pricedSessions: [...index.values()].filter((c) => c.priced).length,
    totalSessions: index.size,
    unpricedModels: [],
  };
  return { index, summary };
}

function downsampleSeries(pts: Array<{ t: number; cost: number; tokens: number }>): CostSeriesPoint[] {
  const sorted = [...pts].sort((a, b) => a.t - b.t);
  let cost = 0;
  let tokens = 0;
  const series: CostSeriesPoint[] = sorted.map((p) => {
    cost += p.cost;
    tokens += p.tokens;
    return { t: p.t, cost, tokens };
  });
  if (series.length <= MAX_SERIES_POINTS) return series;
  const step = series.length / MAX_SERIES_POINTS;
  const ds: CostSeriesPoint[] = [];
  for (let i = 0; i < MAX_SERIES_POINTS; i++) ds.push(series[Math.floor(i * step)]);
  ds.push(series[series.length - 1]);
  return ds;
}

/**
 * Timed agent/skill invocations for the session-detail Timeline.
 *
 * A subagent_completed event fires at completion and carries duration_ms, so the dispatch
 * spans [completion − duration, completion]. Its cost/tokens are recovered by attributing
 * the subagent's own api_requests — those tagged `query_source = agent:*` — that fall inside
 * that window (the subagent shares the parent session.id). Each api_request is attributed to at
 * most one dispatch, so parallel subagents whose windows overlap do not both claim a shared
 * request (which would double-count a dispatch's cost/tokens). Falls back to the event's
 * total_tokens when no windowed agent request matches.
 */
export function buildDispatches(sessionEvents: OtelEvent[]): DispatchEvent[] {
  const agentReqs = sessionEvents
    .filter((e) => isApiRequest(e) && String(attr(e, 'query_source') || '').startsWith('agent:'))
    .map((e) => ({ ms: Date.parse(e.ts), e }))
    .filter((x) => Number.isFinite(x.ms));

  const skillReqs = sessionEvents
    .filter((e) => isApiRequest(e) && attr(e, 'skill.name'))
    .map((e) => ({ ms: Date.parse(e.ts), name: String(attr(e, 'skill.name')), e }))
    .filter((x) => Number.isFinite(x.ms));

  const skillStarts = sessionEvents
    .filter((e) => e.name === 'skill_activated')
    .map((e) => ({ name: String(attr(e, 'skill.name') || '(skill)'), ms: Date.parse(e.ts) }))
    .filter((x) => Number.isFinite(x.ms));

  // Pass 1: collect every agent dispatch window (subagent_completed events) before attributing
  // any request — attribution needs to compare ALL windows for a given request, not just the
  // one whose subagent_completed event happens to appear first.
  interface AgentWindow {
    e: OtelEvent;
    start: number;
    end: number;
    durationMs: number;
  }
  const agentWindows: AgentWindow[] = [];
  for (const e of sessionEvents) {
    if (e.name !== 'subagent_completed') continue;
    const end = Date.parse(e.ts);
    if (!Number.isFinite(end)) continue;
    const durationMs = num(attr(e, 'duration_ms'));
    const start = durationMs > 0 ? end - durationMs : end;
    agentWindows.push({ e, start, end, durationMs });
  }

  // Pass 2: attribute each agent:* api_request to the NARROWEST containing window. OTEL carries
  // no per-invocation id linking a request to a specific subagent run, so when parallel
  // subagents' [start, end] windows overlap, the tightest containing window is the best
  // available signal (a wider, unrelated window should not out-compete a precise match). Each
  // request contributes to at most one window.
  const claimed = new Map<AgentWindow, { tokens: TokenUsage; costUSD: number; matched: number }>();
  for (const ar of agentReqs) {
    let best: AgentWindow | null = null;
    for (const w of agentWindows) {
      if (ar.ms < w.start || ar.ms > w.end) continue;
      if (!best || w.end - w.start < best.end - best.start) best = w;
    }
    if (!best) continue;
    let claim = claimed.get(best);
    if (!claim) {
      claim = { tokens: emptyTokens(), costUSD: 0, matched: 0 };
      claimed.set(best, claim);
    }
    addTokens(claim.tokens, ar.e);
    claim.costUSD += num(attr(ar.e, 'cost_usd'));
    claim.matched += 1;
  }

  const out: DispatchEvent[] = [];
  for (const w of agentWindows) {
    const claim = claimed.get(w);
    const d: DispatchEvent = { kind: 'agent', name: String(attr(w.e, 'agent_type') || '(agent)'), start: w.start, durationMs: w.durationMs };
    if (claim && claim.matched > 0) {
      d.tokens = claim.tokens;
      d.costUSD = claim.costUSD;
    } else {
      const tt = num(attr(w.e, 'total_tokens'));
      if (tt > 0) {
        const t = emptyTokens();
        t.total = tt;
        d.tokens = t;
      }
    }
    out.push(d);
  }

  // Skill windows are non-overlapping by construction (a skill's window ends at the next
  // activation of the SAME skill), so the original name+window matching is unaffected by the
  // parallel-agent fix above and is kept as-is.
  for (const e of sessionEvents) {
    if (e.name !== 'skill_activated') continue;
    const start = Date.parse(e.ts);
    if (!Number.isFinite(start)) continue;
    const name = String(attr(e, 'skill.name') || '(skill)');
    const nextSame = skillStarts
      .filter((s) => s.name === name && s.ms > start)
      .reduce((min, s) => Math.min(min, s.ms), Infinity);
    const matched = skillReqs.filter((r) => r.name === name && r.ms >= start && r.ms < nextSame);
    const d: DispatchEvent = { kind: 'skill', name, start, durationMs: 0 };
    if (matched.length) {
      const tokens = emptyTokens();
      let costUSD = 0;
      let lastEnd = start;
      for (const { ms, e: req } of matched) {
        addTokens(tokens, req);
        costUSD += num(attr(req, 'cost_usd'));
        lastEnd = Math.max(lastEnd, ms + num(attr(req, 'duration_ms')));
      }
      d.durationMs = Math.max(0, lastEnd - start);
      d.tokens = tokens;
      d.costUSD = costUSD;
    }
    out.push(d);
  }

  out.sort((a, b) => a.start - b.start);
  return out.slice(0, MAX_DISPATCHES);
}

/** Read the first `bytes` of a file without loading the whole (transcripts can be large). */
function readHead(file: string, bytes = 65536): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

function defaultProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

let _transcriptIndex: { dir: string; map: Map<string, string> } | null = null;
function transcriptIndex(projectsDir: string): Map<string, string> {
  if (_transcriptIndex && _transcriptIndex.dir === projectsDir) return _transcriptIndex.map;
  const map = new Map<string, string>();
  try {
    for (const dir of readdirSync(projectsDir)) {
      let files: string[];
      try {
        files = readdirSync(join(projectsDir, dir));
      } catch {
        continue;
      }
      for (const f of files) if (f.endsWith('.jsonl')) map.set(f.slice(0, -6), join(projectsDir, dir, f));
    }
  } catch {
    /* no projects dir */
  }
  _transcriptIndex = { dir: projectsDir, map };
  return map;
}

/**
 * Recover the real project (cwd) and git branch for a session from its Claude Code
 * transcript (~/.claude/projects/<dir>/<session-id>.jsonl) — the authoritative record of
 * where Claude Code ran. Native OTEL carries neither. Returns undefined if no transcript.
 */
export function lookupTranscriptCwd(sessionId: string, projectsDir: string = defaultProjectsDir()): CwdInfo | undefined {
  const file = transcriptIndex(projectsDir).get(sessionId);
  if (!file) return undefined;
  try {
    for (const line of readHead(file).split('\n')) {
      if (!line.trim()) continue;
      let e: { cwd?: string; gitBranch?: string };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.cwd || e.gitBranch) return { cwd: e.cwd, branch: e.gitBranch };
    }
  } catch {
    /* unreadable */
  }
  return undefined;
}

/**
 * Synthesize MetricDelta records for a session so the aggregator computes tools, skills,
 * agents, turns, title, and net lines. Turns are derived from user_prompt events (one delta
 * each); all session activity is aggregated onto the first delta (the report shows session
 * totals, not per-turn splits). A session with activity but no captured prompts still gets
 * one delta so its tools/agents surface.
 */
export function buildDeltas(sessionEvents: OtelEvent[], cwd?: CwdInfo): MetricDelta[] {
  const sid = sessionEvents.length ? sessionOf(sessionEvents[0]) : '';
  const prompts = sessionEvents
    .filter((e) => e.name === 'user_prompt')
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  // Aggregate session activity.
  const tools: Record<string, number> = {};
  const toolStatus: Record<string, { success: number; failure: number }> = {};
  const agentInvocations: Record<string, number> = {};
  const skillInvocations: Record<string, number> = {};
  const models = new Set<string>();
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const e of sessionEvents) {
    if (e.name === 'tool_result') {
      const tn = String(attr(e, 'tool_name') || '(unknown)');
      tools[tn] = (tools[tn] || 0) + 1;
      if (!toolStatus[tn]) toolStatus[tn] = { success: 0, failure: 0 };
      if (String(attr(e, 'success')) === 'true') toolStatus[tn].success += 1;
      else toolStatus[tn].failure += 1;
    } else if (e.name === 'subagent_completed') {
      const a = String(attr(e, 'agent_type') || '(agent)');
      agentInvocations[a] = (agentInvocations[a] || 0) + 1;
    } else if (e.name === 'skill_activated') {
      const s = String(attr(e, 'skill.name') || '(skill)');
      skillInvocations[s] = (skillInvocations[s] || 0) + 1;
    } else if (isApiRequest(e)) {
      if (attr(e, 'model')) models.add(String(attr(e, 'model')));
    } else if (e._type === 'metric' && e.name === 'claude_code.lines_of_code.count') {
      const v = num(e.value);
      if (attr(e, 'type') === 'added') linesAdded += v;
      else if (attr(e, 'type') === 'removed') linesRemoved += v;
    }
  }

  const hasActivity =
    Object.keys(tools).length > 0 ||
    Object.keys(agentInvocations).length > 0 ||
    Object.keys(skillInvocations).length > 0 ||
    linesAdded > 0 ||
    linesRemoved > 0 ||
    models.size > 0;

  const turnCount = prompts.length || (hasActivity ? 1 : 0);
  if (turnCount === 0) return [];

  const branch = cwd?.branch;
  const deltas: MetricDelta[] = [];
  for (let i = 0; i < turnCount; i++) {
    const p = prompts[i];
    deltas.push({
      recordId: `${sid}-otel-${i}`,
      sessionId: sid,
      agentSessionId: sid,
      timestamp: p ? Date.parse(p.ts) : (sessionEvents[0] ? Date.parse(sessionEvents[0].ts) : 0),
      gitBranch: branch,
      userPrompts: p ? [{ count: 1, text: String(attr(p, 'prompt') || '') }] : undefined,
      syncStatus: 'synced',
      syncAttempts: 0,
    });
  }

  // Attach all aggregated activity to the first delta — totals are what the report shows.
  const first = deltas[0];
  if (Object.keys(tools).length) first.tools = tools;
  if (Object.keys(toolStatus).length) first.toolStatus = toolStatus;
  if (Object.keys(agentInvocations).length) first.agentInvocations = agentInvocations;
  if (Object.keys(skillInvocations).length) first.skillInvocations = skillInvocations;
  if (models.size) first.models = [...models];
  if (linesAdded > 0 || linesRemoved > 0) {
    // OTEL's lines_of_code metric has no per-file path, so net lines are attributed to one
    // synthetic aggregate path (the aggregator skips path-less ops). Consequence: a session's
    // "files changed" reads 1 — net lines are accurate, per-file breakdown is not available.
    first.fileOperations = [{ type: 'edit', path: '<otel:aggregate>', linesAdded, linesRemoved }];
  }
  return deltas;
}

/** Map of session id → cwd/branch, from this plugin's own session.start events. */
function buildCwdMap(events: OtelEvent[]): Map<string, CwdInfo> {
  const m = new Map<string, CwdInfo>();
  for (const e of events) {
    if (attr(e, 'event_type') === 'claude.session.start' || attr(e, 'cwd')) {
      const sid = sessionOf(e);
      if (sid && !m.has(sid)) {
        m.set(sid, { cwd: attr(e, 'cwd') ? String(attr(e, 'cwd')) : undefined, branch: attr(e, 'git_branch') ? String(attr(e, 'git_branch')) : undefined });
      }
    }
  }
  return m;
}

/** Build one RawSessionData (with synthesized deltas) for a session's events. */
export function buildRawSession(sessionId: string, sessionEvents: OtelEvent[], cwd: CwdInfo | undefined, projectLabel: string): RawSessionData {
  const times = sessionEvents.map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  const startTime = times.length ? Math.min(...times) : 0;
  const endTime = times.length ? Math.max(...times) : 0;
  const workingDirectory = cwd?.cwd || projectLabel;
  const startEvent: SessionStartEvent = {
    recordId: sessionId,
    type: 'session_start',
    timestamp: startTime,
    codeMieSessionId: sessionId,
    agentName: 'claude',
    syncStatus: 'synced',
    data: { provider: 'claude', workingDirectory, startTime },
  };
  const endEvent: SessionEndEvent = {
    recordId: `${sessionId}-end`,
    type: 'session_end',
    timestamp: endTime,
    codeMieSessionId: sessionId,
    agentName: 'claude',
    syncStatus: 'synced',
    data: { endTime, duration: Math.max(0, endTime - startTime), totalTurns: 0 },
  };
  return { sessionId, startEvent, endEvent, deltas: buildDeltas(sessionEvents, cwd) };
}

/** Load + map an OTEL events file into the analytics pipeline inputs. */
export function loadOtelSessions(opts: {
  file: string;
  filter?: OtelFilter;
  projectLabel?: string;
  /** Override the cwd/branch source (defaults to the Claude Code transcript join). */
  cwdLookup?: (sessionId: string) => CwdInfo | undefined;
}): {
  rawSessions: RawSessionData[];
  costIndex: SessionCostIndex;
  summary: CostSummary;
} {
  const projectLabel = opts.projectLabel ?? 'Unknown';
  const cwdLookup = opts.cwdLookup ?? ((sid: string) => lookupTranscriptCwd(sid));
  const events = parseOtelJsonl(readFileSync(opts.file, 'utf-8'));

  // Owned sessions = those with an api_request matching the user/time filter.
  const apiRequests = filterApiRequests(events, opts.filter);
  const ownedSids = new Set(apiRequests.map(sessionOf).filter(Boolean));

  // Group ALL events for owned sessions (deltas/dispatches need the full event variety).
  const bySession = new Map<string, OtelEvent[]>();
  for (const e of events) {
    const sid = sessionOf(e);
    if (sid && ownedSids.has(sid)) {
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid)!.push(e);
    }
  }

  const pluginCwdMap = buildCwdMap(events); // fallback for sessions recorded with this plugin
  const { index, summary } = buildCostIndex(apiRequests);

  // Attach per-session dispatches (Timeline) onto the cost index.
  for (const [sid, evs] of bySession) {
    const sc: SessionCost | undefined = index.get(sid);
    if (sc) {
      const d = buildDispatches(evs);
      if (d.length) sc.dispatches = d;
    }
  }

  const rawSessions = [...bySession.entries()].map(([sid, evs]) => {
    // Project/branch: transcript join first (authoritative, works for all sessions),
    // then this plugin's session.start event as a fallback.
    const cwd = cwdLookup(sid) ?? pluginCwdMap.get(sid);
    return buildRawSession(sid, evs, cwd, projectLabel);
  });
  return { rawSessions, costIndex: index, summary };
}
