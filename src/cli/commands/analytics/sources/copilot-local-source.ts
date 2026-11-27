import { MetricsDataLoader } from '../data-loader.js';
import { logger } from '@/utils/logger.js';
import type { AnalyticsFilter } from '../types.js';
import type { AnalyticsSource, SourceLoadOptions, SourceResult } from './types.js';

/**
 * GitHub Copilot local source: usage scanned from Copilot's own on-disk artifacts — the
 * CLI/Desktop `session-store.db`, its per-session `events.jsonl`, the VS Code extension's
 * chat-session logs, and the same stores inside running WSL distros.
 *
 * Cost is authoritative in the sense `SourceResult.cost` means: the source computed it and the
 * runner must not re-enrich. It is still a token ESTIMATE (`costSource: 'native-estimate'`),
 * because Copilot bills premium requests rather than tokens and reports no per-call dollar
 * figure — the premium-request counters ride along on each row instead.
 *
 * Deliberately NOT merged into {@link SessionsSource}: `native-loader` already discovers
 * `copilot-cli` sessions from `~/.copilot/session-state/`, so merging without a dedup policy
 * would double-count every CLI session. Exposed as `codemie analytics copilot` until that is
 * settled (see `docs/SPEC-copilot-local-statistics.md`).
 */
export class CopilotLocalSource implements AnalyticsSource {
  constructor(private readonly options: { maxAgeDays?: number; skipWsl?: boolean; skipVsCode?: boolean } = {}) {}

  async load(opts: SourceLoadOptions): Promise<SourceResult> {
    const { loadCopilotLocalSessions } = await import('../copilot-local/index.js');
    const result = await loadCopilotLocalSessions({
      maxAgeDays: this.options.maxAgeDays ?? windowDays(opts.filter),
      skipWsl: this.options.skipWsl,
      skipVsCode: this.options.skipVsCode,
    });

    for (const health of result.health) {
      if (health.reasons.length > 0 || health.errors > 0) {
        logger.debug(
          `[copilot-local] ${health.scanner}: ${health.rowsRead} row(s), ${health.errors} error(s)` +
            `${health.reasons.length > 0 ? ` — ${health.reasons.join(', ')}` : ''}`
        );
      }
    }

    // Honor the structural filters this source can evaluate from session metadata. The date
    // window is already applied during the scan, so it is left out here to avoid filtering
    // twice on two different clocks.
    const structural: AnalyticsFilter = {
      ...(opts.filter.agentName && { agentName: opts.filter.agentName }),
      ...(opts.filter.projectPattern && { projectPattern: opts.filter.projectPattern }),
      ...(opts.filter.branch && { branch: opts.filter.branch }),
    };
    const loader = new MetricsDataLoader();
    const rawSessions = result.rawSessions.filter(
      (session) =>
        (!opts.filter.sessionId || session.sessionId === opts.filter.sessionId) &&
        loader.sessionMatchesFilter(session, structural)
    );

    return { rawSessions, cost: { index: result.costIndex, summary: result.summary } };
  }
}

/**
 * The filter's date window as a day count, when it names one.
 *
 * The scanners take an age in days (Copilot's own artifacts are addressed by mtime and
 * `created_at`, not by a date range), so a `--from` boundary becomes "this many days back".
 * Rounded up, so the requested day is always fully inside the scan.
 */
function windowDays(filter: AnalyticsFilter): number | undefined {
  const from = filter.fromDate?.getTime();
  if (from === undefined || !Number.isFinite(from)) {
    return undefined;
  }
  return Math.max(1, Math.ceil((Date.now() - from) / 86_400_000));
}
