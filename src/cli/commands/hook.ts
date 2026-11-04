import { Command } from 'commander';
import { logger } from '@/utils/logger.js';
import { AgentRegistry } from '@/agents/registry.js';
import { SESSION_ORIGIN, SESSION_ORIGIN_ENV_KEY, type Session } from '@/agents/core/session/types.js';
import type { BaseHookEvent, HookTransformer, MCPConfigSummary, ExtensionsScanSummary } from '@/agents/core/types.js';
import { ensureOtlpProxy } from './proxy/connect-orchestrator.js';
import { forwardOtlpEventsToSpool } from '@/agents/plugins/utils.js';
import { ensureCodeMieSsoAuth, ensureCodeMieSsoAuthOrWait, type AuthGateInput } from '@/providers/plugins/sso/sso.auth-gate.js';
import { describeLogin } from '@/providers/plugins/sso/sso.detached-login.js';
import {
  lastRecordedActivityAt,
  markDroppedIfUndelivered,
  maxDeltaTimestamp,
  readLiveRecord,
  reconcileLockPath,
} from '@/agents/core/session/stale-session-reconciliation.js';
import { sameHost } from '@/agents/core/session/send-path.js';
import { syntheticSessionEnd } from '@/agents/core/session/synthetic-session-end.js';
import { nextRecordStart } from '@/agents/core/session/next-record-start.js';
import { isClosedGeneration, moveSetToGeneration } from '@/agents/core/session/session-generation.js';
import { configSendPathApiUrl, getConfigValue } from './hook/config-value.js';
import { applySessionEndOptions, sessionEndOptions, type SessionEndOptions } from './hook/session-end-options.js';
import type { PidLock } from '@/utils/pid-lock.js';
import { isSessionFileLockTimeout } from '@/utils/errors.js';
import { buildProcessingContext } from './hook/processing-context.js';
import { loadAnalyticsCookies } from './hook/analytics-cookies.js';
import { deliverSessionRecord, liveWrapperDelivering, nativeSessionId } from './hook/delivery.js';
import { ensureOwnGeneration, generationStartEvent, isOtherGeneration } from './hook/own-generation.js';
import { getSessionPath } from '@/agents/core/session/session-config.js';
import { existsSync } from 'fs';

/**
 * Hook event handlers for agent lifecycle events
 * Called by agent plugin hooks via stdin JSON
 *
 * This is a unified hook handler that routes based on hook_event_name
 * from the JSON payload. All agent hooks send their event type.
 */

/**
 * SessionStart event
 */
export interface SessionStartEvent extends BaseHookEvent {
  hook_event_name: 'SessionStart';
  source: string;                  // e.g., "startup"; "late-start" on the start a later event synthesizes
  /**
   * Set only by the start a later event synthesizes for its generation: where the previous
   * generation ended. Never read from a parsed payload
   */
  startTime?: number;
}

/**
 * The outcome of setting aside the generation `{id}.json` holds for another one. `closed`: the
 * previous generation is gone from `{id}.json` (`previousEnd`: the end its close wrote); `own`: the
 * record is the caller's own generation, unclosed (another hook process of it wrote it first),
 * nothing closed or moved; `kept`: the previous generation stays in `{id}.json`.
 */
interface GenerationClose {
  outcome: 'closed' | 'own' | 'kept';
  previousEnd?: number;
}

/**
 * SessionEnd event
 */
export interface SessionEndEvent extends BaseHookEvent {
  hook_event_name: 'SessionEnd';
  reason: string;                  // e.g., "exit", "logout"
  cwd: string;                     // Always present for SessionEnd
}

/**
 * SubagentStop event
 */
export interface SubagentStopEvent extends BaseHookEvent {
  hook_event_name: 'SubagentStop';
  agent_id: string;                // Sub-agent ID
  agent_transcript_path: string;   // Path to agent's transcript file
  stop_hook_active: boolean;       // Whether stop hook is active
  cwd: string;                     // Current working directory
}

/**
 * Configuration for hook event processing
 * Used for programmatic API usage (when not using environment variables)
 */
export interface HookProcessingConfig {
  /** Agent name (e.g., 'claude', 'gemini') */
  agentName: string;
  /** CodeMie session ID */
  sessionId: string;
  /** Provider name (e.g., 'ai-run-sso') */
  provider?: string;
  /** API base URL */
  apiBaseUrl?: string;
  /** SSO cookies for authentication */
  cookies?: string;
  /** API key for localhost development */
  apiKey?: string;
  /** Client type identifier (e.g., 'vscode-codemie', 'codemie-cli') */
  clientType?: string;
  /** Client version */
  version?: string;
  /** Profile name for logging */
  profileName?: string;
  /** Project name */
  project?: string;
  /** Model name */
  model?: string;
  /** SSO URL for credential loading */
  ssoUrl?: string;
  /** Optional dedicated CodeMie API URL for analytics sync */
  syncApiUrl?: string;
  /**
   * Environment carrying CODEMIE_PROFILE_CONFIG (the active profile URL) for
   * credential lookup; defaults to process.env. In-process callers pass the
   * agent env, which the main process does not inherit.
   */
  env?: NodeJS.ProcessEnv;
  /** Pid of the process that owns the session (the in-process wrapper); stored with `ownerStartedAt`, both or none */
  ownerPid?: number;
  /** Start time (Unix ms) of the `ownerPid` process */
  ownerStartedAt?: number;
  /** Stops the SessionEnd network work (end metric, sync) at once */
  abortSignal?: AbortSignal;
  /** Epoch ms past which the SessionEnd network work stops (a wrapper's exit deadline may come in `env` instead) */
  deadlineMs?: number;
  /**
   * The caller (the start pass, the wrapper's own-record step) already holds this session's reconcile
   * lock: SessionEnd does not take it again, and a failed flush or status write throws; the record
   * stays `active` and the next start's pass retries it (the start pass counts its attempts)
   */
  holdsReconcileLock?: boolean;
  /** Finalize the record locally only: no end metric, no sync, no rename */
  localOnly?: boolean;
}

/** How long a new generation's close may spend delivering the generation it closes before moving it aside. */
const GENERATION_CLOSE_BUDGET_MS = 2_000;

/**
 * Read JSON from stdin
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Stamps `--event <name>` onto the parsed JSON body as `codemieEventName`, for hosts whose
 * native hook payload carries no event-name field (e.g. Copilot CLI's camelCase events). Falls
 * back to the raw, unmodified input on a parse failure, so `OtlpAgentAdapter.processOtlpEvent`'s
 * own `JSON.parse` — not this helper — is what surfaces a malformed-input error.
 */
export function injectEventName(raw: string, eventName: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return raw;
    }
    return JSON.stringify({ ...(parsed as Record<string, unknown>), codemieEventName: eventName });
  } catch {
    return raw;
  }
}

/**
 * Initialize logger context using CODEMIE_SESSION_ID
 *
 * Uses CODEMIE_SESSION_ID from environment for:
 * - Logging (logger.setSessionId)
 * - Session files (~/.codemie/sessions/{sessionId}.json)
 * - Metrics files (~/.codemie/sessions/{sessionId}_metrics.jsonl)
 * - Conversation files (~/.codemie/sessions/{sessionId}_conversation.jsonl)
 *
 * @returns The CodeMie session ID from environment
 * @throws Error if required environment variables are missing
 */
function initializeLoggerContext(): string {
  const agentName = process.env.CODEMIE_AGENT;
  if (!agentName) {
    // Debug: log which CODEMIE_* variables are present — NAMES ONLY. Values can
    // carry credentials (CODEMIE_API_KEY, CODEMIE_OPENAI_API_KEY, profile config)
    // and the log file is attached to bug reports and support requests.
    const codemieEnvVars = Object.keys(process.env)
      .filter(key => key.startsWith('CODEMIE_'))
      .join(', ');
    logger.debug(`[hook:debug] CODEMIE_AGENT missing. Available CODEMIE_* vars: ${codemieEnvVars || 'none'}`);
    throw new Error('CODEMIE_AGENT environment variable is required');
  }

  // Use CODEMIE_SESSION_ID from environment
  const sessionId = process.env.CODEMIE_SESSION_ID;
  if (!sessionId) {
    throw new Error('CODEMIE_SESSION_ID environment variable is required');
  }

  // Set logger context
  logger.setAgentName(agentName);
  logger.setSessionId(sessionId);

  // Set profile if available
  const profileName = process.env.CODEMIE_PROFILE_NAME;
  if (profileName) {
    logger.setProfileName(profileName);
  }

  logger.debug(`[hook:init] Using CodeMie session ID: ${sessionId.slice(0, 8)}...`);

  return sessionId;
}


/**
 * Handle SessionStart event
 * Creates session correlation document using hook data
 */
