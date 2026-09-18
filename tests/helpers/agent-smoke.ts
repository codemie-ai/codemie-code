/**
 * Shared harness for agent-tier "real work" smoke tests.
 *
 * Every non-Claude agent smoke proves the same end-to-end path: isolated
 * CODEMIE_HOME + own sso-autotest profile (with an agent-appropriate model) +
 * copied SSO credentials + a git-initialised workspace, then spawn the agent's
 * bin with `--task` and confirm the response reaches stdout. The knobs that
 * differ per agent (bin, model, HOME isolation, trust env vars) are parameters.
 *
 * CODEMIE_* env vars are stripped via ssoCleanEnv() — essential, because a run
 * launched from inside a codemie-agent context inherits CODEMIE_PROVIDER/MODEL
 * that would otherwise override the file profile and break provider validation.
 */

import { spawnSync, execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copySsoCredentials, ssoCleanEnv } from './sso-auth.js';
import { getTempDir } from './temp-workspace.js';
import { getCodemieTestUrl } from './test-env.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface AgentSmokeOptions {
  /** bin file under bin/, e.g. 'codemie-opencode.js'. */
  binName: string;
  /** Model to pin in the profile (must satisfy the agent's model rules). */
  model: string;
  /** Prompt for --task. Defaults to a trivial READY probe. */
  prompt?: string;
  /**
   * Redirect HOME to the temp dir (isolates the agent's own state dir).
   * Leave false for agents whose binary is resolved from the real HOME
   * (e.g. kimi at ~/.kimi-code/bin).
   */
  isolateHome?: boolean;
  /** Extra env for the spawned agent (e.g. GEMINI_CLI_TRUST_WORKSPACE). */
  extraEnv?: Record<string, string>;
  /** Spawn timeout in ms (default 150s). */
  timeoutMs?: number;
}

export interface AgentSmokeRun {
  result: SpawnSyncReturns<string>;
  testHome: string;
}

function writeSmokeProfile(home: string, model: string): void {
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
        model,
        timeout: 300,
        debug: false,
      },
    },
    workspace: { codeMieUrl: url },
  };
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'codemie-cli.config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Create an isolated home, write a profile, copy creds, git-init the workspace,
 * and run `<bin> --task <prompt>`. Caller is responsible for
 * setupSsoAutotestProfile()/teardown and for rm-ing the returned testHome.
 */
export function runAgentTaskSmoke(opts: AgentSmokeOptions): AgentSmokeRun {
  const testHome = mkdtempSync(join(getTempDir(), 'codemie-agentsmoke-'));
  writeSmokeProfile(testHome, opts.model);
  copySsoCredentials(testHome);
  // Codex/Gemini/etc. refuse to run outside a trusted (git) directory.
  execFileSync('git', ['init', '-q', testHome], { stdio: 'ignore' });

  const env: NodeJS.ProcessEnv = {
    ...ssoCleanEnv(),
    CODEMIE_HOME: testHome,
    ...(opts.isolateHome ? { HOME: testHome } : {}),
    ...(opts.extraEnv ?? {}),
  };

  const result = spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'bin', opts.binName), '--task', opts.prompt ?? 'Reply with only the single word READY'],
    { cwd: testHome, env, encoding: 'utf-8', timeout: opts.timeoutMs ?? 150_000 },
  );

  return { result, testHome };
}
