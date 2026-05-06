import { describe, expect, it } from 'vitest';
import { parseSkillNamesFromSkillsTelemetry } from '../skills-sh-telemetry.js';

describe('parseSkillNamesFromSkillsTelemetry', () => {
  it('returns trimmed skill names for the requested upstream event', () => {
    const stderr = [
      'CODEMIE_SKILLS_SH_TELEMETRY {"event":"install","skills":" ignored "}',
      'CODEMIE_SKILLS_SH_TELEMETRY {"event":"remove","skills":" alpha, beta ,gamma "}',
    ].join('\n');

    expect(parseSkillNamesFromSkillsTelemetry(stderr, 'remove')).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('returns undefined when no requested event payload is present', () => {
    const stderr = 'CODEMIE_SKILLS_SH_TELEMETRY {"event":"install","skills":"alpha"}';

    expect(parseSkillNamesFromSkillsTelemetry(stderr, 'update')).toBeUndefined();
  });
});
