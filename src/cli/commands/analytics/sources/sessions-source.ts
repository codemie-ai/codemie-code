import { MetricsDataLoader } from '../data-loader.js';
import { logger } from '../../../../utils/logger.js';
import type { AnalyticsSource, SourceLoadOptions, SourceResult } from './types.js';

/**
 * Local-session source: ~/.codemie tracked sessions merged with discovered native agent
 * logs (plain `claude` etc.). Cost is omitted here and derived by the cost-enricher only
 * when a report is requested, matching the original analytics behavior.
 */
export class SessionsSource implements AnalyticsSource {
  async load(opts: SourceLoadOptions): Promise<SourceResult> {
    const loader = new MetricsDataLoader();
    const rawSessions = loader.loadSessions(opts.filter);

    // Discover native agent logs (not tracked by CodeMie) and merge so analytics reflect
    // ALL usage. Deduped against tracked logs inside the loader.
    if (opts.scanNative !== false) {
      try {
        const { loadNativeSessions } = await import('../native-loader.js');
        const natives = (await loadNativeSessions(opts.filter))
          .filter((s) => loader.sessionMatchesFilter(s, opts.filter))
          .filter((s) => opts.includeExternal || s.startEvent?.data.provider !== 'native-external');
        rawSessions.push(...natives);
      } catch (error) {
        logger.debug('Native session discovery failed (continuing with tracked sessions):', error);
      }
    }
    return { rawSessions };
  }
}
