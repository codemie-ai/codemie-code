import { describe, it, expect } from 'vitest';
import { extractSlashCommand, normalizeUserPrompt } from '../copilot-cli.constants.js';
import { buildSessionSummaryEvent, mergeDetails, summarizeSlice } from '../../copilot-cli-otlp/copilot-cli-otlp.usage.js';
import type { CopilotEvent } from '../copilot-cli-event-types.js';

const REVIEW = 'The user has requested a code review via the /review command. Use the task tool.';
const FLEET = 'You are now in fleet mode. Dispatch sub-agents in parallel.';

describe('slash command detection', () => {
  it('normalizes /review and /fleet instructions to the command', () => {
    expect(normalizeUserPrompt(REVIEW)).toBe('/review');
    expect(normalizeUserPrompt(FLEET)).toBe('/fleet');
    const real = `<current_datetime>2026-10-30T12:36:30+02:00</current_datetime>\n\n${FLEET}\n\nNow proceed.\n\nUser request: how to work`;
    expect(normalizeUserPrompt('Fleet deployed: how to work', real)).toBe('/fleet: how to work');
    expect(normalizeUserPrompt('plain prompt')).toBe('plain prompt');
  });

  it('extracts the command name', () => {
    expect(extractSlashCommand(undefined, REVIEW)).toBe('review');
    expect(extractSlashCommand(undefined, FLEET)).toBe('fleet');
    expect(extractSlashCommand('/security-review now')).toBe('security-review');
    expect(extractSlashCommand('hello')).toBeUndefined();
    expect(extractSlashCommand('/sdlc-factory:sdlc-standard x')).toBe('sdlc-factory:sdlc-standard');
    expect(extractSlashCommand('/v1.2 notes')).toBeUndefined();
    expect(extractSlashCommand('/1 item')).toBeUndefined();
  });

  it('falls back to the fleet label when the transformed text is missing', () => {
    expect(normalizeUserPrompt('Fleet deployed: how to work')).toBe('/fleet: how to work');
    expect(extractSlashCommand('Fleet deployed: how to work')).toBe('fleet');
  });
});

describe('session summary commands', () => {
  const msg = (transformedContent: string, timestamp: string): CopilotEvent =>
    ({ type: 'user.message', timestamp, data: { content: transformedContent, transformedContent } }) as CopilotEvent;

  it('keeps commands in call order with repeats, merges across slices and emits primary_command', () => {
    const a = summarizeSlice('s', [msg(REVIEW, '2026-01-01T00:00:00Z'), msg(REVIEW, '2026-01-01T00:01:00Z')], 'incremental');
    const b = summarizeSlice('s', [msg(FLEET, '2026-01-01T00:02:00Z')], 'incremental');
    expect(a.details.commands).toEqual(['review', 'review']);
    const merged = mergeDetails(a.details, b.details);
    expect(merged.commands).toEqual(['review', 'review', 'fleet']);
    const summary = buildSessionSummaryEvent({
      sessionId: 's', phase: 'final', counters: a.counters, details: merged,
      startedAt: '', endedAt: '', usagePartial: false,
    });
    expect(summary['commands']).toEqual(['review', 'review', 'fleet']);
    expect(summary['primary_command']).toBe('review');
  });
});
