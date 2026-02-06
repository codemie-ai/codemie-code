/**
 * Hook Event Processor API
 *
 * Programmatic API for processing hook events from external services (e.g., VSCode plugin).
 * This duplicates logic from src/cli/commands/hook.ts to provide a programmatic interface
 * without requiring stdin/stdout communication.
 *
 * Key differences from CLI command:
 * - Accepts event objects directly (no stdin/stdout)
 * - Uses explicit config object instead of environment variables
 * - Throws exceptions instead of using process.exit()
 * - Logger context set via config, not environment
 */

import { logger } from '../utils/logger.js';
import { AgentRegistry } from '../agents/registry.js';
import type { BaseHookEvent, HookTransformer, MCPConfigSummary } from '../agents/core/types.js';
import type { ProcessingContext } from '../agents/core/session/BaseProcessor.js';
import type {
  SessionStartEvent,
  SessionEndEvent,
  SubagentStopEvent
} from '../cli/commands/hook.js';
import {
  normalizeEventName as normalizeEventNameImpl,
  addCompletedPrefix,
  handlePreCompact,
  handlePermissionRequest,
  startActivityTracking,
  accumulateActiveDuration,
  updateSessionStatus,
  renameSessionFiles
} from '../cli/commands/hook.js';

/**
 * Configuration for HookEventProcessor
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
}

/**
 * Hook Event Processor
 *
 * Processes hook events programmatically without requiring stdin/stdout.
 * Duplicates logic from src/cli/commands/hook.ts for external service integration.
 */
export class HookEventProcessor {
  private config: HookProcessingConfig;

  constructor(config: HookProcessingConfig) {
    this.config = config;

    // Validate required fields
    if (!config.agentName) {
      throw new Error('agentName is required in HookProcessingConfig');
    }
    if (!config.sessionId) {
      throw new Error('sessionId is required in HookProcessingConfig');
    }

    // Initialize logger context
    logger.setAgentName(config.agentName);
    logger.setSessionId(config.sessionId);
    if (config.profileName) {
      logger.setProfileName(config.profileName);
    }
  }

  /**
   * Process a hook event
   * Main entry point that routes to appropriate handler
   *
   * @param event - Hook event to process
   * @throws Error if event processing fails
   */
  async processEvent(event: BaseHookEvent): Promise<void> {
    // Validate required fields
    if (!event.session_id) {
      throw new Error('Missing required field: session_id');
    }
    if (!event.hook_event_name) {
      throw new Error('Missing required field: hook_event_name');
    }
    if (!event.transcript_path) {
      throw new Error('Missing required field: transcript_path');
    }

    // Apply hook transformation if agent provides a transformer
    let transformedEvent: BaseHookEvent = event;
    try {
      const agent = AgentRegistry.getAgent(this.config.agentName);
      if (agent) {
        const transformer = (agent as any).getHookTransformer?.() as HookTransformer | undefined;
        if (transformer) {
          logger.debug(`[hook] Applying ${this.config.agentName} hook transformer`);
          transformedEvent = transformer.transform(event);
          logger.debug(`[hook] Transformation complete: ${event.hook_event_name} → ${transformedEvent.hook_event_name}`);
        }
      }
    } catch (transformError) {
      const transformMsg = transformError instanceof Error ? transformError.message : String(transformError);
      logger.error(`[hook] Transformation failed: ${transformMsg}, using original event`);
      // Continue with original event on transformation failure
      transformedEvent = event;
    }

    // Normalize event name
    const normalizedEventName = this.normalizeEventName(transformedEvent.hook_event_name);

    logger.info(
      `[hook] Processing ${normalizedEventName} event (codemie_session=${this.config.sessionId.slice(0, 8)}..., agent_session=${transformedEvent.session_id.slice(0, 8)}...)`
    );

    // Route to appropriate handler
    await this.routeHookEvent(transformedEvent, normalizedEventName);
  }

