import { describe, expect, it } from 'vitest';
import { REPORT_SESSION_KEEP_LIST, redactPayload } from '../redact.js';
import type { ReportPayload, ReportSessionRecord } from '../types.js';

function payload(): ReportPayload {
  const session = {
    sessionId: 's1', agentName: 'claude', provider: 'native', project: '/home/dev/acme-repo',
    branch: 'feature/EPMCDME-123-secret', title: '/review-pr !456 check auth', models: ['m1'],
    turns: 3, tools: [{ toolName: 'Read', totalCalls: 1, successCount: 1, failureCount: 0, successRate: 1 }],
    agentSessionFile: '/home/dev/.claude/s1.jsonl', futureField: 'private text',
  } as unknown as ReportSessionRecord;
  return { meta: { projectFilter: '/home/dev/acme-repo' } as ReportPayload['meta'], sessions: [session] };
}

describe('redactPayload', () => {
  it('reduce mode reduces title and branch and keeps metrics', () => {
    const out = redactPayload(payload(), 'reduce').sessions[0] as unknown as Record<string, unknown>;
    expect(out.title).toBe('/review-pr !456');
    expect(out.branch).toBe('EPMCDME-123');
    expect(out.turns).toBe(3);
    expect(out.models).toEqual(['m1']);
    expect(out.project).toBe('acme-repo');
    expect(out.agentSessionFile).toBeUndefined();
    expect(out.futureField).toBe('REDACTED:FUTURE-FIELD');
  });

  it('reduce mode cuts a branch with no ticket and keeps an empty title empty', () => {
    const p = payload();
    p.sessions[0].branch = 'main';
    p.sessions[0].title = '';
    const out = redactPayload(p, 'reduce').sessions[0];
    expect(out.branch).toBe('REDACTED:BRANCH');
    expect(out.title).toBe('');
  });

  it('redact mode keeps today\'s output', () => {
    const out = redactPayload(payload(), 'redact');
    expect(out.sessions[0].title).toBe('');
    expect(out.sessions[0].branch).toBe('feature/EPMCDME-123-secret');
    expect(out.sessions[0].project).toBe('acme-repo');
    expect(out.meta.projectFilter).toBe('<redacted>');
  });

  it('exposes the keep-list', () => {
    expect(REPORT_SESSION_KEEP_LIST.keep.has('sessionId')).toBe(true);
    expect(REPORT_SESSION_KEEP_LIST.keep.has('title')).toBe(false);
  });
});
