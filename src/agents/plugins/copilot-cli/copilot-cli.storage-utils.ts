/**
 * Tolerant reader for Copilot's `events.jsonl`.
 *
 * A live session's final line can be truncated mid-write, and the schema is undocumented,
 * so unparseable lines are dropped rather than thrown. The cost enricher catches per
 * session anyway, but degrading here keeps one bad line from discarding a whole session.
 */

import { readFileSync } from 'fs';
import type { CopilotEvent } from './copilot-cli-event-types.js';
import { unlessAbsent } from '../../core/session/no-transcript-correlation.js';
import { logger } from '../../../utils/logger.js';

export function readCopilotEventsTolerant(filePath: string): CopilotEvent[] {
  try {
    return readCopilotEvents(filePath);
  } catch (error) {
    logger.debug(`[copilot-cli] unreadable events.jsonl at ${filePath}:`, error);
    return [];
  }
}

/** The transcript's events: an absent file has none, any other read failure throws, a torn line is dropped. */
export function readCopilotEvents(filePath: string): CopilotEvent[] {
  const text = unlessAbsent(() => readFileSync(filePath, 'utf-8'));
  return text === undefined ? [] : parseCopilotEvents(text, filePath);
}

/** The events of a transcript's text; a torn or unparseable line is dropped. */
export function parseCopilotEvents(text: string, filePath: string): CopilotEvent[] {
  const events: CopilotEvent[] = [];
  let dropped = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        events.push(parsed as CopilotEvent);
      }
    } catch {
      dropped++;
    }
  }

  if (dropped > 0) {
    logger.debug(`[copilot-cli] dropped ${dropped} unparseable line(s) in ${filePath}`);
  }
  return events;
}
