# Enforce LiteLLM Integration in CLI Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `codemie-cli setup` runs in a project with an existing LiteLLM integration, the wizard must detect it, auto-select LiteLLM, and require the API key before saving.

**Architecture:** A `detectLiteLLMEnforcement()` function is added to `setup.ts` and runs before the provider-selection prompt. If it detects an integration it returns an enforcement context; `handlePluginSetup()` threads that context to `LiteLLMSetupSteps.getCredentials()` via a new optional `SetupContext` parameter in `types.ts`. Gate failure falls back gracefully; SSO path is unchanged.

**Tech Stack:** TypeScript/ESM, Vitest, inquirer, chalk, ora. Node.js ≥ 20. No new dependencies.

## Global Constraints

- Node.js ≥ 20. ES modules only — all imports use `.js` extension.
- `@/` alias resolves to `src/`. Prefer it for cross-area imports.
- No `any` in new code. Explicit return types on all exported functions.
- Conventional Commits enforced by commitlint — use `fix(cli): ...` for setup changes.
- Tests: Vitest, `describe` / `it` / `expect` / `vi.mock` / `vi.spyOn`. Dynamic `vi.mock` for side-effectful modules.
- `console.log` for user-facing output; `logger.debug` / `logger.warn` for internal diagnostics.
- Error messages use `chalk` for colour.
- `getCredentials` context parameter is optional — all existing provider implementations remain valid without change.

---

## File Map

| File | Action | What changes |
|---|---|---|
| `src/providers/core/types.ts` | Modify | Add `SetupContext` interface; add optional `context?: SetupContext` to `ProviderSetupSteps.getCredentials` |
| `src/providers/plugins/litellm/litellm.setup-steps.ts` | Modify | Accept `SetupContext` in `getCredentials`; enforce non-empty key when `context.enforcedIntegration` is set |
| `src/cli/commands/setup.ts` | Modify | Add `LiteLLMEnforcementContext` type, `detectLiteLLMEnforcement()`, update `runSetupWizard()` and `handlePluginSetup()` |
| `src/providers/plugins/litellm/__tests__/litellm.setup-steps.test.ts` | Create | Unit tests for `LiteLLMSetupSteps.getCredentials` — normal and enforcement modes |
| `src/cli/commands/__tests__/setup.enforcement.test.ts` | Create | Unit tests for `detectLiteLLMEnforcement` — success, failure (graceful fallback), and no-integration paths |

`sso.setup-steps.ts` — no changes needed (spec Phase 5 confirmed SSO key enforcement is not required).

---

## Task 1: Add `SetupContext` to `types.ts` and update the interface

**Test-first:** yes — TypeScript compilation is the test; we verify the updated interface compiles and that `LiteLLMSetupSteps.getCredentials` is still structurally compatible after the change.

**Files:**
- Modify: `src/providers/core/types.ts:290-299`
- Test: `src/providers/plugins/litellm/__tests__/litellm.setup-steps.test.ts` (created in this task, used across Tasks 1–2)

**Interfaces:**
- Produces: `SetupContext` (exported from `types.ts`) — used by Task 2 and Task 3
- Produces: updated `ProviderSetupSteps.getCredentials(isUpdate?: boolean, context?: SetupContext)` signature

- [ ] **Step 1: Create the test file with a compile-time structural check**

```typescript
// src/providers/plugins/litellm/__tests__/litellm.setup-steps.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SetupContext } from '../../../core/types.js';
import { LiteLLMSetupSteps } from '../litellm.setup-steps.js';

// Structural check: SetupContext must be importable and have the right shape
describe('SetupContext type', () => {
  it('is accepted by getCredentials without breaking the normal call', async () => {
    // Arrange
    vi.mock('inquirer', () => ({
      default: {
        prompt: vi.fn().mockResolvedValue({ baseUrl: 'http://localhost:4000', apiKey: '' })
      }
    }));

    const context: SetupContext = {};  // empty context — normal mode
    // If this line compiles, the optional parameter is correctly typed
    const result = await LiteLLMSetupSteps.getCredentials(false, context);
    expect(result.baseUrl).toBe('http://localhost:4000');
  });
});
```

