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
import { resolvePrice } from '../../src/utils/pricing.js';
import { fetchLiveCatalog, getCodemieTestUrl, isImageOnlyModel } from '../helpers/index.js';
import { isRouterModel } from '../../src/utils/model-family.js';

describe.runIf(process.env.SSO_AVAILABLE !== 'false')('agent-analytics-pricing-reconciliation (T3): catalog pricing reconciliation', () => {
  it('every enabled catalog model resolves through resolvePrice', () => {
    const codeMieUrl = getCodemieTestUrl();
    const enabledModels = fetchLiveCatalog(codeMieUrl, 'pricing-catalog-fetch').filter((m) => m.enabled && !isRouterModel(m) && !isImageOnlyModel(m));

    const unresolved = enabledModels
      .map((m) => m.deployment_name)
      .filter((deploymentName) => resolvePrice(deploymentName) === null);

    expect(unresolved, `Unpriced catalog models: ${unresolved.join('\n')}`).toEqual([]);
  });
});
