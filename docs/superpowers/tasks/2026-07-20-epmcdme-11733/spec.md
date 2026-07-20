# Spec: Enforce LiteLLM Integration in CLI Setup

**Ticket**: EPMCDME-11733  
**Branch**: EPMCDME-11733  
**Type**: Bug / Enforcement

---

## Goal

When `codemie-cli setup` runs in a project that has a LiteLLM integration configured in the CodeMie backend, the setup wizard must detect this and enforce usage of that integration. The user cannot complete setup without providing the required LiteLLM API key.

---

## Acceptance Criteria (from ticket)

1. During setup, the system detects when the selected project already has a LiteLLM integration created.
2. If LiteLLM integration exists, the setup flow enforces its usage for CLI configuration.
3. User cannot complete CLI setup without providing the required LiteLLM key.
4. Validation message clearly explains why setup cannot continue without LiteLLM credentials.
5. The enforced flow does not affect projects that do not have LiteLLM integration created.
6. No invalid CLI configuration state can be saved for projects where LiteLLM integration is mandatory.

---

## Design

### Overview

A new **pre-auth integration gate** runs at the start of `runSetupWizard()`, before the provider-selection prompt. It authenticates with CodeMie, identifies the user's project, and checks for a LiteLLM integration. If found, the wizard auto-selects LiteLLM and requires an API key. If not found (or if the gate fails gracefully), the wizard proceeds with the normal provider selection flow unchanged.

---

### Phase 1 — Integration Gate in `setup.ts`

A new function `detectLiteLLMEnforcement()` is added to `setup.ts`. It runs unconditionally before the provider-selection prompt.

**Steps:**

1. Prompt for CodeMie URL. Pre-fill from local config (`codeMieUrl` field) if available; default to `DEFAULT_CODEMIE_BASE_URL` otherwise.
2. Authenticate using `authenticateWithCodeMie(codeMieUrl)`.
3. Select the user's project using `selectCodeMieProject(authResult)`.
4. Fetch integrations using `fetchCodeMieIntegrations(authResult.apiUrl, authResult.cookies)` filtered by `project_name === selectedProject`.
5. Return one of:
   - `{ enforced: false }` — no integration found; wizard proceeds normally.
   - `{ enforced: true, integration: CodeMieIntegration, project: string, authResult: SSOAuthResult }` — enforcement is active.

**Failure behaviour:**
- If any step throws (network error, SSO unavailable, project fetch fails, integration fetch fails): catch the error, log a warning with `logger.warn()`, print a yellow warning banner to the user, and return `{ enforced: false }`. The wizard continues to the normal provider selection. This prevents the gate from blocking setups in air-gapped or restricted environments.
- The warning banner message: `"⚠️  Could not check for mandatory integrations (${errorMessage}). Continuing with normal provider setup."`

**Integration with `runSetupWizard()`:**
- Call `detectLiteLLMEnforcement()` after the storage-location prompt and before the provider-selection prompt.
- Store the result in a local variable `enforcementGate`.
- If `enforcementGate.enforced === true`: print an enforcement banner, skip the provider-selection prompt, and pass `enforcementGate` into `handlePluginSetup()`.
- If `enforcementGate.enforced === false`: proceed to the normal provider-selection prompt unchanged.

**Enforcement banner (printed when enforcement is active):**
```
📌 This project uses a mandatory LiteLLM integration: "{alias}"
   Provider has been set to LiteLLM automatically.
```

**Guard:** Before skipping the provider prompt, assert that `ProviderRegistry.getSetupSteps('litellm')` exists. If LiteLLM is not registered for any reason, throw with: `"LiteLLM integration is required for this project but the LiteLLM provider is not available. Please reinstall codemie-cli."` This prevents an unrecoverable blank-prompt state.

---

### Phase 2 — `handlePluginSetup()` context threading

`handlePluginSetup()` gains an optional fourth parameter:

```typescript
async function handlePluginSetup(
  providerName: string,
  setupSteps: ProviderSetupSteps,
  profileName: string | null,
  isUpdate: boolean,
  storageLocation: 'global' | 'local',
  enforcementContext?: LiteLLMEnforcementContext   // new, optional
): Promise<void>
```

Where `LiteLLMEnforcementContext` is a new local type in `setup.ts`:

```typescript
interface LiteLLMEnforcementContext {
  integration: CodeMieIntegration;
  project: string;
  authResult: SSOAuthResult;
}
```

`handlePluginSetup()` passes this context to `setupSteps.getCredentials()` via the new optional second parameter.

---

### Phase 3 — `ProviderSetupSteps` interface extension (`types.ts`)

Add a new exported type and extend `getCredentials`:

```typescript
export interface SetupContext {
  enforcedIntegration?: {
    id: string;
    alias: string;
    codeMieUrl: string;
  };
}
```