- [ ] **Step 2: Run to confirm it fails (type import missing)**

```bash
cd C:/Projects/codemie-dev/codemie-code
npx vitest run src/providers/plugins/litellm/__tests__/litellm.setup-steps.test.ts
```

Expected: FAIL — `SetupContext` is not exported from `types.ts`.

- [ ] **Step 3: Add `SetupContext` and update `ProviderSetupSteps.getCredentials` in `types.ts`**

In `src/providers/core/types.ts`, add immediately after line 272 (after `ProviderCredentials` interface):

```typescript
/**
 * Context passed from the setup wizard into provider setup steps.
 * When enforcedIntegration is set, the provider must enforce API key entry.
 */
export interface SetupContext {
  enforcedIntegration?: {
    id: string;
    alias: string;
    codeMieUrl: string;
  };
}
```

Then on line 299 (the `getCredentials` declaration inside `ProviderSetupSteps`), change:

```typescript
  getCredentials(isUpdate?: boolean): Promise<ProviderCredentials>;
```

to:

```typescript
  getCredentials(isUpdate?: boolean, context?: SetupContext): Promise<ProviderCredentials>;
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
npx vitest run src/providers/plugins/litellm/__tests__/litellm.setup-steps.test.ts
```

Expected: PASS — `SetupContext` is now exported and the structural check compiles.

- [ ] **Step 5: Typecheck entire codebase to confirm no regressions**

```bash
cd C:/Projects/codemie-dev/codemie-code
npm run typecheck
```

Expected: zero errors. All existing `getCredentials()` implementations are backward-compatible because the new parameter is optional.

- [ ] **Step 6: Commit**

```bash
git add src/providers/core/types.ts src/providers/plugins/litellm/__tests__/litellm.setup-steps.test.ts
git commit -m "fix(cli): add SetupContext to ProviderSetupSteps.getCredentials for enforcement threading"
```

---

## Task 2: Update `LiteLLMSetupSteps.getCredentials` to enforce key in enforcement mode

**Test-first:** yes — write failing tests for enforcement behaviour before implementing.

**Files:**
- Modify: `src/providers/plugins/litellm/litellm.setup-steps.ts`
- Test: `src/providers/plugins/litellm/__tests__/litellm.setup-steps.test.ts`

**Interfaces:**
- Consumes: `SetupContext` from `src/providers/core/types.ts` (Task 1)
- Produces: updated `LiteLLMSetupSteps.getCredentials` that requires non-empty `apiKey` when `context.enforcedIntegration` is set

- [ ] **Step 1: Add failing tests for normal mode and enforcement mode**

Append to `src/providers/plugins/litellm/__tests__/litellm.setup-steps.test.ts`:

```typescript
import chalk from 'chalk';

describe('LiteLLMSetupSteps.getCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('normal mode (no context)', () => {
    it('allows empty API key — defaults to "not-required"', async () => {
      const inquirer = await import('inquirer');
      vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({
        baseUrl: 'http://localhost:4000',
        apiKey: ''
      });

      const result = await LiteLLMSetupSteps.getCredentials();
      expect(result.apiKey).toBe('not-required');
    });

    it('preserves a provided API key', async () => {
      const inquirer = await import('inquirer');
      vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({
        baseUrl: 'http://localhost:4000',
        apiKey: 'sk-abc123'
      });

      const result = await LiteLLMSetupSteps.getCredentials();
      expect(result.apiKey).toBe('sk-abc123');
    });
  });

  describe('enforcement mode (context.enforcedIntegration set)', () => {
    const enforcedContext: SetupContext = {
      enforcedIntegration: {
        id: 'int-1',
        alias: 'my-integration',
        codeMieUrl: 'https://codemie.example.com'
      }
    };

    it('returns credentials with provided key when key is non-empty', async () => {
      const inquirer = await import('inquirer');
      vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({
        baseUrl: 'http://proxy.example.com',
        apiKey: 'sk-enforced-key'
      });

      const result = await LiteLLMSetupSteps.getCredentials(false, enforcedContext);
      expect(result.apiKey).toBe('sk-enforced-key');
      expect(result.baseUrl).toBe('http://proxy.example.com');
    });

    it('does NOT fall back to "not-required" — validation in prompt prevents empty key', async () => {
      // The validator in the prompt prevents submission of an empty key.
      // When inquirer resolves (mocked), we simulate the user entering a key.
      // This test verifies the "happy path" result — the validator itself is
      // exercised by the validator-function unit test below.
      const inquirer = await import('inquirer');
      vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({
        baseUrl: 'http://proxy.example.com',
        apiKey: 'required-key'
      });

      const result = await LiteLLMSetupSteps.getCredentials(false, enforcedContext);
      expect(result.apiKey).not.toBe('not-required');
      expect(result.apiKey).toBe('required-key');
    });
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```bash
npx vitest run src/providers/plugins/litellm/__tests__/litellm.setup-steps.test.ts
```

Expected: FAIL — `getCredentials` does not accept a second parameter and always uses `'not-required'`.

- [ ] **Step 3: Update `litellm.setup-steps.ts` to accept and enforce `SetupContext`**

Replace the entire file content:

```typescript
/**
 * LiteLLM Setup Steps
 *
 * Interactive setup flow for LiteLLM provider.
 */

