/**
 * Parses structured payloads captured from upstream `skills` telemetry.
 *
 * The egress guard blocks the upstream network request but writes the query
 * payload to stderr with this marker. This gives the wrapper the selected
 * skill names from interactive upstream flows without parsing human output.
 */

import { logger } from '@/utils/logger.js';
import { capList } from './sanitize.js';

export const SKILLS_SH_TELEMETRY_MARKER = 'CODEMIE_SKILLS_SH_TELEMETRY';

interface SkillsTelemetryPayload {
  event?: string;
  skills?: string;
}

export function parseSkillNamesFromSkillsTelemetry(
  stderr: string,
  event: string
): string[] | undefined {
  const skillNames: string[] = [];
  const lines = stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${SKILLS_SH_TELEMETRY_MARKER} `));

  for (const line of lines) {
    const rawPayload = line.slice(SKILLS_SH_TELEMETRY_MARKER.length + 1);
    try {
      const payload = JSON.parse(rawPayload) as SkillsTelemetryPayload;
      if (payload.event !== event || !payload.skills) {
        continue;
      }
      skillNames.push(...payload.skills.split(',').map((skill) => skill.trim()));
    } catch (error) {
      logger.debug('[skills] Failed to parse skills.sh telemetry payload', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return capList(skillNames);
}
