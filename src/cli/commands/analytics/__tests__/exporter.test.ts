/**
 * Verifies AnalyticsExporter includes the cost and active-duration fields that the
 * console path already shows (Est. Cost / per-session Cost:, Active: line) when
 * --export json/csv is used — see CR-003.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AnalyticsExporter } from '../exporter.js';
import type { RootAnalytics, SessionAnalytics } from '../types.js';
import type { SessionCostIndex, CostSummary } from '../cost/types.js';

vi.mock('chalk', () => {
  const identity = (s: string) => s;
  const chalk = new Proxy(identity, { get: () => identity });
  return { default: chalk };
});

function session(overrides: Partial<SessionAnalytics> = {}): SessionAnalytics {
  return {
    sessionId: 's1',
    agentName: 'claude',
    provider: 'ai-run-sso',
    workingDirectory: '/repo',
    title: 'fix the bug',
    primaryBranch: 'main',
    startTime: 1_000,
    endTime: 2_000,
    duration: 1_000,
    activeDurationMs: 42_000,
    totalTurns: 1,
    totalFileOperations: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalLinesModified: 0,
    netLinesChanged: 0,
    filesChanged: 0,
    filesWritten: 0,
    filesEdited: 0,
    totalToolCalls: 0,
    successfulToolCalls: 0,
    failedToolCalls: 0,
    toolSuccessRate: 0,
    models: [],
    tools: [],
    languages: [],
    formats: [],
    files: [],
    ...overrides,
  } as unknown as SessionAnalytics;
}

function rootWith(s: SessionAnalytics): RootAnalytics {
  return {
    projects: [
      {
        projectPath: '/repo',
        branches: [
          {
            branchName: 'main',
            sessions: [s],
          },
        ],
      },
    ],
  } as unknown as RootAnalytics;
}

describe('AnalyticsExporter cost/active-duration inclusion', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'exporter-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exportJSON includes each session cost and the run-level cost summary', () => {
    const analytics = rootWith(session());
    const costIndex: SessionCostIndex = new Map([
      ['s1', { sessionId: 's1', costUSD: 1.23, priced: true } as never],
    ]);
    const costSummary: CostSummary = {
      totalCostUSD: 1.23,
      pricedSessions: 1,
      totalSessions: 1,
      unpricedModels: [],
    };

    const outPath = join(tempDir, 'out.json');
    AnalyticsExporter.exportJSON(analytics, outPath, costIndex, costSummary);

    const parsed = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(parsed.costSummary).toEqual(costSummary);
    expect(parsed.projects[0].branches[0].sessions[0].cost).toEqual({ costUSD: 1.23, priced: true });
  });

  it('exportCSV adds Active Duration and Cost columns populated from session/costIndex data', () => {
    const analytics = rootWith(session());
    const costIndex: SessionCostIndex = new Map([
      ['s1', { sessionId: 's1', costUSD: 1.23, priced: true } as never],
    ]);

    const outPath = join(tempDir, 'out.csv');
    AnalyticsExporter.exportCSV(analytics, outPath, costIndex);

    const [header, row] = readFileSync(outPath, 'utf-8').trim().split('\n');
    expect(header).toContain('Active Duration (s)');
    expect(header).toContain('Cost (USD)');

    const headerCols = header.split(',');
    const rowCols = row.split(',');
    expect(rowCols[headerCols.indexOf('Active Duration (s)')]).toBe('42');
    expect(rowCols[headerCols.indexOf('Cost (USD)')]).toBe('1.23');
  });
});
