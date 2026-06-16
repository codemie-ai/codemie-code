# Non-Interactive `codemie setup` Design

**Date:** 2026-06-15  
**Status:** Approved  
**Author:** AI Agent (brainstorming session)  

---

## Goal

Allow `codemie setup` to run without user interaction when configuration does not yet exist, accepting the provider and all required parameters via CLI flags and/or environment variables.

---

## Requirements

1. Support **all providers** in non-interactive mode where feasible.
2. Inputs come from **CLI flags** and **environment variables**, with CLI flags taking priority.
3. Default to **global** config scope (`~/.codemie/`).
4. Default profile name is the **provider name**, with auto-increment on collision (`bedrock`, `bedrock-2`, ...).
5. Model selection: use `--model` / `CODEMIE_MODEL`, otherwise fall back to the provider's first `recommendedModels` entry.
6. If an identical profile already exists, exit silently (idempotent).
7. If a profile exists with different values, fail unless `--force` is passed.
8. Providers that require browser authentication (SSO, Anthropic Subscription) must only proceed if already authenticated; otherwise fail with a clear message.

---

## Architecture & Data Flow

New/changed components:

1. **`src/providers/core/types.ts`**
   - Extend `ProviderSetupSteps` with:
     ```ts
     buildCredentialsFromInputs?(
       inputs: NonInteractiveSetupInputs
     ): Promise<ProviderCredentials>;
     ```
   - Add `NonInteractiveSetupInputs` type:
     ```ts
     interface NonInteractiveSetupInputs {
       provider: string;
       baseUrl?: string;
       apiKey?: string;
       model?: string;
       awsProfile?: string;
       awsAccessKeyId?: string;
       awsSecretAccessKey?: string;
       awsRegion?: string;
       codemieUrl?: string;
       codemieProject?: string;
       jwtToken?: string;
       profileName?: string;
       storage: 'global' | 'local';
       [key: string]: unknown;
     }
     ```

2. **`src/providers/plugins/<provider>/<provider>.setup-steps.ts`**
   - Each provider implements `buildCredentialsFromInputs` where non-interactive setup is feasible.
   - SSO/Anthropic first check for existing authentication and throw a clear `ConfigurationError` if auth is missing.

3. **`src/cli/commands/setup.ts`**
   - Add `--non-interactive` / `--ci`, `--provider`, `--storage`, `--profile-name`, and provider-specific flags.
   - When `--non-interactive` is set, call `runNonInteractiveSetupWizard(options)` instead of `runSetupWizard`.

4. **`src/cli/setup/non-interactive.ts` (new)**
   - Builds `NonInteractiveSetupInputs` from CLI flags and environment variables.
   - Routes to the provider's `buildCredentialsFromInputs`.
   - Reuses the existing save/config-build flow (`handlePluginSetup` or an extracted public equivalent).

```
CLI (setup.ts --non-interactive)
  ↓
build inputs from flags + env
  ↓
ProviderRegistry.getSetupSteps(provider)
  ↓
provider.buildCredentialsFromInputs(inputs)
  ↓
handlePluginSetup(provider, setupSteps, profileName, isUpdate, storageLocation)
  ↓
ConfigLoader.saveProfile / initProjectConfig
```

This preserves the existing architecture: CLI → Registry → Plugin → Core → Utils.

---

## CLI Interface

### New flags on `codemie setup`

| Flag | Env fallback | Description |
|---|---|---|
| `--non-interactive` / `--ci` | `CODEMIE_NON_INTERACTIVE=true` | Enable headless mode |
| `--provider <name>` | `CODEMIE_PROVIDER` | Required in non-interactive mode |
| `--storage global\|local` | `CODEMIE_STORAGE_SCOPE` | Default: `global` |
| `--profile-name <name>` | `CODEMIE_PROFILE_NAME` | Default: provider name, auto-increment on collision |
| `--model <model>` | `CODEMIE_MODEL` | Default: provider's `recommendedModels[0]` |
| `--base-url <url>` | `CODEMIE_BASE_URL` | Provider endpoint |
| `--api-key <key>` | `CODEMIE_API_KEY` | API key / token |
| `--aws-profile <name>` | `CODEMIE_AWS_PROFILE` | AWS profile name |
| `--aws-access-key-id <id>` | `CODEMIE_AWS_ACCESS_KEY_ID` | AWS access key |
| `--aws-secret-access-key <secret>` | `CODEMIE_AWS_SECRET_ACCESS_KEY` | AWS secret key |
| `--aws-region <region>` | `CODEMIE_AWS_REGION` | AWS region |
| `--codemie-url <url>` | `CODEMIE_URL` | CodeMie platform URL |
| `--codemie-project <project>` | `CODEMIE_PROJECT` | CodeMie project |
| `--jwt-token <token>` | `CODEMIE_JWT_TOKEN` | JWT token |

### Input priority

1. CLI flag (highest)
2. Environment variable
3. Provider-specific default (e.g., Bedrock `us-east-1`, provider `defaultBaseUrl`)

### Validation

- If `--non-interactive` is set but `--provider` / `CODEMIE_PROVIDER` is missing, fail with `ConfigurationError('Provider is required in non-interactive mode. Use --provider or set CODEMIE_PROVIDER.')`.
- If the chosen provider does not implement `buildCredentialsFromInputs` and requires interactive auth, fail with a clear message.

---

## Provider Input Mapping

### `bedrock`
- Requires one of:
  - `--aws-profile`
  - `--aws-access-key-id` + `--aws-secret-access-key` + `--aws-region`
