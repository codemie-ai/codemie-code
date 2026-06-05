/**
 * Agent Interactive Session Tests — TC-014, TC-015, TC-024, TC-025, TC-026
 *
 * Run with: npm run test:integration:agent
 * Requires: INCLUDE_JWT_TESTS=true, CI_CODEMIE_* env vars
 *
 * TC-014: Setup assistants wizard via PTY — registers CI assistant in config.
 * TC-015: Assistants chat with invalid ID — negative test, exits non-zero.
 * TC-024: In-session model switch via /model slash command.
 * TC-025: Skill slash command invocation inside a running agent session.
 * TC-026: Non-interactive assistant chat PONG test.
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  fetchJwtToken,
  writeJwtProfile,
  getTempDir,
  spawnPty,
  getLatestMetricsRecord,
} from '../helpers/index.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');
const CLI_BIN = join(REPO_ROOT, 'bin', 'codemie.js');
const INCLUDE_JWT_TESTS = process.env.INCLUDE_JWT_TESTS === 'true';

// Minimal env to prevent credential leakage to subprocesses
function cleanEnv(): NodeJS.ProcessEnv {
  const pick = (...keys: string[]): NodeJS.ProcessEnv =>
    Object.fromEntries(keys.flatMap((k) => (process.env[k] !== undefined ? [[k, process.env[k]]] : [])));
  return {
    PATH: process.env.PATH ?? '',
    NODE_PATH: process.env.NODE_PATH ?? '',
    // Windows: required for DLL loading and executable resolution
    ...pick('SystemRoot', 'SYSTEMROOT', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'COMSPEC',
            'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'),
    // Unix: home and locale
    ...pick('HOME', 'USER', 'LANG', 'LC_ALL', 'SHELL'),
  };
}

describe.runIf(INCLUDE_JWT_TESTS)('Interactive session tests', () => {
  let jwtToken: string;

  beforeAll(async () => {
    jwtToken = await fetchJwtToken();
  }, 30_000);

  // ── TC-014: Setup assistants wizard via PTY ────────────────────────────────
  // Drives the `codemie setup assistants` interactive wizard via PTY:
  //   1. Searches for CI_CODEMIE_ASSISTANT_NAME in the picker and selects it.
  //   2. Chooses "Agent Skills" registration mode (gets a /slug command).
  //   3. Keeps Global storage scope.
  //   4. Confirms Target Agents screen.
  // Verifies the config is updated, then checks the /slug command works in
  // a live codemie-claude session.
  describe('TC-014 — setup assistants wizard registers assistant as skill', () => {
    let testHome: string;
    const assistantName = process.env.CI_CODEMIE_ASSISTANT_NAME ?? '';
    // Slug is the lowercase-no-separator version of the display name,
    // e.g. "AutoTestAssistantRandomGenerator" → "autotestassistantrandomgenerator".
    const assistantSlug = assistantName.toLowerCase().replace(/[^a-z0-9]/g, '');

    beforeAll(async () => {
      if (!assistantName) {
        throw new Error('CI_CODEMIE_ASSISTANT_NAME must be set when INCLUDE_JWT_TESTS=true');
      }
      testHome = mkdtempSync(join(getTempDir(), 'codemie-setup-asst-'));
      writeJwtProfile(testHome, { jwtToken });
      // .claude/ marker lets auto-detection include Claude Code as a target agent.
      mkdirSync(join(testHome, '.claude'), { recursive: true });

      const setupProc = spawnPty(
        process.execPath,
        [CLI_BIN, 'setup', 'assistants'],
        {
          cwd: testHome,
          env: { ...process.env, CODEMIE_HOME: testHome, CODEMIE_JWT_TOKEN: jwtToken, TERM: 'xterm-256color' },
        },
      );

      try {
        // Step 1: Assistants picker — search by name, select, then Continue.
        await setupProc.waitFor(/\d+ assistants total/, 60_000);
        await new Promise((r) => setTimeout(r, 1_500));   // wait for UI to finish rendering
        setupProc.write('\x1B[A');                        // Arrow Up → focus search box
        await new Promise((r) => setTimeout(r, 300));
        for (const char of assistantName) {
          setupProc.write(char);
          await new Promise((r) => setTimeout(r, 150));   // slow enough to avoid PTY buffer drops
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
    });

    it('codemie-cli.config.json contains the registered assistant slug', () => {
      const configPath = join(testHome, 'codemie-cli.config.json');
      const raw = readFileSync(configPath, 'utf-8');
      expect(
        raw.includes(assistantSlug),
        `Expected config to contain slug "${assistantSlug}".\nConfig: ${raw}`,
      ).toBe(true);
    });

    it('agent responds to /<slug> and returns a number 1-10', async () => {
      const proc = spawnPty(
        process.execPath,
        [CLAUDE_BIN, '--profile', 'jwt-autotest', '--jwt-token', jwtToken],
        {
          cwd: testHome,
          env: { ...cleanEnv(), CODEMIE_HOME: testHome, TERM: 'xterm-256color' },
        },
      );

      try {
        await proc.waitFor(/Model\s*[│|]/i, 60_000);
        await proc.waitFor(/╰─/, 60_000);
        await new Promise((r) => setTimeout(r, 1_000));
        proc.writeLine(`/${assistantSlug} hi`);
        await proc.waitFor(/\b([1-9]|10)\b/, 90_000).catch((err: unknown) => {
          try {
            writeFileSync(join(testHome, 'pty-debug.txt'), proc.lines().join('\n'));
          } catch { /* best-effort */ }
          throw err;
        });
      } finally {
        proc.writeLine('/exit');
        await proc.exit(90_000);
      }

      const lines = proc.lines();
      const matchedLine = lines.find((l) => /\b([1-9]|10)\b/.test(l));
      expect(
        matchedLine,
        `Expected a line with a number 1-10 from /${assistantSlug}.\nLast PTY lines:\n${lines.slice(-20).join('\n')}`,
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
      writeJwtProfile(testHome, { jwtToken });
      chatResult = spawnSync(
        process.execPath,
        [CLI_BIN, 'assistants', 'chat', '--jwt-token', jwtToken, 'nonexistent-assistant-id-000', 'Say hello'],
        {
          cwd: testHome,
          env: { ...cleanEnv(), CODEMIE_HOME: testHome, CODEMIE_JWT_TOKEN: jwtToken, CI: '1' },
          encoding: 'utf-8',
          timeout: 30_000,
        },
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

  // ── TC-024: In-session /model switch via PTY ────────────────────────────────
  // Uses node-pty to give the process a real TTY (isTTY=true), which is required
  // for the /model slash command to be available inside a running agent session.
  // Verifies that the switched model appears in the session metrics file.
  describe('TC-024 — in-session /model switch records new model in metrics', () => {
    let testHome: string;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-interactive-model-'));
      // Profile starts with the default model (sonnet); /model will switch to haiku.
      writeJwtProfile(testHome, { jwtToken });
    });

    afterAll(async () => {
      await new Promise((r) => setTimeout(r, 500));
      rmSync(testHome, { recursive: true, force: true });
    });

    it('agent processes /model switch and records new model in metrics', async () => {
      const proc = spawnPty(
        process.execPath,
        [CLAUDE_BIN, '--profile', 'jwt-autotest', '--jwt-token', jwtToken],
        {
          cwd: testHome,
          env: { ...cleanEnv(), CODEMIE_HOME: testHome, TERM: 'xterm-256color' },
        },
      );

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
        await proc.waitFor(/(?<![Ss]ay )PONG/i, 150_000, pongCursor).catch((err: unknown) => {
          // Dump PTY lines so they survive a vitest native crash on Windows.
          try {
            writeFileSync(join(testHome, 'pty-debug.txt'), proc.lines().join('\n'));
          } catch { /* best-effort */ }
          throw err;
        });
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

  // ── TC-025: Skill invocation inside running session ─────────────────────────
  // Installs the 'random-generator' platform skill via the interactive
  // codemie setup skills wizard (driven by PTY), then verifies that the
  // /random-generator slash command is available in a Claude Code session
  // and returns a number in the range 1-10.
  describe('TC-025 — skill slash command in running session', () => {
    let testHome: string;

    beforeAll(async () => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-interactive-skill-'));
      writeJwtProfile(testHome, { jwtToken });
      // .claude/ marker causes auto-detection to include Claude Code as a target agent.
      mkdirSync(join(testHome, '.claude'), { recursive: true });

      const setupProc = spawnPty(
        process.execPath,
        [CLI_BIN, 'setup', 'skills', '--profile', 'jwt-autotest'],
        {
          cwd: testHome,
          // Full process.env for proxy/TLS/server-URL vars; CODEMIE_JWT_TOKEN set explicitly
          // because the token is fetched into jwtToken but never exported to process.env.
          env: { ...process.env, CODEMIE_HOME: testHome, CODEMIE_JWT_TOKEN: jwtToken, TERM: 'xterm-256color' },
        },
      );

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
        // Type letter-by-letter — the search field processes one keypress at a time
        for (const char of 'random-generator') {
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

    it('agent responds to /random-generator and returns a number 1-10', async () => {
      const proc = spawnPty(
        process.execPath,
        [CLAUDE_BIN, '--profile', 'jwt-autotest', '--jwt-token', jwtToken],
        {
          cwd: testHome,
          env: { ...cleanEnv(), CODEMIE_HOME: testHome, TERM: 'xterm-256color' },
        },
      );

      try {
        await proc.waitFor(/Model\s*[│|]/i, 60_000);
        await proc.waitFor(/╰─/, 60_000);
        await new Promise((r) => setTimeout(r, 1_000));
        proc.writeLine('/random-generator hi');
        await proc.waitFor(/\b([1-9]|10)\b/, 90_000).catch((err: unknown) => {
          try {
            writeFileSync(join(testHome, 'pty-debug.txt'), proc.lines().join('\n'));
          } catch { /* best-effort */ }
          throw err;
        });
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

  // ── TC-026: Assistant chat non-interactive ──────────────────────────────────
  // Uses CI_CODEMIE_ASSISTANT_ID (autotestassistantrandomgenerator) which always
  // responds with a random number 1-10.
  describe('TC-026 — assistants chat non-interactive (random number test)', () => {
    let testHome: string;
    const assistantId = process.env.CI_CODEMIE_ASSISTANT_ID ?? '';
    let chatResult: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      if (!assistantId) {
        throw new Error('CI_CODEMIE_ASSISTANT_ID must be set when INCLUDE_JWT_TESTS=true');
      }
      testHome = mkdtempSync(join(getTempDir(), 'codemie-asst-chat-'));
      writeJwtProfile(testHome, { jwtToken, assistantId });
      chatResult = spawnSync(
        process.execPath,
        [CLI_BIN, 'assistants', 'chat', '--jwt-token', jwtToken, assistantId, 'hi'],
        {
          cwd: testHome,
          env: {
            ...cleanEnv(),
            CODEMIE_HOME: testHome,
            CODEMIE_JWT_TOKEN: jwtToken,
            CI: '1',
          },
          encoding: 'utf-8',
          timeout: 60_000,
        }
      );
    }, 90_000);

    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('exits 0 and returns a number 1-10', () => {
      const out = (chatResult.stdout ?? '') + (chatResult.stderr ?? '');
      expect(chatResult.status, `stdout: ${chatResult.stdout ?? ''}\nstderr: ${chatResult.stderr ?? ''}`).toBe(0);
      expect(out).toMatch(/\b([1-9]|10)\b/);
    });
  });
});
