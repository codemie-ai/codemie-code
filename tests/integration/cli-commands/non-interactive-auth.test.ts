/** EPMCDME-14148 — non-interactive SSO failure must exit cleanly, end to end. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIRunner } from '../../helpers/cli-runner.js';
import { ssoCleanEnv } from '../../helpers/sso-auth.js';

const EXPECTED_MESSAGE =
  'SSO authentication required. Please run "codemie setup" with SSO provider first.';

describe('non-interactive SSO auth failure', () => {
  const runner = new CLIRunner();
  let isolatedHome: string;
  let result: ReturnType<CLIRunner['runSilent']> & { combined: string };

  beforeAll(() => {
    // Empty home = "no valid SSO session", without touching the real ~/.codemie.
    isolatedHome = mkdtempSync(join(tmpdir(), 'codemie-14148-'));

    const startedAt = Date.now();
    const raw = runner.runSilent('sdk assistants list', {
      // ssoCleanEnv strips CODEMIE_*: ConfigLoader.loadFromEnv reads
      // CODEMIE_PROVIDER/API_KEY/URL directly, so an empty home alone does not
      // guarantee "no valid SSO session" when run from a CodeMie agent shell.
      env: { ...ssoCleanEnv(), CODEMIE_HOME: isolatedHome },
      // 'ignore' stdin is not a TTY — the condition under test.
      stdio: ['ignore', 'pipe', 'pipe'],
      // execSync blocks the worker, so Vitest's testTimeout cannot interrupt a hang.
      timeout: 15_000,
    });

    // Without these two, a hang satisfies every assertion below — including the
    // one named for it: ETIMEDOUT yields status null, which collapses to exit 1,
    // and stderr already holds what was printed before the block.
    expect(raw.timedOut ?? false).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    result = { ...raw, combined: `${raw.output}\n${raw.error ?? ''}` };
  });

  afterAll(() => {
    rmSync(isolatedHome, { recursive: true, force: true });
  });

  it('exits non-zero instead of hanging on a re-authentication prompt', () => {
    expect(result.exitCode).not.toBe(0);
  });

  it('names the remediation the user should run', () => {
    // Verbatim: a loose /codemie setup/ also matches other failure paths.
    expect(result.combined).toContain(EXPECTED_MESSAGE);
  });

  it('sends the diagnostic to stderr and keeps it off stdout', () => {
    expect(result.error ?? '').toContain(EXPECTED_MESSAGE);
    expect(result.output).not.toContain(EXPECTED_MESSAGE);
  });

  it('does not print a raw stack trace', () => {
    expect(result.combined).not.toMatch(/^\s+at\s+/m);
    expect(result.combined).not.toContain('ConfigurationError:');
    expect(result.combined).not.toMatch(/Node\.js v\d/);
  });
});
