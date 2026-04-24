/**
 * Integration tests for codemie-claude CLI task execution.
 *
 * Migrated from: codemie-sdk/test-harness/.../test_codemie_cli_claude.py
 *
 * This test suite verifies:
 * 1. Configuration file creation
 * 2. Command execution and response validation
 * 3. File creation with task mode and permission handling
 *
 * Environment variables:
 * - DEFAULT_TIMEOUT: Command timeout in seconds (default: 60)
 * - FRONTEND_URL: CodeMie frontend URL for sso-autotest profile
 * - CODEMIE_API_DOMAIN: CodeMie API domain for sso-autotest profile
 * - CODEMIE_MODEL: Model name for sso-autotest profile (default: "claude-sonnet-4-6")
 * - INCLUDE_SSO_TESTS: Set to "true" to enable this test suite (default: skipped)
 */

import { config as loadEnv } from 'dotenv';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  realpathSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { SessionDataSchema } from './models/session.js';
import { MetricsRecordSchema } from './models/metrics.js';
import {
  ConversationRecordSchema,
  UserMessageSchema,
  AssistantMessageSchema,
} from './models/conversation.js';
import { z } from 'zod';

function validateSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.issues
      .map(e => `  [${e.path.join('.')}] ${e.message}`)
      .join('\n');
    throw new Error(`${label} failed schema validation:\n${errors}`);
  }
  return result.data;
}

// Load credentials from .env.test.local (gitignored) if present.
// Create this file with FRONTEND_URL and CODEMIE_API_DOMAIN before running.
loadEnv({ path: '.env.test.local', override: false });

// Timeout from environment (seconds → milliseconds)
const CLI_TIMEOUT_MS = parseInt(process.env.DEFAULT_TIMEOUT ?? '60', 10) * 1000;

// Setup hooks (installs) can take much longer than individual commands
const SETUP_TIMEOUT_MS = CLI_TIMEOUT_MS * 5;

const IS_WINDOWS = process.platform === 'win32';

/**
 * Build a clean environment for subprocesses by stripping all CODEMIE_* vars
 * inherited from the outer session (e.g. CODEMIE_SESSION_ID, CODEMIE_PROVIDER,
 * CODEMIE_BASE_URL, CODEMIE_API_KEY, CODEMIE_PROFILE_CONFIG, …).
 * Without this, the spawned codemie-claude inherits the parent session's
 * context and ignores the config file the test wrote to the codemie home dir.
 *
 * CODEMIE_HOME is intentionally NOT preserved so subprocesses default to the
 * real ~/.codemie directory, ensuring session files are written there.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('CODEMIE_'),
    ),
  ) as NodeJS.ProcessEnv;
}

/**
 * Run an external command cross-platform.
 * On Windows, wraps via `cmd /c` to resolve .cmd wrappers from PATH without
 * triggering DEP0190 (shell:true + args array deprecation in Node.js v22+).
 */
function runCmd(
  cmd: string,
  args: string[],
  options: Record<string, unknown> = {},
) {
  const [spawnCmd, spawnArgs] = IS_WINDOWS
    ? (['cmd', ['/c', cmd, ...args]] as const)
    : ([cmd, args] as const);

  return spawnSync(spawnCmd, spawnArgs, {
    encoding: 'utf-8' as const,
    ...options,
  });
}

/**
 * Resolve Windows 8.3 short path names to full long paths.
 * Equivalent to ctypes.windll.kernel32.GetLongPathNameW in Python.
 */
