import { describe, expect, it } from 'vitest';

import { obfuscatePayload, redactPayload, selectExportPayload } from '../redact.js';
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

describe('selectExportPayload', () => {
  it('obfuscates the title when obfuscation is on and --redact is not set', () => {
    const out = selectExportPayload(payload('mail bob@example.com'), false, 'on');
    expect(out.sessions[0].title).toContain('[REDACTED:EMAIL]');
  });

  it('--redact wins over obfuscation', () => {
    expect(selectExportPayload(payload('bob@example.com'), true, 'on').sessions[0].title).toBe('');
  });

  it('leaves the payload alone when off and not redacted', () => {
    const input = payload('bob@example.com');
    expect(selectExportPayload(input, false, 'off')).toBe(input);
  });
});
