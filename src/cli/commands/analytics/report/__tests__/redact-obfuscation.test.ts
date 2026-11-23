import { describe, expect, it } from 'vitest';

import { obfuscatePayload, redactPayload } from '../redact.js';
import type { ReportPayload, ReportSessionRecord } from '../types.js';

function payload(title: string): ReportPayload {
  return {
    meta: { projectFilter: 'all' },
    sessions: [{ title, project: '/home/u/proj' } as unknown as ReportSessionRecord],
  } as unknown as ReportPayload;
}

describe('obfuscatePayload', () => {
  it('masks emails in the session title when mode is on', () => {
    const out = obfuscatePayload(payload('mail bob@example.com now'), 'on');
    expect(out.sessions[0].title).toContain('[REDACTED:EMAIL]');
    expect(out.sessions[0].title).not.toContain('bob@example.com');
  });

  it('returns the payload unchanged when mode is off', () => {
    const input = payload('mail bob@example.com now');
    expect(obfuscatePayload(input, 'off')).toBe(input);
  });

  it('--redact (redactPayload) still blanks the title', () => {
    expect(redactPayload(payload('bob@example.com')).sessions[0].title).toBe('');
  });
});
