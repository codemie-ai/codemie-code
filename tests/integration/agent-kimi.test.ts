/**
 * Kimi agent — real-work smoke test (agent tier).
 *
 * First automated end-to-end proof that `codemie kimi --task` authenticates,
 * resolves a live Kimi/Moonshot model (resolveKimiModel over the CodeMie
 * catalog), starts the proxy, spawns the native kimi binary and returns the
 * answer on stdout — previously manual-only.
 *
 * NOTE: HOME is NOT isolated — the kimi binary is resolved from the real
 * ~/.kimi-code/bin, so redirecting HOME would hide it. The model must be a
 * kimi-* deployment (kimi-k2 is used; kimi accepts any locally, then resolves).
 *
 * Gated on SSO_AVAILABLE. Cleanup: profile restored + temp home removed.
 *
 * Run: npx vitest run --project agent -- agent-kimi
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

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('Kimi agent smoke (real)', () => {
  let originalActiveProfile: string | undefined;
  let run: AgentSmokeRun;

  beforeAll(() => {
    originalActiveProfile = setupSsoAutotestProfile();
    run = runAgentTaskSmoke({
      binName: 'codemie-kimi.js',
      model: process.env.CODEMIE_KIMI_MODEL ?? 'kimi-k2',
      isolateHome: false, // kimi binary lives under the real ~/.kimi-code/bin
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

  it('resolves a live Kimi model and routes the agent response to stdout', () => {
    expect(run.result.stdout).toMatch(/READY/i);
  });
});
