/**
 * Claude Lifecycle Adapter
 *
 * Detects session lifecycle events for Claude Code by parsing history.jsonl
 * for /clear commands that reset the session.
 */

import { SessionLifecycleAdapter } from '../../core/session/types.js';
import { HistoryParser } from './history-parser.js';
import { join } from 'path';
import { homedir } from 'os';

export class ClaudeLifecycleAdapter implements SessionLifecycleAdapter {
  private historyPath: string;

  constructor() {
    this.historyPath = join(homedir(), '.claude', 'history.jsonl');
  }

  /**
   * Check if session has ended (e.g., /clear command)
   *
   * @param agentSessionId - Agent's session identifier
   * @param afterTimestamp - Only check events after this time
   * @returns Timestamp of session end event, or null if still active
   */
  async detectSessionEnd(
    agentSessionId: string,
    afterTimestamp: number
  ): Promise<number | null> {
    const parser = new HistoryParser(this.historyPath);
    return await parser.findClearCommand(agentSessionId, afterTimestamp);
  }
}
