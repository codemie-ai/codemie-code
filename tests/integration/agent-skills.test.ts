/**
 * Skill tests — TC-025
 *
 * Run with: npm run test:integration:agent
 *
 * Auth mode (CI_IS_LOCAL_RUN in .env.test.local):
 *   true  (default) — SSO mode; uses developer's sso-autotest profile in ~/.codemie
 *   false           — JWT mode; isolates to a temp CODEMIE_HOME with bearer-auth profile
 *
 * A fresh skill (auto-skill-random-gen) is created in the outer beforeAll via the SDK
 * and deleted in afterAll, removing any static skill dependency.
 *
 * TC-025: Skill slash command invocation inside a running agent session.
 *         Installs the dynamically created skill via the interactive setup wizard,
 *         then verifies the slash command is available and returns a number 1-10.
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeMieClient } from 'codemie-sdk';
import { getCodemieClient } from '@/utils/sdk-client.js';
import { createSkill, deleteSkill } from '@/cli/commands/sdk/services/skills.js';
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
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');
const CLI_BIN = join(REPO_ROOT, 'bin', 'codemie.js');

const CI_IS_LOCAL_RUN = getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true);

// Unique per-run suffix so concurrent runs and other users' leftover skills don't collide.
const RUN_SUFFIX = randomBytes(3).toString('hex');
const SKILL_NAME = `auto-skill-random-gen-${RUN_SUFFIX}`;
const SKILL_DESCRIPTION = 'Integration test skill — auto-created and deleted by the test suite. Returns a random number from 1 to 10.';
const SKILL_CONTENT = [
  '# Random Number Generator',
  '',
  'When invoked, respond with a single random number between 1 and 10.',
  'Your entire response must be exactly the number — no words, punctuation, or explanation.',
].join('\n');

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('Skill tests', () => {
  let jwtToken: string;
  let jwtHome: string;
  let sdkClient: CodeMieClient;
  let createdSkillId: string;
  let originalActiveProfile: string | undefined;

  beforeAll(async () => {
    const ciCodemieUrl = (process.env.CI_CODEMIE_URL ?? '').replace(/\/$/, '');

    if (!CI_IS_LOCAL_RUN) {
      jwtToken = await fetchJwtToken();
      jwtHome = mkdtempSync(join(getTempDir(), 'codemie-skill-jwt-'));
      writeJwtProfile(jwtHome, { jwtToken });
      sdkClient = new CodeMieClient({
        codemie_api_domain: `${ciCodemieUrl}/code-assistant-api`,
        jwt_token: jwtToken,
        verify_ssl: process.env.CODEMIE_INSECURE !== '1',
      });
    } else {
      originalActiveProfile = setupSsoAutotestProfile();
      sdkClient = await getCodemieClient(true);
    }

    const aboutUser = await sdkClient.users.aboutMe();
    const project = aboutUser.applications[0];
    if (!project) throw new Error('No accessible project found for this user');

    const created = await createSkill(sdkClient, {
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      content: SKILL_CONTENT,
      project,
    });
    createdSkillId = created.id;
  }, 60_000);

  afterAll(async () => {
    if (createdSkillId && sdkClient) {
      try { await deleteSkill(sdkClient, createdSkillId); } catch { /* best-effort */ }
    }
    if (!CI_IS_LOCAL_RUN) {
      if (jwtHome) rmSync(jwtHome, { recursive: true, force: true });
    } else {
      teardownSsoAutotestProfile(originalActiveProfile);
    }
  });

  // ── TC-025: Skill invocation inside running session ─────────────────────────
  // Installs the dynamically created platform skill via the interactive codemie
  // setup skills wizard (driven by PTY), then verifies that the skill's slash
  // command is available in a Claude Code session and returns a number 1-10.
  describe('TC-025 — skill slash command in running session', () => {
    let testHome: string;

    beforeAll(async () => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-skill-'));
      if (!CI_IS_LOCAL_RUN) {
        writeJwtProfile(testHome, { jwtToken });
      } else {
        writeSsoProfile(testHome);
        copySsoCredentials(testHome);
      }
      // .claude/ marker causes auto-detection to include Claude Code as a target agent.
      mkdirSync(join(testHome, '.claude'), { recursive: true });

      const setupArgs = CI_IS_LOCAL_RUN
        ? [CLI_BIN, 'setup', 'skills']
        : [CLI_BIN, 'setup', 'skills', '--profile', 'jwt-autotest'];
      const setupEnv = CI_IS_LOCAL_RUN
        ? { ...ssoCleanEnv(), CODEMIE_HOME: testHome, TERM: 'xterm-256color' }
        // Full process.env for proxy/TLS/server-URL vars; CODEMIE_JWT_TOKEN set explicitly
        // because the token is fetched into jwtToken but never exported to process.env.
        : { ...process.env, CODEMIE_HOME: testHome, CODEMIE_JWT_TOKEN: jwtToken, TERM: 'xterm-256color' };

      const setupProc = spawnPty(process.execPath, setupArgs, { cwd: testHome, env: setupEnv });

      try {
        // Step 1: Disclaimer screen.
        await setupProc.waitFor(/Press Enter to continue/, 30_000);
        setupProc.write('\r');

        // Step 2: Storage scope — keep Global default, just Enter.
        // Using Global + CODEMIE_HOME ensures skills write to testHome's config.
        await setupProc.waitFor(/Where would you like to save/, 30_000);
        setupProc.write('\r');

        // Step 3: Target Agents — pre-selected; Enter confirms.
        await setupProc.waitFor(/Target Agents/, 30_000);
        setupProc.write('\r');

        // Step 4: Skills picker — wait for the count line unique to this screen.
        // Default focus is on list item 0 (not the search box). Arrow Up moves
        // focus to search. The search field requires individual keypresses — bulk
        // write does not trigger its keystroke handler. With the list filtered to
        // one result, one Arrow Down after Space reaches the Continue button.
        await setupProc.waitFor(/\d+ skills total/, 60_000);
        await new Promise((r) => setTimeout(r, 500));    // Let the picker fully render
        setupProc.write('\x1B[A');                       // Arrow Up → focus search box
        await new Promise((r) => setTimeout(r, 200));
        // Type letter-by-letter — the search field processes one keypress at a time.
        for (const char of SKILL_NAME) {
          setupProc.write(char);
          await new Promise((r) => setTimeout(r, 50));
        }
        await new Promise((r) => setTimeout(r, 1_500)); // Debounce (500ms) + API fetch
        setupProc.write('\x1B[B');                       // Arrow Down → unfocus search, cursor=0
        await new Promise((r) => setTimeout(r, 300));
        setupProc.write(' ');                            // Space to select (1 filtered result)
        await new Promise((r) => setTimeout(r, 200));
        setupProc.write('\x1B[B');                       // Arrow Down → focus Continue button
        await new Promise((r) => setTimeout(r, 200));
        setupProc.write('\r');                           // Enter to confirm (Continue button)

        await setupProc.waitFor(/Registered \d+ skill/, 30_000);
      } finally {
        await setupProc.exit(15_000);
      }
    }, 120_000);

    afterAll(async () => {
      // Small delay for Windows to release file handles from PTY processes.
      await new Promise((r) => setTimeout(r, 500));
      rmSync(testHome, { recursive: true, force: true });
    });

    it(`agent responds to /${SKILL_NAME} and returns a number 1-10`, async () => {
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
        proc.writeLine(`/${SKILL_NAME} hi`);
        await proc.waitFor(/\b([1-9]|10)\b/, 90_000);
      } finally {
        proc.writeLine('/exit');
        await proc.exit(90_000);
      }

      const lines = proc.lines();
      const matchedLine = lines.find((l) => /\b([1-9]|10)\b/.test(l));
      expect(
        matchedLine,
        `Expected a line containing a number 1-10.\nLast PTY lines:\n${lines.slice(-20).join('\n')}`,
      ).toBeTruthy();
      const num = parseInt(matchedLine!.match(/\b([1-9]|10)\b/)![1], 10);
      expect(num).toBeGreaterThanOrEqual(1);
      expect(num).toBeLessThanOrEqual(10);
    }, 240_000);
  });
});
