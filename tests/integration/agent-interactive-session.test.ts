/**
 * Agent Interactive Session Tests — TC-024, TC-025, TC-026
 *
 * Run with: npm run test:integration:agent
 * Requires: INCLUDE_JWT_TESTS=true, CI_CODEMIE_* env vars
 *
 * TC-024: In-session model switch via /model slash command.
 * TC-025: Skill slash command invocation inside a running agent session.
 * TC-026: Non-interactive assistant chat PONG test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fetchJwtToken, writeJwtProfile, waitForOutput, cleanKill } from '../helpers/index.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');
const CLI_BIN = join(REPO_ROOT, 'bin', 'codemie.js');
const INCLUDE_JWT_TESTS = process.env.INCLUDE_JWT_TESTS === 'true';

// Minimal env to prevent credential leakage to subprocesses
function cleanEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    NODE_PATH: process.env.NODE_PATH ?? '',
  };
}

describe.runIf(INCLUDE_JWT_TESTS)('Interactive session tests', () => {
  let jwtToken: string;

  beforeAll(async () => {
    jwtToken = await fetchJwtToken();
  }, 30_000);

  // ── TC-024: Change model via /model slash command ───────────────────────────
  describe('TC-024 — in-session model switch via /model', () => {
    let testHome: string;

    beforeAll(() => {
      testHome = mkdtempSync(join(tmpdir(), 'codemie-interactive-model-'));
      writeJwtProfile(testHome, { jwtToken });
    });
    afterAll(() => rmSync(testHome, { recursive: true, force: true }));

    it('agent acknowledges /model switch and responds with new model', async () => {
      const proc = spawn(
        process.execPath,
        [CLAUDE_BIN, '--profile', 'jwt-autotest', '--jwt-token', jwtToken],
        {
          env: { ...cleanEnv(), CODEMIE_HOME: testHome },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      try {
        await waitForOutput(proc, />\s*$|human:|ready/i, 60_000);
        proc.stdin!.write('/model claude-haiku-4-5-20251001\n');
        await waitForOutput(proc, /haiku|model.*switch|changed/i, 30_000);
        proc.stdin!.write('Say the word CONFIRMED and nothing else\n');
        const line = await waitForOutput(proc, /CONFIRMED/i, 60_000);
        expect(line).toMatch(/CONFIRMED/i);
      } finally {
        await cleanKill(proc);
      }
    }, 180_000);
  });

  // ── TC-025: Skill invocation inside running session ─────────────────────────
  describe('TC-025 — skill slash command in running session', () => {
    let testHome: string;
    let skillSource: string;
    let skillSlashCommand: string;

    beforeAll(async () => {
      testHome = mkdtempSync(join(tmpdir(), 'codemie-interactive-skill-'));
      writeJwtProfile(testHome, { jwtToken });

      const findResult = spawnSync(
        process.execPath,
        [CLI_BIN, 'skills', 'find', '--json', '--limit', '1'],
        {
          env: { ...process.env, CODEMIE_HOME: testHome, CI: '1' },
          encoding: 'utf-8',
          timeout: 30_000,
        }
      );
      const found = JSON.parse(findResult.stdout) as Array<{ source: string; name: string }>;
      if (!found.length) throw new Error('No skills in marketplace — cannot run TC-025');
      skillSource = found[0].source;
      skillSlashCommand = `/${found[0].name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;

      spawnSync(
        process.execPath,
        [CLI_BIN, 'skills', 'add', skillSource, '-a', 'claude-code', '-y'],
        {
          env: { ...process.env, CODEMIE_HOME: testHome, CI: '1' },
          encoding: 'utf-8',
          timeout: 60_000,
        }
      );
    }, 90_000);

    afterAll(() => {
      if (skillSource) {
        spawnSync(
          process.execPath,
          [CLI_BIN, 'skills', 'remove', '-s', skillSource, '-a', 'claude-code', '-y'],
          {
            env: { ...process.env, CODEMIE_HOME: testHome, CI: '1' },
            encoding: 'utf-8',
            timeout: 30_000,
          }
        );
      }
      rmSync(testHome, { recursive: true, force: true });
    });

    it('agent responds to skill slash command invocation', async () => {
      const proc = spawn(
        process.execPath,
        [CLAUDE_BIN, '--profile', 'jwt-autotest', '--jwt-token', jwtToken],
        {
          env: { ...cleanEnv(), CODEMIE_HOME: testHome },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      try {
        await waitForOutput(proc, />\s*$|human:|ready/i, 60_000);
        proc.stdin!.write(`${skillSlashCommand}\n`);
        const line = await waitForOutput(proc, /.+/, 60_000);
        expect(line.length).toBeGreaterThan(0);
      } finally {
        await cleanKill(proc);
      }
    }, 180_000);
  });

  // ── TC-026: Assistant chat non-interactive ──────────────────────────────────
  describe('TC-026 — assistants chat non-interactive (PONG test)', () => {
    let testHome: string;
    const assistantId = process.env.CI_CODEMIE_ASSISTANT_ID ?? '';
    let chatResult: ReturnType<typeof spawnSync>;

    beforeAll(() => {
      testHome = mkdtempSync(join(tmpdir(), 'codemie-asst-chat-'));
      writeJwtProfile(testHome, { jwtToken });
      chatResult = spawnSync(
        process.execPath,
        [CLI_BIN, 'assistants', 'chat', assistantId, 'Say PONG and nothing else'],
        {
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

    it('exits 0 and returns PONG response', () => {
      expect(chatResult.status).toBe(0);
      expect((chatResult.stdout ?? '') + (chatResult.stderr ?? '')).toMatch(/PONG/i);
    });
  });
});