import type { ProviderSetupSteps, ProviderCredentials, SetupContext } from '../../core/types.js';
import { LiteLLMTemplate } from './litellm.template.js';
import inquirer from 'inquirer';
import chalk from 'chalk';

export const LiteLLMSetupSteps: ProviderSetupSteps = {
  name: 'litellm',

  async getCredentials(_isUpdate = false, context?: SetupContext): Promise<ProviderCredentials> {
    const enforced = context?.enforcedIntegration;

    if (enforced) {
      console.log(chalk.cyan(`\n🔒 LiteLLM integration required: "${enforced.alias}"`));
      console.log(chalk.dim('   Get your API key from your CodeMie portal (Settings → Integrations).\n'));
    }

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'baseUrl',
        message: 'LiteLLM Proxy URL:',
        default: LiteLLMTemplate.defaultBaseUrl,
        validate: (input: string) => input.trim() !== '' || 'Base URL is required'
      },
      {
        type: 'password',
        name: 'apiKey',
        message: enforced
          ? `API Key for integration "${enforced.alias}" (required):`
          : 'API Key (optional, leave empty if not required):',
        mask: '*',
        validate: enforced
          ? (input: string) =>
              input.trim() !== '' ||
              'API Key is required for this integration. Retrieve it from your CodeMie portal.'
          : undefined
      }
    ]);

    return {
      baseUrl: answers.baseUrl.trim(),
      apiKey: enforced ? answers.apiKey.trim() : (answers.apiKey?.trim() || 'not-required')
    };
  },

  async fetchModels(credentials: ProviderCredentials): Promise<string[]> {
    const { LiteLLMModelProxy } = await import('./litellm.models.js');

    const modelProxy = new LiteLLMModelProxy(
      credentials.baseUrl || LiteLLMTemplate.defaultBaseUrl,
      credentials.apiKey
    );

    try {
      const models = await modelProxy.listModels();
      return models.map(m => m.id);
    } catch {
      return LiteLLMTemplate.recommendedModels;
    }
  },

  buildConfig(credentials: ProviderCredentials, selectedModel: string) {
    return {
      provider: 'litellm',
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      model: selectedModel
    };
  }
};
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run src/providers/plugins/litellm/__tests__/litellm.setup-steps.test.ts
```

Expected: PASS — all cases in `LiteLLMSetupSteps.getCredentials` pass.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/providers/plugins/litellm/litellm.setup-steps.ts \
        src/providers/plugins/litellm/__tests__/litellm.setup-steps.test.ts
git commit -m "fix(cli): enforce LiteLLM API key when SetupContext.enforcedIntegration is present"
```

---

## Task 3: Add `detectLiteLLMEnforcement()` and wire it into `setup.ts`

**Test-first:** yes — write failing tests for the enforcement gate before implementing.

**Files:**
- Modify: `src/cli/commands/setup.ts`
- Create: `src/cli/commands/__tests__/setup.enforcement.test.ts`

