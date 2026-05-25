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
  agents?: string;
}

export interface ParsedSkillsTelemetry {
  skillNames: string[] | undefined;
  agents: string[] | undefined;
}

export function parseSkillsTelemetry(
  stderr: string,
  event: string
): ParsedSkillsTelemetry {
  const skillNames: string[] = [];
  const agentNames: string[] = [];
  const lines = stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${SKILLS_SH_TELEMETRY_MARKER} `));

  for (const line of lines) {
    const rawPayload = line.slice(SKILLS_SH_TELEMETRY_MARKER.length + 1);
    try {
      const payload = JSON.parse(rawPayload) as SkillsTelemetryPayload;
      if (payload.event !== event) {
        continue;
      }
      if (payload.skills) {
        skillNames.push(
          ...payload.skills
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        );
      }
      if (payload.agents) {
        agentNames.push(
          ...payload.agents
            .split(',')
            .map((a) => a.trim())
            .filter((a) => a.length > 0)
        );
      }
    } catch (error) {
      logger.debug('[skills] Failed to parse skills.sh telemetry payload', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    skillNames: capList(skillNames),
    agents: capList(agentNames),
  };
}

export function parseSkillNamesFromSkillsTelemetry(
  stderr: string,
  event: string
): string[] | undefined {
  return parseSkillsTelemetry(stderr, event).skillNames;
}