  /**
   * Handle SessionStart event
   */
  async handleSessionStart(event: SessionStartEvent): Promise<void> {
    await this.createSessionRecord(event);
    await this.sendSessionStartMetrics(event, event.session_id);
  }

  /**
   * Handle SessionEnd event
   */
  async handleSessionEnd(event: SessionEndEvent): Promise<void> {
    logger.info(`[hook:SessionEnd] ${JSON.stringify(event)}`);

    // 0. Final activity accumulation
    await this.accumulateActiveDuration();

    // 1. TRANSFORMATION: Transform remaining messages → JSONL
    await this.performIncrementalSync(event, 'SessionEnd');

    // 2. API SYNC: Sync pending data to API
    await this.syncPendingDataToAPI(event.session_id);

    // 3. Send session end metrics
    await this.sendSessionEndMetrics(event, event.session_id);

    // 4. Update session status
    await this.updateSessionStatus(event);

    // 5. Rename files LAST
    await this.renameSessionFiles();
  }

  /**
   * Handle Stop event
   */
  async handleStop(event: BaseHookEvent): Promise<void> {
    await this.accumulateActiveDuration();
    await this.performIncrementalSync(event, 'Stop');
  }

  /**
   * Handle SubagentStop event
   */
  async handleSubagentStop(event: SubagentStopEvent): Promise<void> {
    await this.performIncrementalSync(event, 'SubagentStop');
  }

  /**
   * Handle PreCompact event
   */
  async handlePreCompact(event: BaseHookEvent): Promise<void> {
    return handlePreCompact(event);
  }

  /**
   * Handle PermissionRequest event
   */
  async handlePermissionRequest(event: BaseHookEvent): Promise<void> {
    return handlePermissionRequest(event);
  }

  /**
   * Handle UserPromptSubmit event
   */
  async handleUserPromptSubmit(event: BaseHookEvent): Promise<void> {
    logger.info(`[hook:UserPromptSubmit] ${JSON.stringify(event)}`);
    await startActivityTracking(this.config.sessionId);
  }

  /**
   * Normalize event name using agent-specific mapping
   */
  private normalizeEventName(eventName: string): string {
    return normalizeEventNameImpl(eventName, this.config.agentName);
  }

