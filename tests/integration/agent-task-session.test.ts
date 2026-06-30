/**
 * Agent task execution and session artifact validation.
 *
 * Migrated from: codemie-sdk/test-harness/.../test_codemie_cli_claude.py
 *
 * Run with: npm run test:integration:agent
 *
 * Auth mode (CI_IS_LOCAL_RUN in .env.test.local):
 *   true  (default) — SSO mode; uses developer's sso-autotest profile in ~/.codemie
 *   false           — JWT mode; isolates to a temp CODEMIE_HOME with bearer-auth profile
 *
 * Environment variables:
 * - CI_IS_LOCAL_RUN: "true" (default) for SSO, "false" for JWT
 * - DEFAULT_TIMEOUT: Command timeout in seconds (default: 60)
 * - CI_CODEMIE_URL: CodeMie frontend URL (both modes)
 * - CI_CODEMIE_URL: CodeMie URL — API domain is derived as CI_CODEMIE_URL/code-assistant-api
 * - CI_CODEMIE_USERNAME / CI_CODEMIE_PASSWORD / CI_CODEMIE_AUTH_URL: JWT mode only
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
  SessionDataSchema,
  MetricsRecordSchema,
  ConversationRecordSchema,
  UserMessageSchema,
  AssistantMessageSchema,
} from './models/index.js';
import { fetchJwtToken, writeJwtProfile, getTempDir, jwtCleanEnv, resolveLongPath, getTestEnvFlagOrDefault, pollForSession, ssoCleanEnv, setupSsoAutotestProfile, teardownSsoAutotestProfile } from '../helpers/index.js';
import { validateSchema } from './models/index.js';

// Timeout from environment (seconds → milliseconds)
const CLI_TIMEOUT_MS = parseInt(process.env.DEFAULT_TIMEOUT ?? '60', 10) * 1000;

// Setup hooks (installs) can take much longer than individual commands
const SETUP_TIMEOUT_MS = CLI_TIMEOUT_MS * 5;

// Repo root is 2 levels up from tests/integration/
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Path to the local codemie-claude entry point (uses dist/ from this repo)
const CLAUDE_BIN = join(repoRoot, 'bin', 'codemie-claude.js');

// true (default) = SSO mode (local dev); false = JWT mode (CI pipeline)
const CI_IS_LOCAL_RUN = getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true);

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('agent task execution and session artifact validation', () => {
  const getConfigDir = (): string => join(homedir(), '.codemie');

  let originalActiveProfile: string | undefined;
  let jwtToken: string;
  let jwtHome: string;

  // build + npm link are handled once by agent-build-setup.ts globalSetup.
  beforeAll(async () => {
    if (!CI_IS_LOCAL_RUN) {
      jwtToken = await fetchJwtToken();
      jwtHome  = mkdtempSync(join(getTempDir(), 'codemie-task-jwt-'));
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

  // temp_test_dir fixture equivalent
  let tempTestDir: string;

  beforeEach(() => {
    tempTestDir = mkdtempSync(join(tmpdir(), 'codemie_test_'));
    // Expand Windows 8.3 short path names to full long paths
    tempTestDir = resolveLongPath(tempTestDir);
  });
  afterEach(() => {
    if (existsSync(tempTestDir)) {
      rmSync(tempTestDir, { recursive: true, force: true });
    }
  });

  it('should create java file with task mode and validate session metrics', async () => {
    // Generate unique UUID to track this test session
    const testUuid = randomUUID();

    const taskDir     = CI_IS_LOCAL_RUN ? tempTestDir : jwtHome;
    const sessionsDir = CI_IS_LOCAL_RUN
      ? join(getConfigDir(), 'sessions')
      : join(jwtHome, 'sessions');

    // Run the local codemie-claude entry point (bin/codemie-claude.js → dist/)
    // so the test always uses the current branch build, not a globally installed binary.
    // Use a clean environment (strip outer CODEMIE_* session vars) so the process
    // reads config from ~/.codemie, not the inherited session of the test runner.
    const result = CI_IS_LOCAL_RUN
      ? spawnSync(
          process.execPath,
          [
            CLAUDE_BIN,
            '--task',
            `Create java file with helloworld app that prints: ${testUuid}`,
            '--permission-mode', 'acceptEdits',
          ],
          { env: ssoCleanEnv(), cwd: tempTestDir, input: 'Y\n',
            encoding: 'utf-8', timeout: CLI_TIMEOUT_MS },
        )
      : spawnSync(
          process.execPath,
          [
            CLAUDE_BIN,
            '--task',
            `Create java file with helloworld app that prints: ${testUuid}`,
            '--permission-mode', 'acceptEdits',
            '--jwt-token', jwtToken,
          ],
          // --permission-mode acceptEdits required: this task creates files
          // (existing JWT tests omit it because they use text-only tasks)
          { cwd: jwtHome, env: { ...jwtCleanEnv(), CODEMIE_HOME: jwtHome },
            encoding: 'utf-8', timeout: CLI_TIMEOUT_MS },
        );

    // Assert command completed successfully
    expect(
      result.status,
      `Command failed with stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    ).toBe(0);

    // Find Java files created in the temporary directory
    const javaFiles = readdirSync(taskDir).filter(f => f.endsWith('.java'));

    // Assert at least one Java file was created
    expect(
      javaFiles.length,
      `No Java files were created in ${taskDir}. Directory contents: ${readdirSync(taskDir).join(', ')}`,
    ).toBeGreaterThan(0);

    // Read and validate the first Java file
    const javaFilePath = join(taskDir, javaFiles[0]);
    const javaContent = readFileSync(javaFilePath, 'utf-8');

    // Assert file is not empty
    expect(javaContent).not.toBe('');

    // Assert file contains HelloWorld-related Java patterns
    expect(
      javaContent.toLowerCase().includes('class') || javaContent.toLowerCase().includes('public'),
      `Java file doesn't contain class definition: ${javaContent}`,
    ).toBe(true);

    // ── Session file verification ────────────────────────────────────────────────
    // Use the same ceiling as the CLI command itself so the poll always
    // outlasts the session-hook rename that happens after process exit.
    const SESSION_POLL_TIMEOUT_MS = CLI_TIMEOUT_MS;

    const { sessionId, dirContents } = await pollForSession(sessionsDir, testUuid, {
      timeoutMs: SESSION_POLL_TIMEOUT_MS,
    });

    expect(
      sessionId,
      `Could not find session containing UUID ${testUuid} in ${sessionsDir} ` +
        `after ${SESSION_POLL_TIMEOUT_MS / 1000}s. ` +
        `Sessions dir contents: ${dirContents}`,
    ).not.toBeNull();

    // Strip 'completed_' prefix to get the bare session ID
    const bareSessionId = sessionId!.replace(/^completed_/, '');

    // Build paths for all 3 session files
    const sessionFile = join(sessionsDir, `${sessionId}.json`);
    const conversationFile = join(sessionsDir, `${sessionId}_conversation.jsonl`);
    const metricsFile = join(sessionsDir, `${sessionId}_metrics.jsonl`);

    // Assert all 3 files exist
    expect(existsSync(sessionFile), `Session file not found: ${sessionFile}`).toBe(true);
    expect(existsSync(conversationFile), `Conversation file not found: ${conversationFile}`).toBe(true);
    expect(existsSync(metricsFile), `Metrics file not found: ${metricsFile}`).toBe(true);

    // ── completed_*.json ──────────────────────────────────────────────────────
    const sessionRaw = JSON.parse(readFileSync(sessionFile, 'utf-8'));
    const session = validateSchema(SessionDataSchema, sessionRaw, `session file ${sessionId}.json`);

    expect(session.sessionId, 'sessionId does not match filename').toBe(bareSessionId);
    expect(session.agentName, 'agentName must not be empty').toBeTruthy();
    expect(session.provider, 'provider must not be empty').toBeTruthy();
    expect(session.workingDirectory, 'workingDirectory must not be empty').toBeTruthy();

    // SSO-only: conversation sync must have run and produced a conversationId
    if (CI_IS_LOCAL_RUN) {
      const syncConv = session.sync?.conversations as Record<string, unknown> | undefined;
      expect(syncConv?.totalSyncAttempts, 'SSO sync must have attempted at least once').toBeGreaterThan(0);
      expect(syncConv?.conversationId, 'SSO sync must have produced a conversationId').toBeTruthy();
      expect(syncConv?.lastSyncAt, 'SSO sync must have recorded a lastSyncAt timestamp').toBeGreaterThan(0);
    }

    // ── completed_*_metrics.jsonl ─────────────────────────────────────────────
    const metricsLines = readFileSync(metricsFile, 'utf-8').split('\n').filter(Boolean);
    const metricsRaw = metricsLines
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .find((r): r is Record<string, unknown> => r !== null && JSON.stringify(r).includes(testUuid));

    expect(
      metricsRaw,
      `No metrics record containing UUID ${testUuid} in ${metricsFile}`,
    ).not.toBeNull();

    const metrics = validateSchema(MetricsRecordSchema, metricsRaw, `metrics file ${sessionId}_metrics.jsonl`);

    expect(metrics.sessionId, 'metrics.sessionId does not match filename').toBe(bareSessionId);
    expect(metrics.userPrompts[0].text, 'userPrompts[0].text must contain the test UUID').toContain(testUuid);

    // SSO-only: sync must have run and stamped a syncedAt timestamp
    if (CI_IS_LOCAL_RUN) {
      expect(metrics.syncedAt, 'SSO sync must have recorded a syncedAt timestamp').toBeGreaterThan(0);
    }

    // ── completed_*_conversation.jsonl ────────────────────────────────────────
    const convLines = readFileSync(conversationFile, 'utf-8').split('\n').filter(Boolean);
    const convRaw = convLines
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .find((r): r is Record<string, unknown> => r !== null && JSON.stringify(r).includes(testUuid));

    expect(
      convRaw,
      `No conversation record containing UUID ${testUuid} in ${conversationFile}`,
    ).not.toBeNull();

    const conv = validateSchema(ConversationRecordSchema, convRaw, `conversation file ${sessionId}_conversation.jsonl`);

    const userMsg = validateSchema(UserMessageSchema, conv.payload.history[0], 'conversation history[0] (user message)');
    const assistantMsg = validateSchema(AssistantMessageSchema, conv.payload.history[1], 'conversation history[1] (assistant message)');

    expect(userMsg.message, 'history[0].message must contain the test UUID').toContain(testUuid);
    expect(assistantMsg.message, 'history[1].message must not be empty').toBeTruthy();

  }, CLI_TIMEOUT_MS + 60_000);
});
