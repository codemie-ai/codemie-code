import { Command } from 'commander';
import { logger } from '../../utils/logger.js';
import { AgentRegistry } from '../../agents/registry.js';
import { getSessionPath, getSessionMetricsPath, getSessionConversationPath } from '../../agents/core/session/session-config.js';
import type { BaseHookEvent, HookTransformer } from '../../agents/core/types.js';

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
interface SessionStartEvent extends BaseHookEvent {
  hook_event_name: 'SessionStart';
  source: string;                  // e.g., "startup"
}

/**
 * SessionEnd event
 */
interface SessionEndEvent extends BaseHookEvent {
  hook_event_name: 'SessionEnd';
  reason: string;                  // e.g., "exit", "logout"
  cwd: string;                     // Always present for SessionEnd
}

/**
 * SubagentStop event
 */
interface SubagentStopEvent extends BaseHookEvent {
  hook_event_name: 'SubagentStop';
  agent_id: string;                // Sub-agent ID
  agent_transcript_path: string;   // Path to agent's transcript file
  stop_hook_active: boolean;       // Whether stop hook is active
  cwd: string;                     // Current working directory
}

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
    // Debug: Log all environment variables that start with CODEMIE_
    const codemieEnvVars = Object.keys(process.env)
      .filter(key => key.startsWith('CODEMIE_'))
      .map(key => `${key}=${process.env[key]}`)
      .join(', ');
    console.error(`[hook:debug] CODEMIE_AGENT missing. Available CODEMIE_* vars: ${codemieEnvVars || 'none'}`);
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
async function handleSessionStart(event: SessionStartEvent, _rawInput: string, sessionId: string): Promise<void> {
  // Create session record with correlation information
  await createSessionRecord(event, sessionId);
  // Send session start metrics (SSO provider only)
  await sendSessionStartMetrics(event, sessionId, event.session_id);
}


/**
 * Handle SessionEnd event
 * Final sync and status update
 * Note: Session ID cleanup happens automatically on next SessionStart via file detection
 */
async function handleSessionEnd(event: SessionEndEvent, sessionId: string): Promise<void> {
  logger.info(`[hook:SessionEnd] ${JSON.stringify(event)}`);

  // 1. TRANSFORMATION: Transform remaining messages → JSONL (pending)
  await performIncrementalSync(event, 'SessionEnd', sessionId);

  // 2. API SYNC: Sync pending data to API using SessionSyncer
  await syncPendingDataToAPI(sessionId, event.session_id);

  // 3. Send session end metrics (needs to read session file)
  await sendSessionEndMetrics(event, sessionId, event.session_id);

  // 4. Update session status
  await updateSessionStatus(event, sessionId);

  // 5. Rename files LAST (after all operations that need to read session)
  await renameSessionFiles(sessionId);
}

/**
 * Sync pending data to API using SessionSyncer
 * Same service used by plugin timer - ensures consistency
 *
 * @param sessionId - CodeMie session ID
 * @param agentSessionId - Agent session ID for context
 */