async function handleSessionStart(event: SessionStartEvent, _rawInput: string, sessionId: string, config: HookProcessingConfig | undefined, endOptions: SessionEndOptions): Promise<void> {
  // One lock-wait budget for the whole SessionStart; the previous generation's delivery is bounded by its own budget once the lock is held
  const { PID_LOCK_WAIT_BUDGET_MS } = await import('../../utils/pid-lock.js');
  const lockDeadlineMs = Math.min(Date.now() + PID_LOCK_WAIT_BUDGET_MS, endOptions.deadlineMs ?? Infinity);
  // Create session record with correlation information
  await createSessionRecordOverUnclosed(event, sessionId, config, endOptions, lockDeadlineMs);
  // Send session start metrics when CodeMie analytics auth is configured
  await sendSessionStartMetrics(event, sessionId, event.session_id, config);
  // Sync CodeMie skills to Claude Code (.claude/skills/)
  await syncSkillsToClaude(event.cwd || process.cwd());
}

/**
 * Sync CodeMie-managed skills to .claude/skills/ for Claude Code discovery.
 * Non-blocking: errors are logged but do not affect session startup.
 */
async function syncSkillsToClaude(cwd: string): Promise<void> {
  try {
    const { SkillSync } = await import(
      '../../skills/sync/SkillSync.js'
    );
    const sync = new SkillSync();
    const result = await sync.syncToClaude({ cwd });
    if (result.synced.length > 0) {
      logger.info(`[hook:SessionStart] Synced ${result.synced.length} skill(s) to .claude/skills/`);
    }
    if (result.errors.length > 0) {
      logger.debug(`[hook:SessionStart] Skill sync errors: ${result.errors.join(', ')}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug(`[hook:SessionStart] Skill sync failed (non-blocking): ${msg}`);
  }
}


/**
 * Handle SessionEnd event
 * Final sync and status update
 * Note: Session ID cleanup happens automatically on next SessionStart via file detection
 *
 * Claude Code kills this hook fast during session teardown, so state-critical
 * local steps run BEFORE any network sync: a kill mid-sync must not leave the
 * session stuck at status "active". The record is renamed `completed_` only once
 * it is delivered; until then `{id}.json` with `status: completed` is the queue a
 * later run delivers from.
 *
 * Runs under the session's reconcile lock: a hook process tries it once and skips
 * the whole finalization when another process holds it; an in-process caller waits
 * up to its deadline.
 */
async function handleSessionEnd(event: SessionEndEvent, sessionId: string, config: HookProcessingConfig | undefined, options: SessionEndOptions): Promise<void> {
  logger.info(`[hook:SessionEnd] ${JSON.stringify(event)}`);

  const { acquirePidLock } = await import('../../utils/pid-lock.js');
  const lock = options.holdsReconcileLock
    ? undefined
    : await acquirePidLock(
      reconcileLockPath(sessionId),
      options.hookProcess
        ? { mode: 'try', pidOnlyLiveness: true }
        : { mode: 'wait', deadlineMs: options.deadlineMs, signal: options.abortSignal }
    );
  if (lock === null) {
    logger.info(`[hook:SessionEnd] Session ${sessionId} is being finalized by another process; skipping its finalization`);
    return;
  }

  try {
    const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
    let record = await new SessionStore().loadSession(sessionId);
    if (record && isOtherGeneration(record, event.session_id)) {
      if (!(await establishOwnGenerationLocked(event, sessionId, record, config, options))) {
        return;
      }
      record = await new SessionStore().loadSession(sessionId);
    }

    // Re-checked under the lock: a record another process already completed is only delivered
    if (record?.status !== 'completed') {
      if (!(await finalizeSession(event, sessionId, config, options))) {
        return;
      }
    } else {
      logger.debug(`[hook:SessionEnd] Session ${sessionId} is already completed; delivering only`);
    }

    if (options.localOnly) {
      return;
    }
    const wrapperPid = options.hookProcess ? await liveWrapperDelivering(event.reason, config) : undefined;
    if (wrapperPid !== undefined) {
      logger.debug(`[hook:SessionEnd] Delivery of ${sessionId} skipped: left to the live wrapper (pid ${wrapperPid}) at its exit`);
      return;
    }
    await deliverSessionRecord(sessionId, event.session_id, event.reason, config, options);
  } finally {
    await lock?.release();
  }
}

/**
 * Under the reconcile lock the SessionEnd holds: sets the record of another generation aside and
 * writes this event's own, so the finalization and delivery that follow run on it. False when the
 * other generation stays, or when the event's own generation is already closed and moved aside (a
 * late SessionEnd of it): nothing of this event is written.
 */
async function establishOwnGenerationLocked(
  event: SessionEndEvent,
  sessionId: string,
  previous: Session,
  config: HookProcessingConfig | undefined,
  options: SessionEndOptions
): Promise<boolean> {
  if (isClosedGeneration(sessionId, event.session_id)) {
    logger.info(`[hook:SessionEnd] ${event.session_id} is a closed generation of ${sessionId}; nothing finalized or delivered`);
    return false;
  }
  const aside = await setAsideUnclosed(event.session_id, sessionId, config, options);
  if (aside.outcome === 'closed') {
    const startTime = aside.previousEnd ?? previous.endTime ?? (await lastRecordedActivityAt(previous));
    await createSessionRecord(generationStartEvent(event, startTime), sessionId, config);
  }
  if (aside.outcome !== 'kept' && !isOtherGeneration(await readLiveRecord(sessionId), event.session_id) && existsSync(getSessionPath(sessionId))) {
    return true;
  }
  logger.error(`[hook:SessionEnd] ${sessionId}.json holds another generation and no record of ${event.session_id} could be written; not finalized`);
  return false;
}

/**
 * Close a live record: flush the transcript, mark it completed with its end time.
 *
 * With `endTimeFromActivity` the end is the session's last recorded activity —
 * max(startTime, activityStartedAt, the last transcript record the flush read,
 * else the latest delta already written) — and the active time is capped at it;
 * otherwise the end is now.
 *
 * A final pass that could not take a session file lock within its budget closes nothing: the record
 * stays `active` (false), and the next CodeMie start finalizes it as stranded from the sync pointer.
 */
async function finalizeSession(event: SessionEndEvent, sessionId: string, config: HookProcessingConfig | undefined, options: SessionEndOptions): Promise<boolean> {
  if (!event.endTimeFromActivity) {
    // 0. Final activity accumulation (handles edge case: session ends without Stop)
    await accumulateActiveDuration(sessionId);
    // 1. TRANSFORMATION: Transform remaining messages → JSONL (pending)
    const pass = await performIncrementalSync(event, 'SessionEnd', sessionId, config, options, undefined, { finalPass: true });
    if (pass.lockTimedOut) return keptActive(sessionId);
    // 2. Update session status
    await updateSessionStatus(event, sessionId, event.endTime, config);
    return true;
  }

  // The record's own fields are read before the flush writes anything
  const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
  const record = await new SessionStore().loadSession(sessionId);
  const lastDeltaAt = await maxDeltaTimestamp(sessionId);
  // The later-record bound is a wrapper-side scan; a hook process keeps the lower bound alone
  const recordsBeforeMs = record && !options.hookProcess ? await nextRecordStart(record) : undefined;

  const pass = await performIncrementalSync(event, 'SessionEnd', sessionId, config, options, recordsBeforeMs, { finalPass: true });
  if (pass.lockTimedOut) return keptActive(sessionId);
  const { lastRecordAt } = pass;

  // ponytail: activity that produced no transcript record is not counted
  const endTime = event.endTime ?? Math.max(
    record?.startTime ?? 0,
    record?.activityStartedAt ?? 0,
    lastRecordAt ?? lastDeltaAt ?? 0
  );
  logger.info(
    `[hook:SessionEnd] End from activity: ${new Date(endTime).toISOString()} ` +
    `(last record ${lastRecordAt ?? 'none'}, last delta ${lastDeltaAt ?? 'none'})`
  );
  await accumulateActiveDuration(sessionId, endTime);
  await updateSessionStatus(event, sessionId, endTime, config);
  return true;
}

/** Logs a SessionEnd whose final pass met a held session file lock; always false (not closed). */
function keptActive(sessionId: string): false {
  logger.warn(`[hook:SessionEnd] The final pass of ${sessionId} could not take a session file lock in its budget; kept active, nothing sent, for the next start to finalize`);
  return false;
}

/**
 * Handle PermissionRequest event
 */
async function handlePermissionRequest(event: BaseHookEvent, _rawInput?: string): Promise<void> {
  logger.debug(`[hook:PermissionRequest] ${JSON.stringify(event)}`);
}

/**
 * Logs a session adapter's result; for a caller holding the reconcile lock a failed processor throws
 * its error, so the flush counts as failed.
 */
function logProcessingResult(
  result: { success: boolean; totalRecords: number; failedProcessors: string[]; processors: Record<string, unknown> },
  hookName: string,
  agentSessionFile: string,
  config: HookProcessingConfig | undefined
): void {
  if (result.success) {
    logger.info(`[hook:${hookName}] Session processing complete: ${result.totalRecords} records processed`);
  } else {
    logger.warn(`[hook:${hookName}] Session processing had failures: ${result.failedProcessors.join(', ')}`);
  }

  const failures: string[] = [];
  for (const [name, procResult] of Object.entries(result.processors)) {
    const processor = procResult as { success: boolean; message?: string };
    if (processor.success) {
      logger.debug(`[hook:${hookName}] Processor ${name}: ${processor.message || 'success'}`);
    } else {
      logger.error(`[hook:${hookName}] Processor ${name}: ${processor.message || 'failed'}`);
      failures.push(`${name}: ${processor.message || 'failed'}`);
    }
  }
  if (!result.success && config?.holdsReconcileLock) {
    throw new Error(`Session processing failed for ${agentSessionFile}: ${failures.join('; ') || result.failedProcessors.join(', ')}`);
  }
}

/**
 * Perform incremental sync using unified SessionAdapter
 *
 * @param event - Hook event with transcript_path and session_id
 * @param hookName - Name of the hook for logging (e.g., "Stop", "UserPromptSubmit")
 * @param sessionId - The CodeMie session ID to use for this extraction
 * @param config - Optional configuration object (if not provided, reads from environment variables).
 *   With `holdsReconcileLock` (the start pass, the wrapper's own-record step) a failed flush throws, so
 *   a SessionEnd stops before its status write and the record stays `active` for a later attempt;
 *   otherwise (a hook process, an in-process plugin's own hook) it is logged and the SessionEnd goes on.
 * @param options - The hook's bounds and mode, applied to the processing context; absent → the context stays unbounded
 * @param finalPass - `{ finalPass }`, set only by SessionEnd: the session's last processing pass
 * @returns The latest timed transcript record read, and whether a processor failed on a session file lock it
 *   could not take within the bounds
 */
async function performIncrementalSync(
  event: BaseHookEvent,
  hookName: string,
  sessionId: string,
  config?: HookProcessingConfig,
  options?: SessionEndOptions,
  recordsBeforeMs?: number,
  { finalPass = false }: { finalPass?: boolean } = {}
): Promise<{ lastRecordAt?: number; lockTimedOut: boolean }> {
  // Latest timed transcript record read across the processed files
  let lastRecordAt: number | undefined;
  let lockTimedOut = false;
  logger.debug(`[hook:${hookName}] Event received: ${JSON.stringify(event)}`);
  logger.info(`[hook:${hookName}] Starting session processing (agent_session=${event.session_id})`);

  try {
    // Get agent name from config or environment
    const agentName = getConfigValue('CODEMIE_AGENT', config);

    if (!agentName) {
      if (config) {
        throw new Error(`Missing required config: agentName`);
      }
      logger.warn(`[hook:${hookName}] Missing CODEMIE_AGENT, skipping extraction`);
      return { lockTimedOut: false };
    }

    // Agents may provide a single transcript path or a list of paths (e.g. Pi's
    // /new and /fork operations switch to a new file in the same run). Process
    // every path so metrics are not lost.
    const agentSessionFiles = event.transcript_paths?.length
      ? event.transcript_paths
      : event.transcript_path
        ? [event.transcript_path]
        : [];
    if (agentSessionFiles.length === 0) {
      logger.warn(`[hook:${hookName}] No transcript_path in event, skipping incremental sync`);
      return { lockTimedOut: false };
    }

    logger.debug(`[hook:${hookName}] Using transcript(s): ${agentSessionFiles.join(', ')}`);

    // Get agent from registry
    const agent = AgentRegistry.getAgent(agentName);
    if (!agent) {
      if (config) {
        throw new Error(`Agent not found in registry: ${agentName}`);
      }
      logger.error(`[hook:${hookName}] Agent not found in registry: ${agentName}`);
      return { lockTimedOut: false };
    }

    // Get session adapter (unified approach)
    const sessionAdapter = (agent as any).getSessionAdapter?.();
    if (!sessionAdapter) {
      if (config) {
        throw new Error(`No session adapter available for agent ${agentName}`);
      }
      logger.warn(`[hook:${hookName}] No session adapter available for agent ${agentName}`);
      return { lockTimedOut: false };
    }

    const context = await buildProcessingContext(sessionId, event.session_id, agentSessionFiles[0], config);
    if (options) applySessionEndOptions(context, options);
    context.recordsBeforeMs = recordsBeforeMs;
    if (finalPass) {
      context.finalPass = true;
    }

    // Process every transcript file. Per-file entry deduplication inside the
    // adapter prevents forked/copied history from being double-counted.
    for (const agentSessionFile of agentSessionFiles) {
      logger.debug(`[hook:${hookName}] Calling SessionAdapter.processSession()`);
      const result = await sessionAdapter.processSession(
        agentSessionFile,
        sessionId,
        context
      );

      if (result.lastRecordAt !== undefined && (lastRecordAt === undefined || result.lastRecordAt > lastRecordAt)) {
        lastRecordAt = result.lastRecordAt;
      }
      if (Object.values(result.processors as Record<string, { success: boolean; message?: string }>)
        .some((processor) => !processor.success && isSessionFileLockTimeout(processor.message))) {
        lockTimedOut = true;
      }

      logProcessingResult(result, hookName, agentSessionFile, config);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[hook:${hookName}] Session processing failed: ${errorMessage}`);
    if (config?.holdsReconcileLock) {
      throw error;
    }
    if (isSessionFileLockTimeout(error)) lockTimedOut = true;
    // Don't throw - hook should not block agent execution or user prompts
  }
  return { lastRecordAt, lockTimedOut };
}

/**
 * Helper: Start activity tracking for a session
 * Called on UserPromptSubmit to mark the start of active time
 *
 * @param sessionId - The CodeMie session ID
 */
async function startActivityTracking(sessionId: string): Promise<void> {
  try {
    const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
    const sessionStore = new SessionStore();
    await sessionStore.startActivityTracking(sessionId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`[hook] Failed to start activity tracking: ${errorMessage}`);
    // Don't throw - activity tracking failure should not block user prompts
  }
}

/**
 * Helper: Accumulate active duration for a session
 * Called on Stop/SessionEnd to mark the end of active time
 *
 * @param sessionId - The CodeMie session ID
 * @returns The duration accumulated in this call (0 if no active period)
 */
async function accumulateActiveDuration(sessionId: string, upTo?: number): Promise<number> {
  try {
    const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
    const sessionStore = new SessionStore();
    return await sessionStore.accumulateActiveDuration(sessionId, upTo);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`[hook] Failed to accumulate active duration: ${errorMessage}`);
    // Don't throw - duration tracking failure should not block session operations
    return 0;
  }
}

