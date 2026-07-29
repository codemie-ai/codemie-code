/**
 * Builds the embedded {@link ReportPayload} from the aggregated analytics
 * hierarchy plus the report-time cost index. Pure — the caller stamps
 * `generatedAt` so this stays deterministic and unit-testable.
 */

import type { RootAnalytics } from '../types.js';
import type { SessionCostIndex, CostSummary, AgentCoverage } from '../cost/types.js';
import { emptyUsage } from '../cost/cost-calculator.js';
import type { ReportPayload, ReportSessionRecord, ReportMeta } from './types.js';
import { detectSessionSource } from './session-source-detector.js';

export interface PayloadContext {
  rangeLabel: string;
  projectFilter: string;
  generatedAt: string; // ISO — caller stamps it
  userEmail?: string;   // caller stamps; absent when not authenticated
  periodStart?: string; // ISO — caller stamps from filter or session start
  periodEnd?: string;   // ISO — caller stamps from filter or session end
}

export function buildPayload(
  root: RootAnalytics,
  costIndex: SessionCostIndex,
  summary: CostSummary,
  ctx: PayloadContext
): ReportPayload {
  const sessions: ReportSessionRecord[] = [];
  const agents = new Set<string>();
  // Per-agent coverage over the DEDUPED set so "which tools are included" stays
  // consistent with the headline session count (not the larger raw scan).
  const coverageMap = new Map<string, AgentCoverage>();
  // The aggregator places a session under EVERY branch it touched, each carrying
  // the full (duplicated) session metrics. Dedupe by sessionId so the flat record
  // list — the single source of truth for the client — counts each session once.
  const seen = new Set<string>();
  // Track earliest/latest activity across included sessions so the meta block can
  // fall back to derived period when the caller did not stamp explicit dates.
  let minStartMs: number | undefined;
  let maxEndMs: number | undefined;

  for (const project of root.projects) {
    for (const branch of project.branches) {
      for (const s of branch.sessions) {
        if (seen.has(s.sessionId)) {
          continue;
        }
        seen.add(s.sessionId);
        if (Number.isFinite(s.startTime) && s.startTime > 0) {
          if (minStartMs === undefined || s.startTime < minStartMs) {
            minStartMs = s.startTime;
          }
          const dur = Number.isFinite(s.duration) ? Math.max(s.duration, 0) : 0;
          const endMs = s.startTime + dur;
          if (maxEndMs === undefined || endMs > maxEndMs) {
            maxEndMs = endMs;
          }
        }
        const cost = costIndex.get(s.sessionId);
        agents.add(s.agentName);
        const skillInvocations = s.skillInvocations ?? [];
        const agentInvocations = s.agentInvocations ?? [];
        const commandInvocations = s.commandInvocations ?? [];
        const cov = coverageMap.get(s.agentName) ?? { agentName: s.agentName, total: 0, priced: 0, withLog: 0 };
        cov.total += 1;
        if (cost?.hadLog) {
          cov.withLog += 1;
        }
        if (cost?.priced) {
          cov.priced += 1;
        }
        coverageMap.set(s.agentName, cov);
        sessions.push({
          sessionId: s.sessionId,
          agentName: s.agentName,
          provider: s.provider,
          title: s.title ?? '',
          project: project.projectPath,
          // The session's dominant branch — so a session that touched several branches is
          // attributed to where it did the most work, not whichever branch iterates first.
          branch: s.primaryBranch ?? branch.branchName,
          startTime: s.startTime,
          durationMs: s.duration,
          turns: s.totalTurns,
          fileOps: s.totalFileOperations,
          linesAdded: s.totalLinesAdded,
          linesRemoved: s.totalLinesRemoved,
          linesModified: s.totalLinesModified,
          netLines: s.netLinesChanged,
          filesChanged: s.filesChanged ?? 0,
          filesWritten: s.filesWritten ?? 0,
          filesEdited: s.filesEdited ?? 0,
          toolCallsTotal: s.totalToolCalls,
          toolCallsSuccess: s.successfulToolCalls,
          toolCallsFailure: s.failedToolCalls,
          models: s.models.map((m) => m.model),
          languages: s.languages.map((l) => l.language),
          tools: s.tools,
          tokens: cost?.tokens ?? emptyUsage(),
          costUSD: cost?.costUSD ?? 0,
          cacheReadCostUSD: cost?.cacheReadCostUSD ?? 0,
          perModelCost: cost?.perModel ?? [],
          hadLog: cost?.hadLog ?? false,
          // Optional and additive — omitted entirely for agents that record full usage,
          // so no other agent's record changes shape.
          ...(cost?.premiumRequests !== undefined ? { premiumRequests: cost.premiumRequests } : {}),
          ...(cost?.usagePartial ? { usagePartial: true } : {}),
          ...(cost?.usageUnavailableReason
            ? { usageUnavailableReason: cost.usageUnavailableReason }
            : {}),
          ...(cost?.costSeries && cost.costSeries.length ? { costSeries: cost.costSeries } : {}),
          ...(cost?.dispatches && cost.dispatches.length ? { dispatches: cost.dispatches } : {}),
          skillInvocations,
          agentInvocations,
          commandInvocations,
          sessionSource: detectSessionSource({ skillInvocations, agentInvocations, commandInvocations }),
        });
      }
    }
  }

  // Derive headline totals from the deduped records so every KPI the client can
  // sum exactly equals the headline (no double-counting, no enricher/hierarchy drift).
  let durationMs = 0;
  let turns = 0;
  let files = 0;
  let netLines = 0;
  let toolCallsTotal = 0;
  let toolCallsSuccess = 0;
  let totalCostUSD = 0;
  let cacheReadCostUSD = 0;
  let pricedSessions = 0;
  for (const r of sessions) {
    durationMs += r.durationMs;
    turns += r.turns;
    files += r.fileOps;
    netLines += r.netLines;
    toolCallsTotal += r.toolCallsTotal;
    toolCallsSuccess += r.toolCallsSuccess;
    totalCostUSD += r.costUSD;
    cacheReadCostUSD += r.cacheReadCostUSD;
    if (costIndex.get(r.sessionId)?.priced) {
      pricedSessions += 1;
    }
  }

  const meta: ReportMeta = {
    generatedAt: ctx.generatedAt,
    rangeLabel: ctx.rangeLabel,
    agents: [...agents],
    projectFilter: ctx.projectFilter,
    totals: {
      sessions: sessions.length,
      durationMs,
      turns,
      files,
      netLines,
      toolCallsTotal,
      toolSuccessRate: toolCallsTotal ? Math.round((toolCallsSuccess / toolCallsTotal) * 1000) / 10 : 0,
      totalCostUSD,
      cacheReadCostUSD,
      pricedSessions,
    },
    unpricedModels: summary.unpricedModels,
    coverage: [...coverageMap.values()].sort((a, b) => b.total - a.total),
    ...(ctx.userEmail !== undefined && { userEmail: ctx.userEmail }),
    ...(ctx.periodStart !== undefined
      ? { periodStart: ctx.periodStart }
      : minStartMs !== undefined
        ? { periodStart: new Date(minStartMs).toISOString() }
        : {}),
    ...(ctx.periodEnd !== undefined
      ? { periodEnd: ctx.periodEnd }
      : maxEndMs !== undefined
        ? { periodEnd: new Date(maxEndMs).toISOString() }
        : {}),
  };

  return { meta, sessions };
}