- Default region: `us-east-1`
- Builds `baseUrl` from region.

### `openai`, `litellm`, `ollama`, `moonshot-subscription`
- `--base-url` (default: provider template `defaultBaseUrl`)
- `--api-key`
- `--model`

### `jwt`
- `--base-url` (default: provider template `defaultBaseUrl`)
- `--jwt-token`
- `--model`

### `ai-run-sso`
- Requires `--codemie-url`
- Checks stored SSO credentials via `CodeMieSSO.getStoredCredentials(codemieUrl)`.
- If missing: throw `ConfigurationError('SSO credentials not found for <url>. Run interactive "codemie setup" first.')`.
- If present: reuse `apiUrl` and cookies, optionally accept `--codemie-project`.

### `anthropic-subscription`
- Calls `getClaudeAuthStatus()`.
- If Claude CLI is not logged in: throw `ConfigurationError('Claude Code is not authenticated. Run "claude auth login" or interactive setup first.')`.
- If logged in: proceed with `baseUrl = AnthropicSubscriptionTemplate.defaultBaseUrl`, `apiKey = ''`.
- Optionally accepts `--codemie-url` and `--codemie-project` for analytics sync.

### Common
- Any unknown/unsupported input is ignored with a debug log.
- If required fields are missing, the provider throws `ConfigurationError` with a list of missing fields.

---

## Non-Interactive Behavior Details

### Profile naming

1. If `--profile-name` / `CODEMIE_PROFILE_NAME` is provided, use it.
2. Otherwise default to the provider name.
3. If a profile with that name already exists, auto-increment: `bedrock-2`, `bedrock-3`, etc.

### Storage scope

- Default: `global`.
- Override with `--storage local` / `CODEMIE_STORAGE_SCOPE=local`.
- Uses `ConfigLoader.saveProfile` for global and `ConfigLoader.initProjectConfig` for local.

### Model selection

1. If `--model` / `CODEMIE_MODEL` is provided, use it.
2. Otherwise use `providerTemplate.recommendedModels[0]`.
3. `fetchModels` is still called for validation when possible, but if it fails, the recommended model is used.

### Idempotency / existing config

- Before saving, compute the full profile that would be written.
- If a profile with the same name already exists and is deep-equal, exit 0 silently.
- If a profile with the same name exists but differs and `--force` is not set, throw `ConfigurationError('Profile "X" already exists with different values. Use --force to overwrite.')`.
- With `--force`, overwrite the existing profile.

### First-time experience

- `FirstTimeExperience.showEcosystemIntro()` is skipped entirely in non-interactive mode.

### Claude install check

- The post-setup `checkAndInstallClaude()` is skipped in non-interactive mode to avoid interactive prompts.

---

## Error Handling

All errors in non-interactive mode produce machine-readable stderr output and a non-zero exit code.

| Scenario | Message |
|---|---|
| `--non-interactive` without `--provider` | `Provider is required in non-interactive mode. Use --provider or set CODEMIE_PROVIDER.` |
| Unknown provider | `Provider "<name>" not found. Available providers: ...` |
| Provider missing `buildCredentialsFromInputs` | `Provider "<name>" does not support non-interactive setup.` |
| Missing required field | `Missing required fields for provider "<name>": awsProfile or (awsAccessKeyId, awsSecretAccessKey, awsRegion).` |
| SSO not pre-authenticated | `SSO credentials not found for <url>. Run interactive "codemie setup" first.` |
| Anthropic not logged in | `Claude Code is not authenticated. Run "claude auth login" or interactive setup first.` |
| Profile exists and differs | `Profile "<name>" already exists with different values. Use --force to overwrite.` |

### Logging

- Use `logger.debug()` for internal state.
- Avoid logging secrets (`apiKey`, `awsSecretAccessKey`, `jwtToken`). Use `sanitizeLogArgs()` where needed.
- No success banners in non-interactive mode. A single `console.log(profileName)` may be emitted on success so scripts can capture the created profile name.

---

## Testing Approach

Tests are only added if explicitly requested, but the design is testable.

### Unit-testable pieces

1. **`src/cli/setup/non-interactive.ts`**
   - Input normalization from flags + env.
   - Unique profile name generation.
   - Idempotency check (deep-equal existing profile).

2. **Provider `buildCredentialsFromInputs` methods**
   - Bedrock: validates profile vs. direct keys, builds correct `baseUrl`.
   - OpenAI/LiteLLM/Ollama: builds credentials from `--base-url`/`--api-key`.
   - SSO: returns stored credentials when available, throws when missing.
   - Anthropic: returns config when Claude is logged in, throws when not.

3. **`src/cli/commands/setup.ts`**
   - Verify `--non-interactive` routes to `runNonInteractiveSetupWizard`.
   - Verify interactive mode is unchanged.

### Integration tests (if requested later)

- Run `codemie setup --non-interactive --provider ollama --base-url http://localhost:11434` in a temporary directory and assert the config file contents.
- Run twice and assert idempotent exit 0.

### Mocks needed

- `ConfigLoader` methods.
- `ProviderRegistry.getSetupSteps`.
- `CodeMieSSO.getStoredCredentials` and `getClaudeAuthStatus`.

---

## Future Enhancements (out of scope)

- `--config-file <path>` / `--config-json '<json>'` for raw profile injection (Approach C from brainstorming).
- Auto-detect local vs. global scope based on git repository presence.
- Non-interactive profile updates via `codemie setup --non-interactive --force`.
