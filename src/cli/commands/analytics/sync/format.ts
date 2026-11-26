/**
 * Shared presentation helpers for `codemie analytics sync install|status`.
 *
 * Both runners print the same two settings-derived facts (the lookback window and the
 * webhook host with its signature masked); this is the single place that formats them so
 * the wording never drifts between the two commands.
 */

import { DEFAULT_LOOKBACK_DAYS } from './config-store.js';
import { redactSecrets } from './redact.js';
import type { SyncSettings } from './types.js';

/** `"<n> days"`, or `"<DEFAULT_LOOKBACK_DAYS> days (default)"` when the settings were
 * written without `--lookback-days` (so the default tracks CLI updates). */
export function lookbackText(settings: SyncSettings): string {
  return settings.lookbackDays === undefined
    ? `${DEFAULT_LOOKBACK_DAYS} days (default)`
    : `${settings.lookbackDays} days`;
}

/** Host only — the signature-bearing query string never reaches output. Falls back to a
 * redacted form of the raw URL on the (validated-away) chance it isn't parseable. */
export function webhookHost(webhookUrl: string): string {
  try {
    return new URL(webhookUrl).host;
  } catch {
    return redactSecrets(webhookUrl);
  }
}
