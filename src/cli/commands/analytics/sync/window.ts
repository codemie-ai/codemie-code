/**
 * Date windows for `codemie analytics sync`.
 *
 * `dailyWindow` builds the recurring day-to-day sync window from the last-sent marker. There
 * is no backfill window any more (EPMCDME-16488 dropped `--from`/`--to`/`--last`): `run`
 * always syncs the daily window computed here.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface SyncWindow {
  from: Date;
  to: Date;
  label: string;
}

function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dailyLabel(from: Date, to: Date): string {
  return `${formatUtcDate(from)}-to-${formatUtcDate(to)}`;
}

/**
 * Build the recurring daily sync window.
 *
 * `from = now - max(lookbackDays·24h, (now - lastSent) + 1h safety margin)`. With no
 * marker (`lastSent === null`), the window is exactly `lookbackDays` wide.
 */
export function dailyWindow(now: Date, lastSent: Date | null, lookbackDays: number): SyncWindow {
  const lookbackMs = lookbackDays * DAY_MS;
  const spanMs =
    lastSent === null ? lookbackMs : Math.max(lookbackMs, now.getTime() - lastSent.getTime() + HOUR_MS);

  const from = new Date(now.getTime() - spanMs);
  const to = now;

  return {
    from,
    to,
    label: dailyLabel(from, to)
  };
}