Update the interface method signature:

```typescript
getCredentials(isUpdate?: boolean, context?: SetupContext): Promise<ProviderCredentials>;
```

The `context` parameter is optional. All existing provider implementations remain valid without changes (TypeScript will accept the narrower existing signatures — they do not need to declare the second parameter). Only `LiteLLMSetupSteps` will actually read the `context`.

---

### Phase 4 — `LiteLLMSetupSteps` enforcement (`litellm.setup-steps.ts`)

Update `LiteLLMSetupSteps.getCredentials()` to accept the optional context and enforce the API key when a context is present.

**When `context?.enforcedIntegration` is set:**

1. Display the integration header before the prompts:
   ```
   🔒 LiteLLM integration required: "{alias}"
      Get your API key from your CodeMie portal (Settings → Integrations).
   ```
2. Prompt for the Proxy URL (unchanged, same default).
3. Prompt for the API Key with:
   - Message: `API Key for integration "{alias}" (required):`
   - `type: 'password'`
   - Validator: `(input) => input.trim() !== '' || 'API Key is required for this integration. Retrieve it from your CodeMie portal.'`
   - No default value (forces the user to enter something).
4. Return credentials with the entered key. The `'not-required'` fallback is **not used** in enforcement mode.

**When no context (normal flow):** existing behaviour unchanged.

---

### Phase 5 — SSO flow enforcement (`sso.setup-steps.ts`)

In `SSOSetupSteps.getCredentials()`, in the section that resolves integrations (current lines 133–140), change the "no integrations found" path:

**Current behaviour:** if integrations.length === 0, log debug and proceed silently.

**New behaviour:** if integrations.length === 0 AND `integrationsFetchError` is undefined (meaning the fetch succeeded but returned nothing):
- Continue silently (same as before — project genuinely has no integration).

If integrations.length > 0 and the user is mid-setup via the SSO path:
- **Current**: auto-select or prompt; integration is optional metadata.
- **New**: same selection logic (auto-select if 1, prompt if many), but the integration is now **required** for the SSO credentials. The existing `integrationInfo` assignment remains, but after selection the SSO flow should produce credentials that signal LiteLLM enforcement to the downstream model fetch / buildConfig.

Note: SSO path users go through SSO → select project → find integration → the integration becomes part of `buildConfig` output. The key enforcement is **not applied in the SSO path** — the SSO token already authenticates the user; the LiteLLM key is separate and only needed in the direct LiteLLM provider path. SSO users access LiteLLM models through the SSO-authenticated CodeMie proxy without a separate API key. The SSO integration detection enforcement means: when an SSO user is on a project with a LiteLLM integration, their profile will record the integration info but they don't need to provide a LiteLLM key.

---

### Error Handling

| Scenario | Behaviour |
|---|---|
| CodeMie URL unreachable | Log warning, fall back to normal setup flow |
| SSO auth times out | Log warning, fall back to normal setup flow |
| Project fetch fails | Log warning, fall back to normal setup flow |
| Integration fetch fails | Log warning, fall back to normal setup flow |
| LiteLLM key left blank in enforcement mode | Validation error in prompt; re-prompt (no save, no exit) |
| LiteLLM provider not registered | Throw with clear error message before showing any prompt |

---

### Files Changed

| File | Change |
|---|---|
| `src/cli/commands/setup.ts` | Add `detectLiteLLMEnforcement()`, update `runSetupWizard()`, update `handlePluginSetup()` signature, add `LiteLLMEnforcementContext` type |
| `src/providers/core/types.ts` | Add `SetupContext` interface; add optional `context?: SetupContext` param to `getCredentials` in `ProviderSetupSteps` |
| `src/providers/plugins/litellm/litellm.setup-steps.ts` | Update `getCredentials()` to accept and enforce `SetupContext`; add key validation and portal URL hint |
| `src/providers/plugins/sso/sso.setup-steps.ts` | Minor: no enforcement of LiteLLM key in SSO path (SSO auth already handles access); existing integration-selection logic unchanged |

---

### What This Does NOT Change

- Non-SSO, non-LiteLLM providers (Anthropic, Bedrock, Ollama, Anthropic Subscription) are completely unaffected.
- Projects with no LiteLLM integration see zero change in their setup flow.
- The `codeMieIntegration` field in `ProviderProfile` retains its current meaning (integration metadata stored after a setup that detected one). It is NOT used as an enforcement trigger.
- The `--force` flag still works; enforcement is re-checked live every time via the gate.

---

### Out of Scope

- Fetching the LiteLLM API key from the CodeMie backend (the API does not expose this; user retrieves it from the portal).
- Adding a "Skip / no key required" bypass for the API key prompt.
- Changing the SSO provider path to require a separate LiteLLM key.