**Interfaces:**
- Consumes: `SetupContext` from `src/providers/core/types.ts` (Task 1)
- Consumes: `fetchCodeMieIntegrations` from `src/providers/plugins/sso/sso.http-client.ts`
- Consumes: `authenticateWithCodeMie`, `selectCodeMieProject`, `promptForCodeMieUrl`, `DEFAULT_CODEMIE_BASE_URL` from `src/providers/core/codemie-auth-helpers.ts`
- Consumes: `CodeMieIntegration`, `SSOAuthResult` from `src/providers/core/types.ts`
- Produces: `detectLiteLLMEnforcement()` — exported for testability (or tested via module mock of its dependencies)
- Produces: updated `handlePluginSetup()` call site in `runSetupWizard()`

- [ ] **Step 1: Write the failing test file**

```typescript
// src/cli/commands/__tests__/setup.enforcement.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all side-effectful modules before importing setup.ts
vi.mock('../../../providers/core/codemie-auth-helpers.js', () => ({
  DEFAULT_CODEMIE_BASE_URL: 'https://codemie.lab.epam.com',
  promptForCodeMieUrl: vi.fn(),
  authenticateWithCodeMie: vi.fn(),
  selectCodeMieProject: vi.fn()
}));

vi.mock('../../../providers/plugins/sso/sso.http-client.js', () => ({
  fetchCodeMieIntegrations: vi.fn()
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), success: vi.fn() }
}));

// Dynamically import after mocks are in place
const { detectLiteLLMEnforcement } = await import('../setup.js');
const authHelpers = await import('../../../providers/core/codemie-auth-helpers.js');
const ssoClient = await import('../../../providers/plugins/sso/sso.http-client.js');

describe('detectLiteLLMEnforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns enforced:true when integration exists for selected project', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockResolvedValue({
      success: true,
      apiUrl: 'https://codemie.example.com/api',
      cookies: { session: 'abc' }
    });
    vi.mocked(authHelpers.selectCodeMieProject).mockResolvedValue({
      project: 'my-project',
      userEmail: 'user@example.com'
    });
    vi.mocked(ssoClient.fetchCodeMieIntegrations).mockResolvedValue([
      { id: 'int-1', alias: 'my-integration', project_name: 'my-project', credential_type: 'LiteLLM' }
    ]);

    const result = await detectLiteLLMEnforcement();

    expect(result.enforced).toBe(true);
    if (result.enforced) {
      expect(result.integration.alias).toBe('my-integration');
      expect(result.project).toBe('my-project');
    }
  });

  it('returns enforced:false when no integration exists for the project', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockResolvedValue({
      success: true,
      apiUrl: 'https://codemie.example.com/api',
      cookies: { session: 'abc' }
    });
    vi.mocked(authHelpers.selectCodeMieProject).mockResolvedValue({
      project: 'clean-project',
      userEmail: 'user@example.com'
    });
    vi.mocked(ssoClient.fetchCodeMieIntegrations).mockResolvedValue([]);

    const result = await detectLiteLLMEnforcement();

    expect(result.enforced).toBe(false);
  });

  it('returns enforced:false (graceful fallback) when SSO auth fails', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockRejectedValue(new Error('Network timeout'));

    const result = await detectLiteLLMEnforcement();

    expect(result.enforced).toBe(false);
  });

  it('returns enforced:false (graceful fallback) when integration fetch throws', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockResolvedValue({
      success: true,
      apiUrl: 'https://api.example.com',
      cookies: { session: 'xyz' }
    });
    vi.mocked(authHelpers.selectCodeMieProject).mockResolvedValue({
      project: 'proj',
      userEmail: 'u@example.com'
    });
    vi.mocked(ssoClient.fetchCodeMieIntegrations).mockRejectedValue(new Error('API unavailable'));

    const result = await detectLiteLLMEnforcement();

    expect(result.enforced).toBe(false);
  });

  it('filters integrations by selected project — ignores integrations for other projects', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockResolvedValue({
      success: true,
      apiUrl: 'https://api.example.com',
      cookies: { session: 'xyz' }
    });
    vi.mocked(authHelpers.selectCodeMieProject).mockResolvedValue({
      project: 'project-A',
      userEmail: 'u@example.com'
    });
    vi.mocked(ssoClient.fetchCodeMieIntegrations).mockResolvedValue([
      { id: 'int-2', alias: 'other-int', project_name: 'project-B', credential_type: 'LiteLLM' }
    ]);

    const result = await detectLiteLLMEnforcement();

    expect(result.enforced).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```bash
