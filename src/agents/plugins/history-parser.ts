/**
 * History Parser Utility
 *
 * Generic utility for parsing JSONL history files.
 * Can be used by any agent that stores user prompts in JSONL format.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { UserPrompt } from '../core/metrics/types.js';
import { logger } from '../../utils/logger.js';

export interface HistoryParserOptions {
  /**
   * Time window for matching prompts to turns (ms)
   * Default: 5000ms (±5 seconds)
   */
  timeWindow?: number;
}

export class HistoryParser {
  private historyPath: string;
  private timeWindow: number;

  constructor(historyPath: string, options: HistoryParserOptions = {}) {
    this.historyPath = historyPath;
    this.timeWindow = options.timeWindow ?? 5000; // Default: ±5 seconds
  }

  /**
   * Check if history file exists
   */
  exists(): boolean {
    return existsSync(this.historyPath);
  }

  /**
   * Parse entire history file and return all user prompts
   * Claude's history.jsonl uses multi-line JSON format (pretty-printed)
   */
  async parseAll(): Promise<UserPrompt[]> {
    try {
      if (!this.exists()) {
        logger.debug(`[HistoryParser] File not found: ${this.historyPath}`);
        return [];
      }

      const content = await readFile(this.historyPath, 'utf-8');

      // Parse multi-line JSON objects
      // Split by newlines followed by opening brace
      const jsonObjects: any[] = [];
      let currentObject = '';
      let braceDepth = 0;
      let inString = false;
      let escapeNext = false;

      for (let i = 0; i < content.length; i++) {
        const char = content[i];
        currentObject += char;

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\') {
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === '{') {
            braceDepth++;
          } else if (char === '}') {
            braceDepth--;

            // Complete object found
            if (braceDepth === 0 && currentObject.trim()) {
              try {
                const parsed = JSON.parse(currentObject.trim());
                jsonObjects.push(parsed);
              } catch {
                logger.debug(`[HistoryParser] Failed to parse object: ${currentObject.substring(0, 100)}...`);
              }
              currentObject = '';
            }
          }
        }
      }

      const prompts: UserPrompt[] = [];

      for (const parsed of jsonObjects) {
        // Validate required fields
        if (parsed.sessionId && parsed.timestamp && parsed.display) {
          prompts.push({
            display: parsed.display,
            timestamp: parsed.timestamp,
            project: parsed.project || '',
            sessionId: parsed.sessionId,
            pastedContents: parsed.pastedContents
          });
        }
      }

      return prompts;
    } catch (error) {
      logger.error(`[HistoryParser] Failed to parse history file: ${this.historyPath}`, error);
      return [];
    }
  }

  /**
   * Get user prompts for a specific session
   */
  async getSessionPrompts(sessionId: string): Promise<UserPrompt[]> {
    const all = await this.parseAll();
    return all.filter(p => p.sessionId === sessionId);
  }

  /**
   * Get prompts for session within time range
   */
  async getPromptsInRange(
    sessionId: string,
    fromTimestamp?: number,
    toTimestamp?: number
  ): Promise<UserPrompt[]> {
    const sessionPrompts = await this.getSessionPrompts(sessionId);

    if (!fromTimestamp && !toTimestamp) {
      return sessionPrompts;
    }

    return sessionPrompts.filter(p => {
      if (fromTimestamp && p.timestamp < fromTimestamp) return false;
      if (toTimestamp && p.timestamp > toTimestamp) return false;
      return true;
    });
  }

  /**
   * Count prompts per session
   * Returns Map<sessionId, count>
   */
  async countBySession(): Promise<Map<string, number>> {
    const all = await this.parseAll();
    const counts = new Map<string, number>();

    for (const prompt of all) {
      counts.set(prompt.sessionId, (counts.get(prompt.sessionId) || 0) + 1);
    }

    return counts;
  }

  /**
   * Find prompts near a specific timestamp (within time window)
   * Useful for correlating prompts with agent turns
   */
  async findPromptsNearTimestamp(
    sessionId: string,
    targetTimestamp: number
  ): Promise<UserPrompt[]> {
    const sessionPrompts = await this.getSessionPrompts(sessionId);

    return sessionPrompts.filter(p => {
      const timeDiff = Math.abs(p.timestamp - targetTimestamp);
      return timeDiff <= this.timeWindow;
    });
  }

  /**
   * Create a timestamp-indexed map for fast lookup
   * Returns Map<timestamp, UserPrompt>
   */
  async createTimestampMap(sessionId: string): Promise<Map<number, UserPrompt>> {
    const sessionPrompts = await this.getSessionPrompts(sessionId);
    const map = new Map<number, UserPrompt>();

    for (const prompt of sessionPrompts) {
      map.set(prompt.timestamp, prompt);
    }

    return map;
  }
}
