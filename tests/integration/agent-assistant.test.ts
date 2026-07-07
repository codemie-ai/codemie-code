/**
 * Assistant management tests — TC-014, TC-015, TC-026
 *
 * Run with: npm run test:integration:agent
 *
 * Auth mode (CI_IS_LOCAL_RUN in .env.test.local):
 *   true  (default) — SSO mode; uses developer's sso-autotest profile in ~/.codemie
 *   false           — JWT mode; isolates to a temp CODEMIE_HOME with bearer-auth profile
 *
 * A fresh assistant (AutoAssistantRandomGenerator) is created in the outer beforeAll
 * via the SDK and deleted in afterAll, removing the static CI_CODEMIE_ASSISTANT_ID
 * dependency.
 *
 * TC-014: Setup assistants wizard via PTY — registers the created assistant as a skill.
 * TC-015: Assistants chat with invalid ID — negative test, exits non-zero.
 * TC-026: Non-interactive assistant chat random-number test.
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeMieClient } from 'codemie-sdk';
import { getCodemieClient } from '@/utils/sdk-client.js';
import { createAssistant, deleteAssistant, listAssistants } from '@/cli/commands/sdk/services/assistants.js';
import {
  fetchJwtToken,
  writeJwtProfile,
  writeSsoProfile,
  copySsoCredentials,
  getTempDir,
  spawnPty,
  jwtCleanEnv,
  ssoCleanEnv,
  setupSsoAutotestProfile,
  teardownSsoAutotestProfile,
  getTestEnvFlagOrDefault,
} from '../helpers/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_BIN = join(REPO_ROOT, 'bin', 'codemie.js');
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');

const CI_IS_LOCAL_RUN = getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true);

// Unique per-run suffix so concurrent runs and other users' leftover assistants don't collide.
const RUN_SUFFIX = randomBytes(3).toString('hex');
const ASSISTANT_NAME = `AutoAssistantRandomGenerator-${RUN_SUFFIX}`;
const ASSISTANT_SYSTEM_PROMPT = [
  'You are random generator',
  'You should answer on any user message with single number from 1 to 10',
  'Nothing else shouldn\'t be provided except random number',
].join('\n');
const ASSISTANT_SLUG = ASSISTANT_NAME.toLowerCase().replace(/[^a-z0-9]/g, '');

function registerAssistantInConfig(codemieHome: string, id: string, name: string, slug: string): void {
  const configPath = join(codemieHome, 'codemie-cli.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  config.codemieAssistants = [{ id, name, slug, registeredAt: new Date().toISOString() }];
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  const agentDir = join(homedir(), '.claude', 'agents');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, `${slug}.md`), `# ${name}\n`, 'utf-8');
}

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('Assistant management tests', () => {
  let jwtToken: string;
  let jwtHome: string;
  let sdkClient: CodeMieClient;
  let createdAssistantId: string;
  let originalActiveProfile: string | undefined;

  beforeAll(async () => {
    const ciCodemieUrl = (process.env.CI_CODEMIE_URL ?? '').replace(/\/$/, '');

    if (!CI_IS_LOCAL_RUN) {
      // JWT mode: isolated temp home
      jwtToken = await fetchJwtToken();
      jwtHome = mkdtempSync(join(getTempDir(), 'codemie-asst-'));
      writeJwtProfile(jwtHome, { jwtToken });
      sdkClient = new CodeMieClient({
        codemie_api_domain: `${ciCodemieUrl}/code-assistant-api`,
        jwt_token: jwtToken,
        verify_ssl: process.env.CODEMIE_INSECURE !== '1',
      });
    } else {
      // SSO mode: upsert sso-autotest profile into ~/.codemie
      originalActiveProfile = setupSsoAutotestProfile();
      sdkClient = await getCodemieClient(true);
    }

    const aboutUser = await sdkClient.users.aboutMe();
    const project = aboutUser.applications[0];
    if (!project) throw new Error('No accessible project found for this user');

    // Remove any same-named assistants left over from interrupted previous runs.
    const stale = await listAssistants(sdkClient);
    for (const a of stale.filter((a) => a.name === ASSISTANT_NAME)) {
      try { await deleteAssistant(sdkClient, a.id!); } catch { /* best-effort */ }
    }

    await createAssistant(sdkClient, {
      name: ASSISTANT_NAME,
      description: 'Integration test assistant — auto-created and deleted by the test suite',
      system_prompt: ASSISTANT_SYSTEM_PROMPT,
      slug: ASSISTANT_SLUG,
      project,
    });

    const assistants = await listAssistants(sdkClient);
    const created = assistants.find((a) => a.name === ASSISTANT_NAME);
    if (!created?.id) throw new Error(`Failed to find created assistant "${ASSISTANT_NAME}" after creation`);
    createdAssistantId = created.id;
  }, 60_000);

  afterAll(async () => {
    if (createdAssistantId && sdkClient) {
      try { await deleteAssistant(sdkClient, createdAssistantId); } catch { /* best-effort */ }
    }
    if (!CI_IS_LOCAL_RUN) {
      if (jwtHome) rmSync(jwtHome, { recursive: true, force: true });
    } else {
      teardownSsoAutotestProfile(originalActiveProfile);
    }
  });

  // ── TC-014: Setup assistants wizard via PTY ────────────────────────────────
  // Drives the `codemie setup assistants` interactive wizard via PTY for the
  // dynamically created AutoAssistantRandomGenerator assistant:
  //   1. Searches for the assistant in the picker and selects it.
  //   2. Chooses "Agent Skills" registration mode (gets a /slug command).
  //   3. Keeps Global storage scope.
  //   4. Confirms Target Agents screen.
  // Verifies the config is updated, then checks the /slug command works in
  // a live codemie-claude session.
  describe('TC-014 — setup assistants wizard registers assistant as skill', () => {
    let testHome: string;

    beforeAll(async () => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-setup-asst-'));
      if (!CI_IS_LOCAL_RUN) {
        writeJwtProfile(testHome, { jwtToken });
      } else {
        writeSsoProfile(testHome);
        copySsoCredentials(testHome);
      }
      mkdirSync(join(testHome, '.claude'), { recursive: true });

      const wizardEnv = CI_IS_LOCAL_RUN
        ? { ...ssoCleanEnv(), CODEMIE_HOME: testHome, TERM: 'xterm-256color' }
        : { ...process.env, CODEMIE_HOME: testHome, CODEMIE_JWT_TOKEN: jwtToken, TERM: 'xterm-256color' };

      const setupProc = spawnPty(
        process.execPath,
        [CLI_BIN, 'setup', 'assistants'],
        { cwd: testHome, env: wizardEnv },
      );

      try {
        // Step 1: Assistants picker — search by name, select, then Continue.
        await setupProc.waitFor(/\d+ assistants total/, 60_000);
        await new Promise((r) => setTimeout(r, 1_500));
        setupProc.write('\x1B[A');                        // Arrow Up → focus search box
        await new Promise((r) => setTimeout(r, 300));
        for (const char of ASSISTANT_NAME) {
          setupProc.write(char);
          await new Promise((r) => setTimeout(r, 150));
        }
        await new Promise((r) => setTimeout(r, 4_000));  // Debounce + search API response
        setupProc.write('\x1B[B');                        // Arrow Down → focus first result
        await new Promise((r) => setTimeout(r, 300));
        setupProc.write(' ');                             // Space to select
        await new Promise((r) => setTimeout(r, 200));
        setupProc.write('\x1B[B');                        // Arrow Down → focus Continue
        await new Promise((r) => setTimeout(r, 200));
        setupProc.write('\r');                            // Enter to confirm Continue

        // Step 2: Mode selection — arrow down once to "Agent Skills", then Enter.
        await setupProc.waitFor(/Configure Registration|How would you like to register/, 45_000);
        await new Promise((r) => setTimeout(r, 300));
        setupProc.write('\x1B[B');                        // Arrow Down → Agent Skills
        await new Promise((r) => setTimeout(r, 200));
        setupProc.write('\r');                            // Enter to confirm

        // Step 3: Storage scope — keep Global default.
        await setupProc.waitFor(/Where would you like to save/, 30_000);
        await new Promise((r) => setTimeout(r, 200));
        setupProc.write('\r');                            // Enter to accept Global

        // Step 4: Target Agents — arrow down twice to reach Continue, then Enter.
        await setupProc.waitFor(/Target Agents/, 30_000);
        await new Promise((r) => setTimeout(r, 300));
        setupProc.write('\x1B[B');                        // Arrow Down #1
        await new Promise((r) => setTimeout(r, 200));
        setupProc.write('\x1B[B');                        // Arrow Down #2 → Continue button
        await new Promise((r) => setTimeout(r, 200));
        setupProc.write('\r');                            // Enter to confirm

        // Step 5: Wait for success confirmation.
        await setupProc.waitFor(/Updated \d+ assistant/, 30_000);
      } finally {
        await setupProc.exit(15_000);
      }
    }, 180_000);

    afterAll(async () => {
      await new Promise((r) => setTimeout(r, 500));
      rmSync(testHome, { recursive: true, force: true });
      rmSync(join(homedir(), '.claude', 'skills', ASSISTANT_SLUG), { recursive: true, force: true });
    });

    it('codemie-cli.config.json contains the registered assistant slug', () => {
      const configPath = join(testHome, 'codemie-cli.config.json');
      const raw = readFileSync(configPath, 'utf-8');
      expect(
        raw.includes(ASSISTANT_SLUG),
        `Expected config to contain slug "${ASSISTANT_SLUG}".\nConfig: ${raw}`,
      ).toBe(true);
    });

    it('agent responds to /<slug> and returns a number 1-10', async () => {
      const sessionArgs = CI_IS_LOCAL_RUN
        ? [CLAUDE_BIN]
        : [CLAUDE_BIN, '--profile', 'jwt-autotest', '--jwt-token', jwtToken];
      const sessionEnv = CI_IS_LOCAL_RUN
        ? { ...ssoCleanEnv(), CODEMIE_HOME: testHome, TERM: 'xterm-256color' }
        : { ...jwtCleanEnv(), CODEMIE_HOME: testHome, TERM: 'xterm-256color' };

      const proc = spawnPty(process.execPath, sessionArgs, { cwd: testHome, env: sessionEnv });

      try {
        await proc.waitFor(/Model\s*[│|]/i, 60_000);
        // On macOS, Claude Code shows a workspace-trust prompt for new temp directories
        // before rendering the startup box.  Start a background handler that accepts the
        // prompt ('1' = Yes, I trust this folder) if it appears, so the startup box can
        // render.  The handler is a no-op on platforms where the prompt does not appear.
        void proc.waitFor(/trust.*folder|trustthisfolder/i, 15_000)
          .then(() => proc.writeLine('1'))
          .catch(() => { /* no trust prompt on this platform */ });
        await proc.waitFor(/╰─/, 60_000);
        await new Promise((r) => setTimeout(r, 1_000));
        proc.writeLine(`/${ASSISTANT_SLUG} hi`);
        await proc.waitFor(/\b([1-9]|10)\b/, 90_000);
      } finally {
        proc.writeLine('/exit');
        await proc.exit(90_000);
      }

      const lines = proc.lines();
      const matchedLine = lines.find((l) => /\b([1-9]|10)\b/.test(l));
      expect(
        matchedLine,
        `Expected a line with a number 1-10 from /${ASSISTANT_SLUG}.\nLast PTY lines:\n${lines.slice(-20).join('\n')}`,
      ).toBeTruthy();
      const num = parseInt(matchedLine!.match(/\b([1-9]|10)\b/)![1], 10);
      expect(num).toBeGreaterThanOrEqual(1);
      expect(num).toBeLessThanOrEqual(10);
    }, 240_000);
  });

  // ── TC-015: Assistants chat with invalid ID (negative) ─────────────────────
  // Verifies that `codemie assistants chat` with an unknown assistant ID exits
  // non-zero and shows an appropriate error message.
  describe('TC-015 — assistants chat with invalid ID (negative)', () => {
    let testHome: string;
    let chatResult: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-asst-invalid-'));
      if (!CI_IS_LOCAL_RUN) {
        writeJwtProfile(testHome, { jwtToken });
      } else {
        writeSsoProfile(testHome);
        copySsoCredentials(testHome);
      }
      const chatArgs = CI_IS_LOCAL_RUN
        ? [CLI_BIN, 'assistants', 'chat', 'nonexistent-assistant-id-000', 'Say hello']
        : [CLI_BIN, 'assistants', 'chat', '--jwt-token', jwtToken, 'nonexistent-assistant-id-000', 'Say hello'];
      const chatEnv = CI_IS_LOCAL_RUN
        ? { ...ssoCleanEnv(), CODEMIE_HOME: testHome, CI: '1' }
        : { ...jwtCleanEnv(), CODEMIE_HOME: testHome, CODEMIE_JWT_TOKEN: jwtToken, CI: '1' };
      chatResult = spawnSync(
        process.execPath,
        chatArgs,
        { cwd: testHome, env: chatEnv, encoding: 'utf-8', timeout: 30_000 },
      );
    }, 60_000);

    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('exits non-zero with an invalid assistant ID', () => {
      expect(chatResult.status).not.toBe(0);
    });

    it('shows an error indicating the assistant was not found or is not registered', () => {
      const out = (chatResult.stdout ?? '') + (chatResult.stderr ?? '');
      expect(out).toMatch(/not found|not registered|register|error|failed|unknown/i);
    });
  });

  // ── TC-026: Assistant chat non-interactive ──────────────────────────────────
  // Uses the dynamically created AutoAssistantRandomGenerator which always
  // responds with a random number 1-10.
  describe('TC-026 — assistants chat non-interactive (random number test)', () => {
    let testHome: string;
    let chatResult: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-asst-chat-'));
      if (!CI_IS_LOCAL_RUN) {
        writeJwtProfile(testHome, { jwtToken });
      } else {
        writeSsoProfile(testHome);
        copySsoCredentials(testHome);
      }
      registerAssistantInConfig(testHome, createdAssistantId, ASSISTANT_NAME, ASSISTANT_SLUG);

      const chatArgs = CI_IS_LOCAL_RUN
        ? [CLI_BIN, 'assistants', 'chat', createdAssistantId, 'hi']
        : [CLI_BIN, 'assistants', 'chat', '--jwt-token', jwtToken, createdAssistantId, 'hi'];
      const chatEnv = CI_IS_LOCAL_RUN
        ? { ...ssoCleanEnv(), CODEMIE_HOME: testHome, CI: '1' }
        : { ...jwtCleanEnv(), CODEMIE_HOME: testHome, CODEMIE_JWT_TOKEN: jwtToken, CI: '1' };
      chatResult = spawnSync(
        process.execPath,
        chatArgs,
        { cwd: testHome, env: chatEnv, encoding: 'utf-8', timeout: 60_000 },
      );
    }, 90_000);

    afterAll(() => {
      rmSync(testHome, { recursive: true, force: true });
      rmSync(join(homedir(), '.claude', 'agents', `${ASSISTANT_SLUG}.md`), { force: true });
    });

    it('exits 0 and returns a number 1-10', () => {
      const out = (chatResult.stdout ?? '') + (chatResult.stderr ?? '');
      expect(chatResult.status, `stdout: ${chatResult.stdout ?? ''}\nstderr: ${chatResult.stderr ?? ''}`).toBe(0);
      expect(out).toMatch(/\b([1-9]|10)\b/);
    });
  });
});