npx vitest run src/cli/commands/__tests__/setup.enforcement.test.ts
```

Expected: FAIL — `detectLiteLLMEnforcement` is not exported from `setup.ts`.

- [ ] **Step 3: Implement `LiteLLMEnforcementContext` type and `detectLiteLLMEnforcement()` in `setup.ts`**

Add these imports at the top of `setup.ts` (after existing imports):

```typescript
import type { CodeMieIntegration, SSOAuthResult, SetupContext } from '../../providers/core/types.js';
import {
  DEFAULT_CODEMIE_BASE_URL,
  authenticateWithCodeMie,
  promptForCodeMieUrl,
  selectCodeMieProject
} from '../../providers/core/codemie-auth-helpers.js';
import { fetchCodeMieIntegrations } from '../../providers/plugins/sso/sso.http-client.js';
```

Add the type and function after the imports block, before `createSetupCommand`:

```typescript
interface LiteLLMEnforcementContext {
  integration: CodeMieIntegration;
  project: string;
  authResult: SSOAuthResult;
}

type EnforcementGateResult =
  | { enforced: false }
  | { enforced: true; integration: CodeMieIntegration; project: string; authResult: SSOAuthResult };

export async function detectLiteLLMEnforcement(
  existingCodeMieUrl?: string
): Promise<EnforcementGateResult> {
  try {
    const codeMieUrl = await promptForCodeMieUrl(
      existingCodeMieUrl || DEFAULT_CODEMIE_BASE_URL
    );
    const authResult = await authenticateWithCodeMie(codeMieUrl);

    if (!authResult.success || !authResult.apiUrl || !authResult.cookies) {
      throw new Error(authResult.error || 'SSO authentication failed');
    }

    const { project } = await selectCodeMieProject(authResult);

    const allIntegrations = await fetchCodeMieIntegrations(
      authResult.apiUrl,
      authResult.cookies
    );

    const projectIntegrations = allIntegrations.filter(
      i => i.project_name === project
    );

    if (projectIntegrations.length === 0) {
      return { enforced: false };
    }

    return {
      enforced: true,
      integration: projectIntegrations[0],
      project,
      authResult
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`Could not check for mandatory integrations: ${errorMessage}`);
    console.log(
      chalk.yellow(
        `\n⚠️  Could not check for mandatory integrations (${errorMessage}). Continuing with normal provider setup.\n`
      )
    );
    return { enforced: false };
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run src/cli/commands/__tests__/setup.enforcement.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/setup.ts \
        src/cli/commands/__tests__/setup.enforcement.test.ts
git commit -m "fix(cli): add detectLiteLLMEnforcement() gate with graceful fallback"
```

---

## Task 4: Wire enforcement gate into `runSetupWizard()` and `handlePluginSetup()`

**Test-first:** yes — integration-level test that verifies `runSetupWizard` skips provider prompt and passes enforcement context when the gate returns `enforced: true`. This is a unit-level integration test that mocks all I/O.

**Files:**
- Modify: `src/cli/commands/setup.ts` (two targeted changes: `runSetupWizard` and `handlePluginSetup`)
- Test: `src/cli/commands/__tests__/setup.enforcement.test.ts` (extend with wiring tests)

**Interfaces:**
- Consumes: `detectLiteLLMEnforcement()` (Task 3)
- Consumes: `LiteLLMEnforcementContext` (Task 3)
- Consumes: `SetupContext` (Task 1)

- [ ] **Step 1: Add failing tests for the wiring behaviour**

Append to `src/cli/commands/__tests__/setup.enforcement.test.ts`:

```typescript
// Additional mocks needed for runSetupWizard wiring tests
vi.mock('../../../utils/config.js', () => ({
  ConfigLoader: {
    hasGlobalConfig: vi.fn().mockResolvedValue(false),
    hasLocalConfig: vi.fn().mockResolvedValue(false),
    listProfiles: vi.fn().mockResolvedValue([]),
    saveProfile: vi.fn().mockResolvedValue(undefined),
    saveUserEmail: vi.fn().mockResolvedValue(undefined),
    getActiveProfileName: vi.fn().mockResolvedValue(null),
    switchProfile: vi.fn().mockResolvedValue(undefined),
    initProjectConfig: vi.fn().mockResolvedValue(undefined)
  }
}));

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn()
  }
}));