function resolveLongPath(p: string): string {
  if (!IS_WINDOWS) return p;
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

// Repo root is 2 levels up from tests/integration/
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Path to the local codemie-claude entry point (uses dist/ from this repo)
const CLAUDE_BIN = join(repoRoot, 'bin', 'codemie-claude.js');

const INCLUDE_SSO_TESTS = process.env.INCLUDE_SSO_TESTS === 'true';

describe.runIf(INCLUDE_SSO_TESTS)('codemie-claude CLI task execution', () => {
  const getConfigDir = (): string => join(homedir(), '.codemie');
  const getConfigFilePath = (): string => join(getConfigDir(), 'codemie-cli.config.json');

  let originalActiveProfile: string | undefined;

  // Equivalent to setup_codemie_base + setup_claude_provider fixtures in conftest.py
  beforeAll(() => {
    const configDir = getConfigDir();
    const configFilePath = getConfigFilePath();

    // Save original activeProfile for restoration after tests
    if (existsSync(configFilePath)) {
      try {
        const existingConfig = JSON.parse(readFileSync(configFilePath, 'utf-8'));
        originalActiveProfile = existingConfig.activeProfile;
      } catch {
        // ignore parse errors
      }
    }

    // ── Build local dist/ ────────────────────────────────────────────────────
    // Always rebuild to guarantee dist/ reflects the current branch source.
    const buildResult = runCmd('npm', ['run', 'build'], { env: cleanEnv(), cwd: repoRoot, timeout: SETUP_TIMEOUT_MS });
    if (buildResult.status !== 0) {
      throw new Error(`npm run build failed:\n${buildResult.stderr}\n${buildResult.stdout}`);
    }

    if (!existsSync(CLAUDE_BIN)) {
      throw new Error(`Expected CLI entry point not found after build: ${CLAUDE_BIN}`);
    }

    // ── Write sso-autotest config ─────────────────────────────────────────────
    mkdirSync(configDir, { recursive: true });

    let config: Record<string, unknown> = {
      version: 2,
      activeProfile: 'sso-autotest',
      profiles: {},
    };

    if (existsSync(configFilePath)) {
      try {
        config = JSON.parse(readFileSync(configFilePath, 'utf-8'));
      } catch {
        // use defaults on parse error
      }
    }

    (config.profiles as Record<string, unknown>)['sso-autotest'] = {
      name: 'sso-autotest',
      provider: 'ai-run-sso',
      authMethod: 'sso',
      codeMieUrl: process.env.FRONTEND_URL ?? '',
      baseUrl: process.env.CODEMIE_API_DOMAIN ?? '',
      apiKey: 'sso-authenticated',
      model: process.env.CODEMIE_MODEL ?? 'claude-sonnet-4-6',
      timeout: 300,
      debug: false,
    };
    config.activeProfile = 'sso-autotest';

    writeFileSync(configFilePath, JSON.stringify(config, null, 2));

  }, SETUP_TIMEOUT_MS);

  // Restore original activeProfile after all tests (equivalent to Python finalizer).
  // With test isolation the config lives in a temp dir that setupTestIsolation()
  // will remove, so this is a no-op in the normal case.
  afterAll(() => {
    const configFilePath = getConfigFilePath();
    if (originalActiveProfile !== undefined && existsSync(configFilePath)) {
      try {
        const currentConfig = JSON.parse(readFileSync(configFilePath, 'utf-8'));
        currentConfig.activeProfile = originalActiveProfile;
        writeFileSync(configFilePath, JSON.stringify(currentConfig, null, 2));
      } catch {
        // ignore restore errors
      }
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

    // Run the local codemie-claude entry point (bin/codemie-claude.js → dist/)
    // so the test always uses the current branch build, not a globally installed binary.
    // Use a clean environment (strip outer CODEMIE_* session vars) so the process
    // reads config from ~/.codemie, not the inherited session of the test runner.
    const result = runCmd(
      'node',
      [
        CLAUDE_BIN,
        '--task',
        `Create java file with helloworld app that prints: ${testUuid}`,
        '--permission-mode',
        'acceptEdits',
      ],
      {
        env: cleanEnv(),
        cwd: tempTestDir,
        input: 'Y\n',  // Answer Y to version update prompt if it appears
        timeout: CLI_TIMEOUT_MS,
      },
    );

    // Assert command completed successfully
    expect(
      result.status,
      `Command failed with stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    ).toBe(0);

    // Find Java files created in the temporary directory
    const javaFiles = readdirSync(tempTestDir).filter(f => f.endsWith('.java'));

    // Assert at least one Java file was created
    expect(
      javaFiles.length,
      `No Java files were created in ${tempTestDir}. Directory contents: ${readdirSync(tempTestDir).join(', ')}`,
    ).toBeGreaterThan(0);

    // Read and validate the first Java file
    const javaFilePath = join(tempTestDir, javaFiles[0]);
    const javaContent = readFileSync(javaFilePath, 'utf-8');

    // Assert file is not empty
    expect(javaContent).not.toBe('');

    // Assert file contains HelloWorld-related Java patterns
    expect(
      javaContent.toLowerCase().includes('class') || javaContent.toLowerCase().includes('public'),
      `Java file doesn't contain class definition: ${javaContent}`,
    ).toBe(true);

    // ── Session file verification ────────────────────────────────────────────────
    // Poll for up to SESSION_POLL_TIMEOUT_MS because onSessionEnd may still be
    // writing/renaming files when spawnSync returns. Files appear as either
    // {id}_conversation.jsonl (before SessionEnd renames) or
    // completed_{id}_conversation.jsonl (after SessionEnd renames).
    const sessionsDir = join(getConfigDir(), 'sessions');
    const SESSION_POLL_TIMEOUT_MS = 30_000;
    const SESSION_POLL_INTERVAL_MS = 1_000;

    // Poll until a conversation file containing testUuid appears (or timeout)
    let sessionId: string | null = null;
    const pollStart = Date.now();

    while (sessionId === null && Date.now() - pollStart < SESSION_POLL_TIMEOUT_MS) {
      if (existsSync(sessionsDir)) {
        const conversationFiles = readdirSync(sessionsDir).filter(f =>
          f.endsWith('_conversation.jsonl'),
        );

        for (const fileName of conversationFiles) {
          try {
            const content = readFileSync(join(sessionsDir, fileName), 'utf-8');
            if (content.includes(testUuid)) {
              sessionId = fileName.replace('_conversation.jsonl', '');
              break;
            }
          } catch {
            continue;
          }
        }
      }

      if (sessionId === null) {
        await new Promise(resolve => setTimeout(resolve, SESSION_POLL_INTERVAL_MS));
      }
    }

    let sessionsDirContents = '(dir missing)';
    if (existsSync(sessionsDir)) {
      try {
        sessionsDirContents = readdirSync(sessionsDir).join(', ') || '(empty)';
      } catch {
        sessionsDirContents = '(read error)';
      }
    }

    expect(
      sessionId,
      `Could not find session containing UUID ${testUuid} in ${sessionsDir} ` +
        `after ${SESSION_POLL_TIMEOUT_MS / 1000}s. ` +
        `Sessions dir contents: ${sessionsDirContents}`,
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
