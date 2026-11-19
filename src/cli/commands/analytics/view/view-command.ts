/**
 * `codemie analytics view` — the Analytics page's numbers, one session's trace, or the HTML
 * report, computed from an existing `codemie analytics --export json` file. It never reads agent
 * logs, so it answers in well under a second for any range the file covers.
 *
 * Machine output: JSON on stdout (or `-o`), no prompts, no colours. A problem is one `✗ …` line
 * on stderr and exit code 1.
 */

import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '@/utils/logger.js';
import { generateReport } from '../report/report-generator.js';
import type { AgentCoverage } from '../cost/types.js';
import type { ReportPayload, ReportSessionRecord } from '../report/types.js';
import { ViewInputError, readExportFile, viewFilterFrom, type ViewFilterOptions } from './input.js';
import { buildSummary, filterRecords } from './summary.js';
import { buildTrace } from './trace.js';
import { SESSION_SCHEMA, type SessionDetail, type ViewFilter } from './types.js';

interface ViewOptions extends ViewFilterOptions {
  input: string;
  compare?: boolean;
  session?: string;
  /** `true` when `--export` was bound to `analytics`'s own `--export [format]` without a value. */
  export: string | true;
  output?: string;
}

export function createViewCommand(): Command {
  return new Command('view')
    .description('Summaries, one session\'s trace or the HTML report from an exported JSON file, without reading agent logs')
    .requiredOption('--input <file>', 'A file written by `codemie analytics --export json`')
    .option('--from <date>', 'Start, inclusive: YYYY-MM-DD (a UTC day) or an ISO timestamp')
    .option('--to <date>', 'End, inclusive: YYYY-MM-DD (the whole UTC day) or an ISO timestamp')
    .option('--last <duration>', 'Sessions from the last duration (e.g. 7d, 24h); overrides --from/--to')
    .option('--agent <name>', 'Only this agent (claude, codex, …)')
    .option('--project <path>', 'Only this project: its full path or its folder name')
    .option('--branch <name>', 'Only this git branch')
    .option('--compare', 'Add the totals of the same-length range just before, and the change')
    .option('--session <id>', 'Print one session with its step trace instead of a summary')
    .option('--export <format>', 'summary (JSON) or html', 'summary')
    .option('-o, --output <path>', 'Write to this file instead of stdout (required for html)')
    // `analytics` defines --from, --to, --last, --agent, --project, --branch, --session, --export
    // and -o too, and the root program parses without positional options, so commander binds
    // those to `analytics` even when they follow `view`. optsWithGlobals() merges both, as `otel` does.
    .action((_options: ViewOptions, command: Command) => runView(command.optsWithGlobals() as ViewOptions));
}

function runView(options: ViewOptions): void {
  const now = Date.now();
  try {
    const format = options.export === true ? 'summary' : options.export.toLowerCase();
    if (format !== 'summary' && format !== 'html') {
      throw new ViewInputError(`Invalid --export format "${options.export}" — use summary or html`);
    }
    if (format === 'html' && !options.output) {
      throw new ViewInputError('--export html writes a file: add -o <path>');
    }
    if (options.session && format === 'html') {
      throw new ViewInputError('--session prints one session as JSON: leave out --export html');
    }
    const filter = viewFilterFrom(options, now);
    const payload = readExportFile(options.input);

    if (options.session) {
      const session = payload.sessions.find((s) => s.sessionId === options.session);
      if (!session) {
        throw new ViewInputError(`No session "${options.session}" in ${options.input}`);
      }
      const detail: SessionDetail = { schema: SESSION_SCHEMA, session, trace: buildTrace(session) };
      writeOutput(`${JSON.stringify(detail, null, 2)}\n`, options.output);
    } else if (format === 'html') {
      const sessions = filterRecords(payload.sessions, filter);
      generateReport(reportPayloadFor(payload, sessions, options, filter, now), options.output!);
    } else {
      const summary = buildSummary(payload, filter, { compare: Boolean(options.compare), now });
      writeOutput(`${JSON.stringify(summary, null, 2)}\n`, options.output);
    }
  } catch (error) {
    if (!(error instanceof ViewInputError)) {
      logger.debug('analytics view failed:', error);
    }
    const message = error instanceof ViewInputError ? error.message : `Analytics view failed: ${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`✗ ${message.split('\n')[0]}\n`);
    process.exitCode = 1;
  }
}

function writeOutput(text: string, output: string | undefined): void {
  if (!output) {
    process.stdout.write(text);
    return;
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, text, 'utf-8');
}

/**
 * The export's payload cut to `sessions`, with the meta a direct export of those sessions would
 * carry: totals and coverage as `payload-builder.ts` computes them, the agents and model lists of
 * these sessions only, and the filter's period.
 */
function reportPayloadFor(source: ReportPayload, sessions: ReportSessionRecord[], options: ViewOptions, filter: ViewFilter, now: number): ReportPayload {
  const totals = { sessions: sessions.length, durationMs: 0, turns: 0, files: 0, netLines: 0, toolCallsTotal: 0, toolSuccessRate: 0, totalCostUSD: 0, cacheReadCostUSD: 0, pricedSessions: 0 };
  let toolCallsSuccess = 0;
  const coverage = new Map<string, AgentCoverage>();
  const models = new Set<string>();
  for (const s of sessions) {
    const priced = (s.perModelCost?.length ?? 0) > 0;
    totals.durationMs += s.durationMs;
    totals.turns += s.turns;
    totals.files += s.fileOps;
    totals.netLines += s.netLines;
    totals.toolCallsTotal += s.toolCallsTotal;
    toolCallsSuccess += s.toolCallsSuccess;
    totals.totalCostUSD += s.costUSD;
    totals.cacheReadCostUSD += s.cacheReadCostUSD;
    if (priced) totals.pricedSessions += 1;
    const cov = coverage.get(s.agentName) ?? { agentName: s.agentName, total: 0, priced: 0, withLog: 0 };
    cov.total += 1;
    if (s.hadLog) cov.withLog += 1;
    if (priced) cov.priced += 1;
    coverage.set(s.agentName, cov);
    for (const m of s.perModelCost ?? []) models.add(m.model);
  }
  totals.toolSuccessRate = totals.toolCallsTotal ? Math.round((toolCallsSuccess / totals.toolCallsTotal) * 1000) / 10 : 0;
  const meta = source.meta;
  return {
    meta: {
      ...meta,
      generatedAt: new Date(now).toISOString(),
      rangeLabel: options.last ?? (options.from || options.to ? 'custom' : meta.rangeLabel),
      agents: [...new Set(sessions.map((s) => s.agentName))],
      projectFilter: options.project ?? meta.projectFilter,
      totals,
      unpricedModels: (meta.unpricedModels ?? []).filter((m) => models.has(m)),
      estimatedModels: (meta.estimatedModels ?? []).filter((m) => models.has(m)),
      localModels: (meta.localModels ?? []).filter((m) => models.has(m)),
      coverage: [...coverage.values()].sort((a, b) => b.total - a.total),
      ...(filter.from !== undefined && { periodStart: new Date(filter.from).toISOString() }),
      ...(filter.to !== undefined && { periodEnd: new Date(filter.to).toISOString() }),
    },
    sessions,
  };
}
