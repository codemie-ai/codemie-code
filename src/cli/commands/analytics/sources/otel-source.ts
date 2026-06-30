import { existsSync } from 'node:fs';
import { AnalyticsSourceError } from '../../../../utils/errors.js';
import { MetricsDataLoader } from '../data-loader.js';
import type { AnalyticsFilter } from '../types.js';
import type { AnalyticsSource, SourceLoadOptions, SourceResult } from './types.js';

/**
 * OTEL source: a flattened otel-events.jsonl file. Cost is authoritative (native
 * `cost_usd`), so it is returned up-front and bypasses the cost-enricher.
 */
export class OtelSource implements AnalyticsSource {
  constructor(private readonly file: string, private readonly user?: string) {}

  async load(opts: SourceLoadOptions): Promise<SourceResult> {
    if (!existsSync(this.file)) {
      throw new AnalyticsSourceError(`OTEL file not found: ${this.file}`);
    }
    const { loadOtelSessions } = await import('../otel-loader.js');
    const res = loadOtelSessions({
      file: this.file,
      filter: { user: this.user, since: opts.filter.fromDate, until: opts.filter.toDate },
    });

    // Honor the structural CLI filters OTEL can evaluate from session metadata. `--user` and the
    // time window are already applied inside loadOtelSessions (on api_request user/ts); apply the
    // rest here so they are not silently ignored — and so a report is never mislabeled (e.g.
    // `--project foo` must not produce a "project: foo" report that still contains every project).
    // The structural filter is date-free: re-applying the window would conflict with the
    // api_request-time filter already done. `--session` is matched explicitly because
    // sessionMatchesFilter does not cover session id. The cost index is left intact — entries for
    // dropped sessions are inert (downstream only reads cost for sessions present in rawSessions,
    // and keepSessionIds cannot resurrect a session the aggregator never sees).
    const structural: AnalyticsFilter = {
      ...(opts.filter.agentName && { agentName: opts.filter.agentName }),
      ...(opts.filter.projectPattern && { projectPattern: opts.filter.projectPattern }),
      ...(opts.filter.branch && { branch: opts.filter.branch }),
    };
    const loader = new MetricsDataLoader();
    const rawSessions = res.rawSessions.filter(
      (s) =>
        (!opts.filter.sessionId || s.sessionId === opts.filter.sessionId) &&
        loader.sessionMatchesFilter(s, structural)
    );

    return { rawSessions, cost: { index: res.costIndex, summary: res.summary } };
  }
}
