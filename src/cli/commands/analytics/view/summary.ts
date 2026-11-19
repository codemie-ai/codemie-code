/**
 * Every number of `codemie analytics view --export summary`, computed from report records.
 *
 * The formulas are the HTML report's own (`report/client/app.js`); each one names the function
 * it mirrors, and `report/__tests__/view-parity.test.ts` runs app.js against this module.
 */

import { agentMatchesAnalyticsFilter } from '../cost/codex-agent.js';
import type { ReportPayload, ReportSessionRecord } from '../report/types.js';
import {
  SUMMARY_SCHEMA,
  type AnalyticsSummary,
  type HeavySessionRow,
  type NamedCallStats,
  type SeriesBucket,
  type SessionRow,
  type SummaryTotals,
  type ViewFilter,
} from './types.js';

type StepKind = 'agent' | 'skill' | 'command';

const DAY_MS = 86_400_000;
/** Ranges longer than this many days are bucketed by week. */
const MAX_DAY_BUCKETS = 35;
/** Rows in the dead and heavy session lists. */
const TOP_ROWS = 8;
// VIEWS.efficiency "Session depth" buckets; the last label is "51+" (app.js prints "50+" for the same > 50 test).
const DEPTH_BUCKETS: ReadonlyArray<readonly [string, (turns: number) => boolean]> = [
  ['1', (t) => t <= 1],
  ['2–5', (t) => t >= 2 && t <= 5],
  ['6–10', (t) => t >= 6 && t <= 10],
  ['11–25', (t) => t >= 11 && t <= 25],
  ['26–50', (t) => t >= 26 && t <= 50],
  ['51+', (t) => t > 50],
];

