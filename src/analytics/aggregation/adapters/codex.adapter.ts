/**
 * Codex Analytics Adapter
 *
 * Extracts analytics data from Codex session files stored in:
 * ~/.codex/sessions/YYYY/MM/DD/rollout-{timestamp}-{sessionId}.jsonl
 *
 * JSONL Format: One JSON event per line
 * - Event types: session_meta, response_item, event_msg, turn_context, ghost_snapshot
 * - Token usage: NOT directly tracked (need to infer or integrate with API)
 * - File modifications: tracked via ghost_snapshot events
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  BaseAnalyticsAdapter,
  AdapterMetadata,
  resolvePath,
  findFiles,
  filterFilesByDate,
  readJSONL,
  detectLanguage,
  detectFormat,
  calculateFileStats
} from '../core/index.js';
import {
  SessionQueryOptions,
  SessionDescriptor,
  CodemieSession,
  CodemieMessage,
  CodemieToolCall,
  CodemieFileModification
} from '../types.js';

/**
 * Codex JSONL event types
 */
interface CodexEvent {
  timestamp: string;
  type: 'session_meta' | 'response_item' | 'event_msg' | 'turn_context' | 'ghost_snapshot';
  payload: CodexSessionMeta | CodexResponseItem | CodexEventMsg | CodexTurnContext | CodexGhostSnapshot;
}

interface CodexSessionMeta {
  id: string;
  timestamp: string;
  cwd: string;
  originator: string;
  cli_version: string;
  instructions?: string | null;
  source: string;
  model_provider: string;
  git?: {
    commit_hash: string;
    branch: string;
    repository_url: string;
  };
}

interface CodexResponseItem {
  type: 'message';
  role: 'user' | 'assistant';
  content: Array<{
    type: 'input_text' | 'text';
    text: string;
  }>;
}

interface CodexEventMsg {
  type: 'user_message' | 'turn_aborted' | 'turn_complete';
  message?: string;
  images?: unknown[];
  error?: string;
}

interface CodexTurnContext {
  cwd: string;
  approval_policy: string;
  sandbox_policy: {
    type: string;
    network_access: boolean;
  };
  model: string;
  summary: string;
}

interface CodexGhostSnapshot {
  ghost_commit: {
    id: string;
    parent: string;
    preexisting_untracked_files: string[];
    preexisting_untracked_dirs: string[];
  };
}

/**
 * Codex analytics adapter
 */
export class CodexAnalyticsAdapter extends BaseAnalyticsAdapter {
  constructor(metadata: AdapterMetadata) {
    super(metadata);
  }

