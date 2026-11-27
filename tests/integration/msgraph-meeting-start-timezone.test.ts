/**
 * msgraph.js transcripts --list — meeting start time is local time with a UTC offset label
 *
 * Regression for: meeting start times in the online-meetings listing (the view the call-notes
 * flow reads) were printed as bare UTC with no timezone label.
 *
 * Runs the skill script offline through tests/helpers/msgraph-runner.ts; set
 * MSGRAPH_SCRIPT_UNDER_TEST to run it against another copy of msgraph.js.
 */

// @case msgraph_meeting_start_local_tz_TC_001

import { describe, it, expect, afterEach } from 'vitest';
import { createMsgraphRunner, MSGRAPH_RUN_TIMEOUT_MS } from '../helpers/msgraph-runner.js';

// One online meeting starting 2026-11-23 08:30 UTC, as Graph returns it (zone-less dateTime + timeZone: UTC)
const GRAPH_RESPONSE = {
  value: [{
    id: 'evt-1', subject: 'Sprint review', isAllDay: false, isOnlineMeeting: true,
    onlineMeeting: { joinUrl: 'https://teams.example.invalid/l/meetup-join/1' },
    start: { dateTime: '2026-11-23T08:30:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-11-23T09:30:00.0000000', timeZone: 'UTC' },
  }],
};

describe('msgraph.js online meetings listing', () => {
  const msgraph = createMsgraphRunner();

  afterEach(() => msgraph.cleanup());

  it('shows the meeting start in local time with a UTC offset label for a non-UTC user', async () => {
    const result = await msgraph.run({
      tz: 'Asia/Tbilisi',
      args: ['transcripts', '--list', '--start', '2026-11-23'],
      graphResponse: GRAPH_RESPONSE,
    });
    const meetingLine = result.stdout.split('\n').find(l => l.includes('Sprint review'));

    expect(result.code, result.stderr).toBe(0); // repro:precondition
    expect(meetingLine, result.stdout).toBeDefined(); // repro:precondition
    expect(meetingLine).toContain('2026-11-23 12:30 (UTC+4)'); // repro:symptom
  }, MSGRAPH_RUN_TIMEOUT_MS + 5_000);
});