/**
 * Handle UserPromptSubmit event
 * Starts activity tracking to measure active session time
 */
async function handleUserPromptSubmit(event: BaseHookEvent, sessionId: string, config?: HookProcessingConfig): Promise<void> {
  logger.info(`[hook:UserPromptSubmit] ${JSON.stringify(event)}`);
  await enforceAnalyticsAuthGate(config);
  // A prompt never waits on the reconcile lock: the next Stop establishes this generation's record
  const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
  if (isOtherGeneration(await new SessionStore().loadSession(sessionId), event.session_id)) {
    if (isClosedGeneration(sessionId, event.session_id)) {
      logger.info(`[hook:UserPromptSubmit] ${event.session_id} is a closed generation of ${sessionId}; activity not tracked`);
    } else {
      logger.debug(`[hook:UserPromptSubmit] ${sessionId} holds another generation's record; activity of ${event.session_id} not tracked`);
    }
    return;
  }
  await startActivityTracking(sessionId);
}

/**
 * Analytics auth gate (generic for all agents using the unified hook handler).
 *
 * Blocks the prompt (exit code 2, stderr fed back to the agent) when CodeMie
 * analytics sync is configured but authentication is known to be broken:
 * - no valid stored SSO credentials (and no CODEMIE_API_KEY), or
 * - the metrics endpoint previously rejected the credentials (invalid-auth
 *   marker written by MetricsApiClient on 401/403 or HTML SSO login page).
 *
 * Without this gate, expired analytics credentials fail silently and sessions
 * disappear from metrics. The marker is cleared by `codemie profile login`
 * and by any successful metrics send.
 */
// Agents whose prompt hook can hold the prompt while a sign-in completes. Kimi's 5s hook budget
// and OpenCode's ignored block cannot wait; programmatic (VSCode) mode never waits.
const AUTH_WAIT_AGENTS = new Set(['claude', 'gemini']);

