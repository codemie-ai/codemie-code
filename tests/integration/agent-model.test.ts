/**
 * Model tests — TC-020, TC-021, TC-022, TC-024
 *
 * Run with: npm run test:integration:agent
 *
 * Auth mode (CI_IS_LOCAL_RUN in .env.test.local):
 *   true  (default) — SSO mode; uses developer's sso-autotest profile in ~/.codemie
 *   false           — JWT mode; isolates to a temp CODEMIE_HOME with bearer-auth profile
 *
 * TC-020: Session uses the model configured in the profile (sonnet and haiku variants).
 * TC-021: Metrics records the configured model in the models array.
 * TC-022: codemie models list returns the configured model in its output.
 * TC-024: In-session model switch via /model slash command records new model in metrics.
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  getLatestMetricsRecord,
  getTestEnvFlagOrDefault,
} from '../helpers/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');
const CLI_BIN = join(REPO_ROOT, 'bin', 'codemie.js');

const CI_IS_LOCAL_RUN = getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true);

/**
 * Write a profile that selects a specific model, in SSO or JWT format
 * depending on CI_IS_LOCAL_RUN. Used by TC-020 and TC-021 to verify that
 * the model field in codemie-cli.config.json is honoured at runtime.
 */
function writeProfileWithModel(codemieHome: string, profileName: string, model: string): void {
  const ciCodemieUrl = (process.env.CI_CODEMIE_URL ?? '').replace(/\/$/, '');
  const profile = CI_IS_LOCAL_RUN
    ? {
        name: profileName,
        provider: 'ai-run-sso',
        authMethod: 'sso',
        codeMieUrl: process.env.CI_CODEMIE_URL ?? '',
        baseUrl: `${ciCodemieUrl}/code-assistant-api`,
        apiKey: 'sso-authenticated',
        model,
        timeout: 300,
        debug: false,
      }
    : {
        name: profileName,
        provider: 'bearer-auth',
        authMethod: 'jwt',
        codeMieUrl: process.env.CI_CODEMIE_URL ?? '',
        baseUrl: `${ciCodemieUrl}/code-assistant-api`,
        model,
      };
  mkdirSync(codemieHome, { recursive: true });
  writeFileSync(
    join(codemieHome, 'codemie-cli.config.json'),
    JSON.stringify({ version: 2, activeProfile: profileName, profiles: { [profileName]: profile } }, null, 2),
    'utf-8',
  );
}

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('Model tests', () => {
  let jwtToken: string;

  // SSO mode: the sso-autotest profile is configured once by the global setup
  // (agent-build-setup.ts) before any test files start. No per-file setup is
  // needed here — calling setupSsoAutotestProfile() again would write to
  // ~/.codemie/codemie-cli.config.json concurrently with other test workers
  // that use ~/.codemie directly, creating a race condition.
  beforeAll(async () => {
    if (!CI_IS_LOCAL_RUN) {
      jwtToken = await fetchJwtToken();
    }
  }, 30_000);

  // ── TC-020: Profile model selection ───────────────────────────────────────────
  // Runs two --task sessions back-to-back, each with a different model profile,
  // then checks that the model recorded in _metrics.jsonl matches the profile.
  // Separate temp homes for each model guarantee unambiguous mtime ordering when
  // reading the latest record.
  describe('TC-020 — session uses model from profile', () => {
    let sonnetHome: string;
    let haikuHome: string;
    let sonnetMetrics: Record<string, unknown>;
    let haikuMetrics: Record<string, unknown>;

    beforeAll(() => {
      sonnetHome = mkdtempSync(join(getTempDir(), 'codemie-model-sonnet-'));
      writeProfileWithModel(sonnetHome, 'profile-sonnet', 'claude-sonnet-4-6');
      if (CI_IS_LOCAL_RUN) copySsoCredentials(sonnetHome);
      spawnSync(
        process.execPath,
        CI_IS_LOCAL_RUN
          ? [CLAUDE_BIN, '--profile', 'profile-sonnet', '--task', 'Say READY']
          : [CLAUDE_BIN, '--profile', 'profile-sonnet', '--jwt-token', jwtToken, '--task', 'Say READY'],
        { cwd: sonnetHome, env: { ...(CI_IS_LOCAL_RUN ? ssoCleanEnv() : jwtCleanEnv()), CODEMIE_HOME: sonnetHome }, encoding: 'utf-8', timeout: 180_000 },
      );
      sonnetMetrics = getLatestMetricsRecord(join(sonnetHome, 'sessions'));

      haikuHome = mkdtempSync(join(getTempDir(), 'codemie-model-haiku-'));
      writeProfileWithModel(haikuHome, 'profile-haiku', 'claude-haiku-4-5-20251001');
      if (CI_IS_LOCAL_RUN) copySsoCredentials(haikuHome);
      spawnSync(
        process.execPath,
        CI_IS_LOCAL_RUN
          ? [CLAUDE_BIN, '--profile', 'profile-haiku', '--task', 'Say READY']
          : [CLAUDE_BIN, '--profile', 'profile-haiku', '--jwt-token', jwtToken, '--task', 'Say READY'],
        { cwd: haikuHome, env: { ...(CI_IS_LOCAL_RUN ? ssoCleanEnv() : jwtCleanEnv()), CODEMIE_HOME: haikuHome }, encoding: 'utf-8', timeout: 180_000 },
      );
      haikuMetrics = getLatestMetricsRecord(join(haikuHome, 'sessions'));
    }, 300_000);

    afterAll(() => {
      if (sonnetHome) rmSync(sonnetHome, { recursive: true, force: true });
      if (haikuHome) rmSync(haikuHome, { recursive: true, force: true });
    });

    it('metrics models array contains sonnet for claude-sonnet-4-6 profile', () => {
      const models = (sonnetMetrics.models as string[]) ?? [];
      expect(
        models.some((m) => /sonnet/i.test(m)),
        `Expected models to contain sonnet, got: ${JSON.stringify(models)}`,
      ).toBe(true);
    });

    it('metrics models array contains haiku for claude-haiku-4-5-20251001 profile', () => {
      const models = (haikuMetrics.models as string[]) ?? [];
      expect(
        models.some((m) => /haiku/i.test(m)),
        `Expected models to contain haiku, got: ${JSON.stringify(models)}`,
      ).toBe(true);
    });
  });

  // ── TC-021: Metrics models array populated ─────────────────────────────────
  // Sanity check: after a minimal --task run, the models array in _metrics.jsonl
  // is non-empty and reflects the model that was configured in the profile.
  describe('TC-021 — metrics records the configured model', () => {
    let testHome: string;
    let metrics: Record<string, unknown>;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-model-tiers-'));
      writeProfileWithModel(testHome, 'profile-tiers', 'claude-sonnet-4-6');
      if (CI_IS_LOCAL_RUN) copySsoCredentials(testHome);
      spawnSync(
        process.execPath,
        CI_IS_LOCAL_RUN
          ? [CLAUDE_BIN, '--profile', 'profile-tiers', '--task', 'Say READY']
          : [CLAUDE_BIN, '--profile', 'profile-tiers', '--jwt-token', jwtToken, '--task', 'Say READY'],
        { cwd: testHome, env: { ...(CI_IS_LOCAL_RUN ? ssoCleanEnv() : jwtCleanEnv()), CODEMIE_HOME: testHome }, encoding: 'utf-8', timeout: 120_000 },
      );
      metrics = getLatestMetricsRecord(join(testHome, 'sessions'));
    }, 180_000);

    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('metrics models array is non-empty and contains the configured model', () => {
      const models = (metrics.models as string[]) ?? [];
      expect(models.length, 'models array must not be empty').toBeGreaterThan(0);
      expect(
        models.some((m) => /sonnet/i.test(m)),
        `Expected models to contain the configured sonnet model, got: ${JSON.stringify(models)}`,
      ).toBe(true);
    });
  });

  // ── TC-022: codemie models list returns available models ──────────────────
  // Calls the codemie CLI (not codemie-claude) with real auth. Verifies that
  // the models list command contacts the provider and returns at least the
  // configured model name.
  describe('TC-022 — codemie models list returns available models', () => {
    let testHome: string;
    let listResult: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      testHome = mkdtempSync(join(getTempDir(), 'codemie-models-'));
      if (!CI_IS_LOCAL_RUN) {
        writeJwtProfile(testHome, { jwtToken });
      } else {
        writeSsoProfile(testHome);
        copySsoCredentials(testHome);
      }
      listResult = spawnSync(
        process.execPath,
        [CLI_BIN, 'models', 'list'],
        {
          cwd: testHome,
          env: {
            ...(CI_IS_LOCAL_RUN ? ssoCleanEnv() : jwtCleanEnv()),
            CODEMIE_HOME: testHome,
            ...(CI_IS_LOCAL_RUN ? {} : { CODEMIE_JWT_TOKEN: jwtToken }),
            CI: '1',
          },
          encoding: 'utf-8',
          timeout: 30_000,
        },
      );
    }, 60_000);

    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('exits 0', () => {
      expect(
        listResult.status,
        `stdout: ${listResult.stdout ?? ''}\nstderr: ${listResult.stderr ?? ''}`,
      ).toBe(0);
    });

    it('output contains the expected model name', () => {
      const out = (listResult.stdout ?? '') + (listResult.stderr ?? '');
      expect(out).toMatch(new RegExp(process.env.CI_CODEMIE_MODEL ?? 'claude', 'i'));
    });
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
        // On macOS, Claude Code shows a workspace-trust prompt for new temp directories
        // before rendering the startup box.  Start a background handler that accepts the
        // prompt ('1' = Yes, I trust this folder) if it appears, so the startup box can
        // render.  The handler is a no-op on platforms where the prompt does not appear.
        void proc.waitFor(/trust.*folder|trustthisfolder/i, 15_000)
          .then(() => proc.writeLine('1'))
          .catch(() => { /* no trust prompt on this platform */ });
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
