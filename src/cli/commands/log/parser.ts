/**
 * Log parser - Parse log entries and session data
 */

import type { LogEntry, LogLevel, SessionMetadata } from './types.js';

/**
 * Parse a debug log line into structured LogEntry
 * Format: [timestamp] [LEVEL] [AGENT] [SESSION_ID] [PROFILE] message
 * Example: [2026-02-03T09:18:48.816Z] [INFO] [claude] [7427566e-...] [codemie-sso] Session sync enabled
 */
export function parseLogLine(line: string): LogEntry | null {
  if (!line.trim()) {
    return null;
  }

  // Match log format with optional profile
  const regex = /^\[([^\]]+)\] \[([^\]]+)\] \[([^\]]+)\] \[([^\]]+)\](?: \[([^\]]+)\])? (.+)$/;
  const match = line.match(regex);

  if (!match) {
    // Return as unparsed entry with current timestamp
    return {
      timestamp: new Date(),
      level: 'debug',
      agent: 'unknown',
      sessionId: 'unknown',
      profile: null,
      message: line,
      rawLine: line
    };
  }

  const [, timestampStr, levelStr, agent, sessionId, profile, message] = match;

  // Parse timestamp
  let timestamp: Date;
  try {
    timestamp = new Date(timestampStr);
    if (isNaN(timestamp.getTime())) {
      timestamp = new Date();
    }
  } catch {
    timestamp = new Date();
  }

  // Normalize log level
  const level = normalizeLogLevel(levelStr);

  return {
    timestamp,
    level,
    agent,
    sessionId,
    profile: profile || null,
    message: message.trim(),
    rawLine: line
  };
}

/**
 * Normalize log level string to LogLevel type
 */
function normalizeLogLevel(levelStr: string): LogLevel {
  const normalized = levelStr.toLowerCase();
  if (normalized === 'info') return 'info';
  if (normalized === 'warn' || normalized === 'warning') return 'warn';
  if (normalized === 'error') return 'error';
  return 'debug';
}

/**
 * Parse session metadata from JSON file
 */
export function parseSessionMetadata(jsonContent: string): SessionMetadata | null {
  try {
    const data = JSON.parse(jsonContent);

    // Validate required fields
    if (!data.sessionId || !data.agentName || !data.provider || !data.startTime) {
      return null;
    }

    return {
      sessionId: data.sessionId,
      agentName: data.agentName,
      provider: data.provider,
      startTime: data.startTime,
      endTime: data.endTime,
      status: data.status || 'active',
      workingDirectory: data.workingDirectory || '',
      gitBranch: data.gitBranch
    };
  } catch {
    return null;
  }
}

/**
 * Parse session conversation from JSONL file
 * Returns array of conversation turns
 */
export function parseSessionConversation(jsonlContent: string): Array<Record<string, unknown>> {
  const turns: Array<Record<string, unknown>> = [];

  const lines = jsonlContent.trim().split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const turn = JSON.parse(line);
      turns.push(turn);
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  return turns;
}
