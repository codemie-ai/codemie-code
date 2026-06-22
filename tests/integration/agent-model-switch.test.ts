/**
 * Model switch tests — TC-024
 *
 * Run with: npm run test:integration:agent
 *
 * Auth mode (CI_IS_LOCAL_RUN in .env.test.local):
 *   true  (default) — SSO mode; uses developer's sso-autotest profile in ~/.codemie
 *   false           — JWT mode; isolates to a temp CODEMIE_HOME with bearer-auth profile
 *
 * TC-024: In-session model switch via /model slash command.
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  getLatestMetricsRecord,
  getTestEnvFlagOrDefault,
} from '../helpers/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');

const CI_IS_LOCAL_RUN = getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true);

describe('Model switch tests', () => {
  let jwtToken: string;
  let originalActiveProfile: string | undefined;

  beforeAll(async () => {
    if (!CI_IS_LOCAL_RUN) {
      jwtToken = await fetchJwtToken();
    } else {
      originalActiveProfile = setupSsoAutotestProfile();
    }
  }, 30_000);

  afterAll(() => {
    if (CI_IS_LOCAL_RUN) {
      teardownSsoAutotestProfile(originalActiveProfile);
    }
  });

  // ── TC-024: In-session /model switch via PTY ────────────────────────────────
  // Uses node-pty to give the process a real TTY (isTTY=true), which is required
  // for the /model slash command to be available inside a running agent session.
  // Verifies that the switched model appears in the session metrics file.
  describe('TC-024 — in-session /model switch records new model in metrics', () => {
    let testHome: string;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-model-switch-'));
      if (!CI_IS_LOCAL_RUN) {
        writeJwtProfile(testHome, { jwtToken });
      } else {
        writeSsoProfile(testHome);
        copySsoCredentials(testHome);
      }
    });

    afterAll(async () => {
      await new Promise((r) => setTimeout(r, 500));
      rmSync(testHome, { recursive: true, force: true });
    });

    it('agent processes /model switch and records new model in metrics', async () => {
      const sessionArgs = CI_IS_LOCAL_RUN
        ? [CLAUDE_BIN]
        : [CLAUDE_BIN, '--profile', 'jwt-autotest', '--jwt-token', jwtToken];
      const sessionEnv = CI_IS_LOCAL_RUN
        ? { ...ssoCleanEnv(), CODEMIE_HOME: testHome, TERM: 'xterm-256color' }
        : { ...jwtCleanEnv(), CODEMIE_HOME: testHome, TERM: 'xterm-256color' };

      const proc = spawnPty(process.execPath, sessionArgs, { cwd: testHome, env: sessionEnv });

      try {
        // Wait for the profile info table rendered before Claude enters interactive mode.
        await proc.waitFor(/Model\s*[│|]/i, 60_000);
        // Wait for Claude Code's startup box to fully render (╰─ is its bottom-left
        // corner).  Sending commands before this point causes them to pile up in the
        // ConPTY input buffer and be drained by readline as ONE combined input when it
        // finally starts — that is the root cause of the "model=...SayPONG" 400 error.
        // Once the startup box is visible, the TUI is rendered and readline is actively
        // waiting for keystrokes, so commands sent now are processed individually.
        await proc.waitFor(/╰─/, 60_000);
        // 1 s buffer for the prompt area to settle after the startup box closes.
        await new Promise((r) => setTimeout(r, 1_000));
        // Switch model in-session via slash command — readline IS ready at this point.
        proc.writeLine('/model claude-haiku-4-5-20251001');
        // Wait for /model to be processed.  Do NOT use waitFor(/haiku/) here because
        // the PTY echoes the input line back (writeLine sends \r\n = proper line) and
        // that echo would match /haiku/ before any Claude Code processing happens.
        await new Promise((r) => setTimeout(r, 8_000));
        // Send a message so haiku is actually used and recorded in metrics.
        const pongCursor = proc.lines().length;
        proc.writeLine('Say PONG and nothing else');
        // Only match PONG in lines received AFTER the message was sent (pongCursor).
        // waitFor scans allLines from startFromLine, so historical output cannot cause
        // a false-positive match.  The lookbehind still excludes the echoed input line
        // "Say PONG and nothing else" (PONG preceded by "Say ").
        await proc.waitFor(/(?<![Ss]ay )PONG/i, 150_000, pongCursor);
        // Give Claude Code 5 s to finish streaming the response to the JSONL and
        // let the Stop hook run so the metrics delta is flushed before /exit.
        // Under parallel load hooks can be slower, so 5 s > the original 3 s.
        await new Promise((r) => setTimeout(r, 5_000));
      } finally {
        // /exit is a local slash command in the Claude Code REPL that exits
        // gracefully, firing SessionEnd → codemie hook → renameFiles.
        proc.writeLine('/exit');
        // Wait up to 90 s for Claude Code to exit and all hooks to complete.
        await proc.exit(90_000);
      }

      const ptyLines = proc.lines();
      const metrics = getLatestMetricsRecord(join(testHome, 'sessions'));
      const models = (metrics.models as string[]) ?? [];
      expect(
        models.some((m) => /haiku/i.test(m)),
        `Expected metrics.models to contain haiku after /model switch.\nGot: ${JSON.stringify(models)}\nLast PTY lines:\n${ptyLines.slice(-30).join('\n')}`,
      ).toBe(true);
    }, 240_000);
  });
});