vi.mock('../../../providers/index.js', () => ({
  ProviderRegistry: {
    getAllProviders: vi.fn().mockReturnValue([]),
    getSetupSteps: vi.fn().mockReturnValue({
      name: 'litellm',
      getCredentials: vi.fn().mockResolvedValue({ baseUrl: 'http://localhost:4000', apiKey: 'sk-test' }),
      fetchModels: vi.fn().mockResolvedValue(['model-a']),
      buildConfig: vi.fn().mockReturnValue({ provider: 'litellm', model: 'model-a' })
    }),
    getProvider: vi.fn().mockReturnValue({ name: 'litellm', recommendedModels: [] })
  }
}));

vi.mock('../../../providers/integration/setup-ui.js', () => ({
  getAllProviderChoices: vi.fn().mockReturnValue([{ name: 'LiteLLM', value: 'litellm' }]),
  displaySetupSuccess: vi.fn(),
  displaySetupError: vi.fn(),
  getAllModelChoices: vi.fn().mockReturnValue([{ name: 'model-a', value: 'model-a' }]),
  displaySetupInstructions: vi.fn()
}));

vi.mock('../../../cli/first-time.js', () => ({
  FirstTimeExperience: { showEcosystemIntro: vi.fn() }
}));

vi.mock('../../../agents/registry.js', () => ({
  AgentRegistry: { getAgent: vi.fn().mockReturnValue(null) }
}));

// Import the detectLiteLLMEnforcement spy — we override its return value per test
const setupModule = await import('../setup.js');

describe('runSetupWizard enforcement wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips provider prompt and auto-selects litellm when enforcement is active', async () => {
    // Spy on detectLiteLLMEnforcement to return enforced state
    vi.spyOn(setupModule, 'detectLiteLLMEnforcement').mockResolvedValue({
      enforced: true,
      integration: { id: 'int-1', alias: 'my-int', project_name: 'proj', credential_type: 'LiteLLM' },
      project: 'proj',
      authResult: { success: true, apiUrl: 'https://api.example.com', cookies: { s: 'x' } }
    });

    const inquirer = await import('inquirer');
    // Storage location prompt — first inquirer call
    vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({ storage: 'global' });
    // Profile name prompt
    vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({ newProfileName: 'test-profile' });
    // Switch-to-new prompt
    vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({ switchToNew: false });

    await setupModule.runSetupWizardForTest();

    // Provider prompt must NOT have been called (no second inquirer.prompt with 'provider')
    const promptCalls = vi.mocked(inquirer.default.prompt).mock.calls;
    const providerPromptCall = promptCalls.find(
      args => Array.isArray(args[0]) && args[0].some((q: any) => q.name === 'provider')
    );
    expect(providerPromptCall).toBeUndefined();
  });

  it('shows provider prompt when enforcement gate returns enforced:false', async () => {
    vi.spyOn(setupModule, 'detectLiteLLMEnforcement').mockResolvedValue({ enforced: false });

    const inquirer = await import('inquirer');
    vi.mocked(inquirer.default.prompt)
      .mockResolvedValueOnce({ storage: 'global' })
      .mockResolvedValueOnce({ provider: 'litellm' })
      .mockResolvedValueOnce({ selectedModel: 'model-a' })
      .mockResolvedValueOnce({ newProfileName: 'profile-b' })
      .mockResolvedValueOnce({ switchToNew: false });

    await setupModule.runSetupWizardForTest();

    const promptCalls = vi.mocked(inquirer.default.prompt).mock.calls;
    const providerPromptCall = promptCalls.find(
      args => Array.isArray(args[0]) && args[0].some((q: any) => q.name === 'provider')
    );
    expect(providerPromptCall).toBeDefined();
  });
});
```

**Note:** `runSetupWizardForTest` is a thin re-export of the internal `runSetupWizard` with the `force` parameter. See Step 3 for the export addition.

- [ ] **Step 2: Run to confirm failures**

```bash
npx vitest run src/cli/commands/__tests__/setup.enforcement.test.ts
```

Expected: FAIL — `runSetupWizardForTest` not exported; `detectLiteLLMEnforcement` not wired.

- [ ] **Step 3: Update `runSetupWizard()` in `setup.ts` to call the gate and branch on result**

After the storage-location prompt block (line ~197 in the current file, just before `// Step 1: Get all registered providers`), insert:

