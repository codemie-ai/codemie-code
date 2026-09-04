# Latest Claude Models on an Anthropic Subscription Profile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On an `anthropic-subscription` profile, pass the user's `--model` through to Claude Code and actually use it, stop asking for/storing a model in setup, make `codemie models list` explain (not error) where models come from, and stop the version prompt from defaulting to a downgrade.

**Architecture:** The subscription profile keeps blanking `CODEMIE_MODEL` so the shared env pipeline is untouched. A new env var `CODEMIE_CLI_MODEL`, set only from the explicit CLI `--model`, carries the request to the subscription `enrichArgs`, which injects `--model` into the `claude` argv (dedup-guarded like `--plugin-dir`). Version-prompt and display decisions are extracted into small pure helpers so the subscription-scoped behavior is unit-testable.

**Tech Stack:** TypeScript (ESM, Node ≥20), Vitest 3.x, Commander, inquirer, chalk.

**Spec:** `docs/superpowers/tasks/2026-08-31-subscription-model-access/spec.md`

## Global Constraints

- Model choice on the subscription path is **relayed**, never validated: no entitlement logic; Claude Code owns any refusal (spec D1).
- Version-pin softening is **subscription-scoped**: only `CODEMIE_PROVIDER === 'anthropic-subscription'` changes; proxied providers keep today's `'install'` default; the minimum-version hard block is unchanged (spec D2).
- Never modify shared env plumbing: `transformEnvVars`, `ConfigLoader.exportProviderEnvVars`, `AgentCLI.collectPassThroughArgs`, or `configOnlyOptions` membership of `'model'`.
- `moonshot-subscription` must not change behavior.
- Provider constant: `ProviderName.ANTHROPIC_SUBSCRIPTION` (`'anthropic-subscription'`) from `src/providers/core/types.ts`. Use it, not a string literal, in new code.
- Imports use the `.js` extension; errors use project error classes; no `console.log` for debug (`logger.debug`). Keep comments to "why" only.

---

### Task 1: `--model` pass-through for the subscription profile (CS1 + CS2)

**Test-first:** yes — `enrichArgs` injects `['--model', <CODEMIE_CLI_MODEL>]` when the env var is set, injects nothing when unset, does not double-inject when `--model` is already present, and composes with `--plugin-dir`.

**Files:**
- Modify: `src/agents/core/AgentCLI.ts` (in `handleRun`, after the `ConfigLoader.load(...)` call, ~line 203)
- Modify: `src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts:95-105` (`agentHooks.claude.enrichArgs`)
- Test: `src/providers/plugins/anthropic-subscription/__tests__/anthropic-subscription.template.test.ts`

**Interfaces:**
- Produces: env var `CODEMIE_CLI_MODEL` (string) — set by `AgentCLI` only when `--model` was explicitly passed this launch; read by the subscription `enrichArgs` and by Task 3's banner helper.
- `enrichArgs(args: string[], _config: AgentConfig): string[]` — now also prepends `['--model', <CODEMIE_CLI_MODEL>]` when set and not already present.

- [ ] **Step 1: Write the failing tests** (append a new `describe` block to the template test)

