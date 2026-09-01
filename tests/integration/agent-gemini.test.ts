/**
 * Gemini agent — real-work smoke test (agent tier).
 *
 * First automated end-to-end proof that `codemie gemini --task` authenticates
 * through the local proxy, uses a gemini-* model, and returns the agent's reply
 * on stdout. Previously the whole gemini launch path (settings.json bootstrap +
 * auth pass-through + spawn) was verified only by hand.
 *
 * MODEL NOTE (EPMCDME-14421): the model MUST be a real catalog deployment.
 * `gemini-3.1-pro` is used here (others: gemini-3-flash, gemini-3.5-flash,
 * gemini-3.6-flash, gemini-3.7-flash — verify with `codemie sdk llm list | grep
 * gemini`). An invalid model no longer produces an opaque upstream HTTP 400:
 * gemini's beforeRun now validates the configured model against the catalog
 * (src/agents/plugins/gemini/gemini.models.ts) and fails fast with a clear error
 * listing the available gemini-* deployments.
 *
 * ISOLATION: shared agent-smoke harness — temp CODEMIE_HOME + own sso-autotest
 * profile + copied creds + git-init + CODEMIE_* stripped. HOME is isolated so
 * Gemini writes settings.json into the temp dir, and GEMINI_CLI_TRUST_WORKSPACE
 * satisfies the non-interactive trust guard.
 *
 * Gated on SSO_AVAILABLE. Cleanup: profile restored + temp home removed.
 *
 * Run: npx vitest run --project agent -- agent-gemini
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import {
  runAgentTaskSmoke,
  setupSsoAutotestProfile,
  teardownSsoAutotestProfile,
  type AgentSmokeRun,
} from '../helpers/index.js';

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('Gemini agent smoke (real)', () => {
  let originalActiveProfile: string | undefined;
  let run: AgentSmokeRun;

  beforeAll(() => {
    originalActiveProfile = setupSsoAutotestProfile();
    run = runAgentTaskSmoke({
      binName: 'codemie-gemini.js',
      // Must be a real gemini-* deployment from the catalog (see MODEL NOTE).
      model: process.env.CODEMIE_GEMINI_MODEL ?? 'gemini-3.1-pro',
      isolateHome: true, // keep Gemini's settings.json out of the real ~/.gemini
      extraEnv: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    });
  }, 180_000);

  afterAll(() => {
    teardownSsoAutotestProfile(originalActiveProfile);
    if (run?.testHome) rmSync(run.testHome, { recursive: true, force: true });
  });

  it('exits 0', () => {
    expect(
      run.result.status,
      `stdout:\n${run.result.stdout ?? ''}\nstderr:\n${run.result.stderr ?? ''}`,
    ).toBe(0);
  });

  it('routes the agent response to stdout', () => {
    expect(run.result.stdout).toMatch(/READY/i);
  });
});