async function syncPendingDataToAPI(sessionId: string, agentSessionId: string): Promise<void> {
  try {
    // Only sync for SSO provider
    const provider = process.env.CODEMIE_PROVIDER;
    if (provider !== 'ai-run-sso') {
      logger.debug('[hook:SessionEnd] Skipping API sync (not SSO provider)');
      return;
    }

    logger.info(`[hook:SessionEnd] Syncing pending data to API`);

    // Build processing context
    const context = await buildProcessingContext(sessionId, agentSessionId, '');

    // Use SessionSyncer service (same as plugin)
    const { SessionSyncer } = await import(
      '../../providers/plugins/sso/session/SessionSyncer.js'
    );
    const syncer = new SessionSyncer();

    // Sync pending data
    const result = await syncer.sync(sessionId, context);

    if (result.success) {
      logger.info(`[hook:SessionEnd] API sync complete: ${result.message}`);
    } else {
      logger.warn(`[hook:SessionEnd] API sync had failures: ${result.message}`);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[hook:SessionEnd] Failed to sync pending data: ${errorMessage}`);
    // Don't throw - sync failure should not block session end
  }
}

/**
 * Handle PermissionRequest event
 */
async function handlePermissionRequest(event: BaseHookEvent, _rawInput: string): Promise<void> {
  logger.debug(`[hook:PermissionRequest] ${JSON.stringify(event)}`);
}

/**
 * Perform incremental sync using unified SessionAdapter
 *
 * @param event - Hook event with transcript_path and session_id
 * @param hookName - Name of the hook for logging (e.g., "Stop", "UserPromptSubmit")
 * @param sessionId - The CodeMie session ID to use for this extraction
 */
async function performIncrementalSync(event: BaseHookEvent, hookName: string, sessionId: string): Promise<void> {
  logger.debug(`[hook:${hookName}] Event received: ${JSON.stringify(event)}`);
  logger.info(`[hook:${hookName}] Starting session processing (agent_session=${event.session_id})`);

  try {
    // Get agent name from environment
    const agentName = process.env.CODEMIE_AGENT;

    if (!agentName) {
      logger.warn(`[hook:${hookName}] Missing CODEMIE_AGENT, skipping extraction`);
      return;
    }

    // Use transcript_path directly from event
    const agentSessionFile = event.transcript_path;
    if (!agentSessionFile) {
      logger.warn(`[hook:${hookName}] No transcript_path in event`);
      return;
    }

    logger.debug(`[hook:${hookName}] Using transcript: ${agentSessionFile}`);

    // Get agent from registry
    const agent = AgentRegistry.getAgent(agentName);
    if (!agent) {
      logger.error(`[hook:${hookName}] Agent not found in registry: ${agentName}`);
      return;
    }

    // Get session adapter (unified approach)
    const sessionAdapter = (agent as any).getSessionAdapter?.();
    if (!sessionAdapter) {
      logger.warn(`[hook:${hookName}] No session adapter available for agent ${agentName}`);
      return;
    }

    // Build processing context
    const context = await buildProcessingContext(sessionId, event.session_id, agentSessionFile);

    // Process session with all processors (metrics + conversations)
    logger.debug(`[hook:${hookName}] Calling SessionAdapter.processSession()`);
    const result = await sessionAdapter.processSession(
      agentSessionFile,
      sessionId,
      context
    );

    if (result.success) {
      logger.info(`[hook:${hookName}] Session processing complete: ${result.totalRecords} records processed`);
    } else {
      logger.warn(`[hook:${hookName}] Session processing had failures: ${result.failedProcessors.join(', ')}`);
    }

    // Log processor results
    for (const [name, procResult] of Object.entries(result.processors)) {
      const result = procResult as { success: boolean; message?: string; recordsProcessed?: number };
      if (result.success) {
        logger.debug(`[hook:${hookName}] Processor ${name}: ${result.message || 'success'}`);
      } else {
        logger.error(`[hook:${hookName}] Processor ${name}: ${result.message || 'failed'}`);
      }
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[hook:${hookName}] Session processing failed: ${errorMessage}`);
    // Don't throw - hook should not block agent execution or user prompts
  }
}

/**
 * Build processing context for SessionAdapter
 * @param sessionId - CodeMie session ID
 * @param agentSessionId - Agent session ID
 * @param agentSessionFile - Path to agent session file
 * @returns Processing context for SessionAdapter
 */