  /**
   * Route event to appropriate handler
   */
  private async routeHookEvent(event: BaseHookEvent, normalizedEventName: string): Promise<void> {
    const startTime = Date.now();

    try {
      switch (normalizedEventName) {
        case 'SessionStart':
          logger.info(`[hook:router] Calling handleSessionStart`);
          await this.handleSessionStart(event as SessionStartEvent);
          break;
        case 'SessionEnd':
          logger.info(`[hook:router] Calling handleSessionEnd`);
          await this.handleSessionEnd(event as SessionEndEvent);
          break;
        case 'PermissionRequest':
          logger.info(`[hook:router] Calling handlePermissionRequest`);
          await this.handlePermissionRequest(event);
          break;
        case 'Stop':
          logger.info(`[hook:router] Calling handleStop`);
          await this.handleStop(event);
          break;
        case 'UserPromptSubmit':
          logger.info(`[hook:router] Calling handleUserPromptSubmit`);
          await this.handleUserPromptSubmit(event);
          break;
        case 'SubagentStop':
          logger.info(`[hook:router] Calling handleSubagentStop`);
          await this.handleSubagentStop(event as SubagentStopEvent);
          break;
        case 'PreCompact':
          logger.info(`[hook:router] Calling handlePreCompact`);
          await this.handlePreCompact(event);
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
      logger.error(`[hook:router] Event handler failed: ${normalizedEventName} (${duration}ms) error="${message}"`);
      throw error;
    }
  }

  /**
   * Perform incremental sync using unified SessionAdapter
   */
  private async performIncrementalSync(event: BaseHookEvent, hookName: string): Promise<void> {
    logger.debug(`[hook:${hookName}] Event received: ${JSON.stringify(event)}`);
    logger.info(`[hook:${hookName}] Starting session processing (agent_session=${event.session_id})`);

    const agentName = this.config.agentName;
    const agentSessionFile = event.transcript_path;
    if (!agentSessionFile) {
      logger.warn(`[hook:${hookName}] No transcript_path in event`);
      return;
    }

    logger.debug(`[hook:${hookName}] Using transcript: ${agentSessionFile}`);

    const agent = AgentRegistry.getAgent(agentName);
    if (!agent) {
      throw new Error(`Agent not found in registry: ${agentName}`);
    }

    const sessionAdapter = (agent as any).getSessionAdapter?.();
    if (!sessionAdapter) {
      throw new Error(`No session adapter available for agent ${agentName}`);
    }

    const context = await this.buildProcessingContext(event.session_id, agentSessionFile);

    logger.debug(`[hook:${hookName}] Calling SessionAdapter.processSession()`);
    const result = await sessionAdapter.processSession(
      agentSessionFile,
      this.config.sessionId,
      context
    );

    if (result.success) {
      logger.info(`[hook:${hookName}] Session processing complete: ${result.totalRecords} records processed`);
    } else {
      logger.warn(`[hook:${hookName}] Session processing had failures: ${result.failedProcessors.join(', ')}`);
    }

    // Log processor results
    for (const [name, procResult] of Object.entries(result.processors)) {
      const procRes = procResult as { success: boolean; message?: string; recordsProcessed?: number };
      if (procRes.success) {
        logger.debug(`[hook:${hookName}] Processor ${name}: ${procRes.message || 'success'}`);
      } else {
        logger.error(`[hook:${hookName}] Processor ${name}: ${procRes.message || 'failed'}`);
      }
    }
  }

  /**
   * Build processing context for SessionAdapter
   */
  private async buildProcessingContext(agentSessionId: string, agentSessionFile: string): Promise<ProcessingContext> {
    const apiUrl = this.config.apiBaseUrl || '';
    const cliVersion = this.config.version || '0.0.0';
    const clientType = this.config.clientType || 'codemie-cli';

    // Build context with SSO credentials if available
    let cookies = this.config.cookies || '';
    let apiKey = this.config.apiKey;

    // If SSO provider and credentials not provided, try to load them
    if (this.config.provider === 'ai-run-sso' && this.config.ssoUrl && apiUrl && !cookies) {
      try {
        const { CodeMieSSO } = await import('../providers/plugins/sso/sso.auth.js');
        const sso = new CodeMieSSO();
        const credentials = await sso.getStoredCredentials(this.config.ssoUrl);

        if (credentials?.cookies) {
          cookies = Object.entries(credentials.cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
        }
      } catch (error) {
        logger.debug('[hook] Failed to load SSO credentials:', error);
      }
    }

    return {
      apiBaseUrl: apiUrl,
      cookies,
      apiKey,
      clientType,
      version: cliVersion,
      dryRun: false,
      sessionId: this.config.sessionId,
      agentSessionId,
      agentSessionFile
    };
  }

  /**
   * Create and save session record
   */
  private async createSessionRecord(event: SessionStartEvent): Promise<void> {
    const agentName = this.config.agentName;
    const provider = this.config.provider;
    const project = this.config.project;

    if (!agentName || !provider) {
      throw new Error('Missing required config: agentName and provider are required for session creation');
    }

    const workingDirectory = event.cwd || process.cwd();

    // Detect git branch
    let gitBranch: string | undefined;
    try {
      const { detectGitBranch } = await import('../utils/processes.js');
      gitBranch = await detectGitBranch(workingDirectory);
    } catch (error) {
      logger.debug('[hook:SessionStart] Could not detect git branch:', error);
    }

    const { SessionStore } = await import('../agents/core/session/SessionStore.js');
    const sessionStore = new SessionStore();

    const session = {
      sessionId: this.config.sessionId,
      agentName,
      provider,
      ...(project && { project }),
      startTime: Date.now(),
      workingDirectory,
      ...(gitBranch && { gitBranch }),
      status: 'active' as const,
      activeDurationMs: 0,
      correlation: {
        status: 'matched' as const,
        agentSessionId: event.session_id,
        agentSessionFile: event.transcript_path,
        retryCount: 0
      }
    };

    await sessionStore.saveSession(session);

    logger.info(
      `[hook:SessionStart] Session created: id=${this.config.sessionId} agent=${agentName} ` +
      `provider=${provider} agent_session=${event.session_id}`
    );
  }

  /**
   * Send session start metrics to CodeMie backend
   */
  private async sendSessionStartMetrics(event: SessionStartEvent, agentSessionId: string): Promise<void> {
    if (this.config.provider !== 'ai-run-sso') {
      logger.debug('[hook:SessionStart] Skipping metrics (not SSO provider)');
      return;
    }

    const agentName = this.config.agentName;
    const ssoUrl = this.config.ssoUrl;
    const apiUrl = this.config.apiBaseUrl;
    const cliVersion = this.config.version;
    const model = this.config.model;
    const project = this.config.project;

    if (!agentName || !ssoUrl || !apiUrl) {
      logger.debug('[hook:SessionStart] Missing required config for metrics');
      return;
    }

    const workingDirectory = event.cwd || process.cwd();

    // Detect MCP servers
    let mcpSummary: MCPConfigSummary | undefined;
    try {
      const agent = AgentRegistry.getAgent(agentName);
      if (agent?.getMCPConfigSummary) {
        mcpSummary = await agent.getMCPConfigSummary(workingDirectory);
        logger.debug('[hook:SessionStart] MCP detection', { total: mcpSummary.totalServers });
      }
    } catch (error) {
      logger.debug('[hook:SessionStart] MCP detection failed, continuing without MCP data', error);
    }

    // Load SSO credentials if not provided
    let cookieHeader = this.config.cookies || '';
    if (!cookieHeader && ssoUrl) {
      try {
        const { CodeMieSSO } = await import('../providers/plugins/sso/sso.auth.js');
        const sso = new CodeMieSSO();
        const credentials = await sso.getStoredCredentials(ssoUrl);

        if (credentials?.cookies) {
          cookieHeader = Object.entries(credentials.cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
        }
      } catch (error) {
        logger.debug('[hook:SessionStart] Failed to load SSO credentials:', error);
      }
    }

    if (!cookieHeader) {
      logger.info(`[hook:SessionStart] No SSO credentials available for ${ssoUrl}`);
      return;
    }

    const { MetricsSender } = await import('../providers/plugins/sso/index.js');

    const sender = new MetricsSender({
      baseUrl: apiUrl,
      cookies: cookieHeader,
      timeout: 10000,
      retryAttempts: 2,
      version: cliVersion,
      clientType: this.config.clientType || 'codemie-cli'
    });

    const status = {
      status: 'started' as const,
      reason: event.source
    };

    await sender.sendSessionStart(
      {
        sessionId: agentSessionId,
        agentName,
        provider: this.config.provider!,
        project,
        model,
        startTime: Date.now(),
        workingDirectory
      },
      workingDirectory,
      status,
      undefined,
      mcpSummary
    );

    logger.info('[hook:SessionStart] Session start metrics sent successfully');
  }

  /**
   * Sync pending data to API using SessionSyncer
   */
  private async syncPendingDataToAPI(agentSessionId: string): Promise<void> {
    if (this.config.provider !== 'ai-run-sso') {
      logger.debug('[hook:SessionEnd] Skipping API sync (not SSO provider)');
      return;
    }

    logger.info(`[hook:SessionEnd] Syncing pending data to API`);

    const context = await this.buildProcessingContext(agentSessionId, '');

    const { SessionSyncer } = await import('../providers/plugins/sso/session/SessionSyncer.js');
    const syncer = new SessionSyncer();

    const result = await syncer.sync(this.config.sessionId, context);

    if (result.success) {
      logger.info(`[hook:SessionEnd] API sync complete: ${result.message}`);
    } else {
      logger.warn(`[hook:SessionEnd] API sync had failures: ${result.message}`);
    }
  }

  /**
   * Update session status on session end
   */
  private async updateSessionStatus(event: SessionEndEvent): Promise<void> {
    return updateSessionStatus(event, this.config.sessionId);
  }

  /**
   * Send session end metrics to CodeMie backend
   */
  private async sendSessionEndMetrics(event: SessionEndEvent, agentSessionId: string): Promise<void> {
    if (this.config.provider !== 'ai-run-sso') {
      logger.debug('[hook:SessionEnd] Skipping metrics (not SSO provider)');
      return;
    }

    const agentName = this.config.agentName;
    const ssoUrl = this.config.ssoUrl;
    const apiUrl = this.config.apiBaseUrl;
    const cliVersion = this.config.version;
    const model = this.config.model;
    const project = this.config.project;

    if (!agentName || !ssoUrl || !apiUrl) {
      logger.debug('[hook:SessionEnd] Missing required config for metrics');
      return;
    }

    const { SessionStore } = await import('../agents/core/session/SessionStore.js');
    const sessionStore = new SessionStore();
    const session = await sessionStore.loadSession(this.config.sessionId);

    if (!session) {
      logger.warn(`[hook:SessionEnd] Session not found for metrics: ${this.config.sessionId}`);
      return;
    }

    const wallClockDurationMs = Date.now() - session.startTime;
    const activeDurationMs = session.activeDurationMs || undefined;

    const status = {
      status: 'completed' as const,
      reason: event.reason
    };

    // Load SSO credentials if not provided
    let cookieHeader = this.config.cookies || '';
    if (!cookieHeader && ssoUrl) {
      try {
        const { CodeMieSSO } = await import('../providers/plugins/sso/sso.auth.js');
        const sso = new CodeMieSSO();
        const credentials = await sso.getStoredCredentials(ssoUrl);

        if (credentials?.cookies) {
          cookieHeader = Object.entries(credentials.cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
        }
      } catch (error) {
        logger.debug('[hook:SessionEnd] Failed to load SSO credentials:', error);
      }
    }

    if (!cookieHeader) {
      logger.info(`[hook:SessionEnd] No SSO credentials found for ${ssoUrl}`);
      return;
    }

    const { MetricsSender } = await import('../providers/plugins/sso/index.js');

    const sender = new MetricsSender({
      baseUrl: apiUrl,
      cookies: cookieHeader,
      timeout: 10000,
      retryAttempts: 2,
      version: cliVersion,
      clientType: this.config.clientType || 'codemie-cli'
    });

    await sender.sendSessionEnd(
      {
        sessionId: agentSessionId,
        agentName,
        provider: this.config.provider!,
        project,
        model,
        startTime: session.startTime,
        workingDirectory: session.workingDirectory
      },
      session.workingDirectory,
      status,
      wallClockDurationMs,
      undefined,
      activeDurationMs
    );

    logger.info('[hook:SessionEnd] Session end metrics sent successfully', {
      status,
      reason: event.reason,
      wallClockDurationMs,
      activeDurationMs
    });
  }

  /**
   * Rename session files with 'completed_' prefix
   */
  private async renameSessionFiles(): Promise<void> {
    return renameSessionFiles(this.config.sessionId);
  }

  /**
   * Add 'completed_' prefix to a file path basename
   */
  private async addCompletedPrefix(filePath: string): Promise<string> {
    return addCompletedPrefix(filePath);
  }

  /**
   * Start activity tracking for a session
   */
  private async startActivityTracking(): Promise<void> {
    return startActivityTracking(this.config.sessionId);
  }

  /**
   * Accumulate active duration for a session
   */
  private async accumulateActiveDuration(): Promise<number> {
    return accumulateActiveDuration(this.config.sessionId);
  }
}
