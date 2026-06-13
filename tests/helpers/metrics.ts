import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Finds the most recently modified *_metrics.jsonl file in sessionsDir and
 * returns the last parsed JSON record from it.
 */
export function getLatestMetricsRecord(sessionsDir: string): Record<string, unknown> {
  const files = readdirSync(sessionsDir)
    .filter((f) => f.endsWith('_metrics.jsonl'))
    .map((f) => join(sessionsDir, f))
    .sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
  if (!files.length) throw new Error('No metrics files found in ' + sessionsDir);
  const lines = readFileSync(files[0], 'utf-8').trim().split('\n').filter(Boolean);
  if (!lines.length) throw new Error('Metrics file is empty: ' + files[0]);
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}
