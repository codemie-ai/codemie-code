/**
 * Agent test T3 — catalog pricing reconciliation
 * (unify-analytics-cost-command, spec section C).
 *
 * Fetches every `enabled` model from the live CodeMie catalog (`fetchCodeMieLlmModels`, the
 * same call `claude.models.ts`/`codex-models.ts`/etc. use at runtime) and asserts each one's
 * `deployment_name` resolves through `resolvePrice()` — any non-null match against
 * `src/utils/pricing.json` (`exact`, `snapshot`, or `reordered`; see `PriceResolution['match']`
 * in `src/utils/pricing.ts`). The `reordered` match lets a version-first Claude id like
 * `claude-4-5-sonnet(-vertex)` resolve onto the table's family-first `claude-sonnet-4-5` row.
 * This is pure lookup: no agent is launched, no CLI is spawned for a session, no network call
 * happens beyond the one catalog fetch.
 *
 * The failure message lists every unresolved id so a pricing.json gap stays visible rather than
 * silently passing. Extra/unused pricing.json rows are irrelevant here — this test only checks
 * that every catalog id resolves, never that the table has no dead rows.
 *
 * Gated the same way as the sibling live-catalog test (agent-analytics-live-models.test.ts, T2):
 * skipped when no valid CodeMie SSO session is present (tests/setup/agent-build-setup.ts sets
 * SSO_AVAILABLE=false and the global setup already validated real credentials before any test
 * file runs, so no additional credential-missing handling is needed here).
 *
 * Run: npx vitest run --project agent tests/integration/agent-analytics-pricing-reconciliation.test.ts
 */

import '../setup/load-test-env.js';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { LlmModel } from '../../src/providers/plugins/sso/sso.http-client.js';
import { resolvePrice } from '../../src/utils/pricing.js';
import { getCodemieTestUrl } from '../helpers/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Fetch the live model catalog in a throwaway CHILD process, not in-process.
 *
 * The `agent` vitest project pins `CODEMIE_HOME` to a fixed per-worker temp dir (see
 * vitest.config.ts) for every test file in it. `CredentialStore`'s `CREDENTIALS_DIR` (in
 * src/utils/security.ts) is computed once, at module-load time, from that same env var — so
 * importing `CodeMieSSO`/`CredentialStore` in-process here would look for credentials under the
 * project's fake test home, not the real `~/.codemie` where the global setup
 * (tests/setup/agent-build-setup.ts) already validated them. Spawning a bare node process with
 * `CODEMIE_*` stripped gives that process a fresh, correct module load against the real home
 * instead. Mirrors agent-analytics-live-models.test.ts's `fetchLiveCatalog` (T2).
 */
function fetchLiveCatalog(codeMieUrl: string): LlmModel[] {
  const distSsoAuth = join(REPO_ROOT, 'dist', 'providers', 'plugins', 'sso', 'sso.auth.js');
  const distHttpClient = join(REPO_ROOT, 'dist', 'providers', 'plugins', 'sso', 'sso.http-client.js');
  const scriptPath = join(tmpdir(), `codemie-pricing-catalog-fetch-${process.pid}.mjs`);
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

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('agent-analytics-pricing-reconciliation (T3): catalog pricing reconciliation', () => {
  it('every enabled catalog model resolves through resolvePrice', () => {
    const codeMieUrl = getCodemieTestUrl();
    const enabledModels = fetchLiveCatalog(codeMieUrl).filter((m) => m.enabled);

    const unresolved = enabledModels
      .map((m) => m.deployment_name)
      .filter((deploymentName) => resolvePrice(deploymentName) === null);

    expect(unresolved, `Unpriced catalog models: ${unresolved.join('\n')}`).toEqual([]);
  });
});