async function enforceAnalyticsAuthGate(config?: HookProcessingConfig): Promise<void> {
  try {
    const provider = getConfigValue('CODEMIE_PROVIDER', config);
    const ssoUrl = getConfigValue('CODEMIE_URL', config);
    const syncApiUrl = getConfigValue('CODEMIE_SYNC_API_URL', config);
    // The analytics-auth-status marker records the LLM-request proxy's own target URL
    // (SSOSessionExpiryPlugin writes `targetApiUrl`), which can differ from the sync/SSO URLs
    // above — without this, the gate's profile-match check (sso.auth-gate.ts's
    // markerAppliesToProfile) never sees the one URL the marker is actually keyed to and
    // silently ignores it. In this hook's own process, CODEMIE_BASE_URL has already been
    // rewritten to the local proxy's URL by BaseAgentAdapter.setupProxy before the agent (and
    // this hook) were spawned, so it no longer matches — CODEMIE_TARGET_API_URL is the original
    // value setupProxy preserves for exactly this (PR #661 review).
    const baseUrl = getConfigValue('CODEMIE_TARGET_API_URL', config) || getConfigValue('CODEMIE_BASE_URL', config);

    const authInput: AuthGateInput = {
      provider,
      ssoUrl,
      baseUrl,
      syncApiUrl,
      apiKey: getConfigValue('CODEMIE_API_KEY', config),
      env: config?.env,
    };

    const canWait = !config && AUTH_WAIT_AGENTS.has(getConfigValue('CODEMIE_AGENT', config) ?? '');
    const authResult = canWait
      ? await ensureCodeMieSsoAuthOrWait(authInput, { onWaitStart: (m) => console.error(m) })
      : await ensureCodeMieSsoAuth(authInput);
    if (authResult.ok) {
      return;
    }

    const message = [
      `Reason: ${authResult.reason}.`,
      describeLogin(authResult.loginOutcome, { wait: authResult.waitResult }),
    ].join('\n');

    logger.warn(`[hook:UserPromptSubmit] Blocking prompt: ${authResult.reason}`);

    if (config) {
      // Programmatic mode (e.g. VSCode extension): let the host decide how to
      // surface the failure instead of exiting its process
      throw new Error(message);
    }

    await logger.close();
    console.error(message);
    process.exit(2); // Blocking: stderr is fed back to the agent
  } catch (error) {
    if (config) {
      throw error;
    }
    // The gate itself must never break the prompt flow
    logger.debug('[hook:UserPromptSubmit] Auth gate check failed (non-blocking):', error);
  }
}

/**
 * Handle Stop event
 * Extracts metrics and conversations from agent session file incrementally
 */
async function handleStop(event: BaseHookEvent, sessionId: string, config: HookProcessingConfig | undefined, options: SessionEndOptions): Promise<void> {
  const generation = await ensureOwnGeneration(event, sessionId, config, options);
  if (generation === 'deferred' || generation === 'closed') {
    return;
  }
  // Accumulate active duration FIRST (marks end of active period)
  await accumulateActiveDuration(sessionId);
  // Then sync metrics/conversations
  await performIncrementalSync(event, 'Stop', sessionId, config, options);
}


/**
 * Handle SubagentStop event
 * Appends agent thought to _conversations.jsonl for later sync
 */
async function handleSubagentStop(event: SubagentStopEvent, sessionId: string, config: HookProcessingConfig | undefined, options: SessionEndOptions): Promise<void> {
  const generation = await ensureOwnGeneration(event, sessionId, config, options);
  if (generation === 'deferred' || generation === 'closed') {
    return;
  }
  await performIncrementalSync(event, 'SubagentStop', sessionId, config, options);
}

/**
 * Handle PreCompact event
 */
async function handlePreCompact(event: BaseHookEvent): Promise<void> {
  logger.debug(`[hook:PreCompact] ${JSON.stringify(event)}`);
}

/**
 * Normalize event name using agent-specific mapping
 * Maps agent-specific event names to internal event names
 *
 * @param eventName - Original event name from hook
 * @param agentName - Agent name (claude, gemini)
 * @returns Normalized internal event name
 */
