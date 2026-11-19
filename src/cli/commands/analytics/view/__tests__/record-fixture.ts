/**
 * Invented report records for the `analytics view` tests. The shape is copied from one session
 * of a real `codemie analytics --export json`; every title, path and number here is made up.
 */

import type { ReportMeta, ReportPayload, ReportSessionRecord } from '../../report/types.js';
import type { DispatchEvent, TokenUsage } from '../../cost/types.js';

export const DAY_MS = 86_400_000;

export function tokens(cacheRead = 50_000, total = 63_000): TokenUsage {
  return { input: 1_000, output: 2_000, cacheRead, cacheCreation: total - cacheRead - 3_000, cacheCreation1h: 0, total };
}

/** A full, priced Claude session; `overrides` replace whole fields. */
export function record(overrides: Partial<ReportSessionRecord> = {}): ReportSessionRecord {
  const sessionId = overrides.sessionId ?? 'session-1';
  return {
    sessionId,
    agentName: 'claude',
    provider: 'native',
    project: '/Users/taylor/projects/garden-planner',
    branch: 'main',
    title: 'Add a watering schedule to the planner',
    startTime: Date.UTC(2026, 10, 10, 9, 0),
    durationMs: 30 * 60_000,
    turns: 12,
    fileOps: 4,
    linesAdded: 40,
    linesRemoved: 10,
    linesModified: 0,
    netLines: 30,
    filesChanged: 3,
    filesWritten: 1,
    filesEdited: 2,
    toolCallsTotal: 10,
    toolCallsSuccess: 9,
    toolCallsFailure: 1,
    models: ['claude-sonnet-4-5'],
    languages: ['TypeScript'],
    tools: [
      { toolName: 'Read', totalCalls: 6, successCount: 6, failureCount: 0, successRate: 100 },
      { toolName: 'Bash', totalCalls: 4, successCount: 3, failureCount: 1, successRate: 75 },
    ],
    skillInvocations: [],
    agentInvocations: [],
    commandInvocations: [],
    sessionSource: 'Pure chat',
    tokens: tokens(),
    costUSD: 0.5,
    cacheReadCostUSD: 0.15,
    perModelCost: [{ model: 'claude-sonnet-4-5', tokens: tokens(), costUSD: 0.5, unpriced: false }],
    hadLog: true,
    agentSessionFile: `/Users/taylor/.claude/projects/-Users-taylor-projects-garden-planner/${sessionId}.jsonl`,
    costSource: 'native-estimate',
    costBasis: 'standard-api-tokens',
    dispatchesComplete: true,
    ...overrides,
  };
}

/** A session CodeMie could not price: no log, no tokens, no cost. */
export function unpricedRecord(overrides: Partial<ReportSessionRecord> = {}): ReportSessionRecord {
  return record({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, total: 0 },
    costUSD: 0,
    cacheReadCostUSD: 0,
    perModelCost: [],
    hadLog: false,
    agentSessionFile: undefined,
    costSource: undefined,
    costBasis: undefined,
    ...overrides,
  });
}

export function dispatch(overrides: Partial<DispatchEvent> & Pick<DispatchEvent, 'kind' | 'name' | 'start'>): DispatchEvent {
  return { durationMs: 0, status: 'completed', ...overrides };
}

export function meta(overrides: Partial<ReportMeta> = {}): ReportMeta {
  return {
    generatedAt: '2026-11-19T12:00:00.000Z',
    rangeLabel: '30d',
    agents: ['claude'],
    projectFilter: 'all',
    totals: {
      sessions: 0, durationMs: 0, turns: 0, files: 0, netLines: 0, toolCallsTotal: 0, toolSuccessRate: 0,
      totalCostUSD: 0, cacheReadCostUSD: 0, pricedSessions: 0,
    },
    unpricedModels: [],
    estimatedModels: [],
    localModels: [],
    coverage: [],
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-11-19T12:00:00.000Z',
    ...overrides,
  };
}

export function payload(sessions: ReportSessionRecord[], metaOverrides: Partial<ReportMeta> = {}): ReportPayload {
  return { meta: meta(metaOverrides), sessions };
}