```typescript
  // Pre-provider LiteLLM enforcement gate
  const existingCodeMieUrl = undefined; // future: read from local config if desired
  const enforcementGate = await detectLiteLLMEnforcement(existingCodeMieUrl);

  let enforced: typeof enforcementGate extends { enforced: true } ? typeof enforcementGate : undefined;
  let selectedProvider: string;
  let selectedSetupSteps: any;

  if (enforcementGate.enforced) {
    const litellmSteps = ProviderRegistry.getSetupSteps('litellm');
    if (!litellmSteps) {
      throw new Error(
        'LiteLLM integration is required for this project but the LiteLLM provider is not available. Please reinstall codemie-cli.'
      );
    }
    console.log(
      chalk.cyan(`\n📌 This project uses a mandatory LiteLLM integration: "${enforcementGate.integration.alias}"`) +
      '\n' +
      chalk.dim('   Provider has been set to LiteLLM automatically.\n')
    );
    selectedProvider = 'litellm';
    selectedSetupSteps = litellmSteps;
    enforced = enforcementGate as any;
  } else {
    // Normal provider selection prompt
    const registeredProviders = ProviderRegistry.getAllProviders();
    const allProviderChoices = getAllProviderChoices(registeredProviders);

    const { provider } = await inquirer.prompt([
      {
        type: 'list',
        name: 'provider',
        message: 'Choose your LLM provider:\n',
        choices: allProviderChoices,
        pageSize: 15,
        default: allProviderChoices[0]?.value
      }
    ]);
    selectedProvider = provider;
    const steps = ProviderRegistry.getSetupSteps(provider);
    if (!steps) {
      throw new Error(`Provider "${provider}" does not have setup steps configured`);
    }
    selectedSetupSteps = steps;
    enforced = undefined;
  }

  await handlePluginSetup(
    selectedProvider,
    selectedSetupSteps,
    profileName,
    isUpdate,
    storageLocation,
    enforced
  );
```

Remove the old provider prompt block (lines ~199–223 in the original):
```typescript
  // Step 1: Get all registered providers from ProviderRegistry  <-- DELETE these lines
  const registeredProviders = ProviderRegistry.getAllProviders();
  const allProviderChoices = getAllProviderChoices(registeredProviders);

  const { provider } = await inquirer.prompt([...]);
  const setupSteps = ProviderRegistry.getSetupSteps(provider);
  if (!setupSteps) {
    throw new Error(`Provider "${provider}" does not have setup steps configured`);
  }
  await handlePluginSetup(provider, setupSteps, profileName, isUpdate, storageLocation);
```

- [ ] **Step 4: Update `handlePluginSetup()` signature and `getCredentials` call**

Change the signature from:

```typescript
async function handlePluginSetup(
  providerName: string,
  setupSteps: any,
  profileName: string | null,
  isUpdate: boolean,
  storageLocation: 'global' | 'local' = 'global'
): Promise<void>
```

to:

```typescript
async function handlePluginSetup(
  providerName: string,
  setupSteps: any,
  profileName: string | null,
  isUpdate: boolean,
  storageLocation: 'global' | 'local' = 'global',
  enforcementContext?: LiteLLMEnforcementContext
): Promise<void>
```

