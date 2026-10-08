/**
 * Env-backed tuning for the OTLP spool. Read lazily on every call so overrides
 * take effect without a restart.
 *
 * Duration knobs are in minutes and accept fractions (`0.5` = 30s). A missing,
 * unparsable, zero or negative value falls back to the default — notably, a
 * zero interval would otherwise degenerate into a spin loop.
 */

const MINUTE_MS = 60_000;

function envMinutesMs(name: string, fallbackMinutes: number): number {
  const parsed = Number(process.env[name]);
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMinutes;
  return minutes * MINUTE_MS;
}

function envCount(name: string, fallbackValue: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackValue;
}

function envBoolean(name: string, fallbackValue: boolean): boolean {
  const raw = process.env[name];
  return raw === undefined ? fallbackValue : raw === 'true';
}

/** How often pending spool bytes are forwarded. */
export function sendIntervalMs(): number {
  return envMinutesMs('OTLP_SEND_INTERVAL_MINUTES', 2);
}

/** How often drained, inactive sessions are garbage-collected. */
export function sweepIntervalMs(): number {
  return envMinutesMs('OTLP_SWEEP_INTERVAL_MINUTES', 15);
}

/**
 * Ticks a hooks-only session waits for OTEL data before being force-forwarded.
 *
 * NOTE: this is a tick count, so the effective wait is
 * `sendIntervalMs() * hooksOnlyWaitTicks()` — currently ~6 minutes, chosen to
 * out-wait one OTEL exporter flush cycle (~60s) plus a send interval.
 * Revisit this value whenever OTLP_SEND_INTERVAL_MINUTES changes.
 *
 * The same tick limit also bounds how long an OTEL-only session waits for hooks
 * before being skipped, so changing it changes the untracked-data retention
 * window and the late-hooks tolerance for tracked sessions.
 */
export function hooksOnlyWaitTicks(): number {
  return envCount('OTLP_SEND_MAX_ATTEMPTS', 3);
}

/** Whether a hooks-only session may be forwarded without any OTEL data. */
export function hooksOnlyForwardAllowed(): boolean {
  return envBoolean('OTLP_ALLOW_HOOKS_ONLY_FORWARD', true);
}

/**
 * Quiet period after a normally ended session (`endedAt`) before its drained
 * spool may be deleted. Sized to cover a late OTEL export plus the send
 * interval needed to forward it.
 */
export function endedSessionGraceMs(): number {
  return envMinutesMs('OTLP_ENDED_SESSION_GRACE_MINUTES', 15);
}

/**
 * Inactivity period after which a session that never reported `SessionEnd` is
 * considered abandoned and its drained spool may be deleted. Measured from the
 * latest spool-file write, never from session creation or cursor updates.
 */
export function abandonedSessionGraceMs(): number {
  return envMinutesMs('OTLP_ABANDONED_SESSION_GRACE_MINUTES', 60);
}
