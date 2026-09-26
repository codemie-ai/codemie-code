import { readdir, stat, unlink, readFile } from 'node:fs/promises';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import type { SSOCredentials, JWTCredentials } from '../../../../../core/types.js';
import { spoolRoot, sessionFile } from './spool-paths.js';
import { withSessionLock } from './session-lock.js';
import type { SessionStatus } from './completeness-gate.js';

const STATUS_SUFFIX = '.status';

/**
 * Enumerate all *.status files in the spool root and delete the full session
 * data for any session that has been forwarded and whose status file is older
 * than STATUS_TTL_MINUTES (env, default 60 minutes).
 */
export async function sweepExpired(credentials: SSOCredentials | JWTCredentials): Promise<void> {
  void credentials; // credentials reserved for future use (e.g. re-auth before sweep)

  const ttlMinutes = Number(process.env['STATUS_TTL_MINUTES'] ?? '60');
  const ttlMs = ttlMinutes * 60 * 1000;
  const root = spoolRoot();

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // Spool root may not exist yet
    return;
  }

  const statusFiles = entries.filter((f) => f.endsWith(STATUS_SUFFIX));

  for (const fileName of statusFiles) {
    const sessionId = fileName.slice(0, -STATUS_SUFFIX.length);
    try {
      await sweepSession(root, sessionId, ttlMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug('[otlp-sweep] per-session error', ...sanitizeLogArgs({ sessionId, err: msg }));
    }
  }
}

async function sweepSession(root: string, sessionId: string, ttlMs: number): Promise<void> {
  const statusPath = sessionFile(sessionId, 'status');

  // Read and parse status
  let status: SessionStatus;
  try {
    const raw = await readFile(statusPath, 'utf-8');
    status = JSON.parse(raw) as SessionStatus;
  } catch {
    return;
  }

  if (!status.forwarded) return;

  // Check mtime
  let fileStat: { mtimeMs: number };
  try {
    fileStat = await stat(statusPath);
  } catch {
    return;
  }

  const ageMs = Date.now() - fileStat.mtimeMs;
  if (ageMs < ttlMs) return;

  // Acquire lock and delete all spool files
  await withSessionLock(sessionId, async () => {
    const filesToDelete = [
      sessionFile(sessionId, 'hooks'),
      sessionFile(sessionId, 'otel_logs'),
      sessionFile(sessionId, 'otel_metrics'),
      sessionFile(sessionId, 'otel_traces'),
      sessionFile(sessionId, 'status'),
    ];
    for (const f of filesToDelete) {
      try {
        await unlink(f);
      } catch {
        // File may already be gone
      }
    }
    logger.debug('[otlp-sweep] swept expired session', ...sanitizeLogArgs({ sessionId, ageMs }));
  });
}