function sum(records: readonly ReportSessionRecord[], value: (s: ReportSessionRecord) => number | undefined): number {
  let total = 0;
  for (const s of records) total += value(s) || 0;
  return total;
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Sessions that started in [from, to] and match every given text filter. `agent` matches as
 * `codemie analytics --agent` does (`codex` covers the Codex family); `project` is a full path or
 * its last segment; `branch` is the session's main branch.
 */
export function filterRecords(records: ReportSessionRecord[], f: ViewFilter): ReportSessionRecord[] {
  return records.filter(
    (s) =>
      (f.from === undefined || s.startTime >= f.from) &&
      (f.to === undefined || s.startTime <= f.to) &&
      (!f.agent || agentMatchesAnalyticsFilter(s.agentName, f.agent)) &&
      (!f.project || s.project === f.project || lastSegment(s.project) === f.project) &&
      (!f.branch || s.branch === f.branch)
  );
}

/** A priced session has a per-model cost line: the enricher's `priced` (`perModel.length > 0`). */
function isPriced(s: ReportSessionRecord): boolean {
  return (s.perModelCost?.length ?? 0) > 0;
}

// app.js successRate: Σ success / Σ calls as a percent with one decimal.
function successRate(records: readonly ReportSessionRecord[]): number {
  const total = sum(records, (s) => s.toolCallsTotal);
  const ok = sum(records, (s) => s.toolCallsSuccess);
  return total ? Math.round((ok / total) * 1000) / 10 : 0;
}

// app.js dispatchCounts: the timed dispatches, unless they are incomplete and tracked counts exist.
function stepCounts(s: ReportSessionRecord, kind: StepKind): Array<{ name: string; totalCalls: number }> {
  const tracked = (kind === 'agent' ? s.agentInvocations : kind === 'skill' ? s.skillInvocations : s.commandInvocations) ?? [];
  if (!s.dispatchesComplete && tracked.length) return tracked;
  const counts = new Map<string, number>();
  for (const d of s.dispatches ?? []) {
    if (d.kind === kind) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
  }
  return [...counts].map(([name, totalCalls]) => ({ name, totalCalls }));
}

function stepCalls(s: ReportSessionRecord, kind: StepKind): number {
  return stepCounts(s, kind).reduce((total, step) => total + step.totalCalls, 0);
}

function rowOf(s: ReportSessionRecord): SessionRow {
  return {
    sessionId: s.sessionId,
    title: s.title,
    agentName: s.agentName,
    project: s.project,
    branch: s.branch,
    models: s.models,
    startTime: s.startTime,
    durationMs: s.durationMs,
    turns: s.turns,
    linesAdded: s.linesAdded,
    linesRemoved: s.linesRemoved,
    filesChanged: s.filesChanged,
    costUSD: s.costUSD,
    hadLog: s.hadLog,
    sessionSource: s.sessionSource,
    steps: { agents: stepCalls(s, 'agent'), skills: stepCalls(s, 'skill'), commands: stepCalls(s, 'command') },
  };
}

// VIEWS.overview KPI and token sums; the success rate as meta.totals rounds it.
function totalsOf(records: readonly ReportSessionRecord[]): SummaryTotals {
  return {
    sessions: records.length,
    pricedSessions: records.filter(isPriced).length,
    costUSD: sum(records, (s) => s.costUSD),
    cacheReadCostUSD: sum(records, (s) => s.cacheReadCostUSD),
    durationMs: sum(records, (s) => s.durationMs),
    turns: sum(records, (s) => s.turns),
    linesAdded: sum(records, (s) => s.linesAdded),
    linesRemoved: sum(records, (s) => s.linesRemoved),
    netLines: sum(records, (s) => s.netLines),
    filesChanged: sum(records, (s) => s.filesChanged),
    toolCalls: sum(records, (s) => s.toolCallsTotal),
    toolSuccessRate: successRate(records),
    tokens: {
      input: sum(records, (s) => s.tokens?.input),
      output: sum(records, (s) => s.tokens?.output),
      cacheRead: sum(records, (s) => s.tokens?.cacheRead),
      cacheCreation: sum(records, (s) => s.tokens?.cacheCreation),
      total: sum(records, (s) => s.tokens?.total),
    },
  };
}

/** Local calendar days from `from` to `to`, or weeks starting Monday when the range is longer than 35 days. */
function bucketsFor(from: number, to: number): { bucket: 'day' | 'week'; slots: Array<{ from: number; to: number }> } {
  const bucket = Math.round((to - from + 1) / DAY_MS) > MAX_DAY_BUCKETS ? 'week' : 'day';
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  if (bucket === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const slots: Array<{ from: number; to: number }> = [];
  // Step by calendar date, never by 24 h: a day across a DST change has 23 or 25 hours.
  while (start.getTime() <= to) {
    const next = new Date(start);
    next.setDate(next.getDate() + (bucket === 'week' ? 7 : 1));
    slots.push({ from: start.getTime(), to: next.getTime() - 1 });
    start.setTime(next.getTime());
  }
  return { bucket, slots };
}

// appendToolsAndModels tool rows: per-tool calls and a whole-percent success rate, by calls.
function toolRows(records: readonly ReportSessionRecord[]): AnalyticsSummary['tools'] {
  const byName = new Map<string, { calls: number; success: number; failure: number }>();
  for (const s of records) {
    for (const t of s.tools ?? []) {
      const cur = byName.get(t.toolName) ?? { calls: 0, success: 0, failure: 0 };
      cur.calls += t.totalCalls;
      cur.success += t.successCount;
      cur.failure += t.failureCount;
      byName.set(t.toolName, cur);
    }
  }
  return [...byName]
    .map(([name, t]) => ({ name, ...t, successRate: t.calls ? Math.round((t.success / t.calls) * 100) : 0 }))
    .sort((a, b) => b.calls - a.calls);
}

// appendInvocationCharts: calls per name from dispatchCounts, by calls.
function stepRows(records: readonly ReportSessionRecord[], kind: StepKind): NamedCallStats[] {
  const byName = new Map<string, NamedCallStats>();
  for (const s of records) {
    const seen = new Set<string>();
    for (const { name, totalCalls } of stepCounts(s, kind)) {
      const cur = byName.get(name) ?? { name, calls: 0, sessions: 0 };
      cur.calls += totalCalls;
      if (!seen.has(name)) cur.sessions += 1;
      seen.add(name);
      byName.set(name, cur);
    }
  }
  return [...byName.values()].sort((a, b) => b.calls - a.calls);
}

// appendToolsAndModels model rows from perModelCost, here by cost with each model's share of it.
function modelRows(records: readonly ReportSessionRecord[]): AnalyticsSummary['models'] {
  const byModel = new Map<string, { costUSD: number; tokens: number; sessions: Set<string> }>();
  for (const s of records) {
    for (const m of s.perModelCost ?? []) {
      const cur = byModel.get(m.model) ?? { costUSD: 0, tokens: 0, sessions: new Set<string>() };
      cur.costUSD += m.costUSD;
      cur.tokens += m.tokens?.total ?? 0;
      cur.sessions.add(s.sessionId);
      byModel.set(m.model, cur);
    }
  }
  let allCost = 0;
  for (const m of byModel.values()) allCost += m.costUSD;
  return [...byModel]
    .map(([model, m]) => ({ model, costUSD: m.costUSD, tokens: m.tokens, sessions: m.sessions.size, share: allCost > 0 ? m.costUSD / allCost : 0 }))
    .sort((a, b) => b.costUSD - a.costUSD);
}

function groupBy<K, V>(records: readonly ReportSessionRecord[], key: (s: ReportSessionRecord) => K, init: (k: K) => V, add: (acc: V, s: ReportSessionRecord) => void): V[] {
  const groups = new Map<K, V>();
  for (const s of records) {
    const k = key(s);
    const acc = groups.get(k) ?? init(k);
    add(acc, s);
    groups.set(k, acc);
  }
  return [...groups.values()];
}

// VIEWS.efficiency: dead sessions, bloat, context per turn and session depth.
function efficiencyOf(records: readonly ReportSessionRecord[], totals: SummaryTotals): AnalyticsSummary['efficiency'] {
  const totalCost = totals.costUSD;
  const dead = records.filter((s) => s.costUSD > 0 && (s.filesChanged || 0) === 0 && s.netLines === 0);
  const deadCost = sum(dead, (s) => s.costUSD);
  // Context per turn counts only sessions that read the cache at all.
  const cached = records.filter((s) => (s.tokens?.cacheRead ?? 0) > 0);
  const cachedTurns = sum(cached, (s) => s.turns);
  const turns = records.map((s) => s.turns || 0).sort((a, b) => a - b);
  const mid = Math.floor(turns.length / 2);
  const median = !turns.length ? 0 : turns.length % 2 ? turns[mid] : Math.round((turns[mid - 1] + turns[mid]) / 2);
  // "Most bloated sessions": cache-read tokens per turn, and cache-read cost as a percent of cost.
  const heavy: HeavySessionRow[] = records
    .map((s) => ({ s, ctx: s.turns ? (s.tokens?.cacheRead ?? 0) / s.turns : 0 }))
    .filter((x) => x.ctx > 0)
    .sort((a, b) => b.ctx - a.ctx)
    .slice(0, TOP_ROWS)
    .map(({ s, ctx }) => ({
      ...rowOf(s),
      contextPerTurn: ctx,
      bloatPct: s.costUSD > 0 ? Math.round(((s.cacheReadCostUSD || 0) / s.costUSD) * 1000) / 10 : 0,
    }));
  return {
    costPerFileUSD: totals.filesChanged ? totalCost / totals.filesChanged : null,
    toolSuccessRate: totals.toolSuccessRate,
    contextPerTurn: cachedTurns ? sum(cached, (s) => s.tokens.cacheRead) / cachedTurns : 0,
    cacheReadCostShare: totalCost > 0 ? totals.cacheReadCostUSD / totalCost : 0,
    dead: {
      sessions: dead.length,
      costUSD: deadCost,
      shareOfCost: totalCost > 0 ? deadCost / totalCost : 0,
      shareOfSessions: records.length ? dead.length / records.length : 0,
      top: dead.slice().sort((a, b) => b.costUSD - a.costUSD).slice(0, TOP_ROWS).map(rowOf),
    },
    depth: {
      buckets: DEPTH_BUCKETS.map(([label, test]) => ({ label, sessions: records.filter((s) => test(s.turns || 0)).length })),
      median,
      average: records.length ? Math.round(totals.turns / records.length) : 0,
    },
    heavy,
  };
}

function changeOf(current: number, previous: number): number | null {
  return previous ? (current - previous) / previous : null;
}

/**
 * The `codemie.analytics.summary/1` document for the sessions of `payload` that match `f`.
 * Without `--from` the range starts at the export's `periodStart`; without `--to` it ends `now`.
 */
export function buildSummary(payload: ReportPayload, f: ViewFilter, opts: { compare: boolean; now: number }): AnalyticsSummary {
  const records = filterRecords(payload.sessions, f);
  const periodStart = payload.meta.periodStart ? Date.parse(payload.meta.periodStart) : NaN;
  const to = f.to ?? opts.now;
  let from = f.from ?? (Number.isFinite(periodStart) ? periodStart : undefined);
  if (from === undefined) {
    from = to;
    for (const s of payload.sessions) from = Math.min(from, s.startTime);
  }
  const totals = totalsOf(records);

  let previous: SummaryTotals | null = null;
  let change: AnalyticsSummary['change'] = null;
  const length = to - from + 1;
  // Only when the export reaches back to the previous range's start; otherwise it would read as a drop.
  if (opts.compare && periodStart <= from - length) {
    previous = totalsOf(filterRecords(payload.sessions, { ...f, from: from - length, to: from - 1 }));
    change = {
      costUSD: changeOf(totals.costUSD, previous.costUSD),
      sessions: changeOf(totals.sessions, previous.sessions),
      durationMs: changeOf(totals.durationMs, previous.durationMs),
    };
  }

  const { bucket, slots } = bucketsFor(from, to);
  const series: SeriesBucket[] = slots.map((slot) => {
    const inSlot = records.filter((s) => s.startTime >= slot.from && s.startTime <= slot.to);
    return {
      ...slot,
      sessions: inSlot.length,
      costUSD: sum(inSlot, (s) => s.costUSD),
      tokens: sum(inSlot, (s) => s.tokens?.total),
      durationMs: sum(inSlot, (s) => s.durationMs),
    };
  });

  return {
    schema: SUMMARY_SCHEMA,
    range: { from, to, bucket },
    filter: { agent: f.agent ?? null, project: f.project ?? null, branch: f.branch ?? null },
    coverage: groupBy(records, (s) => s.agentName, (agentName) => ({ agentName, sessions: 0, priced: 0, withLog: 0 }), (acc, s) => {
      acc.sessions += 1;
      if (isPriced(s)) acc.priced += 1;
      if (s.hadLog) acc.withLog += 1;
    }).sort((a, b) => b.sessions - a.sessions),
    totals,
    previous,
    change,
    series,
    tools: toolRows(records),
    skills: stepRows(records, 'skill'),
    agents: stepRows(records, 'agent'),
    commands: stepRows(records, 'command'),
    models: modelRows(records),
    projects: groupBy(records, (s) => s.project, (project) => ({ project, costUSD: 0, sessions: 0, netLines: 0 }), (acc, s) => {
      acc.costUSD += s.costUSD;
      acc.sessions += 1;
      acc.netLines += s.netLines;
    }).sort((a, b) => b.costUSD - a.costUSD),
    agentsUsed: groupBy(filterRecords(payload.sessions, { ...f, agent: undefined }), (s) => s.agentName, (agentName) => ({ agentName, sessions: 0, costUSD: 0 }), (acc, s) => {
      acc.sessions += 1;
      acc.costUSD += s.costUSD;
    }).sort((a, b) => b.sessions - a.sessions),
    efficiency: efficiencyOf(records, totals),
    sessions: records.slice().sort((a, b) => b.startTime - a.startTime).map(rowOf),
  };
}
