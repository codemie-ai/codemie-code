/**
 * Agent test T2 — live, tool-forcing prompt per catalog model
 * (unify-analytics-cost-command, spec section C).
 *
 * Fetches every `enabled` model from the live CodeMie catalog
 * (`fetchCodeMieLlmModels`, same call `claude.models.ts`/`codex-models.ts`/etc. use at
 * runtime), maps each one to the agent that can drive it (`claude-*` -> codemie-claude,
 * `gpt-*`/`o<digit>*`/`*codex*` -> codemie-codex, `gemini-*` -> codemie-gemini), and runs a
 * trivial tool-forcing `--task` (see `PROMPT` below — NOT a plain "hi") through
 * `runAgentTaskSmoke` for each mapped model — all against ONE shared isolated CODEMIE_HOME, so a
 * single `analytics --export json` run afterwards can see every session together. Models with no
 * compatible agent (e.g. deepseek/qwen/kimi/grok deployments) are skipped and logged, not failed.
 * A documented `EXCLUDED_MODEL_IDS` list (below) further exempts a handful of catalog ids with a
 * reproduced upstream/agent-side failure from the cost assertion, without hiding them silently.
 *
 * WHY A SHARED HOME: `runAgentTaskSmoke` normally mkdtemps a fresh CODEMIE_HOME per call.
 * `tests/helpers/agent-smoke.ts` gained an optional `testHome` passthrough (this task) so every
 * model's session lands under the same `sessions/` directory instead of an isolated one per run
 * — otherwise a single `analytics` invocation could never see them all at once.
 *
 * ISOLATION PER AGENT (mirrors the existing single-model live suites):
 *   - claude:  isolateHome=false — codemie-claude drives the real `claude` native binary, which
 *     keeps writing its own transcripts under the real ~/.claude. That's fine for cost
 *     enrichment: `correlation.agentSessionFile` is stored as an ABSOLUTE path, so the
 *     downstream `analytics` run (with CODEMIE_HOME repointed at the shared test home) still
 *     resolves it regardless of which HOME wrote it (see agent-analytics-report-shape.test.ts).
 *   - codex:   isolateHome=false — matches agent-codex.test.ts (no native binary/home needed).
 *   - gemini:  isolateHome=true + GEMINI_CLI_TRUST_WORKSPACE=true — matches agent-gemini.test.ts
 *     (keeps Gemini's settings.json out of the real ~/.gemini and satisfies its trust guard).
 *
 * RUNTIME: this drives one real agent turn per enabled catalog model (dozens at the time of
 * writing) sequentially against one shared home, then one `analytics` run. Expect this to take
 * a long time; hookTimeout below is sized generously rather than per exact catalog size.
 *
 * Gated on SSO_AVAILABLE (tests/setup/agent-build-setup.ts): skipped when no valid CodeMie SSO
 * session is present.
 *
 * Run: npx vitest run --project agent -- agent-analytics-live-models
 */

import '../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { LlmModel } from '../../src/providers/plugins/sso/sso.http-client.js';
import { canonicalizeModelId } from '../../src/utils/pricing.js';
import type { ReportPayload } from '../../src/cli/commands/analytics/report/types.js';
import {
  runAgentTaskSmoke,
  setupSsoAutotestProfile,
  teardownSsoAutotestProfile,
  getTempDir,
  getCodemieTestUrl,
} from '../helpers/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_BIN = join(REPO_ROOT, 'bin', 'codemie.js');

/**
 * Fetch the live model catalog in a throwaway CHILD process, not in-process.
 *
 * The `agent` vitest project pins `CODEMIE_HOME` to a fixed per-worker temp dir (see
 * vitest.config.ts) for every test file in it. `CredentialStore`'s `CREDENTIALS_DIR` (in
 * src/utils/security.ts) is computed once, at module-load time, from that same env var — so
 * importing `CodeMieSSO`/`CredentialStore` in-process here would look for credentials under the
 * project's fake test home, not the real `~/.codemie` where `copySsoCredentials()` (used
 * everywhere else in this file) reads them from. Spawning a bare node process with `CODEMIE_*`
 * stripped gives that process a fresh, correct module load against the real home instead.
 */