function normalizeEventName(eventName: string, agentName: string): string {
  try {
    logger.info(`[hook:normalize] Input: eventName="${eventName}", agentName="${agentName}"`);

    // Get agent from registry
    const agent = AgentRegistry.getAgent(agentName);
    if (!agent) {
      logger.warn(`[hook:router] Agent not found for event normalization: ${agentName}`);
      return eventName; // Return original name as fallback
    }

    // Check if agent has event name mapping
    const eventMapping = (agent as any).metadata?.hookConfig?.eventNameMapping;
    if (!eventMapping) {
      logger.info(`[hook:normalize] No mapping defined for agent ${agentName}, using event name as-is`);
      // No mapping defined - assume agent uses internal names (like Claude)
      return eventName;
    }

    logger.info(`[hook:normalize] Available mappings for ${agentName}: ${JSON.stringify(Object.keys(eventMapping))}`);

    // Apply mapping
    const normalizedName = eventMapping[eventName];
    if (normalizedName) {
      logger.info(`[hook:normalize] Mapped: ${eventName} → ${normalizedName} (agent=${agentName})`);
      return normalizedName;
    }

    // Event not in mapping - return original
    logger.info(`[hook:normalize] No mapping found for "${eventName}", using original name`);
    return eventName;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[hook:router] Failed to normalize event name: ${message}`);
    return eventName; // Fallback to original
  }
}

/**
 * Route event to appropriate handler based on hook_event_name
 * Handles events gracefully with detailed logging and error context
 *
 * @param event - The hook event to route (may be transformed)
 * @param rawInput - Raw JSON input string
 * @param sessionId - The CodeMie session ID to use for all operations
 * @param agentName - The agent name for event normalization
 * @param config - Optional configuration object (if not provided, reads from environment variables)
 */
async function routeHookEvent(event: BaseHookEvent, rawInput: string, sessionId: string, agentName: string, config?: HookProcessingConfig, abortSignal?: AbortSignal, hookProcess = false): Promise<void> {
  const startTime = Date.now();

  try {
    // Normalize event name using agent-specific mapping
    const originalEventName = event.hook_event_name;
    logger.info(`[hook:router] Routing event: original="${originalEventName}", agent="${agentName}"`);

    const normalizedEventName = normalizeEventName(originalEventName, agentName);
    logger.info(`[hook:router] Normalized event name: "${normalizedEventName}"`);

    switch (normalizedEventName) {
      case 'SessionStart':
        logger.info(`[hook:router] Calling handleSessionStart`);
        await handleSessionStart(event as SessionStartEvent, rawInput, sessionId, config, sessionEndOptions(config, abortSignal, hookProcess));
        break;
      case 'SessionEnd':
        logger.info(`[hook:router] Calling handleSessionEnd`);
        await handleSessionEnd(event as SessionEndEvent, sessionId, config, sessionEndOptions(config, abortSignal, hookProcess));
        break;
      case 'PermissionRequest':
        logger.info(`[hook:router] Calling handlePermissionRequest`);
        await handlePermissionRequest(event, rawInput);
        break;
      case 'Stop':
        logger.info(`[hook:router] Calling handleStop`);
        await handleStop(event, sessionId, config, sessionEndOptions(config, abortSignal, hookProcess));
        break;
      case 'UserPromptSubmit':
        logger.info(`[hook:router] Calling handleUserPromptSubmit`);
        await handleUserPromptSubmit(event, sessionId, config);
        break;
      case 'SubagentStop':
        logger.info(`[hook:router] Calling handleSubagentStop`);
        await handleSubagentStop(event as SubagentStopEvent, sessionId, config, sessionEndOptions(config, abortSignal, hookProcess));
        break;
      case 'PreCompact':
        logger.info(`[hook:router] Calling handlePreCompact`);
        await handlePreCompact(event);
        break;
      default:
        logger.info(`[hook:router] Unsupported event: ${normalizedEventName} (silently ignored)`);
        return;
    }

    // Deferred ownership marker: covers sessions where transcript_path was empty at
    // SessionStart (transcript file not yet created). appendTranscriptMarker is idempotent —
    // it skips if the per-Claude-session sidecar already exists.
    if (
      event.transcript_path &&
      (normalizedEventName === 'UserPromptSubmit' || normalizedEventName === 'Stop')
    ) {
      const { appendTranscriptMarker, isExternalOrigin } = await import(
        '../../agents/core/session/session-origin-audit.js'
      );
      const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
      const session = await new SessionStore().loadSession(sessionId);
      // Never (re-)stamp a transcript that's flagged external-resume — doing so would
      // re-adopt it into the local analytics ownership index (native-loader.ts).
      if (!isExternalOrigin(session)) {
        appendTranscriptMarker(event.transcript_path, sessionId, agentName);
      }
    }

    const duration = Date.now() - startTime;
    logger.info(`[hook:router] Event handled successfully: ${normalizedEventName} (${duration}ms)`);

  } catch (error: unknown) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    const normalizedEventName = normalizeEventName(event.hook_event_name, agentName);
    logger.error(
      `[hook:router] Event handler failed: ${normalizedEventName} (${duration}ms) error="${message}"`
    );
    throw error;
  }
}

/**
 * Helper: Create and save session record
 * Uses correlation information from hook event
 *
 * @param event - SessionStart event data
 * @param sessionId - The CodeMie session ID from logger context
 * @param config - Optional configuration object (if not provided, reads from environment variables)
 */
async function createSessionRecord(event: SessionStartEvent, sessionId: string, config?: HookProcessingConfig): Promise<void> {
  try {
    // Get metadata from config or environment
    const agentName = getConfigValue('CODEMIE_AGENT', config);
    const provider = getConfigValue('CODEMIE_PROVIDER', config);
    const project = getConfigValue('CODEMIE_PROJECT', config);

    if (!agentName || !provider) {
      if (config) {
        throw new Error('Missing required config: agentName and provider are required for session creation');
      }
      logger.warn('[hook:SessionStart] Missing required env vars for session creation');
      return;
    }

    // Determine working directory
    const workingDirectory = event.cwd || process.cwd();

    // Detect git branch and remote repository in parallel
    let gitBranch: string | undefined;
    let remoteRepository: string | undefined;
    try {
      const { detectGitBranch, detectGitRemoteRepo } = await import('../../utils/processes.js');
      [gitBranch, remoteRepository] = await Promise.all([
        detectGitBranch(workingDirectory),
        detectGitRemoteRepo(workingDirectory),
      ]);
    } catch (error) {
      logger.debug('[hook:SessionStart] Could not detect git info:', error);
    }

    // Import session types and store
    const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
    const sessionStore = new SessionStore();

    // A SessionStart can RE-ENTER an already-tracked LIVE session: `compact` fires SessionStart for
    // the SAME CODEMIE_SESSION_ID without ending the session, so the primary {id}.json is still on
    // disk and loadSession returns the live record. Rebuilding it from scratch would reset startTime
    // to "now" and zero the accumulated activeDurationMs — under-reporting the session's true span
    // and active time (startTime is also read by the metrics aggregator and sent to the backend).
    // Preserve the existing record's accumulated state in place; only refresh status and correlation
    // to the current transcript from fields the event actually provides.
    //
    // Guard on a LIVE record (active + no endTime): exit/logout fire SessionEnd, which marks the record
    // completed (endTime set) and renames {id}.json → completed_{id}.json. Because loadSession
    // transparently falls back to the completed_ file, an unguarded re-entry would RESURRECT a
    // finished session — inheriting its stale startTime/activeDurationMs and leaving an `active`
    // record that still carries a past endTime; completed records fall through to the fresh-build
    // below. This branch serves `compact` / `startup` / a `resume` of the same native session: a start of
    // a new generation (`clear`, another native session) never reaches it over a live record, which is
    // closed and moved aside first.
    const existing = await sessionStore.loadSession(sessionId);
    if (existing && existing.status === 'active' && existing.endTime === undefined) {
      const {
        appendTranscriptMarker: writeMarker,
        appendAuditEvent: writeAudit,
        isExternalOrigin,
      } = await import('../../agents/core/session/session-origin-audit.js');

      existing.status = 'active';
      if (gitBranch) {
        existing.gitBranch = gitBranch;
      }
      if (remoteRepository) {
        existing.repository = remoteRepository;
      }
      existing.correlation = {
        ...existing.correlation,
        status: 'matched',
        ...(event.session_id && { agentSessionId: event.session_id }),
        ...(event.transcript_path && { agentSessionFile: event.transcript_path }),
      };
      // Preserve an already-set origin; only derive from env for pre-existing records that
      // predate this field. An established origin must never flip on re-entry.
      if (!existing.origin && getConfigValue(SESSION_ORIGIN_ENV_KEY, config) === SESSION_ORIGIN.EXTERNAL_RESUME) {
        existing.origin = SESSION_ORIGIN.EXTERNAL_RESUME;
      }
      await sessionStore.saveSession(existing);
      if (event.transcript_path && !isExternalOrigin(existing)) {
        writeMarker(event.transcript_path, sessionId, agentName);
        writeAudit('transcript_marker_written', {
          codemieSessionId: sessionId,
          claudeSessionId: event.session_id,
          transcriptPath: event.transcript_path,
        });
      }
      logger.info(
        `[hook:SessionStart] Session re-entered (source=${event.source}): preserved ` +
        `startTime=${existing.startTime} activeDurationMs=${existing.activeDurationMs}`
      );
      return;
    }

    const { appendTranscriptMarker, appendAuditEvent, isExternalOrigin } = await import(
      '../../agents/core/session/session-origin-audit.js'
    );
    const origin =
      getConfigValue(SESSION_ORIGIN_ENV_KEY, config) === SESSION_ORIGIN.EXTERNAL_RESUME
        ? SESSION_ORIGIN.EXTERNAL_RESUME
        : undefined;

    // The owning wrapper: an in-process caller names it in config, a hook process reads the env
    // the wrapper exported; a hook process never stores its own pid.
    const { wrapperOwnerFromEnv } = await import('../../utils/processes.js');
    const owner = config
      ? config.ownerPid !== undefined && config.ownerStartedAt !== undefined
        ? { ownerPid: config.ownerPid, ownerStartedAt: config.ownerStartedAt }
        : undefined
      : wrapperOwnerFromEnv(process.env);
    const codemieUrl = getConfigValue('CODEMIE_URL', config);
    const clientType = getConfigValue('CODEMIE_CLIENT_TYPE', config);
    const model = getConfigValue('CODEMIE_MODEL', config);

    // Create session record with correlation already matched
    const startTime = event.startTime ?? Date.now();
    const session = {
      sessionId,
      agentName,
      provider,
      ...(project && { project }),
      ...owner,
      ...(codemieUrl && { codemieUrl }),
      ...(clientType && { clientType }),
      ...(model && { model }),
      startTime,
      workingDirectory,
      ...(remoteRepository && { repository: remoteRepository }),
      ...(gitBranch && { gitBranch }),
      status: 'active' as const,
      activeDurationMs: 0, // Initialize active duration tracking
      ...(origin && { origin }),
      correlation: {
        status: 'matched' as const,
        agentSessionId: event.session_id,
        agentSessionFile: event.transcript_path,
        retryCount: 0
      },
      // A resumed Claude transcript already holds earlier records: the first processing run
      // treats everything before this record's start as already sent.
      ...((agentName === 'claude' || agentName === 'claude-acp') && event.session_id && event.transcript_path && {
        runtimeCheckpoint: {
          externalSessionId: event.session_id,
          transcriptPath: event.transcript_path,
          lastDiscoveredAt: startTime,
          baselineCutoffMs: startTime
        }
      })
    };

    // Save session
    await sessionStore.saveSession(session);

    // Never stamp a transcript that's flagged external-resume — doing so would re-adopt it
    // into the local analytics ownership index (native-loader.ts) and undo the exclusion.
    if (session.correlation.agentSessionFile && !isExternalOrigin(session)) {
      appendTranscriptMarker(
        session.correlation.agentSessionFile,
        sessionId,
        agentName,
      );
      appendAuditEvent('transcript_marker_written', {
        codemieSessionId: sessionId,
        claudeSessionId: event.session_id,
        transcriptPath: session.correlation.agentSessionFile,
      });
    }

    logger.info(
      `[hook:SessionStart] Session created: id=${sessionId} agent=${agentName} ` +
      `provider=${provider} agent_session=${event.session_id}`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[hook:SessionStart] Failed to create session record: ${errorMessage}`);
    // Don't throw - hook should not block agent execution
  }
}

/**
 * Creates the session record. A start of another native session under the same id (`/clear`, an
 * in-process `/resume`, or the start a later event of a new generation stands in for) first closes
 * the previous generation and moves it aside — a `completed` one, or an unclosed one of another
 * native session — so the fresh generation's hooks never write onto it; a start over an unclosed
 * record of its own native session re-enters it. The close, the move and the fresh write run under
 * one hold of the reconcile lock, waited for until `lockDeadlineMs`: a process still holding it may
 * write the old generation by id, and a second hook process of the new generation finds the fresh
 * record under the lock (`own`: nothing written). So does a fresh write over a `completed_{id}.json`
 * of another generation. A synthesized start begins where that close ended the previous generation. A
 * lock still held after the wait leaves the generation in place and writes no fresh record: its
 * holder is a finalizer, which closes it. A failure here is logged, never thrown: the rest of the
 * SessionStart still runs.
 */
