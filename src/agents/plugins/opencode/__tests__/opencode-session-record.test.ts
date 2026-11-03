/**
 * Risk 1 regression guard — ensureSessionFile must never clobber the real
 * session record.
 *
 * The design for the codemie-opencode telemetry work calls this out explicitly:
 * `executeOnSessionStart` (BaseAgentAdapter:542) creates the real record with
 * `status: 'active'` and `correlation.agentSessionId` set to the CodeMie session
 * id, and `executeBeforeRun` (:578) then runs `ensureSessionFile` as a safety
 * net. That is safe ONLY because of the ordering and because ensureSessionFile
 * early-returns on an existing record. If either property breaks, every
 * tool-usage row silently ships `session_id: "unknown"` and
 * `session_duration_ms` is destroyed.
 *
 * These tests exercise the REAL SessionStore and the REAL ensureSessionFile
 * against an isolated CODEMIE_HOME — no mocks — because a mocked
 * ensureSessionFile cannot prove anything about what lands on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

let codemieHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  codemieHome = mkdtempSync(join(tmpdir(), 'codemie-session-record-'));
  originalHome = process.env.CODEMIE_HOME;
  process.env.CODEMIE_HOME = codemieHome;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.CODEMIE_HOME;
  } else {
    process.env.CODEMIE_HOME = originalHome;
  }
  rmSync(codemieHome, { recursive: true, force: true });
});

/** Mirrors the record createSessionRecord writes during SessionStart. */
async function writeActiveSessionRecord(): Promise<void> {
  const { SessionStore } = await import('../../../core/session/SessionStore.js');
  const store = new SessionStore();

  await store.saveSession({
    sessionId: SESSION_ID,
    agentName: 'opencode',
    provider: 'codemie',
    status: 'active',
    startTime: Date.now(),
    workingDirectory: process.cwd(),
    gitBranch: 'feat/opencode-telemetry-parity',
    correlation: { agentSessionId: SESSION_ID },
  } as never);
}

describe('ensureSessionFile (Risk 1 — session record clobbering)', () => {
  it('leaves an existing active record untouched', async () => {
    await writeActiveSessionRecord();

    const { ensureSessionFile } = await import('../../../core/session/ensure-session.js');
    await ensureSessionFile(SESSION_ID, { CODEMIE_AGENT: 'opencode' } as NodeJS.ProcessEnv, 'opencode');

    const { SessionStore } = await import('../../../core/session/SessionStore.js');
    const session = await new SessionStore().loadSession(SESSION_ID);

    // The two fields the whole telemetry pipeline keys on.
    expect(session?.status).toBe('active');
    expect(session?.correlation?.agentSessionId).toBe(SESSION_ID);
    expect(session?.correlation?.agentSessionId).not.toBe('unknown');
  });

  it('preserves startTime, so session_duration_ms is not destroyed', async () => {
    await writeActiveSessionRecord();

    const { SessionStore } = await import('../../../core/session/SessionStore.js');
    const store = new SessionStore();
    const before = await store.loadSession(SESSION_ID);

    const { ensureSessionFile } = await import('../../../core/session/ensure-session.js');
    await ensureSessionFile(SESSION_ID, { CODEMIE_AGENT: 'opencode' } as NodeJS.ProcessEnv, 'opencode');

    const after = await store.loadSession(SESSION_ID);
    expect(after?.startTime).toBe(before?.startTime);
  });

  it('with no prior record writes a live record owned by this process, and a second call changes nothing', async () => {
    // onSessionStart swallows a processEvent throw, so nothing may have written the real
    // record by the time beforeRun runs: the placeholder must then be a normal live record.
    const env = {
      CODEMIE_AGENT: 'opencode',
      CODEMIE_URL: 'https://codemie.example.com',
      CODEMIE_CLIENT_TYPE: 'codemie-opencode',
      CODEMIE_MODEL: 'gpt-5.1',
    } as NodeJS.ProcessEnv;
    const { ensureSessionFile } = await import('../../../core/session/ensure-session.js');
    const before = Date.now();
    await ensureSessionFile(SESSION_ID, env, 'opencode');
    const after = Date.now();

    const { getSessionPath } = await import('../../../core/session/session-config.js');
    const written = readFileSync(getSessionPath(SESSION_ID), 'utf-8');
    const session = JSON.parse(written);

    expect(session.status).toBe('active');
    expect(session.endTime).toBeUndefined();
    expect(session.correlation.agentSessionId).toBe(SESSION_ID);
    expect(session.ownerPid).toBe(process.pid);
    expect(typeof session.ownerStartedAt).toBe('number');
    expect(session.startTime).toBeGreaterThanOrEqual(before);
    expect(session.startTime).toBeLessThanOrEqual(after);
    // The start pass delivers a stranded record to its own host, under its client and model
    expect(session.codemieUrl).toBe('https://codemie.example.com');
    expect(session.clientType).toBe('codemie-opencode');
    expect(session.model).toBe('gpt-5.1');

    await ensureSessionFile(SESSION_ID, env, 'opencode');
    expect(readFileSync(getSessionPath(SESSION_ID), 'utf-8')).toBe(written);
  });
});
