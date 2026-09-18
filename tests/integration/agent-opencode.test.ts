/**
 * OpenCode agent — real-work smoke test (agent tier).
 *
 * First automated end-to-end proof that `codemie opencode --task` authenticates
 * through the local proxy, launches the real opencode binary via its `run`
 * subcommand, and returns the agent's answer on stdout. Previously the entire
 * opencode launch path (binary resolve → proxy → OPENCODE_CONFIG/hooks → spawn)
 * was verified only by hand. Uses the shared agent-smoke harness; HOME is
 * isolated so opencode's own state dir stays out of the developer's real home.
 *
 * Gated on SSO_AVAILABLE (tests/setup/agent-build-setup.ts). Cleanup: profile
 * restored + temp home removed in afterAll.
 *
 * Run: npx vitest run --project agent -- agent-opencode
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

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('OpenCode agent smoke (real)', () => {
  let originalActiveProfile: string | undefined;
  let run: AgentSmokeRun;

  beforeAll(() => {
    originalActiveProfile = setupSsoAutotestProfile();
    // opencode has no model block list — a claude model is fine.
    run = runAgentTaskSmoke({ binName: 'codemie-opencode.js', model: 'claude-sonnet-4-6', isolateHome: true });
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