  async findSessions(options?: SessionQueryOptions): Promise<SessionDescriptor[]> {
    const baseDir = resolvePath(this.homePath);
    const sessionsDir = join(baseDir, this.sessionsPath || 'sessions');

    if (!existsSync(sessionsDir)) {
      return [];
    }

    const descriptors: SessionDescriptor[] = [];

    try {
      // Scan YYYY/MM/DD directory structure
      const { readdir } = await import('node:fs/promises');
      const years = await readdir(sessionsDir, { withFileTypes: true });

      for (const yearDir of years) {
        if (!yearDir.isDirectory() || !/^\d{4}$/.test(yearDir.name)) continue;

        const yearPath = join(sessionsDir, yearDir.name);
        const months = await readdir(yearPath, { withFileTypes: true });

        for (const monthDir of months) {
          if (!monthDir.isDirectory() || !/^\d{2}$/.test(monthDir.name)) continue;

          const monthPath = join(yearPath, monthDir.name);
          const days = await readdir(monthPath, { withFileTypes: true });

          for (const dayDir of days) {
            if (!dayDir.isDirectory() || !/^\d{2}$/.test(dayDir.name)) continue;

            const dayPath = join(monthPath, dayDir.name);

            // Find all rollout-*.jsonl files
            const jsonlFiles = await findFiles(dayPath, /^rollout-.*\.jsonl$/);

            // Filter by date if specified
            let filteredFiles = jsonlFiles;
            if (options?.dateFrom || options?.dateTo) {
              filteredFiles = await filterFilesByDate(jsonlFiles, options.dateFrom, options.dateTo);
            }

            // Process each session file
            for (const filePath of filteredFiles) {
              try {
                // Read first event to get session metadata
                const events = await readJSONL(filePath, 1);
                if (events.length === 0) continue;

                const firstEvent = events[0] as CodexEvent;
                if (firstEvent.type !== 'session_meta') {
                  console.warn(`Expected session_meta as first event in ${filePath}`);
                  continue;
                }

                const sessionMeta = firstEvent.payload as CodexSessionMeta;

                descriptors.push({
                  sessionId: sessionMeta.id,
                  agent: this.agentName,
                  filePaths: [filePath],
                  metadata: {
                    cwd: sessionMeta.cwd,
                    gitBranch: sessionMeta.git?.branch,
                    gitCommit: sessionMeta.git?.commit_hash,
                    cliVersion: sessionMeta.cli_version,
                    timestamp: sessionMeta.timestamp
                  }
                });
              } catch (error) {
                console.error(`Failed to read session file ${filePath}: ${error}`);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error scanning Codex sessions: ${error}`);
    }

    // Apply pagination using inherited method
    return this.applyPagination(descriptors, options);
  }

  async extractSession(descriptor: SessionDescriptor): Promise<CodemieSession> {
    // Read all events from session file
    const filePath = descriptor.filePaths[0];
    const allEvents = await readJSONL(filePath) as CodexEvent[];

    // Extract session metadata
    const sessionMetaEvent = allEvents.find(e => e.type === 'session_meta');
    if (!sessionMetaEvent) {
      throw new Error(`No session_meta event found in ${filePath}`);
    }
    const sessionMeta = sessionMetaEvent.payload as CodexSessionMeta;

    // Calculate session timing
    const firstEvent = allEvents[0];
    const lastEvent = allEvents[allEvents.length - 1];
    const startTime = new Date(firstEvent.timestamp);
    const endTime = new Date(lastEvent.timestamp);
    const durationMs = endTime.getTime() - startTime.getTime();

    // Count user messages (event_msg with type: user_message)
    const userMessageEvents = allEvents.filter(
      e => e.type === 'event_msg' && (e.payload as CodexEventMsg).type === 'user_message'
    );

    // Count assistant messages (response_item with role: assistant)
    const assistantMessages = allEvents.filter(
      e => e.type === 'response_item' &&
           (e.payload as CodexResponseItem).role === 'assistant'
    );

    // Extract tool calls (implicit - Codex doesn't have explicit tool call structure)
    const toolCalls = await this.extractToolCalls(descriptor);

    // Count successful/failed tool calls
    const successfulToolCalls = toolCalls.filter(tc => tc.status === 'success').length;
    const failedToolCalls = toolCalls.filter(tc => tc.status === 'failure').length;

    // Track tool usage
    const toolUsage: Record<string, number> = {};
    const toolStatus: Record<string, { success: number; failure: number }> = {};

    for (const tc of toolCalls) {
      toolUsage[tc.toolName] = (toolUsage[tc.toolName] || 0) + 1;

      if (!toolStatus[tc.toolName]) {
        toolStatus[tc.toolName] = { success: 0, failure: 0 };
      }
      if (tc.status === 'success') {
        toolStatus[tc.toolName].success++;
      } else if (tc.status === 'failure') {
        toolStatus[tc.toolName].failure++;
      }
    }

    // Extract model from turn_context events
    const turnContexts = allEvents.filter(e => e.type === 'turn_context');
    const modelUsage: Record<string, number> = {};
    let model = 'gpt-4.1'; // Default

    for (const event of turnContexts) {
      const context = event.payload as CodexTurnContext;
      if (context.model) {
        model = context.model;
        modelUsage[context.model] = (modelUsage[context.model] || 0) + 1;
      }
    }

    // Extract file modifications
    const fileModifications = await this.extractFileModifications(descriptor);

    // Calculate file statistics
    const fileStats = calculateFileStats(fileModifications);

    // Token usage: NOT directly available in Codex logs
    // We return 0 for all token counts with a note in design doc
    const tokens = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 0
    };

    // Check for errors and completion status
    const abortedEvents = allEvents.filter(
      e => e.type === 'event_msg' && (e.payload as CodexEventMsg).type === 'turn_aborted'
    );

    const completeEvents = allEvents.filter(
      e => e.type === 'event_msg' && (e.payload as CodexEventMsg).type === 'turn_complete'
    );

    // Session is considered failed if:
    // 1. There are aborted events
    // 2. There are failed tool calls
    // 3. There are user messages but no assistant responses (incomplete/failed session)
    // 4. No turn_complete event and session ended
    const hadErrors = failedToolCalls > 0 ||
                     abortedEvents.length > 0 ||
                     (userMessageEvents.length > 0 && assistantMessages.length === 0) ||
                     completeEvents.length === 0;

    // Determine exit reason
    let exitReason: string | undefined;
    if (abortedEvents.length > 0) {
      const lastAbort = abortedEvents[abortedEvents.length - 1];
      exitReason = (lastAbort.payload as CodexEventMsg).error || 'aborted';
    } else if (userMessageEvents.length > 0 && assistantMessages.length === 0) {
      exitReason = 'incomplete - no assistant response';
    } else if (completeEvents.length === 0) {
      exitReason = 'incomplete - no completion event';
    }

    // Get project path
    const projectPath = (descriptor.metadata.cwd as string) || '';

    return {
      sessionId: descriptor.sessionId,
      agent: 'codex',
      agentVersion: sessionMeta.cli_version,
      startTime,
      endTime,
      durationMs,
      projectPath,
      gitBranch: sessionMeta.git?.branch,
      gitCommit: sessionMeta.git?.commit_hash,
      model,
      provider: sessionMeta.model_provider || 'openai',
      userMessageCount: userMessageEvents.length,
      assistantMessageCount: assistantMessages.length,
      toolCallCount: toolCalls.length,
      successfulToolCalls,
      failedToolCalls,
      fileModifications: fileModifications.length,
      toolUsage,
      toolStatus,
      modelUsage,
      tokens,
      exitReason,
      hadErrors,
      fileStats
    };
  }

  async extractMessages(descriptor: SessionDescriptor): Promise<CodemieMessage[]> {
    const filePath = descriptor.filePaths[0];
    const allEvents = await readJSONL(filePath) as CodexEvent[];

    const messages: CodemieMessage[] = [];

    // Extract response_item events (messages)
    for (const event of allEvents) {
      if (event.type === 'response_item') {
        const item = event.payload as CodexResponseItem;
        if (item.type !== 'message') continue;

        // Extract text content
        const content = item.content
          .filter(c => c.type === 'input_text' || c.type === 'text')
          .map(c => c.text)
          .join('\n');

        // Note: Codex doesn't provide message-level token data
        messages.push({
          messageId: `${descriptor.sessionId}-${event.timestamp}`,
          sessionId: descriptor.sessionId,
          timestamp: new Date(event.timestamp),
          role: item.role,
          content,
          tokens: undefined, // Not available in Codex logs
          model: undefined   // Model tracked at turn level, not message level
        });
      }
    }

    return messages;
  }

  async extractToolCalls(descriptor: SessionDescriptor): Promise<CodemieToolCall[]> {
    const filePath = descriptor.filePaths[0];
    const allEvents = await readJSONL(filePath) as CodexEvent[];

    const toolCalls: CodemieToolCall[] = [];

    // Note: Codex doesn't have explicit tool call structure
    // Tool calls are implicit in the conversation flow
    // We can infer some from ghost_snapshot events (file system operations)

    // Extract ghost_snapshot events as proxy for file operations
    const ghostSnapshots = allEvents.filter(e => e.type === 'ghost_snapshot');

    for (const event of ghostSnapshots) {
      const snapshot = event.payload as CodexGhostSnapshot;

      // Each ghost snapshot represents a file system state change
      toolCalls.push({
        toolCallId: `ghost-${snapshot.ghost_commit.id}`,
        messageId: `${descriptor.sessionId}-${event.timestamp}`,
        sessionId: descriptor.sessionId,
        timestamp: new Date(event.timestamp),
        toolName: 'ghost_snapshot',
        toolArgs: {
          commit_id: snapshot.ghost_commit.id,
          parent: snapshot.ghost_commit.parent,
          preexisting_untracked_files: snapshot.ghost_commit.preexisting_untracked_files,
          preexisting_untracked_dirs: snapshot.ghost_commit.preexisting_untracked_dirs
        },
        status: 'success',
        result: snapshot.ghost_commit
      });
    }

    // Check for aborted turns (failures)
    const abortedEvents = allEvents.filter(
      e => e.type === 'event_msg' && (e.payload as CodexEventMsg).type === 'turn_aborted'
    );

    for (const event of abortedEvents) {
      const eventMsg = event.payload as CodexEventMsg;
      toolCalls.push({
        toolCallId: `abort-${event.timestamp}`,
        messageId: `${descriptor.sessionId}-${event.timestamp}`,
        sessionId: descriptor.sessionId,
        timestamp: new Date(event.timestamp),
        toolName: 'turn_aborted',
        toolArgs: {},
        status: 'failure',
        error: eventMsg.error || 'Turn aborted'
      });
    }

    return toolCalls;
  }

  async extractFileModifications(descriptor: SessionDescriptor): Promise<CodemieFileModification[]> {
    const filePath = descriptor.filePaths[0];
    const allEvents = await readJSONL(filePath) as CodexEvent[];

    const modifications: CodemieFileModification[] = [];

    // Extract file modifications from ghost_snapshot events
    const ghostSnapshots = allEvents.filter(e => e.type === 'ghost_snapshot');

    // Compare consecutive snapshots to detect changes
    for (let i = 0; i < ghostSnapshots.length; i++) {
      const currentEvent = ghostSnapshots[i];
      const currentSnapshot = currentEvent.payload as CodexGhostSnapshot;

      // Get previous snapshot if exists
      const prevSnapshot = i > 0 ? (ghostSnapshots[i - 1].payload as CodexGhostSnapshot) : null;

      // Files in current snapshot but not in previous = new files
      const currentFiles = new Set(currentSnapshot.ghost_commit.preexisting_untracked_files);
      const prevFiles = prevSnapshot ?
        new Set(prevSnapshot.ghost_commit.preexisting_untracked_files) :
        new Set<string>();

      // New files (created)
      for (const file of currentFiles) {
        if (!prevFiles.has(file)) {
          const language = detectLanguage(file);
          const format = detectFormat(file);
          const fileExtension = file.substring(file.lastIndexOf('.'));

          modifications.push({
            sessionId: descriptor.sessionId,
            toolCallId: `ghost-${currentSnapshot.ghost_commit.id}`,
            timestamp: new Date(currentEvent.timestamp),
            filePath: file,
            operation: 'create',
            linesAdded: 0, // Can't determine without file content
            linesRemoved: 0,
            linesModified: 0,
            toolName: 'ghost_snapshot',
            wasNewFile: true,
            fileExtension,
            language,
            format
          });
        }
      }

      // Modified files (existed in both snapshots)
      for (const file of currentFiles) {
        if (prevFiles.has(file)) {
          const language = detectLanguage(file);
          const format = detectFormat(file);
          const fileExtension = file.substring(file.lastIndexOf('.'));

          modifications.push({
            sessionId: descriptor.sessionId,
            toolCallId: `ghost-${currentSnapshot.ghost_commit.id}`,
            timestamp: new Date(currentEvent.timestamp),
            filePath: file,
            operation: 'update',
            linesAdded: 0, // Can't determine without file content
            linesRemoved: 0,
            linesModified: 0,
            toolName: 'ghost_snapshot',
            wasNewFile: false,
            fileExtension,
            language,
            format
          });
        }
      }

      // Deleted files (in previous but not in current)
      for (const file of prevFiles) {
        if (!currentFiles.has(file)) {
          const language = detectLanguage(file);
          const format = detectFormat(file);
          const fileExtension = file.substring(file.lastIndexOf('.'));

          modifications.push({
            sessionId: descriptor.sessionId,
            toolCallId: `ghost-${currentSnapshot.ghost_commit.id}`,
            timestamp: new Date(currentEvent.timestamp),
            filePath: file,
            operation: 'delete',
            linesAdded: 0,
            linesRemoved: 0,
            linesModified: 0,
            toolName: 'ghost_snapshot',
            wasNewFile: false,
            fileExtension,
            language,
            format
          });
        }
      }
    }

    return modifications;
  }
}
