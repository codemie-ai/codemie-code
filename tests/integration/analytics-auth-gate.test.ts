/**
 * Analytics Auth Gate — CLI contract tests
 *
 * Exercises `enforceAnalyticsAuthGate` (src/cli/commands/hook.ts), the
 * UserPromptSubmit prompt-blocking safety net, by driving the real
 * `codemie hook` CLI (bin/codemie.js against the pre-built dist) with a
 * UserPromptSubmit event on stdin.
 *
 * Each spawn runs against an isolated temp CODEMIE_HOME so the developer's
 * real ~/.codemie is never touched, no stored SSO credentials exist, and the
 * analytics-auth-status.json marker can be written per-case. No network calls
 * occur: credential lookup reads only the (empty) temp home.
 *
 * Gate contract (CLI mode, config read from environment):
 * - analytics NOT configured                         => allowed (exit 0)
 * - configured + CODEMIE_API_KEY + no invalid marker => allowed (exit 0)
 * - configured + no api key + no stored SSO creds    => BLOCKED (exit 2)
 * - configured + api key + invalid-auth marker       => BLOCKED (exit 2)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO_ROOT, 'bin', 'codemie.js');

const BLOCK_HEADER =
  'CodeMie analytics authentication is invalid — session metrics are NOT being uploaded.';

interface HookResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

describe('analytics auth gate (codemie hook UserPromptSubmit)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codemie-auth-gate-'));
  });

  afterEach(() => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  /**
   * Write an analytics-auth-status marker into the isolated temp home.
   */
  function writeMarker(content: unknown): void {
    writeFileSync(
      join(home, 'analytics-auth-status.json'),
      typeof content === 'string' ? content : JSON.stringify(content),
      'utf-8'
    );
  }

  /**
   * Drive `codemie hook` with a UserPromptSubmit event on stdin.
   * `extraEnv` supplies the analytics-relevant configuration; the child gets a
   * deliberately minimal environment so nothing leaks from the test runner.
   */
  function runHook(extraEnv: Record<string, string>): HookResult {
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(transcript, '', 'utf-8');
    const event = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'agent-session-under-test',
      transcript_path: transcript,
    };

    const result = spawnSync('node', [BIN, 'hook'], {
      input: JSON.stringify(event),
      encoding: 'utf-8',
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CODEMIE_HOME: home,
        CODEMIE_AGENT: 'claude',
        CODEMIE_SESSION_ID: 'codemie-session-under-test',
        CODEMIE_SKIP_UPDATE_CHECK: 'true',
        ...extraEnv,
      },
    });

    return {
      code: result.status,
      stderr: result.stderr ?? '',
      stdout: result.stdout ?? '',
    };
  }

  it('allows the prompt when analytics is not configured (exit 0)', () => {
    const res = runHook({});
    expect(res.code).toBe(0);
    // The gate message must never appear on the allowed path.
    expect(res.stderr).not.toContain(BLOCK_HEADER);
  });

  it('allows the prompt when configured (ai-run-sso) with an API key and no invalid marker (exit 0)', () => {
    const res = runHook({ CODEMIE_PROVIDER: 'ai-run-sso', CODEMIE_API_KEY: 'test-key' });
    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain(BLOCK_HEADER);
  });

  it('blocks the prompt when configured but no api key and no stored SSO credentials (exit 2)', () => {
    const res = runHook({ CODEMIE_PROVIDER: 'ai-run-sso' });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(BLOCK_HEADER);
    expect(res.stderr).toContain('no valid CodeMie SSO credentials found');
    // Re-login instruction; without CODEMIE_URL the command has no --url suffix.
    expect(res.stderr).toContain('codemie profile login');
    expect(res.stderr).not.toContain('--url');
    expect(res.stderr).toContain('Then re-send your prompt.');
  });

  it('blocks the prompt when a valid api key is present but an invalid-auth marker exists (exit 2)', () => {
    writeMarker({
      status: 'invalid',
      reason: 'HTTP 401',
      baseUrl: 'https://metrics.example',
      detectedAt: Date.now(),
    });
    const res = runHook({ CODEMIE_PROVIDER: 'ai-run-sso', CODEMIE_API_KEY: 'test-key' });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(BLOCK_HEADER);
    expect(res.stderr).toContain('rejected the stored credentials');
    // The marker's reason is surfaced back to the user.
    expect(res.stderr).toContain('HTTP 401');
  });

  it('blocks when configured via CODEMIE_URL + CODEMIE_SYNC_API_URL (no provider) with no auth, and points --url at the SSO url (exit 2)', () => {
    const res = runHook({
      CODEMIE_URL: 'https://sso.example',
      CODEMIE_SYNC_API_URL: 'https://api.example',
    });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(BLOCK_HEADER);
    expect(res.stderr).toContain('codemie profile login --url https://sso.example');
  });

  it('treats a non-"invalid" marker status as no marker and allows the prompt (exit 0)', () => {
    writeMarker({ status: 'valid' });
    const res = runHook({ CODEMIE_PROVIDER: 'ai-run-sso', CODEMIE_API_KEY: 'test-key' });
    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain(BLOCK_HEADER);
  });

  it('tolerates a malformed marker file (best-effort read) and allows the prompt (exit 0)', () => {
    writeMarker('{ this is not valid json');
    const res = runHook({ CODEMIE_PROVIDER: 'ai-run-sso', CODEMIE_API_KEY: 'test-key' });
    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain(BLOCK_HEADER);
  });

  it('is NOT configured when only CODEMIE_URL is set (no sync api url, no ai-run-sso), so it allows even without auth (exit 0)', () => {
    const res = runHook({ CODEMIE_URL: 'https://sso.example' });
    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain(BLOCK_HEADER);
  });

  it('is NOT configured when only CODEMIE_SYNC_API_URL is set (no sso url, no ai-run-sso), so it allows even without auth (exit 0)', () => {
    const res = runHook({ CODEMIE_SYNC_API_URL: 'https://api.example' });
    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain(BLOCK_HEADER);
  });
});
