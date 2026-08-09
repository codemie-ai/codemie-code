/**
 * Pi Incremental Sync Timer
 *
 * Pi has no hook surface that fires mid-run, so without this timer a session's
 * metrics exist only in memory until `onSessionEnd` flushes them. A SIGKILL, a
 * closed terminal, or an OS shutdown therefore loses the entire run. Ticking every
 * ~30 s writes per-record metric deltas to JSONL and uploads whatever is PENDING,
 * so at most one interval's worth of work is ever at risk.
 *
 * Which transcripts to process is read from the run ledger the CodeMie extension
 * writes from inside Pi — never inferred from the session directory. A directory
 * listing cannot tell this run's transcripts from a concurrent `pi`'s, and claiming
 * one uploads a stranger's prompts under this user's identity.
 *
 * @see pi.extension.ts
 */

import { resolve } from 'path';
import type { ProcessingContext } from '@/agents/core/session/BaseProcessor.js';
import type { SessionAdapter } from '@/agents/core/session/BaseSessionAdapter.js';
import type { AgentMetadata } from '@/agents/core/types.js';
import { logger } from '@/utils/logger.js';
import { readPiRunLedger } from './pi.extension.js';
import { PiSessionAdapter } from './pi.session.js';
import type { PiMetricsProcessingContext } from './session/processors/pi.metrics-processor.js';

export interface StartPiIncrementalSyncOptions {
  /** CodeMie session id — names both the ledger and the metric JSONL files. */
  sessionId: string;
  /** Pi agent metadata, used to build the default session adapter. */
  metadata: AgentMetadata;
  /** Builds a fresh ProcessingContext on each tick (cookies/version may rotate). */
  buildContext: () => ProcessingContext;
  /** CodeMie SSO URL used to load stored credentials (e.g. env.CODEMIE_URL). */
  ssoUrl?: string;
  /** Sync API base URL for the upload context (env.CODEMIE_SYNC_API_URL ?? env.CODEMIE_BASE_URL). */
  syncApiUrl?: string;
  /** CLI version string forwarded to the upload context. */
  cliVersion?: string;
  /** Overrides the default and the env interval. Injected by tests. */
  intervalMs?: number;
  /** Overrides the default `PiSessionAdapter`. Injected by tests. */
  adapter?: SessionAdapter;
}

/** Set to `false` to run Pi without the mid-run flush. */
const DISABLE_ENV = 'CODEMIE_PI_SYNC_ENABLED';
const INTERVAL_ENV = 'CODEMIE_PI_SYNC_INTERVAL_MS';

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * How long `stop` waits for a tick that is already running before abandoning it.
 *
 * It is a backstop, not the mechanism: `stop` first tells the tick to skip its upload, so
 * what it normally waits for is a local transcript parse. The bound only matters when the
 * tick was already inside the upload, which no signal can interrupt.
 */
const STOP_DRAIN_TIMEOUT_MS = 5_000;

interface InFlightTick {
  /** Resolves when the tick has finished. Never rejects — `runTick` swallows its errors. */
  readonly done: Promise<void>;
  /** Aborted by `stop`, which makes the tick return instead of starting an upload. */
  readonly stopping: AbortController;
}

const activeTimers = new Map<string, NodeJS.Timeout>();
const inFlightTicks = new Map<string, InFlightTick>();

export function startPiIncrementalSync(options: StartPiIncrementalSyncOptions): void {
  if (process.env[DISABLE_ENV] === 'false') {
    logger.debug(`[pi-incremental-sync] Disabled by ${DISABLE_ENV}=false`);
    return;
  }
  if (activeTimers.has(options.sessionId)) {
    logger.debug(`[pi-incremental-sync] Already running for session ${options.sessionId}`);
    return;
  }

  const intervalMs = resolveIntervalMs(options.intervalMs);

  const timer = setInterval(() => {
    scheduleTick(options);
  }, intervalMs);
  // Don't pin the Node event loop alive solely on this timer; when Pi finishes, the
  // parent must be free to exit rather than wait out an interval.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  activeTimers.set(options.sessionId, timer);

  logger.debug(
    `[pi-incremental-sync] Started (session=${options.sessionId}, intervalMs=${intervalMs})`
  );
}

