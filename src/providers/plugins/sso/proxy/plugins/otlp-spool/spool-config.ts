/**
 * Env-backed tuning for the OTLP spool. Read lazily on every call so tests and
 * runtime overrides take effect without a restart.
 */

function envNumber(name: string, fallbackValue: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackValue;
}

function envBoolean(name: string, fallbackValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallbackValue;
  return raw === 'true';
}

/** Ticks a hooks-only session waits for OTEL data before being force-forwarded. */
export function hooksOnlyWaitTicks(): number {
  return envNumber('OTLP_SEND_MAX_ATTEMPTS', 4);
}

/** Whether a hooks-only session may be forwarded without any OTEL data. */
export function hooksOnlyForwardAllowed(): boolean {
  return envBoolean('OTLP_ALLOW_HOOKS_ONLY_FORWARD', true);
}

/**
 * Quiet period after a normally ended session (`endedAt`) before its drained
 * spool may be deleted. Gives late hook/OTEL writes time to arrive.
 */
export function endedSessionGraceMs(): number {
  return envNumber('OTLP_ENDED_SESSION_GRACE_MINUTES', 5) * 60_000;
}

/**
 * Inactivity period after which a session that never reported `SessionEnd`
 * is considered abandoned and its drained spool may be deleted.
 */
export function abandonedSessionTimeoutMs(): number {
  return envNumber('STATUS_TTL_MINUTES', 60) * 60_000;
}

export function sendIntervalMs(): number {
  return Math.max(500, envNumber('OTLP_SEND_INTERVAL_MS', 5_000));
}

export function sweepIntervalMs(): number {
  return Math.max(30_000, envNumber('OTLP_SWEEP_INTERVAL_MS', 5 * 60_000));
}