```ts
describe('agentHooks - enrichArgs (claude) --model passthrough', () => {
  const enrich = AnthropicSubscriptionTemplate.agentHooks.claude!.enrichArgs!;
  const cfg = { agent: 'claude' } as any;

  beforeEach(() => {
    delete process.env.CODEMIE_CLI_MODEL;
    delete process.env.CODEMIE_CLAUDE_EXTENSION_DIR;
  });
  afterEach(() => {
    delete process.env.CODEMIE_CLI_MODEL;
    delete process.env.CODEMIE_CLAUDE_EXTENSION_DIR;
  });

  it('injects --model when CODEMIE_CLI_MODEL is set', () => {
    process.env.CODEMIE_CLI_MODEL = 'claude-opus-4-5';
    expect(enrich(['--task', 'hi'], cfg)).toEqual(['--model', 'claude-opus-4-5', '--task', 'hi']);
  });

  it('injects nothing when CODEMIE_CLI_MODEL is unset', () => {
    expect(enrich(['--task', 'hi'], cfg)).toEqual(['--task', 'hi']);
  });

  it('does not double-inject when --model is already present', () => {
    process.env.CODEMIE_CLI_MODEL = 'claude-opus-4-5';
    expect(enrich(['--model', 'claude-haiku-4-5'], cfg)).toEqual(['--model', 'claude-haiku-4-5']);
  });

  it('composes with the --plugin-dir injection', () => {
    process.env.CODEMIE_CLI_MODEL = 'claude-opus-4-5';
    process.env.CODEMIE_CLAUDE_EXTENSION_DIR = '/ext';
    expect(enrich(['--task', 'hi'], cfg)).toEqual(['--plugin-dir', '/ext', '--model', 'claude-opus-4-5', '--task', 'hi']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/providers/plugins/anthropic-subscription/__tests__/anthropic-subscription.template.test.ts -t "model passthrough"`
Expected: FAIL (current `enrichArgs` ignores `CODEMIE_CLI_MODEL`).

- [ ] **Step 3: Implement `enrichArgs`** — replace the body at `anthropic-subscription.template.ts:96-104`

```ts
      enrichArgs(args: string[], _config: AgentConfig): string[] {
        let result = args;

        // Carry the explicit CLI --model straight through to the claude binary.
        // Sourced from CODEMIE_CLI_MODEL (set by AgentCLI only when the user passed
        // -m/--model this launch) — never from the stored profile, so a pre-existing
        // profile's stale model is ignored. Claude Code owns entitlement/refusal.
        const cliModel = process.env.CODEMIE_CLI_MODEL;
        if (cliModel && !result.includes('--model')) {
          result = ['--model', cliModel, ...result];
        }

        const pluginDir = process.env.CODEMIE_CLAUDE_EXTENSION_DIR;
        if (pluginDir && !result.some(arg => arg === '--plugin-dir')) {
          result = ['--plugin-dir', pluginDir, ...result];
        }

        return result;
      }
```

- [ ] **Step 4: Wire `CODEMIE_CLI_MODEL` in `AgentCLI.handleRun`** — after the `const config = await ConfigLoader.load(...)` block (~line 203), add:

```ts
      // Record the explicitly-requested CLI model so the anthropic-subscription
      // provider can pass it through to Claude Code. Only set when the user passed
      // -m/--model this launch (options.model), never from the stored profile.
      if (typeof options.model === 'string' && options.model.trim() !== '') {
        process.env.CODEMIE_CLI_MODEL = options.model.trim();
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/providers/plugins/anthropic-subscription/__tests__/anthropic-subscription.template.test.ts`
Expected: PASS (new block + all existing cases).

- [ ] **Step 6: Commit**

```bash
git add src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts src/agents/core/AgentCLI.ts src/providers/plugins/anthropic-subscription/__tests__/anthropic-subscription.template.test.ts
git commit -m "feat(providers): pass subscription --model through to Claude Code"
```

---

### Task 2: Subscription-scoped version-pin default + message (CS3)

**Test-first:** yes — `newerVersionPromptDefault` returns `'continue'` for `anthropic-subscription` and `'install'` otherwise; `olderSupportedModelNote` returns the "newer models" note only for the subscription provider.

**Files:**
- Create: `src/agents/core/version-prompt-policy.ts`
- Modify: `src/agents/core/BaseAgentAdapter.ts` (Scenario 1 `isNewer` ~line 440-467; Scenario 2 `hasUpdate` ~line 484-502)
- Test: `src/agents/core/__tests__/version-prompt-policy.test.ts`

