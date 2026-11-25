import { describe, expect, it } from 'vitest';
import { REPORT_SESSION_KEEP_LIST, redactPayloadPerSession, reduceSession } from '../redact.js';
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

describe('reduceSession and the --redact mode', () => {
  it('reduce mode reduces title and branch and keeps metrics', () => {
    const out = reduceSession(payload().sessions[0]) as unknown as Record<string, unknown>;
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
    p.sessions[0].branch = 'feature/acme-bank-migration';
    p.sessions[0].title = '';
    const out = reduceSession(p.sessions[0]);
    expect(out.branch).toBe('REDACTED:BRANCH');
    expect(out.title).toBe('');
  });

  it('redact mode keeps today\'s output', async () => {
    const out = await redactPayloadPerSession(payload(), { redact: true, unreduced: true });
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

describe('redactPayloadPerSession (CR-003)', () => {
  it('reduces every session when the global flag is on, whatever the cwd', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = await mkdtemp(join(tmpdir(), 'reduce-home-'));
    const optedIn = await mkdtemp(join(tmpdir(), 'reduce-proj-on-'));
    const plain = await mkdtemp(join(tmpdir(), 'reduce-proj-off-'));
    await mkdir(join(optedIn, '.codemie'), { recursive: true });
    await writeFile(join(optedIn, '.codemie', 'codemie-cli.config.json'), JSON.stringify({ analytics: { promptReduction: true } }));
    const previousHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = home;
    try {
      const { redactPayloadPerSession } = await import('../redact.js');
      const p = payload();
      const on = { ...p.sessions[0], sessionId: 'on', project: optedIn, branch: 'feature/acme-bank-migration' };
      const off = { ...p.sessions[0], sessionId: 'off', project: plain, branch: 'feature/acme-bank-migration' };
      const out = await redactPayloadPerSession({ meta: p.meta, sessions: [on, off] }, {});
      expect(out.sessions.find((s) => s.sessionId === 'on')?.branch).toBe('REDACTED:BRANCH');
      expect(out.sessions.find((s) => s.sessionId === 'off')?.branch).toBe('feature/acme-bank-migration');
    } finally {
      if (previousHome === undefined) delete process.env.CODEMIE_HOME;
      else process.env.CODEMIE_HOME = previousHome;
    }
  });
});

describe('report privacy decisions across projects (CR-012, CR-014)', () => {
  async function withHome<T>(optedIn: string[] | undefined, body: () => Promise<T>): Promise<T> {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = await mkdtemp(join(tmpdir(), 'reduce-home-'));
    if (optedIn) await writeFile(join(home, 'analytics-reduction-projects.json'), JSON.stringify(optedIn));
    const previousHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = home;
    try {
      return await body();
    } finally {
      if (previousHome === undefined) delete process.env.CODEMIE_HOME;
      else process.env.CODEMIE_HOME = previousHome;
    }
  }

  it('reduces the console report from a plain directory when another project opted in', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const plain = await mkdtemp(`${tmpdir()}/reduce-plain-`);
    await withHome(['/work/other-project'], async () => {
      const { resolveReportPrivacyMode } = await import('../redact.js');
      expect(await resolveReportPrivacyMode({}, plain)).toBe('reduce');
      expect(await resolveReportPrivacyMode({ unreduced: true }, plain)).toBeUndefined();
    });
  });

  it('leaves the console report unreduced when nothing opted in', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const plain = await mkdtemp(`${tmpdir()}/reduce-plain-`);
    await withHome(undefined, async () => {
      const { resolveReportPrivacyMode } = await import('../redact.js');
      expect(await resolveReportPrivacyMode({}, plain)).toBeUndefined();
    });
  });

  it('reduces a session whose project directory no longer exists when a project opted in', async () => {
    await withHome(['/work/other-project'], async () => {
      const { redactPayloadPerSession } = await import('../redact.js');
      const p = payload();
      const moved = { ...p.sessions[0], project: '/gone/moved-away-project', branch: 'feature/acme-bank-migration' };
      const out = await redactPayloadPerSession({ meta: p.meta, sessions: [moved] }, {});
      expect(out.sessions[0].branch).toBe('REDACTED:BRANCH');
    });
  });
});