async function buildProcessingContext(
  sessionId: string,
  agentSessionId: string,
  agentSessionFile: string
): Promise<any> {
  // Get environment variables
  const provider = process.env.CODEMIE_PROVIDER;
  const ssoUrl = process.env.CODEMIE_URL;
  const apiUrl = process.env.CODEMIE_BASE_URL || '';
  const cliVersion = process.env.CODEMIE_CLI_VERSION || '0.0.0';
  const clientType = process.env.CODEMIE_CLIENT_TYPE || 'codemie-cli';

  // Build context with SSO credentials if available
  let cookies = '';
  let apiKey: string | undefined;

  if (provider === 'ai-run-sso' && ssoUrl && apiUrl) {
    try {
      const { CodeMieSSO } = await import('../../providers/plugins/sso/sso.auth.js');
      const sso = new CodeMieSSO();
      const credentials = await sso.getStoredCredentials(ssoUrl);

      if (credentials?.cookies) {
        cookies = Object.entries(credentials.cookies)
          .map(([key, value]) => `${key}=${value}`)
          .join('; ');
      }
    } catch (error) {
      logger.debug('[hook] Failed to load SSO credentials:', error);
    }
  }

  // Check for API key (for local development)
  if (process.env.CODEMIE_API_KEY) {
    apiKey = process.env.CODEMIE_API_KEY;
  }

  return {
    apiBaseUrl: apiUrl,
    cookies,
    apiKey,
    clientType,
    version: cliVersion,
    dryRun: false,
    sessionId,
    agentSessionId,
    agentSessionFile
  };
}

/**
 * Handle Stop event
 * Extracts metrics and conversations from agent session file incrementally
 */
async function handleStop(event: BaseHookEvent, sessionId: string): Promise<void> {
  await performIncrementalSync(event, 'Stop', sessionId);
}


/**
 * Handle SubagentStop event
 * Appends agent thought to _conversations.jsonl for later sync
 */
