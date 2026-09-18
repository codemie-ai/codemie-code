/**
 * Pi agent — real-work smoke test (agent tier).
 *
 * First automated end-to-end proof that `codemie pi --task` authenticates,
 * performs its invocation rewrite + PI_CODING_AGENT_DIR redirect + agent-dir
 * copy, spawns the pi binary through the proxy and returns the answer on stdout.
 * Pi is the newest/most-complex adapter (session-id injection, session-dir
 * redirect) and its real launch was entirely manual before.
 *
 * HOME is isolated: Pi redirects its agent dir into <cwd>/.pi/codemie, so a
 * temp HOME keeps the run self-contained. Pi accepts a claude model.
 *
 * Gated on SSO_AVAILABLE. Cleanup: profile restored + temp home removed.
 *
 * Run: npx vitest run --project agent -- agent-pi
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

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('Pi agent smoke (real)', () => {
  let originalActiveProfile: string | undefined;
  let run: AgentSmokeRun;

  beforeAll(() => {
    originalActiveProfile = setupSsoAutotestProfile();
    run = runAgentTaskSmoke({ binName: 'codemie-pi.js', model: 'claude-sonnet-4-6', isolateHome: true });
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
