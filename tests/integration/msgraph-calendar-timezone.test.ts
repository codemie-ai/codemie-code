/**
 * msgraph.js calendar — timezone label and all-day range contract test
 *
 * Runs the skill script offline through tests/helpers/msgraph-runner.ts, so no network
 * or real credentials are used.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createMsgraphRunner, MSGRAPH_RUN_TIMEOUT_MS } from '../helpers/msgraph-runner.js';

const allDay = (subject: string, start: string, end: string): Record<string, unknown> => ({
  subject, isAllDay: true,
  start: { dateTime: start + 'T00:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: end + 'T00:00:00.0000000', timeZone: 'UTC' },
  organizer: { emailAddress: { name: 'Org' } },
});

const GRAPH_RESPONSE = {
  value: [
    {
      subject: 'Timed', isAllDay: false,
      start: { dateTime: '2026-11-23T08:30:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-11-23T09:30:00.0000000', timeZone: 'UTC' },
      organizer: { emailAddress: { name: 'Org' } },
    },
    allDay('OneDay', '2026-11-23', '2026-11-24'),
    allDay('ThreeDay', '2026-11-23', '2026-11-26'),
  ],
};

describe('msgraph.js calendar timezone and all-day formatting', () => {
  const msgraph = createMsgraphRunner();

  afterEach(() => msgraph.cleanup());

  async function run(tz: string, cliArgs: string[]): Promise<string> {
    const result = await msgraph.run({ tz, args: ['calendar', ...cliArgs], graphResponse: GRAPH_RESPONSE });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout;
  }

  it('labels timed events with the local UTC offset and all-day events as dates', async () => {
    const out = await run('Asia/Tbilisi', []);
    expect(out).toContain('2026-11-23 12:30 (UTC+4)');
    expect(out).toContain('2026-11-23 (all day)');
  }, MSGRAPH_RUN_TIMEOUT_MS + 5_000);

  it('shows the inclusive last day for all-day events in the busy view', async () => {
    const out = await run('Asia/Tbilisi', ['--availability', '--start', '2026-11-23T00:00:00', '--end', '2026-11-30T00:00:00']);
    expect(out).toContain('2026-11-23 (all day) — 2026-11-23 (all day): OneDay');
    expect(out).toContain('2026-11-23 (all day) — 2026-11-25 (all day): ThreeDay');
  }, MSGRAPH_RUN_TIMEOUT_MS + 5_000);

  it('labels the zone as UTC when the local zone is UTC', async () => {
    const out = await run('UTC', []);
    expect(out).toContain('2026-11-23 08:30 (UTC)');
  }, MSGRAPH_RUN_TIMEOUT_MS + 5_000);
});