/**
 * Stop ticking and wait — for a bounded time — on a tick that is already running.
 *
 * The wait is the point. `clearInterval` cancels the *schedule*, not the tick already
 * executing, and the caller's next move is the end-of-session flush over the same
 * `{sessionId}_metrics.jsonl`. Both read the file's record ids before either appends, so
 * an overlap appends the same deltas twice — and the sync path uploads pending records
 * without deduplicating them by record id.
 *
 * The bound is the point too. This runs on the way out of the CLI, and the tick's upload
 * is a 30 s API timeout over three attempts *per batch*: waiting it out would hang the
 * exit for minutes whenever the sync host black-holes traffic. So the tick is first told
 * to skip its upload — the phase that can take minutes and that appends nothing — and only
 * the remainder is awaited, under {@link STOP_DRAIN_TIMEOUT_MS}.
 *
 * If the bound expires the tick was already mid-upload, and the hazard accepted is the
 * inverse of the double-append: `MetricsSyncProcessor` finishes by rewriting the whole
 * metrics file from the snapshot it read, so deltas the session-end flush appends in the
 * meantime can be dropped. One truncated shutdown is the price of never hanging every
 * user whose network is down.
 */
export async function stopPiIncrementalSync(
  sessionId: string,
  /** Overrides {@link STOP_DRAIN_TIMEOUT_MS}. Injected by tests. */
  drainTimeoutMs: number = STOP_DRAIN_TIMEOUT_MS
): Promise<void> {
  const timer = activeTimers.get(sessionId);
  if (timer) {
    clearInterval(timer);
    activeTimers.delete(sessionId);
  }

  const inFlight = inFlightTicks.get(sessionId);
  if (inFlight) {
    inFlight.stopping.abort();
    await drainTick(sessionId, inFlight.done, drainTimeoutMs);
  }

  if (timer || inFlight) {
    logger.debug(`[pi-incremental-sync] Stopped (session=${sessionId})`);
  }
}

