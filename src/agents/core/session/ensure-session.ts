import { logger } from '../../../utils/logger.js';

/**
 * Ensure session metadata file exists for SessionSyncer.
 * Creates a new session file in ~/.codemie/sessions/ if one doesn't already exist.
 *
 * @param sessionId - The CODEMIE_SESSION_ID
 * @param env - Process environment variables
 * @param defaultAgentName - Fallback agent name when CODEMIE_AGENT is unset (e.g. 'opencode', 'codemie-code')
 */
export async function ensureSessionFile(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  defaultAgentName: string
): Promise<void> {
  try {
    const { SessionStore } = await import('./SessionStore.js');
    const sessionStore = new SessionStore();

    const existing = await sessionStore.loadSession(sessionId);
    if (existing) {
      logger.debug(`[${defaultAgentName}] Session file already exists`);
      return;
    }

    const agentName = env.CODEMIE_AGENT || defaultAgentName;
    const provider = env.CODEMIE_PROVIDER || 'unknown';
    const project = env.CODEMIE_PROJECT;
    const workingDirectory = process.cwd();

    let gitBranch: string | undefined;
    let remoteRepository: string | undefined;
    try {
      const { detectGitBranch, detectGitRemoteRepo } = await import('../../../utils/processes.js');
      [gitBranch, remoteRepository] = await Promise.all([
        detectGitBranch(workingDirectory),
        detectGitRemoteRepo(workingDirectory),
      ]);
    } catch {
      // Git detection optional
    }

    // Estimate startTime from grace period (session ended ~2 seconds ago during grace period)
    // This prevents negative session durations in metrics aggregation
    const estimatedStartTime = Date.now() - 2000;

    const session = {
      sessionId,
      agentName,
      provider,
      ...(project && { project }),
      startTime: estimatedStartTime,
      workingDirectory,
      ...(remoteRepository && { repository: remoteRepository }),
      ...(gitBranch && { gitBranch }),
      status: 'completed' as const,
      activeDurationMs: 0,
      correlation: {
        status: 'matched' as const,
        agentSessionId: 'unknown',
        retryCount: 0
      }
    };

    await sessionStore.saveSession(session);
    logger.debug(`[${defaultAgentName}] Created session metadata file`);

  } catch (error) {
    logger.warn(`[${defaultAgentName}] Failed to create session file:`, error);
    // Don't throw - processing can continue without session file (sync will fail though)
  }
}
