/**
 * Parity between the HTML report and `codemie analytics view`: runs app.js's own `traceEntries`
 * and `successRate` (sliced out of the real file, as report-views.test.ts does) on the same
 * sessions as the view module, so the two cannot drift apart unnoticed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { runInNewContext } from 'vm';
import { buildTrace } from '../../view/trace.js';
import { buildSummary } from '../../view/summary.js';
import { dispatch, payload, record } from '../../view/__tests__/record-fixture.js';
import type { ReportSessionRecord } from '../types.js';

const appSource = readFileSync(fileURLToPath(new URL('../client/app.js', import.meta.url)), 'utf-8');

function sliceOf(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error(`slice markers not found in app.js: ${startMarker}`);
  return appSource.slice(start, end);
}

interface AppTraceEntry {
  key: string;
  label: string;
  level: number;
  parent: AppTraceEntry | null;
  children: AppTraceEntry[];
  issue: string;
}

const traceEntries = runInNewContext(
  `${sliceOf('function traceEntries(s) {', '// Every link selects an invocation entry')} traceEntries`,
  {}
) as (s: unknown) => AppTraceEntry[];
const successRate = runInNewContext(
  `${sliceOf('function sum(arr, f) {', '// ---- filter state')} successRate`,
  {}
) as (fs: unknown[]) => number;

const sessions: ReportSessionRecord[] = [
  record({
    sessionId: 'nested',
    dispatches: [
      dispatch({ kind: 'command', name: 'teams-transcript', id: 'cmd-2', ownerAgentId: 'nested', start: 900, relationshipStatus: 'root' }),
      dispatch({ kind: 'agent', name: 'code-review-orchestrator', id: 'tool-1', agentId: 'agent-1', ownerAgentId: 'nested', start: 100, depth: 1, relationshipStatus: 'resolved' }),
      dispatch({ kind: 'agent', name: 'review-lens', id: 'tool-2', agentId: 'agent-2', parentId: 'tool-1', ownerAgentId: 'agent-1', start: 200, depth: 2, relationshipStatus: 'resolved' }),
      dispatch({ kind: 'agent', name: 'review-lens', id: 'tool-3', agentId: 'agent-3', parentId: 'tool-1', ownerAgentId: 'agent-1', start: 210, depth: 2, relationshipStatus: 'resolved' }),
      dispatch({ kind: 'skill', name: 'brainstorming', id: 'tool-4', ownerAgentId: 'agent-2', start: 220, relationshipStatus: 'resolved' }),
      dispatch({ kind: 'command', name: 'teams-transcript', id: 'cmd-1', ownerAgentId: 'nested', start: 50, relationshipStatus: 'root' }),
      dispatch({ kind: 'skill', name: 'legacy', start: 60 }),
    ],
  }),
  record({
    sessionId: 'broken',
    dispatches: [
      dispatch({ kind: 'agent', name: 'loop-a', id: 'a', agentId: 'agent-a', parentId: 'b', start: 10 }),
      dispatch({ kind: 'agent', name: 'loop-b', id: 'b', agentId: 'agent-b', parentId: 'a', start: 20 }),
      dispatch({ kind: 'agent', name: 'twin', id: 'same', start: 30 }),
      dispatch({ kind: 'agent', name: 'twin', id: 'same', start: 40 }),
      dispatch({ kind: 'skill', name: 'under-twin', parentId: 'same', start: 50 }),
      dispatch({ kind: 'skill', name: 'conflicted', id: 'c', relationshipStatus: 'conflict', start: 60 }),
      dispatch({ kind: 'skill', name: 'unresolved', id: 'm', relationshipStatus: 'missing', start: 70 }),
      dispatch({ kind: 'skill', name: 'no-owner', id: 'o', ownerAgentId: 'agent-gone', start: 80 }),
      dispatch({ kind: 'skill', name: 'deep', id: 'd', depth: 3, start: 90 }),
      dispatch({ kind: 'agent', name: 'fine', id: 'f', start: 5 }),
      dispatch({ kind: 'skill', name: 'child-of-fine', id: 'g', parentId: 'f', start: 0 }),
    ],
  }),
  record({ sessionId: 'empty', dispatches: undefined }),
];

describe('view parity with the HTML report', () => {
  it('buildTrace gives the same order, levels and parents as the report\'s traceEntries', () => {
    for (const s of sessions) {
      const app = traceEntries(JSON.parse(JSON.stringify(s)));
      const view = buildTrace(s);

      expect(view.map((e) => e.key)).toEqual(app.map((e) => e.key));
      expect(view.map((e) => e.level)).toEqual(app.map((e) => e.level));
      expect(view.map((e) => e.parentKey)).toEqual(app.map((e) => e.parent?.key ?? null));
      expect(view.map((e) => e.childKeys)).toEqual(app.map((e) => e.children.map((c) => c.key)));
      expect(view.map((e) => e.issue)).toEqual(app.map((e) => e.issue || null));
      // Labels differ only by the report's "kind · " prefix.
      expect(view.map((e) => `${e.kind} · ${e.label}`)).toEqual(app.map((e) => e.label));
    }
  });

  it('summary tool success equals the report\'s successRate for the same sessions', () => {
    const sets = [
      sessions,
      [record({ toolCallsTotal: 3, toolCallsSuccess: 2 })],
      [record({ toolCallsTotal: 7, toolCallsSuccess: 7 }), record({ sessionId: 'b', toolCallsTotal: 9, toolCallsSuccess: 1 })],
      [record({ toolCallsTotal: 0, toolCallsSuccess: 0 })],
      [],
    ];
    for (const set of sets) {
      const summary = buildSummary(payload(set), {}, { compare: false, now: Date.UTC(2026, 10, 19) });

      expect(summary.totals.toolSuccessRate).toBe(successRate(JSON.parse(JSON.stringify(set))));
      expect(summary.efficiency.toolSuccessRate).toBe(summary.totals.toolSuccessRate);
    }
  });
});