async function handleSubagentStop(event: SubagentStopEvent, sessionId: string): Promise<void> {
  await performIncrementalSync(event, 'SubagentStop', sessionId);
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
 * @param agentName - Agent name (claude, gemini, codex)
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
 */
async function routeHookEvent(event: BaseHookEvent, rawInput: string, sessionId: string, agentName: string): Promise<void> {
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
        await handleSessionStart(event as SessionStartEvent, rawInput, sessionId);
        break;
      case 'SessionEnd':
        logger.info(`[hook:router] Calling handleSessionEnd`);
        await handleSessionEnd(event as SessionEndEvent, sessionId);
        break;
      case 'PermissionRequest':
        logger.info(`[hook:router] Calling handlePermissionRequest`);
        await handlePermissionRequest(event, rawInput);
        break;
      case 'Stop':
        logger.info(`[hook:router] Calling handleStop`);
        await handleStop(event, sessionId);
        break;
      case 'SubagentStop':
        logger.info(`[hook:router] Calling handleSubagentStop`);
        await handleSubagentStop(event as SubagentStopEvent, sessionId);
        break;
      case 'PreCompact':
        logger.info(`[hook:router] Calling handlePreCompact`);
        await handlePreCompact(event);
        break;
      default:
        logger.info(`[hook:router] Unsupported event: ${normalizedEventName} (silently ignored)`);
        return;
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
 */
async function createSessionRecord(event: SessionStartEvent, sessionId: string): Promise<void> {
  try {
    // Get metadata from environment
    const agentName = process.env.CODEMIE_AGENT;
    const provider = process.env.CODEMIE_PROVIDER;
    const project = process.env.CODEMIE_PROJECT;

    if (!agentName || !provider) {
      logger.warn('[hook:SessionStart] Missing required env vars for session creation');
      return;
    }

    // Determine working directory
    const workingDirectory = event.cwd || process.cwd();

    // Detect git branch
    let gitBranch: string | undefined;
    try {
      const { detectGitBranch } = await import('../../utils/processes.js');
      gitBranch = await detectGitBranch(workingDirectory);
    } catch (error) {
      logger.debug('[hook:SessionStart] Could not detect git branch:', error);
    }

    // Import session types and store
    const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
    const sessionStore = new SessionStore();

    // Create session record with correlation already matched
    const session = {
      sessionId,
      agentName,
      provider,
      ...(project && { project }),
      startTime: Date.now(),
      workingDirectory,
      ...(gitBranch && { gitBranch }),
      status: 'active' as const,
      correlation: {
        status: 'matched' as const,
        agentSessionId: event.session_id,
        agentSessionFile: event.transcript_path,
        retryCount: 0
      }
    };

    // Save session
    await sessionStore.saveSession(session);

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
 * Helper: Send session start metrics to CodeMie backend
 * Only works with ai-run-sso provider
 *
 * @param event - SessionStart event data
 * @param sessionId - The CodeMie session ID (for file operations)
 * @param agentSessionId - The agent's session ID (for API)
 */
async function sendSessionStartMetrics(event: SessionStartEvent, sessionId: string, agentSessionId: string): Promise<void> {
  try {
    // Only send metrics for SSO provider
    const provider = process.env.CODEMIE_PROVIDER;
    if (provider !== 'ai-run-sso') {
      logger.debug('[hook:SessionStart] Skipping metrics (not SSO provider)');
      return;
    }

    // Get required environment variables
    const agentName = process.env.CODEMIE_AGENT;
    const ssoUrl = process.env.CODEMIE_URL;
    const apiUrl = process.env.CODEMIE_BASE_URL;
    const cliVersion = process.env.CODEMIE_CLI_VERSION;
    const model = process.env.CODEMIE_MODEL;
    const project = process.env.CODEMIE_PROJECT;

    if (!sessionId || !agentName || !ssoUrl || !apiUrl) {
      logger.debug('[hook:SessionStart] Missing required env vars for metrics');
      return;
    }

    // Determine working directory
    const workingDirectory = event.cwd || process.cwd();

    // Load SSO credentials
    const { CodeMieSSO } = await import('../../providers/plugins/sso/sso.auth.js');
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(ssoUrl);

    if (!credentials || !credentials.cookies) {
      logger.info(`[hook:SessionStart] No SSO credentials found for ${ssoUrl}`);
      return;
    }

    // Build cookie header
    const cookieHeader = Object.entries(credentials.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');

    // Use MetricsSender to send session start metric
    const { MetricsSender } = await import(
      '../../providers/plugins/sso/index.js'
    );

    const sender = new MetricsSender({
      baseUrl: apiUrl,
      cookies: cookieHeader,
      timeout: 10000,
      retryAttempts: 2,
      version: cliVersion,
      clientType: 'codemie-cli'
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
        provider,
        project,
        model,
        startTime: Date.now(),
        workingDirectory
      },
      workingDirectory,
      status
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
 */
async function updateSessionStatus(event: SessionEndEvent, sessionId: string): Promise<void> {
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
    await sessionStore.updateSessionStatus(sessionId, status, event.reason);

    logger.info(
      `[hook:SessionEnd] Session status updated: id=${sessionId} status=${status} reason=${event.reason}`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[hook:SessionEnd] Failed to update session status: ${errorMessage}`);
    // Don't throw - hook should not block agent execution
  }
}

/**
 * Add 'completed_' prefix to a file path basename
 * Example: /path/to/session.json → /path/to/completed_session.json
 */
async function addCompletedPrefix(filePath: string): Promise<string> {
  const { dirname, basename, join } = await import('path');
  return join(dirname(filePath), `completed_${basename(filePath)}`);
}

/**
 * Rename session files with 'completed_' prefix
 * Uses session-config.ts helpers to ensure consistent paths.
 *
 * Renames:
 * - Session file: {sessionId}.json → completed_{sessionId}.json
 * - Metrics file: {sessionId}_metrics.jsonl → completed_{sessionId}_metrics.jsonl
 * - Conversations file: {sessionId}_conversation.jsonl → completed_{sessionId}_conversation.jsonl
 *
 * @param sessionId - The CodeMie session ID
 */
async function renameSessionFiles(sessionId: string): Promise<void> {
  const { rename } = await import('fs/promises');
  const { existsSync } = await import('fs');

  const renamedFiles: string[] = [];
  const errors: string[] = [];

  // 1. Rename session file
  try {
    const sessionFile = getSessionPath(sessionId);
    const newSessionFile = await addCompletedPrefix(sessionFile);

    if (existsSync(sessionFile)) {
      await rename(sessionFile, newSessionFile);
      renamedFiles.push('session');
      logger.debug(`[hook:SessionEnd] Renamed session file: ${sessionId}.json → completed_${sessionId}.json`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errors.push(`session: ${errorMessage}`);
    logger.warn(`[hook:SessionEnd] Failed to rename session file: ${errorMessage}`);
  }

  // 2. Rename metrics file
  try {
    const metricsFile = getSessionMetricsPath(sessionId);
    const newMetricsFile = await addCompletedPrefix(metricsFile);

    if (existsSync(metricsFile)) {
      await rename(metricsFile, newMetricsFile);
      renamedFiles.push('metrics');
      logger.debug(`[hook:SessionEnd] Renamed metrics file: ${sessionId}_metrics.jsonl → completed_${sessionId}_metrics.jsonl`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errors.push(`metrics: ${errorMessage}`);
    logger.warn(`[hook:SessionEnd] Failed to rename metrics file: ${errorMessage}`);
  }

  // 3. Rename conversations file
  try {
    const conversationsFile = getSessionConversationPath(sessionId);
    const newConversationsFile = await addCompletedPrefix(conversationsFile);

    if (existsSync(conversationsFile)) {
      await rename(conversationsFile, newConversationsFile);
      renamedFiles.push('conversations');
      logger.debug(`[hook:SessionEnd] Renamed conversations file: ${sessionId}_conversation.jsonl → completed_${sessionId}_conversation.jsonl`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errors.push(`conversations: ${errorMessage}`);
    logger.warn(`[hook:SessionEnd] Failed to rename conversations file: ${errorMessage}`);
  }

  // Log summary
  if (renamedFiles.length > 0) {
    logger.info(`[hook:SessionEnd] Renamed files: ${renamedFiles.join(', ')}`);
  }

  if (errors.length > 0) {
    logger.warn(`[hook:SessionEnd] File rename errors: ${errors.join('; ')}`);
  }
}

/**
 * Helper: Send session end metrics to CodeMie backend
 * Only works with ai-run-sso provider
 *
 * @param event - SessionEnd event data
 * @param sessionId - The CodeMie session ID (for file operations)
 * @param agentSessionId - The agent's session ID (for API)
 */
async function sendSessionEndMetrics(event: SessionEndEvent, sessionId: string, agentSessionId: string): Promise<void> {
  try {
    // Only send metrics for SSO provider
    const provider = process.env.CODEMIE_PROVIDER;
    if (provider !== 'ai-run-sso') {
      logger.debug('[hook:SessionEnd] Skipping metrics (not SSO provider)');
      return;
    }

    // Get required environment variables
    const agentName = process.env.CODEMIE_AGENT;
    const ssoUrl = process.env.CODEMIE_URL;
    const apiUrl = process.env.CODEMIE_BASE_URL;
    const cliVersion = process.env.CODEMIE_CLI_VERSION;
    const model = process.env.CODEMIE_MODEL;
    const project = process.env.CODEMIE_PROJECT;

    if (!agentName || !ssoUrl || !apiUrl) {
      logger.debug('[hook:SessionEnd] Missing required env vars for metrics');
      return;
    }

    // Load session to get start time
    const { SessionStore } = await import('../../agents/core/session/SessionStore.js');
    const sessionStore = new SessionStore();
    const session = await sessionStore.loadSession(sessionId);

    if (!session) {
      logger.warn(`[hook:SessionEnd] Session not found for metrics: ${sessionId}`);
      return;
    }

    // Calculate duration
    const durationMs = Date.now() - session.startTime;

    // Build status object with reason from event
    // Status is "completed" for normal session endings, with reason from Claude (e.g., "exit", "logout")
    const status = {
      status: 'completed' as const,
      reason: event.reason
    };

    // Load SSO credentials
    const { CodeMieSSO } = await import('../../providers/plugins/sso/sso.auth.js');
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(ssoUrl);

    if (!credentials?.cookies) {
      logger.info(`[hook:SessionEnd] No SSO credentials found for ${ssoUrl}`);
      return;
    }

    // Build cookie header
    const cookieHeader = Object.entries(credentials.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');

    // Use MetricsSender to send session end metric
    const { MetricsSender } = await import(
      '../../providers/plugins/sso/index.js'
    );

    const sender = new MetricsSender({
      baseUrl: apiUrl,
      cookies: cookieHeader,
      timeout: 10000,
      retryAttempts: 2,
      version: cliVersion,
      clientType: 'codemie-cli'
    });

    // Send session end metric (use agent session ID for API)
    await sender.sendSessionEnd(
      {
        sessionId: agentSessionId,
        agentName,
        provider,
        project,
        model,
        startTime: session.startTime,
        workingDirectory: session.workingDirectory
      },
      session.workingDirectory,
      status,
      durationMs
      // error parameter omitted - undefined for normal termination
    );

    logger.info('[hook:SessionEnd] Session end metrics sent successfully', {
      status,
      reason: event.reason,
      durationMs
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`[hook:SessionEnd] Failed to send metrics: ${errorMessage}`);
    // Don't throw - metrics failures should not block agent execution
  }
}

/**
 * Create unified hook command
 * Routes to appropriate handler based on hook_event_name in JSON payload
 */
export function createHookCommand(): Command {
  return new Command('hook')
    .description('Unified hook event handler (called by agent plugins)')
    .action(async () => {
      const hookStartTime = Date.now();
      let event: BaseHookEvent | null = null;

      try {
        // Read JSON from stdin
        const input = await readStdin();

        // Log raw input at debug level (may contain sensitive data)
        logger.debug(`[hook] Received input (${input.length} bytes)`);

        // Parse JSON
        try {
          event = JSON.parse(input) as BaseHookEvent;
        } catch (parseError: unknown) {
          const parseMsg = parseError instanceof Error ? parseError.message : String(parseError);
          logger.error(`[hook] Failed to parse JSON input: ${parseMsg}`);
          logger.debug(`[hook] Invalid JSON: ${input.substring(0, 200)}...`);
          process.exit(2); // Blocking error
        }

        // Validate required fields from hook input schema
        if (!event.session_id) {
          logger.error('[hook] Missing required field: session_id');
          logger.debug(`[hook] Received event: ${JSON.stringify(event)}`);
          process.exit(2); // Blocking error
        }

        if (!event.hook_event_name) {
          logger.error('[hook] Missing required field: hook_event_name');
          logger.debug(`[hook] Received event: ${JSON.stringify(event)}`);
          process.exit(2); // Blocking error
        }

        if (!event.transcript_path) {
          logger.error('[hook] Missing required field: transcript_path');
          logger.debug(`[hook] Received event: ${JSON.stringify(event)}`);
          process.exit(2); // Blocking error
        }

        // Initialize logger context using CODEMIE_SESSION_ID from environment
        // This ensures consistent session ID across all hooks
        const sessionId = initializeLoggerContext();

        // Get agent name from environment
        const agentName = process.env.CODEMIE_AGENT || 'unknown';

        // Apply hook transformation if agent provides a transformer
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

        // Log hook invocation
        logger.info(
          `[hook] Processing ${transformedEvent.hook_event_name} event (codemie_session=${sessionId.slice(0, 8)}..., agent_session=${transformedEvent.session_id.slice(0, 8)}...)`
        );

        // Route to appropriate handler with transformed event and session ID
        await routeHookEvent(transformedEvent, input, sessionId, agentName);

        // Log successful completion
        const totalDuration = Date.now() - hookStartTime;
        logger.info(
          `[hook] Completed ${event.hook_event_name} event successfully (${totalDuration}ms)`
        );

        // Flush logger before exit to ensure write completes
        await logger.close();
        process.exit(0); // Success

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
        process.exit(1); // Non-blocking warning
      }
    });
}
