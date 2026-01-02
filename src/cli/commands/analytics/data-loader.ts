/**
 * Data loader for analytics - reads JSONL metric files
 * Uses core MetricDelta type from src/metrics/types.ts
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { MetricDelta } from '../../../agents/core/metrics/types.js';
import type { AnalyticsFilter } from './types.js';
import { getCodemiePath } from '../../../utils/paths.js';

/**
 * Session start event (special record type)
 * Not part of MetricDelta, but stored in same JSONL file
 */
interface SessionStartEvent {
  recordId: string;
  type: 'session_start';
  timestamp: number;
  codeMieSessionId: string;
  agentName: string;
  syncStatus: string;
  data: {
    provider: string;
    workingDirectory: string;
    startTime: number;
  };
}

/**
 * Session end event (special record type)
 */
interface SessionEndEvent {
  recordId: string;
  type: 'session_end';
  timestamp: number;
  codeMieSessionId: string;
  agentName: string;
  syncStatus: string;
  data: {
    endTime: number;
    duration: number;
    totalTurns: number;
    totalTokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation?: number;
    };
    totalCost: number;
  };
}

/**
 * Turn event (intermediate record type for backward compatibility)
 * This is a wrapper around token data, will be converted to MetricDelta
 */
interface TurnEvent {
  recordId: string;
  type: 'turn';
  timestamp: number | string;
  codeMieSessionId: string;
  agentSessionId: string;
  agentName: string;
  syncStatus: string;
  data: {
    turnNumber: number;
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation?: number;
    };
    cost: number;
    model: string;
  };
}

/**
 * Tool call event (intermediate record type)
 */
interface ToolCallEvent {
  recordId: string;
  type: 'tool_call';
  timestamp: number | string;
  codeMieSessionId: string;
  agentSessionId?: string;
  agentName: string;
  syncStatus: string;
  data: {
    toolCall: {
      id: string;
      name: string;
      timestamp: number;
      status: 'success' | 'error';
      input: Record<string, unknown>;
      output?: unknown;
      error?: string;
      fileOperation?: {
        type: 'read' | 'write' | 'edit' | 'delete';
        path: string;
        language?: string;
        format?: string;
        linesAdded?: number;
        linesRemoved?: number;
        linesModified?: number;
      };
    };
  };
}

/**
 * Union type for all JSONL record types
 */
type MetricsRecord = MetricDelta | SessionStartEvent | SessionEndEvent | TurnEvent | ToolCallEvent | { type: string };

/**
 * Raw session data loaded from JSONL files
 */
export interface RawSessionData {
  sessionId: string;
  startEvent?: SessionStartEvent;
  endEvent?: SessionEndEvent;
  deltas: MetricDelta[];
}

/**
 * Load all metric files from ~/.codemie/metrics/sessions/
 */