/** Await the tick, giving up after `timeoutMs` so a stuck upload cannot hold the CLI open. */
async function drainTick(
  sessionId: string,
  done: Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<'expired'>((resolveExpiry) => {
    timer = setTimeout(() => resolveExpiry('expired'), timeoutMs);
  });

  try {
    const outcome = await Promise.race([done.then(() => 'drained' as const), expiry]);
    if (outcome === 'expired') {
      logger.warn(
        `[pi-incremental-sync] Gave up waiting for the in-flight tick after ${timeoutMs} ms `
        + `(session=${sessionId}); it is most likely still uploading`
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

function resolveIntervalMs(override?: number): number {
  if (override !== undefined && override > 0) return override;

  // A non-positive delay is not "use the default" to Node: it clamps to 1 ms, so a
  // mistyped env var turns the timer into a hot loop that re-parses every transcript.
  const fromEnv = Number(process.env[INTERVAL_ENV]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_INTERVAL_MS;
}

/**
 * Run a tick unless one is already running, and publish it so `stop` can await it.
 *
 * Re-entrancy is guarded rather than queued: a tick that outruns the interval means
 * the transcripts are large, and stacking another parse on top would only compound
 * that. The skipped work is picked up by the next tick, which re-reads the ledger.
 */
function scheduleTick(options: StartPiIncrementalSyncOptions): void {
  const { sessionId } = options;
  if (inFlightTicks.has(sessionId)) {
    logger.debug(`[pi-incremental-sync] Tick still running, skipping (session=${sessionId})`);
    return;
  }

  const stopping = new AbortController();
  const done: Promise<void> = runTick(options, stopping.signal).finally(() => {
    // Only retract our own entry: a stop/start cycle may have published a newer tick.
    if (inFlightTicks.get(sessionId)?.done === done) {
      inFlightTicks.delete(sessionId);
    }
  });
  inFlightTicks.set(sessionId, { done, stopping });
}

/**
 * Process every transcript the ledger attributes to this run, then push what the
 * processors wrote.
 */
async function runTick(
  options: StartPiIncrementalSyncOptions,
  stopping: AbortSignal
): Promise<void> {
  try {
    const ledger = await readPiRunLedger(options.sessionId);
    if (ledger.transcripts.length === 0) {
      logger.debug(`[pi-incremental-sync] No transcripts yet for session ${options.sessionId}`);
      return;
    }

    const adapter = options.adapter ?? new PiSessionAdapter(options.metadata);
    const gitBranch = await resolveRunGitBranch(options.sessionId, ledger.cwd);

    for (const transcript of ledger.transcripts) {
      try {
        const result = await adapter.processSession(
          transcript,
          options.sessionId,
          buildTickContext(options, gitBranch)
        );
        logger.debug(
          `[pi-incremental-sync] tick ok session=${options.sessionId} `
          + `transcript=${transcript} records=${result.totalRecords}`
        );
      } catch (error) {
        // One unreadable transcript must not strand the others in the same run.
        logger.error(`[pi-incremental-sync] processSession failed for ${transcript}:`, error);
      }
    }

    // Everything above appends to the metrics JSONL, so it is drained in full; the upload
    // only reads and rewrites it, and it is the phase that can take minutes. A stop that
    // lands before it starts skips it outright — the session-end flush that follows syncs
    // exactly what this upload would have.
    if (stopping.aborted) {
      logger.debug(
        `[pi-incremental-sync] Stopping, so this tick skips its upload (session=${options.sessionId})`
      );
      return;
    }

    await uploadPending(options);
  } catch (error) {
    logger.error('[pi-incremental-sync] tick failed:', error);
  }
}

/**
 * The processing context for one mid-run tick.
 *
 * Two things separate it from the end-of-session context: the branch, which the metrics
 * aggregator emits one record per, so deltas written without it land in a second,
 * unattributed bucket for the same session; and the terminality of a missing tool result,
 * which mid-run means "still running" rather than "never finished".
 *
 * The resolved branch outranks any the caller's context carries, because the caller can
 * only know the branch CodeMie was launched on — which is the wrong one precisely when the
 * two differ. See {@link resolveRunGitBranch}.
 */
function buildTickContext(
  options: StartPiIncrementalSyncOptions,
  gitBranch: string | undefined
): PiMetricsProcessingContext {
  return {
    ...options.buildContext(),
    ...(gitBranch && { gitBranch }),
    emitUnresolvedToolCalls: false,
  };
}

/**
 * The branch this run's deltas belong under — the one the end-of-run correlation settles on.
 *
 * `correlateRunToSession` rewrites the session record's branch at session end whenever the
 * ledger's cwd is a different checkout than the one CodeMie was launched from, which is
 * what `codemie pi --session /other/repo/x.jsonl` does. The aggregator emits one record per
 * distinct branch, so a tick that stamped the launch branch would split a single session
 * across two branch records. Reading the cwd the ledger records about itself is identity,
 * not attribution.
 */
async function resolveRunGitBranch(
  sessionId: string,
  ledgerCwd: string | undefined
): Promise<string | undefined> {
  try {
    const { SessionStore } = await import('@/agents/core/session/SessionStore.js');
    const session = await new SessionStore().loadSession(sessionId);

    if (
      ledgerCwd &&
      session?.workingDirectory &&
      resolve(ledgerCwd) !== resolve(session.workingDirectory)
    ) {
      const { detectGitBranch } = await import('@/utils/processes.js');
      return (await detectGitBranch(ledgerCwd)) ?? session.gitBranch;
    }

    return session?.gitBranch;
  } catch (error) {
    logger.debug('[pi-incremental-sync] Could not resolve the run git branch:', error);
    return undefined;
  }
}

async function uploadPending(options: StartPiIncrementalSyncOptions): Promise<void> {
  if (!options.ssoUrl || !options.syncApiUrl) return;

  try {
    const uploadContext = await buildUploadContext(
      options.sessionId,
      options.ssoUrl,
      options.syncApiUrl,
      options.cliVersion
    );
    if (!uploadContext) return;

    const { SessionSyncer } = await import(
      '@/providers/plugins/sso/session/SessionSyncer.js'
    );
    const result = await new SessionSyncer().sync(options.sessionId, uploadContext);
    logger.debug(
      `[pi-incremental-sync] upload ${result.success ? 'ok' : 'partial'}: ${result.message}`
    );
  } catch (error) {
    // An upload failure leaves the payloads PENDING; the next tick retries them.
    logger.error('[pi-incremental-sync] upload failed:', error);
  }
}

async function buildUploadContext(
  sessionId: string,
  ssoUrl: string,
  syncApiUrl: string,
  version = '0.0.0'
): Promise<ProcessingContext | null> {
  try {
    const { CodeMieSSO } = await import('@/providers/plugins/sso/sso.auth.js');
    const credentials = await new CodeMieSSO().getStoredCredentials(ssoUrl);
    if (!credentials?.cookies) {
      logger.debug('[pi-incremental-sync] No SSO credentials available, skipping upload');
      return null;
    }
    const cookies = Object.entries(credentials.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    return {
      apiBaseUrl: syncApiUrl,
      cookies,
      clientType: 'codemie-pi',
      version,
      dryRun: false,
      sessionId,
    };
  } catch (error) {
    logger.debug('[pi-incremental-sync] Failed to build upload context:', error);
    return null;
  }
}