**Interfaces:**
- Produces:
  - `newerVersionPromptDefault(provider: string | undefined): 'install' | 'continue'` — `'continue'` iff `provider === ProviderName.ANTHROPIC_SUBSCRIPTION`, else `'install'`.
  - `olderSupportedModelNote(provider: string | undefined): string | null` — the "newer models may be unavailable" line for the subscription provider, else `null`.
- Consumes: `envOverrides?.CODEMIE_PROVIDER` inside `run()` (the provider is on the `envOverrides` argument passed at `AgentCLI.ts:461`).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { newerVersionPromptDefault, olderSupportedModelNote } from '../version-prompt-policy.js';

describe('version-prompt-policy', () => {
  it('defaults the newer-than-pinned prompt to continue for anthropic-subscription', () => {
    expect(newerVersionPromptDefault('anthropic-subscription')).toBe('continue');
  });
  it('keeps install as the default for proxied providers', () => {
    expect(newerVersionPromptDefault('ai-run-sso')).toBe('install');
    expect(newerVersionPromptDefault(undefined)).toBe('install');
  });
  it('returns the older-but-supported note only for anthropic-subscription', () => {
    expect(olderSupportedModelNote('anthropic-subscription')).toMatch(/newer models/i);
    expect(olderSupportedModelNote('litellm')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/agents/core/__tests__/version-prompt-policy.test.ts`
Expected: FAIL ("Cannot find module '../version-prompt-policy.js'").

- [ ] **Step 3: Implement the helper** — create `src/agents/core/version-prompt-policy.ts`

```ts
import { ProviderName } from '../../providers/core/types.js';

/**
 * A pin that would downgrade an already-installed newer binary is softened to a
 * warning that defaults to keeping what is installed — but only on the Anthropic
 * Subscription profile, whose model availability comes from the installed Claude
 * Code version. Proxied providers keep 'install' as the tested default. The
 * minimum-version block is unaffected (a separate branch).
 */
export function newerVersionPromptDefault(provider: string | undefined): 'install' | 'continue' {
  return provider === ProviderName.ANTHROPIC_SUBSCRIPTION ? 'continue' : 'install';
}

/**
 * On an older-but-supported Claude Code, tell subscription users that newer models
 * may be unavailable on that version (the update to the verified version is already
 * offered by the prompt). Returns null for providers this story does not touch.
 */
export function olderSupportedModelNote(provider: string | undefined): string | null {
  if (provider !== ProviderName.ANTHROPIC_SUBSCRIPTION) return null;
  return 'Newer models may be unavailable on this version of Claude Code.';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/agents/core/__tests__/version-prompt-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `BaseAgentAdapter.run()`** — at the top of `run()` compute the provider once (after the `supportedVersion` guard opens), e.g. `const provider = envOverrides?.CODEMIE_PROVIDER;`. Then:
  - Scenario 1 (`isNewer`, ~line 465): change `default: 'install'` to `default: newerVersionPromptDefault(provider)`.
  - Scenario 2 (`hasUpdate`, ~line 484): after the existing message lines and before the prompt, add:

```ts
        const olderNote = olderSupportedModelNote(provider);
        if (olderNote) {
          console.log(chalk.white(`   ${olderNote}`));
          console.log();
        }
```

  Add the import: `import { newerVersionPromptDefault, olderSupportedModelNote } from './version-prompt-policy.js';`. Leave Scenario 0 (`isBelowMinimum`) and Scenario 2's `default: 'install'` unchanged.

- [ ] **Step 6: Run typecheck + the policy test**

Run: `npm run typecheck && npx vitest run src/agents/core/__tests__/version-prompt-policy.test.ts`
Expected: typecheck passes; test passes.

- [ ] **Step 7: Commit**

```bash
git add src/agents/core/version-prompt-policy.ts src/agents/core/__tests__/version-prompt-policy.test.ts src/agents/core/BaseAgentAdapter.ts
git commit -m "feat(agents): stop the version prompt defaulting to a downgrade on subscription"
```

---

### Task 3: Launch banner states the model in use (CS4)

**Test-first:** yes — `resolveLaunchModelDisplay` returns the explicit CLI model on subscription, a per-session phrase (not `'unknown'`) when none, and today's `envModel || 'unknown'` for other providers.

**Files:**
- Modify: `src/agents/core/version-prompt-policy.ts` (add a display helper — colocated model-presentation policy) OR create `src/agents/core/launch-model-display.ts`
- Modify: `src/agents/core/BaseAgentAdapter.ts:564`
- Test: `src/agents/core/__tests__/launch-model-display.test.ts`

**Interfaces:**
- Produces: `resolveLaunchModelDisplay(provider: string | undefined, envModel: string | undefined, cliModel: string | undefined): string` — for the subscription provider returns `cliModel` when set, else `'chosen per session by Claude Code / your Anthropic subscription'`; for all other providers returns `envModel || 'unknown'` (today's behavior).

- [ ] **Step 1: Write the failing tests** — create `src/agents/core/__tests__/launch-model-display.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { resolveLaunchModelDisplay } from '../launch-model-display.js';

describe('resolveLaunchModelDisplay', () => {
  it('shows the explicit CLI model on the subscription profile', () => {
    expect(resolveLaunchModelDisplay('anthropic-subscription', '', 'claude-opus-4-5')).toBe('claude-opus-4-5');
  });
  it('shows a per-session phrase (not "unknown") when no CLI model on subscription', () => {
    const s = resolveLaunchModelDisplay('anthropic-subscription', '', undefined);
    expect(s).not.toBe('unknown');
    expect(s).toMatch(/Claude Code/i);
  });
  it('is unchanged for non-subscription providers', () => {
    expect(resolveLaunchModelDisplay('litellm', 'gpt-5.5', undefined)).toBe('gpt-5.5');
    expect(resolveLaunchModelDisplay('litellm', '', undefined)).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/agents/core/__tests__/launch-model-display.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — create `src/agents/core/launch-model-display.ts`

```ts
import { ProviderName } from '../../providers/core/types.js';

const SUBSCRIPTION_PER_SESSION = 'chosen per session by Claude Code / your Anthropic subscription';

/**
 * What the launch banner prints as the model. On the subscription profile the model
 * is either the explicit --model the user passed (CODEMIE_CLI_MODEL) or, absent that,
 * Claude Code's own per-session choice — never the blanked CODEMIE_MODEL, which would
 * otherwise render as 'unknown'. Other providers keep their existing behavior.
 */
export function resolveLaunchModelDisplay(
  provider: string | undefined,
  envModel: string | undefined,
  cliModel: string | undefined,
): string {
  if (provider === ProviderName.ANTHROPIC_SUBSCRIPTION) {
    return cliModel && cliModel.trim() !== '' ? cliModel : SUBSCRIPTION_PER_SESSION;
  }
  return envModel || 'unknown';
}
```

- [ ] **Step 4: Wire into the banner** — at `BaseAgentAdapter.ts:564` replace `const model = env.CODEMIE_MODEL || 'unknown';` with:

```ts
      const model = resolveLaunchModelDisplay(provider, env.CODEMIE_MODEL, process.env.CODEMIE_CLI_MODEL);
```

Add the import `import { resolveLaunchModelDisplay } from './launch-model-display.js';`. Reuse the `provider` local from `env.CODEMIE_PROVIDER` already computed at line 562.

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `npx vitest run src/agents/core/__tests__/launch-model-display.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/agents/core/launch-model-display.ts src/agents/core/__tests__/launch-model-display.test.ts src/agents/core/BaseAgentAdapter.ts
git commit -m "feat(agents): state the subscription session model in the launch banner"
```

---

### Task 4: `codemie models list` explains the subscription source (CS5)

**Test-first:** yes — `subscriptionModelsListMessage` mentions the Anthropic subscription and `/model`, and does not say "not supported".

**Files:**
- Modify: `src/cli/commands/models.ts` (add helper + a branch after `provider` resolves, ~line 66)
- Test: `src/cli/commands/__tests__/models-subscription-message.test.ts`

**Interfaces:**
- Produces: `subscriptionModelsListMessage(): string` — the informational text (single string) shown for the subscription provider.

- [ ] **Step 1: Write the failing test** — create `src/cli/commands/__tests__/models-subscription-message.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { subscriptionModelsListMessage } from '../models.js';

describe('subscriptionModelsListMessage', () => {
  it('explains models come from the Anthropic subscription and how to switch in-session', () => {
    const msg = subscriptionModelsListMessage();
    expect(msg).toMatch(/Anthropic subscription/i);
    expect(msg).toMatch(/\/model/);
    expect(msg).not.toMatch(/not supported/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/cli/commands/__tests__/models-subscription-message.test.ts`
Expected: FAIL (`subscriptionModelsListMessage` not exported).

- [ ] **Step 3: Implement** — in `src/cli/commands/models.ts` add the export near the top and a branch in the `list` action after `const provider = config.provider;` (before the `UNSUPPORTED_PROVIDERS` / `getModelProxy` checks, ~line 66):

```ts
export function subscriptionModelsListMessage(): string {
  return [
    'Models for this profile come from your Anthropic subscription and the installed Claude Code version.',
    'CodeMie does not maintain a model list for it.',
    'Run codemie-claude and use /model inside Claude Code to see or change the model for a session.',
  ].join('\n');
}
```

```ts
        if (provider === ProviderName.ANTHROPIC_SUBSCRIPTION) {
          console.log(subscriptionModelsListMessage());
          return; // exit 0 — this is informational, not an error
        }
```

Add `import { ProviderName } from '../../providers/core/types.js';` if not already imported.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/cli/commands/__tests__/models-subscription-message.test.ts`
Expected: PASS.

- [ ] **Step 5: Manual smoke (optional, non-gating)** — on a subscription profile, `node bin/codemie.js models list` prints the message and exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/models.ts src/cli/commands/__tests__/models-subscription-message.test.ts
git commit -m "feat(cli): explain subscription model source in models list instead of erroring"
```

---

### Task 5: Setup no longer prompts for or stores a model (CS6)

**Test-first:** yes — `setupModelSummaryLine` states a per-session choice (no model name) for the subscription provider and shows the model for others; the setup flow sets `selectedModel = ''` so `buildConfig` stores no model.

**Files:**
- Modify: `src/cli/commands/setup.ts` (model-selection block ~line 424-435)
- Modify: `src/providers/integration/setup-ui.ts` (`displaySetupSuccess`, line 266-274)
- Test: `src/providers/integration/__tests__/setup-success-model-line.test.ts`

**Interfaces:**
- Produces: `setupModelSummaryLine(provider: string, model: string): string` — for the subscription provider, a per-session sentence; else `` `🤖 Model: ${model}` ``.

- [ ] **Step 1: Write the failing test** — create `src/providers/integration/__tests__/setup-success-model-line.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { setupModelSummaryLine } from '../setup-ui.js';

describe('setupModelSummaryLine', () => {
  it('states per-session choice for the subscription provider (no stored model name)', () => {
    const line = setupModelSummaryLine('anthropic-subscription', '');
    expect(line).toMatch(/per session/i);
    expect(line).toMatch(/Claude Code/i);
  });
  it('shows the model for other providers', () => {
    expect(setupModelSummaryLine('litellm', 'gpt-5.5')).toContain('gpt-5.5');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/integration/__tests__/setup-success-model-line.test.ts`
Expected: FAIL (`setupModelSummaryLine` not exported).

- [ ] **Step 3: Implement the summary helper** — in `setup-ui.ts` add and use it in `displaySetupSuccess` (replace line 273):

```ts
export function setupModelSummaryLine(provider: string, model: string): string {
  if (provider === 'anthropic-subscription') {
    return '🤖 Model: chosen per session by Claude Code and your Anthropic subscription';
  }
  return `🤖 Model: ${model}`;
}
```

Replace `console.log(chalk.cyan(`🤖 Model: ${model}`));` with `console.log(chalk.cyan(setupModelSummaryLine(provider, model)));`.

- [ ] **Step 4: Skip the model prompt in setup** — in `setup.ts`, wrap the model-selection block (~424-435) so the subscription provider does not prompt or store a model:

```ts
    // Step 3: Model selection
    let selectedModel: string;
    if (providerName === ProviderName.ANTHROPIC_SUBSCRIPTION) {
      // Model is chosen per session by Claude Code + the user's Anthropic
      // subscription; storing one here would never take effect (exportEnvVars
      // blanks it) and would be shown as a stale value later.
      selectedModel = '';
    } else {
      const preselectedModel = setupSteps.selectModel
        ? await setupSteps.selectModel(credentials, models, providerTemplate)
        : undefined;
      if (preselectedModel) {
        selectedModel = preselectedModel;
        logger.success(`Model selected automatically: ${selectedModel}`);
      } else {
        selectedModel = await promptForModelSelection(models, providerTemplate);
      }
    }
```

Ensure `ProviderName` is imported in `setup.ts`. `buildConfig(credentials, '')` then stores `model: ''` (no code change to `buildConfig` needed).

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/providers/integration/__tests__/setup-success-model-line.test.ts src/providers/plugins/anthropic-subscription/__tests__/anthropic-subscription.setup-steps.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (confirm the existing setup-steps tests still pass — `buildConfig` unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/setup.ts src/providers/integration/setup-ui.ts src/providers/integration/__tests__/setup-success-model-line.test.ts
git commit -m "feat(cli): stop asking for and storing a model on subscription setup"
```

---

### Task 6: Full quality gate + regression sweep

**Files:** none (verification only)

- [ ] **Step 1: Run the unit project**

Run: `npx vitest run --project unit`
Expected: PASS, including `model-tier-e2e.test.ts` (non-subscription env pipeline regression guard) and `flag-transform-contract.test.ts`.

- [ ] **Step 2: Lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: zero warnings; clean types.

- [ ] **Step 3: Confirm scope discipline**

Run: `git diff --name-only origin/main...HEAD`
Expected: only `AgentCLI.ts`, `anthropic-subscription.template.ts`, `version-prompt-policy.ts`, `launch-model-display.ts`, `BaseAgentAdapter.ts`, `models.ts`, `setup.ts`, `setup-ui.ts`, their tests, and the task docs. **No** change to `transformEnvVars`/`exportProviderEnvVars`/`collectPassThroughArgs` or to `moonshot-subscription`.

---

## Self-Review

**Spec coverage:** CS1→Task1 (AgentCLI env var); CS2→Task1 (enrichArgs); CS3→Task2 (version policy, both scenarios); CS4→Task3 (banner); CS5→Task4 (models list); CS6→Task5 (setup prompt + summary). D1 relay (no code — verified by absence of entitlement logic); D2 subscription-scoped (Task2/3/4/5 all gate on `ProviderName.ANTHROPIC_SUBSCRIPTION`); D3 env var (Task1); D4 tests (every task). G4 (actual-model reporting) verified in spec — no task. AC "stale stored model not shown" → Task5 (`selectedModel=''`) + Task3 banner (reads CLI model, not stored). All AC groups map to a task or a verified no-op.

**Placeholder scan:** No TBD/TODO; every code step has concrete code. Copy strings are final.

**Type consistency:** Helper names are stable across tasks: `newerVersionPromptDefault`, `olderSupportedModelNote`, `resolveLaunchModelDisplay`, `subscriptionModelsListMessage`, `setupModelSummaryLine`. `CODEMIE_CLI_MODEL` is written in Task1 and read in Task1 (enrichArgs) and Task3 (banner). `ProviderName.ANTHROPIC_SUBSCRIPTION` used consistently.
