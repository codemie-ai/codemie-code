import { describe, expect, it } from 'vitest';
import { parseSkillNamesFromSkillsTelemetry, parseSkillsTelemetry } from '../skills-sh-telemetry.js';

describe('parseSkillsTelemetry', () => {
  it('parses both skillNames and agents from a matched event', () => {
    const stderr =
      'CODEMIE_SKILLS_SH_TELEMETRY {"event":"install","skills":"foo,bar","agents":"claude-code,cursor"}';
    const result = parseSkillsTelemetry(stderr, 'install');
    expect(result.skillNames).toEqual(['foo', 'bar']);
    expect(result.agents).toEqual(['claude-code', 'cursor']);
  });

  it('returns agents undefined when agents field is absent', () => {
    const stderr = 'CODEMIE_SKILLS_SH_TELEMETRY {"event":"install","skills":"qa-gates"}';
    const result = parseSkillsTelemetry(stderr, 'install');
    expect(result.skillNames).toEqual(['qa-gates']);
    expect(result.agents).toBeUndefined();
  });

  it('returns skillNames undefined when skills field is absent', () => {
    const stderr = 'CODEMIE_SKILLS_SH_TELEMETRY {"event":"install","agents":"claude-code"}';
    const result = parseSkillsTelemetry(stderr, 'install');
    expect(result.skillNames).toBeUndefined();
    expect(result.agents).toEqual(['claude-code']);
  });

  it('returns both undefined when no matching event line is present', () => {
    const result = parseSkillsTelemetry('no telemetry here', 'install');
    expect(result.skillNames).toBeUndefined();
    expect(result.agents).toBeUndefined();
  });

  it('ignores events for a different event type', () => {
    const stderr =
      'CODEMIE_SKILLS_SH_TELEMETRY {"event":"remove","skills":"foo","agents":"claude-code"}';
    const result = parseSkillsTelemetry(stderr, 'install');
    expect(result.skillNames).toBeUndefined();
    expect(result.agents).toBeUndefined();
  });

  it('trims whitespace from skill names and agent names', () => {
    const stderr =
      'CODEMIE_SKILLS_SH_TELEMETRY {"event":"install","skills":" foo , bar ","agents":" claude-code , cursor "}';
    const result = parseSkillsTelemetry(stderr, 'install');
    expect(result.skillNames).toEqual(['foo', 'bar']);
    expect(result.agents).toEqual(['claude-code', 'cursor']);
  });

  it('accumulates skills and agents across multiple matching telemetry lines', () => {
    const stderr = [
      'CODEMIE_SKILLS_SH_TELEMETRY {"event":"install","skills":"foo","agents":"claude-code"}',
      'CODEMIE_SKILLS_SH_TELEMETRY {"event":"install","skills":"bar","agents":"cursor"}',
    ].join('\n');
    const result = parseSkillsTelemetry(stderr, 'install');
    expect(result.skillNames).toEqual(['foo', 'bar']);
    expect(result.agents).toEqual(['claude-code', 'cursor']);
  });

  it('only processes lines matching the marker prefix', () => {
    const stderr = [
      'some random log line with install in it',
      'CODEMIE_SKILLS_SH_TELEMETRY {"event":"install","skills":"real","agents":"claude-code"}',
    ].join('\n');
    const result = parseSkillsTelemetry(stderr, 'install');
    expect(result.skillNames).toEqual(['real']);
    expect(result.agents).toEqual(['claude-code']);
  });
});

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
