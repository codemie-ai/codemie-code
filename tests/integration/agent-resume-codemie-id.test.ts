/**
 * `codemie-claude --resume <codemie-session-id>` (EPMCDME-17189).
 *
 * A session started with `codemie-claude --task` must be resumable by the CodeMie session id
 * that `codemie log list-sessions` / `codemie analytics` print, not only by Claude's own id.
 *
 * Run with: npx vitest run --project agent tests/integration/agent-resume-codemie-id.test.ts
 *
 * Auth mode (CI_IS_LOCAL_RUN in .env.test.local):
 *   true  (default) — SSO mode; uses developer's sso-autotest profile in ~/.codemie
 *   false           — JWT mode; isolates to a temp CODEMIE_HOME with bearer-auth profile
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
  fetchJwtToken,
  writeJwtProfile,
  getTempDir,
  jwtCleanEnv,
  resolveLongPath,
  getTestEnvFlagOrDefault,
  pollForSession,
  ssoCleanEnv,
  setupSsoAutotestProfile,
  teardownSsoAutotestProfile,
} from '../helpers/index.js';

const CLI_TIMEOUT_MS = parseInt(process.env.DEFAULT_TIMEOUT ?? '60', 10) * 1000;
const SETUP_TIMEOUT_MS = CLI_TIMEOUT_MS * 5;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLAUDE_BIN = join(repoRoot, 'bin', 'codemie-claude.js');

const CI_IS_LOCAL_RUN = getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true);

interface CompletedSessionRecord {
  sessionId: string;
  origin?: string;
  correlation?: { agentSessionId?: string };
}

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('codemie-claude --resume with a CodeMie session id', () => {
  let originalActiveProfile: string | undefined;
  let jwtToken: string;
  let jwtHome: string;
  let tempTestDir: string;

  beforeAll(async () => {
    if (!CI_IS_LOCAL_RUN) {
      jwtToken = await fetchJwtToken();
      jwtHome = mkdtempSync(join(getTempDir(), 'codemie-resume-jwt-'));
      writeJwtProfile(jwtHome, { jwtToken });
    } else {
      originalActiveProfile = setupSsoAutotestProfile();
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    if (!CI_IS_LOCAL_RUN) {
      if (jwtHome) rmSync(jwtHome, { recursive: true, force: true });
    } else {
      teardownSsoAutotestProfile(originalActiveProfile);
    }
  });

  beforeEach(() => {
    tempTestDir = resolveLongPath(mkdtempSync(join(tmpdir(), 'codemie_resume_test_')));
  });

  afterEach(() => {
    if (existsSync(tempTestDir)) {
      rmSync(tempTestDir, { recursive: true, force: true });
    }
  });

  function runClaude(extraArgs: string[]): ReturnType<typeof spawnSync> {
    // Both runs must share a cwd: Claude keys its native transcripts by project path.
    return CI_IS_LOCAL_RUN
      ? spawnSync(process.execPath, [CLAUDE_BIN, ...extraArgs], {
          env: ssoCleanEnv(),
          cwd: tempTestDir,
          encoding: 'utf-8',
          timeout: CLI_TIMEOUT_MS,
        })
      : spawnSync(process.execPath, [CLAUDE_BIN, ...extraArgs, '--jwt-token', jwtToken], {
          env: { ...jwtCleanEnv(), CODEMIE_HOME: jwtHome },
          cwd: jwtHome,
          encoding: 'utf-8',
          timeout: CLI_TIMEOUT_MS,
        });
  }

  function readRecord(sessionsDir: string, polledId: string): CompletedSessionRecord {
    return JSON.parse(readFileSync(join(sessionsDir, `${polledId}.json`), 'utf-8')) as CompletedSessionRecord;
  }

  it('resumes a session by the CodeMie id and passes the native id to Claude', async () => {
    const sessionsDir = CI_IS_LOCAL_RUN ? join(homedir(), '.codemie', 'sessions') : join(jwtHome, 'sessions');

    // 1. Start a session and find its CodeMie id the way `codemie log list-sessions` shows it.
    const firstMarker = randomUUID();
    const first = runClaude(['--task', `Reply with exactly this text and nothing else: ${firstMarker}`]);
    expect(first.status, `first run failed.\nstderr: ${first.stderr}\nstdout: ${first.stdout}`).toBe(0);

    const firstPoll = await pollForSession(sessionsDir, firstMarker, { timeoutMs: CLI_TIMEOUT_MS });
    expect(firstPoll.sessionId, `no session for ${firstMarker}. Dir: ${firstPoll.dirContents}`).not.toBeNull();

    const firstRecord = readRecord(sessionsDir, firstPoll.sessionId!);
    const codemieId = firstPoll.sessionId!.replace(/^completed_/, '');
    const nativeId = firstRecord.correlation?.agentSessionId;
    expect(firstRecord.sessionId).toBe(codemieId);
    expect(nativeId, 'completed record must carry the native Claude id').toBeTruthy();
    expect(nativeId).not.toBe(codemieId);

    // 2. Resume with the CodeMie id (the id the user copies from analytics / list-sessions).
    const secondMarker = randomUUID();
    const second = runClaude([
      '--resume', codemieId,
      '--task', `Reply with exactly this text and nothing else: ${secondMarker}`,
    ]);
    const output = `${second.stdout}\n${second.stderr}`;
    expect(second.status, `resume failed.\n${output}`).toBe(0);
    expect(output).not.toContain('was not created through CodeMie');
    expect(output).not.toContain('resume blocked');

    // 3. The resumed run is its own CodeMie session, resumed from the native id and still tracked.
    const secondPoll = await pollForSession(sessionsDir, secondMarker, { timeoutMs: CLI_TIMEOUT_MS });
    expect(secondPoll.sessionId, `no session for ${secondMarker}. Dir: ${secondPoll.dirContents}`).not.toBeNull();

    const secondRecord = readRecord(sessionsDir, secondPoll.sessionId!);
    expect(secondRecord.sessionId).not.toBe(codemieId);
    expect(
      secondRecord.correlation?.agentSessionId,
      'the resumed run must continue the original native Claude session',
    ).toBe(nativeId);
    expect(secondRecord.origin, 'a CodeMie id must not be treated as an external resume').not.toBe('external-resume');
  }, CLI_TIMEOUT_MS * 3 + 60_000);
});
