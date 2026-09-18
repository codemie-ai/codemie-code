/**
 * TC-029: codemie setup wizard — SSO profile creation (PTY)
 *
 * Walks through the interactive `codemie setup` wizard, creates a fresh SSO
 * profile, then verifies the written config file.
 *
 * SSO-only: step 4–5 opens a browser for authentication.
 * Run with: npx vitest run --project agent
 *
 * Isolation: the wizard runs with CODEMIE_HOME pointing to a temp dir so it
 * never touches ~/.codemie — safe to run in parallel with other agent tests.
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnPty } from '../helpers/pty-session.js';
import { ssoCleanEnv, getTempDir } from '../helpers/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CODEMIE_BIN = join(REPO_ROOT, 'bin', 'codemie.js');

/** Deterministic test profile name typed in step 8. */
const TEST_PROFILE_NAME = 'setup-test-sso';

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('TC-029 — codemie setup wizard (SSO)', () => {
  let testHome: string;

  beforeAll(() => {
    // Fresh isolated config home — wizard writes here, never touches ~/.codemie.
    testHome = mkdtempSync(join(getTempDir(), 'codemie-setup-'));
  });

  afterAll(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it(
    'walks the wizard, creates an SSO profile, and verifies the written config',
    async () => {
      const proc = spawnPty(process.execPath, [CODEMIE_BIN, 'setup'], {
        cwd: homedir(),
        // CODEMIE_HOME isolation: wizard reads/writes testHome, not ~/.codemie.
        env: { ...ssoCleanEnv(), CODEMIE_HOME: testHome },
      });

      // ── Step 1 (conditional): "What would you like to do?" ─────────────────────
      // Appears only when existing profiles are present. Fresh testHome has none,
      // so this is skipped. The conditional guard handles both cases.
      const firstLine = await proc.waitFor(
        /what would you like to do|where would you like to store/i,
        30_000,
      );
      if (/what would you like to do/i.test(firstLine)) {
        await new Promise(r => setTimeout(r, 200));
        proc.write('\r'); // accept default: add a new profile
        await proc.waitFor(/where would you like to store/i, 15_000);
      }

      // ── Step 2: "Where would you like to store?" → global (default) ────────────
      await new Promise(r => setTimeout(r, 200));
      proc.write('\r');

      // ── Step 3: "Choose your LLM provider" → SSO (first, priority 0) ──────────
      await proc.waitFor(/choose your llm provider/i, 15_000);
      await new Promise(r => setTimeout(r, 200));
      proc.write('\r');

      // ── Step 4: SSO organization URL → accept default (codemie prod) ──────────
      // SSO credential setup prompts "CodeMie organization URL:" pre-filled with
      // the prod default. Accept it; the saved URL is cross-verified via the
      // config-file assertion below.
      //
      // This is an input (not list) prompt: it sits in the incomplete tail line and
      // inquirer only attaches its keypress listener once fully rendered, so a too-
      // early keystroke is dropped. A ~600ms settle after the prompt matches avoids
      // that race (200ms was too short and left the wizard stuck on this prompt).
      await proc.waitFor(/organization url:\s*\(http/i, 15_000);
      await new Promise(r => setTimeout(r, 600));
      proc.write('\r'); // accept default

      // ── Step 5: Browser SSO flow ─────────────────────────────────────────────────
      // The wizard opens the browser; wait up to 2 minutes for the user to log in.
      // On a machine with an active CodeMie SSO session the callback returns
      // immediately, so this resolves within seconds; the 2 min budget covers a
      // cold login that needs manual interaction.
      await proc.waitFor(/Authentication successful/i, 120_000);

      // ── Step 6: "Select your project:" → first option ──────────────────────────
      await proc.waitFor(/Select your project/i, 30_000);
      await new Promise(r => setTimeout(r, 500));
      proc.write('\r');
      // Capture "✓ Selected project: <name>" for cross-verification with config.
      const projectLine = await proc.waitFor(/Selected project:/i, 15_000);
      const selectedProject = projectLine.match(/Selected project:\s*(\S+)/i)?.[1];

      // ── Step 7: Model selection → first option ──────────────────────────────────
      await proc.waitFor(/\(Use arrow keys\)/i, 15_000);
      await new Promise(r => setTimeout(r, 500));
      proc.write('\r');

      // ── Step 8: Profile name → clear default, type test name ────────────────────
      await proc.waitFor(/Enter a name for this profile/i, 15_000);
      await new Promise(r => setTimeout(r, 200));
      proc.write('\x15'); // Ctrl+U — clears the entire readline input
      await new Promise(r => setTimeout(r, 100));
      proc.writeLine(TEST_PROFILE_NAME);

      // Wait for save confirmation: '✔ Profile "..." saved to global config'
      await proc.waitFor(/Profile .+ saved to (global|local) config/i, 15_000);

      // ── Step 9: "Switch to profile as active?" → confirm ────────────────────────
      // Safe: wizard writes to testHome only; ~/.codemie is not touched.
      await proc.waitFor(/Switch to profile/i, 10_000);
      await new Promise(r => setTimeout(r, 200));
      proc.writeLine('y');

      await proc.exit(30_000);

      // ── Verify config ────────────────────────────────────────────────────────────
      const configPath = join(testHome, 'codemie-cli.config.json');
      expect(existsSync(configPath), 'config file must exist in testHome after setup').toBe(true);

      // codeMieUrl and codeMieProject are repo/tooling-context fields; the
      // decouple-provider-workspace-config migration (007) moved them out of the
      // ProviderProfile into a scope-level `workspace` (WorkspaceConfig) object, so
      // they are asserted against cfg.workspace, not the profile.
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        activeProfile?: string;
        profiles?: Record<string, Record<string, unknown>>;
        workspace?: { codeMieUrl?: string; codeMieProject?: string };
      };
      const profile = cfg.profiles?.[TEST_PROFILE_NAME];

      expect(profile, `profile "${TEST_PROFILE_NAME}" must exist in config`).toBeDefined();
      expect(profile!.name, 'name must match the typed profile key').toBe(TEST_PROFILE_NAME);
      expect(profile!.provider, 'provider must be ai-run-sso').toBe('ai-run-sso');
      expect(String(profile!.apiKey ?? ''), 'apiKey must be sso-provided').toBe('sso-provided');
      expect(String(cfg.workspace?.codeMieUrl ?? ''), 'codeMieUrl must be the prod URL').toMatch(
        /codemie\.lab\.epam\.com/,
      );
      expect(String(profile!.baseUrl ?? ''), 'baseUrl must include code-assistant-api').toMatch(
        /code-assistant-api/,
      );

      // Step 9 verification: profile was activated
      expect(cfg.activeProfile, 'activeProfile must be set to the new profile').toBe(
        TEST_PROFILE_NAME,
      );

      // Verify the selected project was persisted (captured from PTY + checked in config)
      expect(String(cfg.workspace?.codeMieProject ?? ''), 'codeMieProject must not be empty').not.toBe('');
      if (selectedProject) {
        expect(cfg.workspace?.codeMieProject, `codeMieProject must match selected "${selectedProject}"`).toBe(
          selectedProject,
        );
      }

      // Verify the selected model was persisted (read from config — more reliable than PTY capture)
      expect(String(profile!.model ?? ''), 'model must not be empty').not.toBe('');
    },
    180_000, // 3 min: allows 2 min for browser auth + PTY interactions
  );
});