function fetchLiveCatalog(codeMieUrl: string): LlmModel[] {
  const distSsoAuth = join(REPO_ROOT, 'dist', 'providers', 'plugins', 'sso', 'sso.auth.js');
  const distHttpClient = join(REPO_ROOT, 'dist', 'providers', 'plugins', 'sso', 'sso.http-client.js');
  const scriptPath = join(tmpdir(), `codemie-catalog-fetch-${process.pid}.mjs`);
  const script = `
import { CodeMieSSO } from ${JSON.stringify(distSsoAuth)};
import { fetchCodeMieLlmModels } from ${JSON.stringify(distHttpClient)};
const url = ${JSON.stringify(codeMieUrl)};
const creds = await new CodeMieSSO().getStoredCredentials(url);
if (!creds) {
  console.error('NO_CREDENTIALS');
  process.exit(2);
}
const models = await fetchCodeMieLlmModels(creds.apiUrl, creds.cookies);
process.stdout.write(JSON.stringify(models));
`;
  writeFileSync(scriptPath, script, 'utf-8');
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CODEMIE_')) delete env[key];
    }
    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf-8', env, timeout: 30_000 });
    if (result.status !== 0) {
      throw new Error(
        `catalog fetch failed (exit ${result.status ?? 'null'}): ${result.stderr}\n` +
          `Run: codemie profile login --url ${codeMieUrl}`,
      );
    }
    return JSON.parse(result.stdout) as LlmModel[];
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

/** Upper bound per live "hi" run; actual trivial-prompt turns finish far sooner. */
const PER_MODEL_TIMEOUT_MS = 120_000;
/** Generous ceiling for the whole sequential sweep + analytics run — not sized to the exact
 *  catalog size (unknown until the beforeAll's own fetch runs), just large enough to never be
 *  the reason a genuinely slow but working sweep gets cut off. */
const SWEEP_TIMEOUT_MS = 100 * 60_000;

interface MappedModel {
  deploymentName: string;
  binName: string;
}

/** `claude-*` -> codemie-claude, `gpt-*`/`o<digit>*`/`*codex*` -> codemie-codex, `gemini-*` -> codemie-gemini. */
function mapModelToBin(deploymentName: string): string | null {
  if (/^claude-/i.test(deploymentName)) return 'codemie-claude.js';
  if (/^gpt-/i.test(deploymentName) || /^o\d/i.test(deploymentName) || /codex/i.test(deploymentName)) {
    return 'codemie-codex.js';
  }
  if (/^gemini-/i.test(deploymentName)) return 'codemie-gemini.js';
  return null;
}

/**
 * A trivial prompt that FORCES a tool call (not just a chat reply). Required because
 * CodexMetricsProcessor (src/agents/plugins/codex/session/processors/codex.metrics-processor.ts)
 * only ever emits a MetricDelta per `function_call` record — with no tool call, a codex session
 * never gets a `models` entry at all, so it can never be found by the assertion below, regardless
 * of whether the turn was priced. A plain "hi" reproducibly leaves every codex session with an
 * empty `models` array. Manually verified (2026-09-26, single-model repro outside this suite)
 * that this exact prompt makes codex run a real `ls -la` via its shell tool (2 function_call
 * records -> 2 deltas, `models` populated) and makes gemini invoke a tool too (falls back to its
 * directory-listing tool when shell execution isn't available) — both then produce a session this
 * test's matching logic can find. Claude was also re-verified with this prompt: it runs the Bash
 * tool successfully and keeps recording via its existing per-turn (not per-tool-call) metrics path.
 * Kept cheap (a trivial, local, side-effect-free directory listing) and deterministic (every
 * agent has *some* tool that can list files, so the tool call reliably happens even when a
 * specific tool, e.g. shell, is unavailable).
 */
const PROMPT =
  'List the files in the current working directory (use a tool call, e.g. run `ls` or use a ' +
  'file-listing tool) and reply with what you found.';

/**
 * Explicit, documented exclusions for catalog ids with a REPRODUCED upstream or agent-side
 * failure — never for being unpriced, and never for a session/cost gap caused by our own code
 * (those must fail this test, per the brief). Each reason states the error actually observed
 * live against CI_CODEMIE_URL; re-confirmed (or superseded) by this file's own sweep — see the
 * per-id console.log emitted below whenever an exclusion is applied, which prints what THIS run
 * actually saw for that id so a stale exclusion doesn't go unnoticed.
 */