export class MetricsDataLoader {
  private sessionsDir: string;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir || getCodemiePath('metrics', 'sessions');
  }

  /**
   * Load all sessions with optional filtering
   */
  loadSessions(filter?: AnalyticsFilter): RawSessionData[] {
    const sessions: RawSessionData[] = [];

    try {
      const files = readdirSync(this.sessionsDir);

      // Find all .json files (session metadata)
      const sessionFiles = files.filter(f => f.endsWith('.json') && !f.includes('_metrics'));

      for (const sessionFile of sessionFiles) {
        // Extract session ID from filename
        const sessionId = sessionFile.replace('.json', '');

        // Skip if filtering by session ID
        if (filter?.sessionId && sessionId !== filter.sessionId) {
          continue;
        }

        // Load session records
        const sessionData = this.loadSession(sessionId);
        if (!sessionData) {
          continue;
        }

        // Apply filters
        if (!this.matchesFilter(sessionData, filter)) {
          continue;
        }

        sessions.push(sessionData);
      }
    } catch {
      // Sessions directory doesn't exist or can't be read
      return [];
    }

    return sessions;
  }

  /**
   * Load a single session's records
   */
  private loadSession(sessionId: string): RawSessionData | null {
    const sessionFile = join(this.sessionsDir, `${sessionId}.json`);
    const metricsFile = join(this.sessionsDir, `${sessionId}_metrics.jsonl`);

    try {
      // Read session metadata
      const sessionMetadata = JSON.parse(readFileSync(sessionFile, 'utf-8'));

      // Create synthetic start event from session metadata
      // Note: gitBranch is stored per-delta, not per-session
      const startEvent: SessionStartEvent = {
        recordId: sessionId,
        type: 'session_start',
        timestamp: sessionMetadata.startTime,
        codeMieSessionId: sessionId,
        agentName: sessionMetadata.agentName,
        syncStatus: 'synced',
        data: {
          provider: sessionMetadata.provider,
          workingDirectory: sessionMetadata.workingDirectory,
          startTime: sessionMetadata.startTime
        }
      };

      // Create synthetic end event if session is completed
      let endEvent: SessionEndEvent | undefined;
      if (sessionMetadata.status === 'completed' && sessionMetadata.endTime) {
        endEvent = {
          recordId: `${sessionId}-end`,
          type: 'session_end',
          timestamp: sessionMetadata.endTime,
          codeMieSessionId: sessionId,
          agentName: sessionMetadata.agentName,
          syncStatus: 'synced',
          data: {
            endTime: sessionMetadata.endTime,
            duration: sessionMetadata.endTime - sessionMetadata.startTime,
            totalTurns: 0, // Will be calculated from deltas
            totalTokens: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheCreation: 0
            },
            totalCost: 0
          }
        };
      }

      const deltas: MetricDelta[] = [];

      // Read metrics JSONL file if it exists
      try {
        const content = readFileSync(metricsFile, 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const record = JSON.parse(line) as MetricsRecord;

            // The _metrics.jsonl files contain direct MetricDelta records
            // Check if it has the MetricDelta structure (recordId, sessionId, tokens, etc.)
            if ('recordId' in record && 'sessionId' in record && 'tokens' in record) {
              deltas.push(record as MetricDelta);
            }
          } catch {
            // Skip malformed lines
            continue;
          }
        }
      } catch {
        // Metrics file doesn't exist or can't be read - that's okay, session might have no metrics yet
      }

      return { sessionId, startEvent, endEvent, deltas };
    } catch {
      return null;
    }
  }

  /**
   * Check if session matches filter criteria
   */
  private matchesFilter(sessionData: RawSessionData, filter?: AnalyticsFilter): boolean {
    if (!filter) {
      return true;
    }

    const startEvent = sessionData.startEvent;
    if (!startEvent) {
      return false;
    }

    // Filter by agent name
    if (filter.agentName && startEvent.agentName !== filter.agentName) {
      return false;
    }

    // Filter by project pattern
    if (filter.projectPattern) {
      const workingDir = startEvent.data.workingDirectory || '';
      if (!this.matchesProjectPattern(workingDir, filter.projectPattern)) {
        return false;
      }
    }

    // Filter by branch - check if any delta in this session matches the branch
    if (filter.branch) {
      const hasMatchingBranch = sessionData.deltas.some(delta => delta.gitBranch === filter.branch);
      if (!hasMatchingBranch) {
        return false;
      }
    }

    // Filter by date range
    if (filter.fromDate && startEvent.data.startTime < filter.fromDate.getTime()) {
      return false;
    }

    if (filter.toDate && startEvent.data.startTime > filter.toDate.getTime()) {
      return false;
    }

    return true;
  }

  /**
   * Check if project path matches pattern
   * Supports:
   * - Basename match: "codemie-code" matches "/path/to/codemie-code"
   * - Partial path: "codemie-ai/codemie-code" matches full path
   * - Full path match
   */
  private matchesProjectPattern(projectPath: string, pattern: string): boolean {
    if (!pattern) {
      return true;
    }

    const normalizedPath = projectPath.toLowerCase();
    const normalizedPattern = pattern.toLowerCase();

    // Exact match
    if (normalizedPath === normalizedPattern) {
      return true;
    }

    // Basename match
    const basename = projectPath.split('/').pop()?.toLowerCase() || '';
    if (basename === normalizedPattern) {
      return true;
    }

    // Partial path match
    if (normalizedPath.includes(normalizedPattern)) {
      return true;
    }

    // Path segment match
    const patternSegments = normalizedPattern.split('/').filter(s => s);
    const pathSegments = normalizedPath.split('/').filter(s => s);

    if (patternSegments.length > 0) {
      for (let i = 0; i <= pathSegments.length - patternSegments.length; i++) {
        let match = true;
        for (let j = 0; j < patternSegments.length; j++) {
          if (pathSegments[i + j] !== patternSegments[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          return true;
        }
      }
    }

    return false;
  }
}