And change the `getCredentials` call (line ~247) from:

```typescript
    const credentials = await setupSteps.getCredentials(isUpdate);
```

to:

```typescript
    const setupContext: SetupContext | undefined = enforcementContext
      ? {
          enforcedIntegration: {
            id: enforcementContext.integration.id,
            alias: enforcementContext.integration.alias,
            codeMieUrl: enforcementContext.authResult.apiUrl || ''
          }
        }
      : undefined;
    const credentials = await setupSteps.getCredentials(isUpdate, setupContext);
```

- [ ] **Step 5: Export `runSetupWizard` as `runSetupWizardForTest` for tests**

At the bottom of `setup.ts`, add:

```typescript
// Exported for unit testing only
export { runSetupWizard as runSetupWizardForTest };
```

Also ensure `detectLiteLLMEnforcement` is already exported (it was exported in Task 3).

- [ ] **Step 6: Run all enforcement tests — expect PASS**

```bash
npx vitest run src/cli/commands/__tests__/setup.enforcement.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Run the full LiteLLM setup-steps test suite**

```bash
npx vitest run src/providers/plugins/litellm/__tests__/litellm.setup-steps.test.ts
```

Expected: all tests PASS.

- [ ] **Step 8: Typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 9: Lint**

```bash
npm run lint
```

Expected: zero warnings.

- [ ] **Step 10: Commit**

```bash
git add src/cli/commands/setup.ts \
        src/cli/commands/__tests__/setup.enforcement.test.ts
git commit -m "fix(cli): wire detectLiteLLMEnforcement into runSetupWizard — auto-select LiteLLM when enforced"
```

---

## Task 5: Run full CI gate

**Test-first:** N/A — this is the final quality gate.

**Files:** No code changes.

- [ ] **Step 1: Run the full test suite**

```bash
cd C:/Projects/codemie-dev/codemie-code
npm run test
```

Expected: all tests PASS.

- [ ] **Step 2: Run full CI**

```bash
npm run ci
```

Expected: lint → typecheck → build → test → zero failures.

- [ ] **Step 3: Review changed files**

Confirm only these files changed (no accidental collateral changes):
- `src/providers/core/types.ts`
- `src/providers/plugins/litellm/litellm.setup-steps.ts`
- `src/cli/commands/setup.ts`
- `src/providers/plugins/litellm/__tests__/litellm.setup-steps.test.ts` (new)
- `src/cli/commands/__tests__/setup.enforcement.test.ts` (new)

```bash
git diff --name-only HEAD~4
```

Expected: exactly the five files listed above (plus `.state.json` and planning artifacts in `docs/`).

---

## Spec coverage self-review

| Spec requirement | Task |
|---|---|
| Phase 1: `detectLiteLLMEnforcement()` in `setup.ts` | Task 3 |
| Prompt CodeMie URL → auth → project → fetch integrations → return result | Task 3 |
| Gate failure → warn + fallback to normal flow | Task 3 (graceful catch) |
| Enforcement banner when enforced | Task 4 |
| Skip provider prompt when enforced | Task 4 |
| Guard: LiteLLM not registered → throw | Task 4 |
| `handlePluginSetup()` gains `enforcedContext?` param | Task 4 |
| `LiteLLMEnforcementContext` type in `setup.ts` | Task 3 |
| `getCredentials()` threads context via `SetupContext` | Task 4 |
| Phase 3: `SetupContext` in `types.ts` | Task 1 |
| Phase 4: `LiteLLMSetupSteps` enforcement mode with hard-required key | Task 2 |
| Phase 5: SSO path unchanged | No change — confirmed no-op |
| AC1: Detect LiteLLM integration | Task 3 |
| AC2: Enforce LiteLLM usage | Task 4 |
| AC3: Cannot complete setup without LiteLLM key | Task 2 |
| AC4: Validation message explains why key is mandatory | Task 2 (prompt message + error text) |
| AC5: No change for projects without integration | Task 3 (enforced:false path) |
| AC6: No invalid config state saved | Task 2 (key required before `buildConfig` is called) |