export async function createSessionRecordOverUnclosed(
  event: SessionStartEvent,
  sessionId: string,
  config: HookProcessingConfig | undefined,
  options: SessionEndOptions,
  lockDeadlineMs: number
): Promise<void> {
  try {
    const live = await readLiveRecord(sessionId);
    const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
    const record = live ?? (await new SessionStore().loadSession(sessionId));
    if (!record || (!isOtherGeneration(record, event.session_id) && (!live || live.status !== 'completed'))) {
      await createSessionRecord(event, sessionId, config);
      return;
    }
    const lock = await waitReconcileLock(sessionId, options, lockDeadlineMs);
    if (!lock) {
      logger.warn(`[hook:SessionStart] ${event.source}: ${reconcileLockPath(sessionId)} is still held; the previous generation (${record.status}) of ${sessionId} left in place, the fresh record is not written`);
      return;
    }
    try {
      const aside = await setAsideUnclosed(event.session_id, sessionId, config, options);
      if (aside.outcome !== 'closed') return;
      // A real SessionStart starts at its own time; only a synthesized start (its `startTime` set)
      // stands in for a SessionStart that could not write, so the previous end bounds it from below.
      const startTime = event.startTime !== undefined ? (aside.previousEnd ?? event.startTime) : undefined;
      await createSessionRecord({ ...event, startTime }, sessionId, config);
    } finally {
      await lock.release();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[hook:SessionStart] Could not write the session record of ${sessionId}: ${msg}`);
    // Don't throw - hook should not block agent execution
  }
}

/**
 * Under the reconcile lock the caller holds, moves aside the `{id}.json` set of the previous
 * generation. Re-read here: the holder may have delivered and renamed it meanwhile, or another hook
 * process of the native session written its record (`own`: nothing moved). Every set taken aside —
 * `completed` of any generation, or unclosed of another — gets the full close first (an unclosed one
 * synthetic-ended, an undelivered one of this launch delivered within the close's budget, then
 * marked): it may never have been tried, its finalizer cut or never come. Only one that close
 * leaves unclosed is closed locally; one it leaves in place is moved as it is. `kept`: the set stays,
 * no fresh record.
 */
async function setAsideUnclosed(
  nativeSessionId: string,
  sessionId: string,
  config: HookProcessingConfig | undefined,
  options: SessionEndOptions
): Promise<GenerationClose> {
  const closed = await closeGenerationLocked(sessionId, options, config, nativeSessionId);
  if (closed.outcome !== 'kept') return closed;
  const live = await readLiveRecord(sessionId);
  if (!live) return { outcome: 'closed' };
  if (live.status !== 'completed' && !isOtherGeneration(live, nativeSessionId)) return { outcome: 'own' };
  const previousEnd = live.status === 'completed' ? live.endTime : await closeUnclosedLocally(live, config);
  if (live.status !== 'completed' && previousEnd === undefined) return { outcome: 'kept' };
  return (await moveUnclosedGeneration(sessionId, options)) ? { outcome: 'closed', previousEnd } : { outcome: 'kept' };
}

/**
 * Closes a generation its full close left unclosed: `completed`, `interrupted`, ending at its last
 * recorded activity, nothing flushed or sent here (the flush is what failed). The save alone is the
 * close: a failed dropped mark is only logged. Returns the end written; undefined when the save failed.
 */
async function closeUnclosedLocally(live: Session, config: HookProcessingConfig | undefined): Promise<number | undefined> {
  let endTime: number;
  try {
    const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
    endTime = await lastRecordedActivityAt(live);
    await new SessionStore().saveSession({ ...live, status: 'completed', reason: 'interrupted', endTime });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[hook] New generation: the previous generation of ${live.sessionId} could not be closed locally; the fresh record is not written: ${errorMessage}`);
    return undefined;
  }
  logger.warn(`[hook] New generation: the previous generation of ${live.sessionId} was still active; closed locally at its last recorded activity, not flushed here`);
  if (sendsThroughThisLaunch(live, config)) {
    await markDroppedIfUndelivered(live.sessionId).catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[hook] New generation: the previous generation of ${live.sessionId} could not be marked dropped: ${errorMessage}`);
    });
  }
  return endTime;
}

/** Whether this launch delivers the record: it has a send path and the record is of its CodeMie host. */
function sendsThroughThisLaunch(record: Session, config: HookProcessingConfig | undefined): boolean {
  return !!configSendPathApiUrl(config) && sameHost(record, { CODEMIE_URL: getConfigValue('CODEMIE_URL', config) });
}

/**
 * Moves a completed `{id}.json` set the previous generation's close left in place to its generation
 * name as it is, delivered or not, its file locks waited for within {@link GENERATION_CLOSE_BUDGET_MS}
 * and the SessionEnd's bounds. False when the move failed or a lock stayed held: the set is kept and no
 * fresh record is written.
 */
async function moveUnclosedGeneration(sessionId: string, options: SessionEndOptions): Promise<boolean> {
  try {
    const moved = await moveSetToGeneration(sessionId, '', {
      deadlineMs: Math.min(Date.now() + GENERATION_CLOSE_BUDGET_MS, options.deadlineMs ?? Infinity),
      signal: options.abortSignal,
      pidOnlyLiveness: options.hookProcess === true,
    });
    logger.warn(`[hook] New generation: the previous generation of ${sessionId} could not be closed; it stays local as ${moved}, unsent`);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[hook] New generation: the previous generation of ${sessionId} could not be closed; the fresh record is not written: ${errorMessage}`);
    return false;
  }
}

/**
 * Helper: Send session start metrics to CodeMie backend
 * Works for providers that have CodeMie analytics authentication configured
 *
 * @param event - SessionStart event data
 * @param sessionId - The CodeMie session ID (for file operations)
 * @param agentSessionId - The agent's session ID (for API)
 * @param config - Optional configuration object (if not provided, reads from environment variables)
 */
