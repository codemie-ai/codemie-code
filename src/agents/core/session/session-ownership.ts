import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCodemiePath } from '../../../utils/paths.js';
import { logger } from '../../../utils/logger.js';

export function scanSessionsForClaudeId(
  claudeSessionId: string,
  sessionsDir?: string,
): boolean {
  const dir = sessionsDir ?? getCodemiePath('sessions');
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (f) => f.endsWith('.json') && !f.endsWith('_metrics.json'),
    );
  } catch {
    return false;
  }
  for (const f of files) {
    try {
      const record = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as {
        correlation?: { agentSessionId?: string };
      };
      if (record.correlation?.agentSessionId === claudeSessionId) {
        return true;
      }
    } catch {
      logger.debug(`[session-ownership] Skipping unreadable session file: ${f}`);
    }
  }
  return false;
}
