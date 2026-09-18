/**
 * Codex agent — real-work smoke test (agent tier).
 *
 * WHY THIS EXISTS
 * ---------------
 * The agent-real tier only ever exercised the Claude agent. Codex — install +
 * SSO/JWT auth + model resolution (fetch CodeMie catalog, rank GPT/Codex models,
 * write ~/.codex/codemie catalog, inject model_providers.codemie with
 * wire_api=responses) + `codex exec` spawn through the local proxy — was verified
 * only by hand before every release. This is the first automated end-to-end proof
 * that `codemie codex --task` actually authenticates, resolves a live model, and
 * returns the agent's answer on stdout.
 *
 * WHAT IT PROVES (one real run closes several release-risk gaps at once):
 *   - provider ai-run-sso is accepted for Codex and the local proxy handshake works
 *   - resolveCodexModel picks a real GPT/Codex deployment from the live catalog
 *     (the requested `gpt-5.4` fuzzy-resolves to the newest matching deployment)
 *   - `--task` → `codex exec` routes the response to the caller's stdout
 *
 * ISOLATION / CLEANUP
 * -------------------
 *   - Runs in a throwaway temp CODEMIE_HOME with its own sso-autotest profile and
 *     a COPY of the developer's SSO credentials — the real ~/.codemie is never
 *     mutated by the run itself (globalSetup's setupSsoAutotestProfile is restored
 *     in its teardown).
 *   - The workspace is `git init`-ed because Codex refuses to run in an untrusted,
 *     non-git directory.
 *   - CODEMIE_* env vars are stripped (ssoCleanEnv) so an ambient codemie-agent
 *     context can't override the file profile — this is essential: without it the
 *     spawned codex inherits a parent CODEMIE_PROVIDER and rejects the provider.
 *   - afterAll removes the temp home; nothing survives the run.
 *
 * Gated on SSO_AVAILABLE (set by tests/setup/agent-build-setup.ts): skipped when
 * no valid CodeMie SSO session is present, exactly like the Claude agent tests.
 *
 * Run: npx vitest run --project agent -- agent-codex
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copySsoCredentials,
  ssoCleanEnv,
  setupSsoAutotestProfile,
  teardownSsoAutotestProfile,
  getTempDir,
  getCodemieTestUrl,
} from '../helpers/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CODEX_BIN = join(REPO_ROOT, 'bin', 'codemie-codex.js');

// A GPT/Codex model; the resolver fuzzy-matches to the newest available
// deployment, so an exact catalog entry is not required. Overridable in case the
// catalog naming shifts.
const CODEX_MODEL = process.env.CODEMIE_CODEX_MODEL ?? 'gpt-5.4';

/** Write an sso-autotest profile carrying a Codex-appropriate model. */
function writeCodexProfile(home: string): void {
  const url = getCodemieTestUrl();
  const config = {
    version: 2,
    activeProfile: 'sso-autotest',
    profiles: {
      'sso-autotest': {
        name: 'sso-autotest',
        provider: 'ai-run-sso',
        authMethod: 'sso',
        codeMieUrl: url,
        baseUrl: `${url}/code-assistant-api`,
        apiKey: 'sso-authenticated',
        model: CODEX_MODEL,
        timeout: 300,
        debug: false,
      },
    },
    workspace: { codeMieUrl: url },
  };
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'codemie-cli.config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('Codex agent smoke (real)', () => {
  let originalActiveProfile: string | undefined;
  let testHome: string;
  let result: ReturnType<typeof spawnSync>;

  beforeAll(() => {
    originalActiveProfile = setupSsoAutotestProfile();

    testHome = mkdtempSync(join(getTempDir(), 'codemie-codex-'));
    writeCodexProfile(testHome);
    copySsoCredentials(testHome);
    // Codex refuses to run outside a trusted (git) directory.
    execFileSync('git', ['init', '-q', testHome], { stdio: 'ignore' });

    result = spawnSync(
      process.execPath,
      [CODEX_BIN, '--task', 'Reply with only the single word READY'],
      {
        cwd: testHome,
        env: { ...ssoCleanEnv(), CODEMIE_HOME: testHome },
        encoding: 'utf-8',
        timeout: 150_000,
      },
    );
  }, 180_000);

  afterAll(() => {
    teardownSsoAutotestProfile(originalActiveProfile);
    if (testHome) rmSync(testHome, { recursive: true, force: true });
  });

  it('exits 0', () => {
    expect(
      result.status,
      `stdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
    ).toBe(0);
  });

  it('resolves a live GPT/Codex model and routes the agent response to stdout', () => {
    expect(result.stdout).toMatch(/READY/i);
  });
});