const EXCLUDED_MODEL_IDS: Record<string, string> = {
  'gpt-5-2025-08-07':
    'upstream LiteLLM 400 "Model Group=gpt-5-2025-08-07 ... Fallbacks=None" — catalog marks it enabled but the backend cannot serve it',
  'gpt-5-mini-2025-08-07':
    'upstream LiteLLM 400 "Model Group=gpt-5-mini-2025-08-07 ... Fallbacks=None" — same upstream gap as gpt-5-2025-08-07',
  'gpt-5-nano-2025-08-07':
    'upstream LiteLLM 400 "Model Group=gpt-5-nano-2025-08-07 ... Fallbacks=None" — same upstream gap as gpt-5-2025-08-07',
  'gpt-5-1-codex-2025-11-13':
    'upstream LiteLLM 400 "Model Group=gpt-5-1-codex-2025-11-13 ... Fallbacks=None" — same upstream gap as gpt-5-2025-08-07',
  'claude-4-5-sonnet':
    'Claude Code CLI itself rejects it as `unrecognized_model` — stale/deprecated catalog entry',
  'claude-4-5-sonnet-vertex':
    'Claude Code CLI itself rejects it as `unrecognized_model` — stale/deprecated catalog entry',
  'gpt-4.1':
    'not codex-compatible per codex-models.ts COMPATIBLE_CODEX_MODEL_PATTERNS (gpt-5/6/codex only); resolveCodexModel silently substitutes a different deployment, so this id can never be exercised as itself through codex',
  'gpt-4.1-mini':
    'not codex-compatible per codex-models.ts COMPATIBLE_CODEX_MODEL_PATTERNS (gpt-5/6/codex only); resolveCodexModel silently substitutes a different deployment, so this id can never be exercised as itself through codex',
  // The four legacy "o-series" reasoning models: same COMPATIBLE_CODEX_MODEL_PATTERNS gap as
  // gpt-4.1/gpt-4.1-mini (none match /codex/i, ^gpt-5, ^gpt-6, or the router-alias pattern) —
  // confirmed live: each ran to exit 0 with a coherent reply but produced no session matching
  // its own id (resolveCodexModel substitutes a compatible deployment instead).
  'o3-mini':
    'not codex-compatible per codex-models.ts COMPATIBLE_CODEX_MODEL_PATTERNS (gpt-5/6/codex only); resolveCodexModel silently substitutes a different deployment, so this id can never be exercised as itself through codex',
  'o1':
    'not codex-compatible per codex-models.ts COMPATIBLE_CODEX_MODEL_PATTERNS (gpt-5/6/codex only); resolveCodexModel silently substitutes a different deployment, so this id can never be exercised as itself through codex',
  'o3-2025-04-16':
    'not codex-compatible per codex-models.ts COMPATIBLE_CODEX_MODEL_PATTERNS (gpt-5/6/codex only); resolveCodexModel silently substitutes a different deployment, so this id can never be exercised as itself through codex',
  'o4-mini-2025-04-16':
    'not codex-compatible per codex-models.ts COMPATIBLE_CODEX_MODEL_PATTERNS (gpt-5/6/codex only); resolveCodexModel silently substitutes a different deployment, so this id can never be exercised as itself through codex',
  'gemini-3-flash':
    'live-verified 2026-09-26: gemini forwards this deployment id verbatim (gemini.models.ts — no fuzzy resolution in this codebase), but the resulting native session transcript records the served model as gemini-3.5-flash, not gemini-3-flash; the CodeMie/upstream backend routes this deployment to a different served model, so the catalog id can never be exercised/matched as itself',
  'gemini-3.6-flash':
    'live-verified 2026-09-26: same backend routing as gemini-3-flash — session transcript records gemini-3.5-flash',
  'gemini-3.7-flash':
    'live-verified 2026-09-26: same backend routing as gemini-3-flash — session transcript records gemini-3.5-flash',
  'gemini-3.8-flash':
    'live-verified 2026-09-26: same backend routing as gemini-3-flash — session transcript records gemini-3.5-flash',
};

/** One trailing snapshot suffix (date/latest/preview), same shape pricing.ts's resolvePrice()
 *  tolerates — a model requested bare may come back from the backend with (or without) it. */
const SNAPSHOT_SUFFIX_PATTERN = /-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest|preview)$/;

/** True when `observed` (a session's recorded model) and `requested` (the catalog deployment we
 *  asked for) canonicalize to the same id, exactly or after stripping one snapshot suffix from
 *  either side. */
function canonicalModelMatches(observed: string, requested: string): boolean {
  const obs = canonicalizeModelId(observed);
  const req = canonicalizeModelId(requested);
  if (obs === req) return true;
  return obs.replace(SNAPSHOT_SUFFIX_PATTERN, '') === req.replace(SNAPSHOT_SUFFIX_PATTERN, '');
}