async function sendSessionStartMetrics(event: SessionStartEvent, sessionId: string, agentSessionId: string, config?: HookProcessingConfig): Promise<void> {
  try {
    // Get required configuration values
    const agentName = getConfigValue('CODEMIE_AGENT', config);
    const provider = getConfigValue('CODEMIE_PROVIDER', config);
    const ssoUrl = getConfigValue('CODEMIE_URL', config);
    const syncApiUrl = getConfigValue('CODEMIE_SYNC_API_URL', config);
    const apiUrl = configSendPathApiUrl(config);
    const cliVersion = getConfigValue('CODEMIE_CLI_VERSION', config);
    const model = getConfigValue('CODEMIE_MODEL', config);
    const project = getConfigValue('CODEMIE_PROJECT', config);

    if (!sessionId || !agentName || !ssoUrl || !apiUrl) {
      logger.debug('[hook:SessionStart] Missing required config for metrics');
      return;
    }

    // Session record is created (with origin persisted) immediately before this is called —
    // see handleSessionStart. Never upload lifecycle metrics for a confirmed external resume.
    const { isExternalOrigin } = await import('../../agents/core/session/session-origin-audit.js');
    const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
    const session = await new SessionStore().loadSession(sessionId);
    if (isExternalOrigin(session)) {
      logger.debug('[hook:SessionStart] Skipping start metrics for external-resume session');
      return;
    }

    // Determine working directory
    const workingDirectory = event.cwd || process.cwd();

    // Detect git-derived repository (owner/repo) so the lifecycle metric
    // matches the session JSON and Pipeline B headers. Without this, the
    // metric falls back to parent/current path inside sendSessionStart.
    let remoteRepository: string | undefined;
    try {
      const { detectGitRemoteRepo } = await import('../../utils/processes.js');
      remoteRepository = await detectGitRemoteRepo(workingDirectory);
    } catch (error) {
      logger.debug('[hook:SessionStart] Could not detect git remote repository:', error);
    }

    // Detect MCP servers and extensions in parallel (non-blocking)
    let mcpSummary: MCPConfigSummary | undefined;
    let extensionsSummary: ExtensionsScanSummary | undefined;
    try {
      const agent = AgentRegistry.getAgent(agentName);
      const [mcp, ext] = await Promise.allSettled([
        agent?.getMCPConfigSummary ? agent.getMCPConfigSummary(workingDirectory) : Promise.resolve(undefined),
        agent?.getExtensionsSummary ? agent.getExtensionsSummary(workingDirectory) : Promise.resolve(undefined),
      ]);

      if (mcp.status === 'fulfilled' && mcp.value) {
        mcpSummary = mcp.value;
        logger.debug('[hook:SessionStart] MCP detection', { total: mcpSummary.totalServers });
      } else if (mcp.status === 'rejected') {
        logger.debug('[hook:SessionStart] MCP detection failed', mcp.reason);
      }

      if (ext.status === 'fulfilled' && ext.value) {
        extensionsSummary = ext.value;
        logger.debug('[hook:SessionStart] Extensions scan', { project: ext.value.project, global: ext.value.global });
      } else if (ext.status === 'rejected') {
        logger.debug('[hook:SessionStart] Extensions scan failed', ext.reason);
      }
    } catch (error) {
      logger.debug('[hook:SessionStart] Setup scan failed, continuing without scan data', error);
    }

    // Load SSO credentials if not provided in config
    const { cookies: cookieHeader, credentialsSuperseded } = await loadAnalyticsCookies('[hook:SessionStart]', ssoUrl, config);

    if (!cookieHeader) {
      if (syncApiUrl) {
        logger.info(
          `[hook:SessionStart] CodeMie analytics sync is configured for ${syncApiUrl}, but no stored credentials were found. Run: codemie profile login --url ${ssoUrl}`
        );
      } else {
        logger.info(`[hook:SessionStart] No SSO credentials available for ${ssoUrl}`);
      }
      return;
    }

    // Use MetricsSender to send session start metric
    const { MetricsSender } = await import(
      '../../providers/plugins/sso/index.js'
    );

    const clientType = getConfigValue('CODEMIE_CLIENT_TYPE', config) || 'codemie-cli';

    const sender = new MetricsSender({
      baseUrl: apiUrl,
      cookies: cookieHeader,
      credentialsSuperseded,
      timeout: 10000,
      retryAttempts: 2,
      version: cliVersion,
      clientType
    });

    // Build status object with reason from event
    const status = {
      status: 'started' as const,
      reason: event.source  // e.g., "startup"
    };

    // Send session start metric (use agent session ID for API)
    await sender.sendSessionStart(
      {
        sessionId: agentSessionId,
        agentName,
        provider: provider || 'unknown',
        project,
        model,
        startTime: Date.now(),
        workingDirectory,
        ...(remoteRepository && { repository: remoteRepository })
      },
      workingDirectory,
      status,
      undefined,          // error
      mcpSummary,         // MCP configuration summary
      extensionsSummary   // Extensions scan summary
    );

    logger.info('[hook:SessionStart] Session start metrics sent successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`[hook:SessionStart] Failed to send metrics: ${errorMessage}`);
    // Don't throw - metrics failures should not block agent execution
  }
}

/**
 * Helper: Update session status on session end
 *
 * @param event - SessionEnd event data
 * @param sessionId - The CodeMie session ID
 * @param config - With `holdsReconcileLock` a failed status write throws (the record stays `active`
 *   for a later attempt); otherwise it is only logged
 */
async function updateSessionStatus(event: SessionEndEvent, sessionId: string, endTime?: number, config?: HookProcessingConfig): Promise<void> {
  try {
    // Import session store
    const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
    const sessionStore = new SessionStore();

    // Load existing session
    const session = await sessionStore.loadSession(sessionId);

    if (!session) {
      logger.warn(`[hook:SessionEnd] Session not found: ${sessionId}`);
      return;
    }

    // Determine status from exit reason
    // Reason values from Claude Code:
    // - clear: Session cleared with /clear command
    // - logout: User logged out
    // - prompt_input_exit: User exited while prompt input was visible
    // - other: Other exit reasons
    //
    // Status mapping: All reasons → completed
    const status = 'completed';

    // Update session status and reason
    await sessionStore.updateSessionStatus(sessionId, status, event.reason, endTime);

    logger.info(
      `[hook:SessionEnd] Session status updated: id=${sessionId} status=${status} reason=${event.reason}`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[hook:SessionEnd] Failed to update session status: ${errorMessage}`);
    if (config?.holdsReconcileLock) {
      throw error;
    }
    // Don't throw - hook should not block agent execution
  }
}

/** The session's reconcile lock, waited for up to the lock helper's 10 s budget, `deadlineMs` or the abort. */
async function waitReconcileLock(sessionId: string, options: SessionEndOptions, deadlineMs: number): Promise<PidLock | null> {
  const { acquirePidLock } = await import('../../utils/pid-lock.js');
  return acquirePidLock(reconcileLockPath(sessionId), {
    mode: 'wait',
    deadlineMs,
    signal: options.abortSignal,
    pidOnlyLiveness: options.hookProcess === true,
  });
}

/**
 * Closes the previous generation under the reconcile lock the caller holds, delivering within
 * {@link GENERATION_CLOSE_BUDGET_MS}: a record still `active` (its SessionEnd never came or was cut)
 * gets the synthetic end over its OWN transcript; a `completed` `{id}.json` (undelivered) is
 * delivered; then every set of the id — live or `completed_` — moves to its generation name,
 * delivered or not, so the fresh record does not overwrite it. A generation of another host, or one
 * this launch has no send path for, is finalized locally and sent nothing. A failure is logged.
 * Re-read under the lock: an unclosed record of the caller's native session (another hook process
 * of it wrote it first) is its own, not closed (`own`); no `{id}.json` leaves nothing to close.
 * `closed` carries the end the close wrote.
 *
 * ponytail: a generation whose delivery does not finish inside the budget leaves the queue (local only)
 */
async function closeGenerationLocked(
  sessionId: string,
  options: SessionEndOptions,
  config: HookProcessingConfig | undefined,
  callerNativeId: string
): Promise<GenerationClose> {
  let previousEnd: number | undefined;
  try {
    const deadlineMs = Math.min(Date.now() + GENERATION_CLOSE_BUDGET_MS, options.deadlineMs ?? Infinity);
    const live = await readLiveRecord(sessionId);
    if (!live) return { outcome: 'closed' };
    if (live.status !== 'completed' && !isOtherGeneration(live, callerNativeId)) {
      logger.info(`[hook] New generation: ${sessionId}.json already holds the record of ${callerNativeId}; nothing closed`);
      return { outcome: 'own' };
    }
    // Another host's generation, or one this launch cannot send, is finalized locally and moved aside unsent, not marked dropped
    const ours = !!live && sendsThroughThisLaunch(live, config);
    const bounded: SessionEndOptions = { ...options, deadlineMs, holdsReconcileLock: true, localOnly: !ours };
    if (live?.status === 'active') {
      logger.info(`[hook] New generation: closing the active previous generation of ${sessionId}`);
      const event = await syntheticSessionEnd(live, { flush: true });
      await handleSessionEnd(event, sessionId, config, bounded);
    } else if (live?.status === 'completed' && ours) {
      logger.info(`[hook] New generation: delivering the undelivered previous generation of ${sessionId}`);
      await deliverSessionRecord(sessionId, nativeSessionId(live), live.reason, config, bounded);
    }
    const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
    // A close whose status write failed completed nothing and left the record live: closed locally before any move
    const after = await new SessionStore().loadSession(sessionId);
    previousEnd = after && after.status !== 'completed' ? await closeUnclosedLocally(after, config) : after?.endTime;
    if (after && after.status !== 'completed' && previousEnd === undefined) return { outcome: 'kept' };
    if (Date.now() >= deadlineMs) {
      logger.info(`[hook] New generation: delivery budget spent; moving the previous generation aside as it is`);
    }
    await moveSetToGeneration(sessionId, 'completed_');
    if (ours && after?.status === 'completed') {
      await markDroppedIfUndelivered(sessionId);
    }
    await moveSetToGeneration(sessionId, '', { deadlineMs, signal: options.abortSignal, pidOnlyLiveness: options.hookProcess === true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[hook] New generation: failed to close the previous generation: ${errorMessage}`);
  }
  return existsSync(getSessionPath(sessionId)) ? { outcome: 'kept' } : { outcome: 'closed', previousEnd };
}

/**
 * Validate hook event required fields
 * @param event - Hook event to validate
 * @param config - Optional configuration object (if provided, throws errors; otherwise sets exitCode)
 * @throws Error if validation fails and config is provided
 */
function validateHookEvent(event: BaseHookEvent, config?: HookProcessingConfig): void {
  if (!event.session_id) {
    const error = new Error('Missing required field: session_id');
    if (config) {
      throw error;
    }
    logger.error('[hook] Missing required field: session_id');
    logger.debug(`[hook] Received event: ${JSON.stringify(event)}`);
    process.exitCode = 2;
    return;
  }

  if (!event.hook_event_name) {
    const error = new Error('Missing required field: hook_event_name');
    if (config) {
      throw error;
    }
    logger.error('[hook] Missing required field: hook_event_name');
    logger.debug(`[hook] Received event: ${JSON.stringify(event)}`);
    process.exitCode = 2;
    return;
  }

  // transcript_path/transcript_paths are optional for SessionStart/SessionEnd in
  // programmatic mode (transcript may not exist yet at start, or may not be
  // discoverable at end). Some agents provide multiple transcript paths.
  const transcriptOptionalEvents = ['SessionStart', 'SessionEnd'];
  const hasTranscriptPath = Boolean(event.transcript_path) || (event.transcript_paths && event.transcript_paths.length > 0);
  if (!hasTranscriptPath && !transcriptOptionalEvents.includes(event.hook_event_name)) {
    const error = new Error('Missing required field: transcript_path');
    if (config) {
      throw error;
    }
    logger.error('[hook] Missing required field: transcript_path');
    logger.debug(`[hook] Received event: ${JSON.stringify(event)}`);
    console.error('codemie hook: missing required field in hook input: transcript_path');
    process.exitCode = 2;
    return;
  }
}

/**
 * Initialize hook context (logger and session/agent info)
 * @param config - Optional configuration object (if not provided, reads from environment variables)
 * @returns Object with sessionId and agentName
 */
function initializeHookContext(config?: HookProcessingConfig): { sessionId: string; agentName: string } {
  let sessionId: string;
  let agentName: string;

  if (config) {
    // Use config object; its log context applies per call (see processEvent)
    sessionId = config.sessionId;
    agentName = config.agentName;
  } else {
    // Use environment variables (CLI mode)
    sessionId = initializeLoggerContext();
    agentName = process.env.CODEMIE_AGENT || 'unknown';
  }

  return { sessionId, agentName };
}

/**
 * Apply hook transformation if agent provides a transformer
 * @param event - Hook event to transform
 * @param agentName - Agent name to get transformer from
 * @returns Transformed event or original event if no transformer available
 */
function applyHookTransformation(event: BaseHookEvent, agentName: string): BaseHookEvent {
  let transformedEvent: BaseHookEvent = event;
  try {
    const agent = AgentRegistry.getAgent(agentName);
    if (agent) {
      const transformer = (agent as any).getHookTransformer?.() as HookTransformer | undefined;
      if (transformer) {
        logger.debug(`[hook] Applying ${agentName} hook transformer`);
        transformedEvent = transformer.transform(event);
        logger.debug(`[hook] Transformation complete: ${event.hook_event_name} → ${transformedEvent.hook_event_name}`);
      } else {
        logger.debug(`[hook] No transformer available for ${agentName}, using event as-is`);
      }
    }
  } catch (transformError) {
    const transformMsg = transformError instanceof Error ? transformError.message : String(transformError);
    logger.error(`[hook] Transformation failed: ${transformMsg}, using original event`);
    // Continue with original event on transformation failure
    transformedEvent = event;
  }
  return transformedEvent;
}

/**
 * Normalize event name and log processing info
 * @param event - Hook event (may be transformed)
 * @param sessionId - CodeMie session ID
 * @param agentName - Agent name
 * @returns Normalized event name
 */
function normalizeAndLogEvent(event: BaseHookEvent, sessionId: string, agentName: string): string {
  const normalizedEventName = normalizeEventName(event.hook_event_name, agentName);
  logger.info(
    `[hook] Processing ${normalizedEventName} event (codemie_session=${sessionId.slice(0, 8)}..., agent_session=${event.session_id.slice(0, 8)}...)`
  );
  return normalizedEventName;
}

/**
 * Process a hook event programmatically
 * Main entry point for programmatic API usage (e.g., VSCode plugin)
 *
 * @param event - Hook event to process
 * @param config - Optional configuration object (if not provided, reads from environment variables)
 * @throws Error if event processing fails and config is provided
 */
export async function processEvent(event: BaseHookEvent, config?: HookProcessingConfig): Promise<void> {
  // Validate required fields
  validateHookEvent(event, config);
  if (process.exitCode === 2) {
    return; // Validation failed in CLI mode
  }

  // Initialize logger context
  const { sessionId, agentName } = initializeHookContext(config);

  const run = async (): Promise<void> => {
    // Apply hook transformation if agent provides a transformer
    const transformedEvent = applyHookTransformation(event, agentName);

    // Normalize event name and log processing info
    normalizeAndLogEvent(transformedEvent, sessionId, agentName);

    // Route to appropriate handler
    // Note: routeHookEvent expects rawInput for PermissionRequest, but we don't have it in programmatic mode
    // Pass empty string as rawInput when config is provided
    await routeHookEvent(transformedEvent, config ? '' : '', sessionId, agentName, config);
  };

  // An in-process caller may process another session than its own: that call's lines carry the
  // config's agent / session / profile, the caller's own lines keep the caller's context.
  if (config) {
    await logger.runWithContext(
      { agentName: config.agentName, sessionId: config.sessionId, profileName: config.profileName },
      run
    );
  } else {
    await run();
  }
}

/**
 * Create unified hook command
 * Routes to appropriate handler based on hook_event_name in JSON payload
 */
export function createHookCommand(): Command {
  return new Command('hook')
    .description('Unified hook event handler (called by agent plugins)')
    .option('--agent <name>', 'Agent name for hook attribution')
    .option('--event <name>', 'Event name for hosts whose hook payload carries none (e.g. Copilot CLI)')
    .action(async (opts: { agent?: string; event?: string }) => {
      const hookStartTime = Date.now();
      let event: BaseHookEvent | null = null;

      // Graceful teardown: Claude Code may SIGTERM/SIGINT this hook while the
      // SessionEnd sync is still running. The FIRST signal only aborts the sync
      // loops — they persist progress at the next checkpoint, release the sync
      // lock, and the process exits normally. A SECOND signal forces exit
      // (defense against a hung HTTP request).
      const abortController = new AbortController();
      const forceExit = () => process.exit(1);
      const requestAbort = (signal: NodeJS.Signals) => {
        logger.debug(`[hook] Received ${signal}; aborting in-flight work gracefully (repeat signal to force exit)`);
        abortController.abort();
        process.once('SIGTERM', forceExit);
        process.once('SIGINT', forceExit);
      };
      process.once('SIGTERM', requestAbort);
      process.once('SIGINT', requestAbort);

      try {
        // Read JSON from stdin
        const input = await readStdin();

        // Log raw input at debug level (may contain sensitive data)
        logger.debug(`[hook] Received input (${input.length} bytes)`);

        // Parse JSON
        try {
          event = JSON.parse(input) as BaseHookEvent;
          // The field is the synthesized start's, never a client's
          delete (event as Partial<SessionStartEvent>).startTime;
        } catch (parseError: unknown) {
          const parseMsg = parseError instanceof Error ? parseError.message : String(parseError);
          logger.error(`[hook] Failed to parse JSON input: ${parseMsg}`);
          logger.debug(`[hook] Invalid JSON: ${input.substring(0, 200)}...`);
          console.error(`codemie hook: failed to parse hook input JSON: ${parseMsg}`);
          process.exit(2); // Blocking error
        }

        const analyticsAgent = AgentRegistry.getAnalyticsAgent(opts.agent!);
        if (analyticsAgent) {
          const otlpInput = opts.event ? injectEventName(input, opts.event) : input;
          await analyticsAgent.processOtlpEvent(otlpInput, { ensureOtlpProxy, forwardOtlpEventsToSpool });
          await logger.close();
          process.exitCode = 0;
          return;
        }

        // Validate required fields from hook input schema
        if (!event.session_id) {
          logger.error('[hook] Missing required field: session_id');
          logger.debug(`[hook] Received event: ${JSON.stringify(event)}`);
          console.error('codemie hook: missing required field in hook input: session_id');
          process.exit(2); // Blocking error
        }

        if (!event.hook_event_name) {
          logger.error('[hook] Missing required field: hook_event_name');
          logger.debug(`[hook] Received event: ${JSON.stringify(event)}`);
          console.error('codemie hook: missing required field in hook input: hook_event_name');
          process.exit(2); // Blocking error
        }

        // Initialize logger context using CODEMIE_SESSION_ID from environment
        // This ensures consistent session ID across all hooks
        const { sessionId, agentName } = initializeHookContext();

        // Apply hook transformation if agent provides a transformer.
        // Some agents (e.g. Kimi) do not emit a transcript_path in their raw
        // hook payload; the transformer computes it from agent-specific session
        // layout before we validate the internal event shape.
        const transformedEvent = applyHookTransformation(event, agentName);

        // Validate required fields after transformation so agent-specific
        // transformers can populate fields such as transcript_path.
        validateHookEvent(transformedEvent);
        if (process.exitCode === 2) {
          return; // Validation failed
        }

        // Normalize event name and log processing info
        normalizeAndLogEvent(transformedEvent, sessionId, agentName);

        // Route to appropriate handler with transformed event and session ID
        await routeHookEvent(transformedEvent, input, sessionId, agentName, undefined, abortController.signal, true);

        // Log successful completion
        const totalDuration = Date.now() - hookStartTime;
        logger.info(
          `[hook] Completed ${event.hook_event_name} event successfully (${totalDuration}ms)`
        );

        // Flush logger before exit to ensure write completes
        await logger.close();
        // Use process.exitCode instead of process.exit() to allow graceful shutdown
        // This prevents Windows libuv UV_HANDLE_CLOSING assertion failures
        process.exitCode = 0;

      } catch (error: unknown) {
        const totalDuration = Date.now() - hookStartTime;
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;

        // Log detailed error information
        const eventName = event?.hook_event_name || 'unknown';
        const sessionId = event?.session_id || 'unknown';

        logger.error(
          `[hook] Failed to handle ${eventName} event (${totalDuration}ms): ${message}`
        );

        if (stack) {
          logger.debug(`[hook] Error stack: ${stack}`);
        }

        logger.debug(`[hook] Event details: agent_session=${sessionId}`);

        // Flush logger before exit
        await logger.close();
        // Surface a one-line reason on stderr: agents report a bare "Failed with
        // non-blocking status code: No stderr output" when the hook exits
        // non-zero silently, leaving the real cause only in the file log.
        console.error(`codemie hook: ${eventName} failed: ${message}`);
        // Use process.exitCode instead of process.exit() to allow graceful shutdown
        // This prevents Windows libuv UV_HANDLE_CLOSING assertion failures
        process.exitCode = 1;
      } finally {
        // Remove signal handlers registered for this invocation
        process.removeListener('SIGTERM', requestAbort);
        process.removeListener('SIGINT', requestAbort);
        process.removeListener('SIGTERM', forceExit);
        process.removeListener('SIGINT', forceExit);
      }
    });
}