/** Drive the built `codemie analytics` CLI (no TTY) against the shared isolated home. */
function runAnalytics(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEMIE_')) delete env[key];
  }
  env.HOME = home;
  env.DO_NOT_TRACK = '1';
  env.CI = '1';
  env.CODEMIE_HOME = home;
  env.CODEMIE_SKIP_UPDATE_CHECK = 'true';

  const result = spawnSync(process.execPath, [CLI_BIN, 'analytics', ...args], {
    cwd: home,
    env,
    encoding: 'utf-8',
    timeout: PER_MODEL_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });

  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('agent-analytics-live-models (T2): live tool-forcing prompt per catalog model', () => {
  let originalActiveProfile: string | undefined;
  let sharedHome: string;
  let mappedModels: MappedModel[] = [];
  let skippedModelIds: string[] = [];
  const runsByModel = new Map<string, SpawnSyncReturns<string>>();
  let payload: ReportPayload;

  beforeAll(async () => {
    originalActiveProfile = setupSsoAutotestProfile();
    sharedHome = mkdtempSync(join(getTempDir(), 'codemie-analytics-live-'));

    // ── Fetch the live catalog and partition into mapped/skipped ──────────────────────
    const codeMieUrl = getCodemieTestUrl();
    const allModels = fetchLiveCatalog(codeMieUrl);
    const enabledModels = allModels.filter((m) => m.enabled);

    for (const model of enabledModels) {
      const binName = mapModelToBin(model.deployment_name);
      if (binName) {
        mappedModels.push({ deploymentName: model.deployment_name, binName });
      } else {
        skippedModelIds.push(model.deployment_name);
      }
    }

    console.log(
      `[agent-analytics-live-models] ${mappedModels.length} mapped, ${skippedModelIds.length} skipped ` +
        `(no compatible agent): ${skippedModelIds.join(', ') || 'none'}`,
    );

    // ── Run the tool-forcing PROMPT through the mapped agent for every model, into the SAME shared home ──
    for (const { deploymentName, binName } of mappedModels) {
      const isGemini = binName === 'codemie-gemini.js';
      const run = runAgentTaskSmoke({
        binName,
        model: deploymentName,
        prompt: PROMPT,
        testHome: sharedHome,
        isolateHome: isGemini,
        ...(isGemini ? { extraEnv: { GEMINI_CLI_TRUST_WORKSPACE: 'true' } } : {}),
        timeoutMs: PER_MODEL_TIMEOUT_MS,
      });
      runsByModel.set(deploymentName, run.result);
    }

    // ── One analytics run over every session just produced ────────────────────────────
    const outPath = join(sharedHome, 'live.json');
    const res = runAnalytics(sharedHome, ['--export', 'json', '-o', outPath]);
    expect(res.status, `analytics run failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
    payload = JSON.parse(readFileSync(outPath, 'utf-8')) as ReportPayload;
  }, SWEEP_TIMEOUT_MS);

  afterAll(() => {
    teardownSsoAutotestProfile(originalActiveProfile);
    if (sharedHome) rmSync(sharedHome, { recursive: true, force: true });
  });

  it('every mapped, non-excluded model has a costed session (present, costUSD > 0, not hadLog with zero cost)', () => {
    const failures: string[] = [];
    const excludedApplied: string[] = [];
    for (const { deploymentName } of mappedModels) {
      const run = runsByModel.get(deploymentName);
      const session = payload.sessions.find((s) => s.models.some((m) => canonicalModelMatches(m, deploymentName)));

      let problem: string | null = null;
      if (!session) {
        problem =
          `${deploymentName}: no matching session found ` +
          `(run exit=${run?.status ?? 'n/a'}, stderr tail: ${(run?.stderr ?? '').slice(-300)})`;
      } else if (!(session.costUSD > 0)) {
        problem = `${deploymentName}: session ${session.sessionId} costUSD=${session.costUSD} (hadLog=${session.hadLog})`;
      } else if (session.hadLog && session.costUSD === 0) {
        problem = `${deploymentName}: session ${session.sessionId} has a log but costUSD is 0`;
      }

      const exclusionReason = EXCLUDED_MODEL_IDS[deploymentName];
      if (exclusionReason) {
        // Logged every time the exclusion is applied (not a silent skip) — including what THIS
        // run actually observed, so a since-fixed upstream/agent issue doesn't hide forever.
        console.log(
          `[agent-analytics-live-models] EXCLUDED ${deploymentName}: ${exclusionReason}\n` +
            `  this run observed: ${problem ?? 'no problem — session found and costed cleanly'}`,
        );
        excludedApplied.push(deploymentName);
        continue;
      }

      if (problem) failures.push(problem);
    }
    console.log(
      `[agent-analytics-live-models] ${excludedApplied.length} model(s) excluded via EXCLUDED_MODEL_IDS: ` +
        `${excludedApplied.join(', ') || 'none'}`,
    );
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('meta.unpricedModels is empty', () => {
    expect(payload.meta.unpricedModels).toEqual([]);
  });
});
