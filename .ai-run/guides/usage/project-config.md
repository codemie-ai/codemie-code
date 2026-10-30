# Project-Level Configuration Guide

**Purpose**: Configure CodeMie settings per repository with fallback to global defaults.

---

## Config Priority

Settings resolve in this order (highest wins):

```
CLI args > Environment variables > Project config > Global config > Defaults
```

Diagnostic: `codemie profile status --show-sources` prints each field with its source label (`cli`, `env`, `project`, `global`, `default`).

---

## Config File Locations

| Level | Path | Scope |
|---|---|---|
| Global | `~/.codemie/codemie-cli.config.json` | All repositories |
| Local | `.codemie/codemie-cli.config.json` | This repository only |

Local config does **not** isolate from global — missing local fields fall back to global. Both files use the same schema (`version: 2`).

**File: `src/env/` and `src/utils/config.ts`** — `ConfigLoader` implementation.

---

## Profile Resolution

Profile lookup is based on the selected profile name. An explicit `--profile <name>` takes
precedence over `activeProfile`.

1. Load the selected global profile as a base.
2. If the repository has a local profile with the same name, overlay it field by field.
3. If a differently named local profile is the repository's active profile, use it only
   as a project-context overlay when the selected profile does not define its own
   `codeMieProject` or `codeMieIntegration`.
4. Apply that project-context overlay only when the global and local CodeMie URLs match
   after normalization, or when either URL is absent.

Provider, model, and credentials always remain aligned to the selected global profile
when profile names differ. A selected profile's explicit project or integration is also
authoritative; the compatible local project context only fills that gap.

Persistent proxy connectors (`proxy connect desktop` and `proxy connect vscode`) use the
effective active profile when `--profile` is omitted. A local `activeProfile` may select a
profile defined globally; a differently named local team profile may still supply compatible
project context, but it cannot replace the selected provider, model, or credentials.

| Scenario | Source of provider/model | Source of codeMieProject |
|---|---|---|
| Only global config | global | global |
| Same-named local profile overrides project fields | global | local |
| Differently named local profile; selected profile defines project context | global (selected profile) | global (selected profile) |
| Differently named local profile; selected profile lacks project context and URLs are compatible | global (selected profile) | local project overlay |
| Differently named local profile; URLs differ | global (selected profile) | global (selected profile) |
| `--profile <name>` with a same-named local profile | local overlay | local overlay |

**Key rule**: `activeProfile` switches are stored in local config when `.codemie/` exists; the profile data itself can come from either source.

`file:src/utils/config.ts` — `loadWithSources()` implements the merge.

---

## ConfigLoader API

```typescript
import { ConfigLoader } from '@codemieai/code/utils/config';

// Check if local config exists
const hasLocal = await ConfigLoader.hasLocalConfig();

// Load merged config with per-field source tracking
const { config, sources } = await ConfigLoader.loadWithSources(process.cwd(), cliOverrides);

// Initialize a local config with specific overrides
await ConfigLoader.initProjectConfig(process.cwd(), {
  codeMieProject: 'my-project',
  codeMieIntegration: { id: 'integration-123', alias: 'my-team' }
});
```

**Method signatures** — `file:src/utils/config.ts`:

| Method | Returns |
|---|---|
| `hasLocalConfig(workingDir?)` | `Promise<boolean>` |
| `getActiveProfileName()` | `Promise<string>` |
| `listProfiles()` | `Promise<ProfileEntry[]>` |
| `loadWithSources(workingDir?, cliOverrides?)` | `Promise<ConfigWithSources>` |
| `initProjectConfig(workingDir, overrides?)` | `Promise<void>` |
| `showWithSources(workingDir?)` | `Promise<void>` (CLI utility) |

### Key Types

```typescript
interface ConfigWithSources {
  config: CodeMieConfigOptions;
  hasLocalConfig: boolean;
  sources: Record<string, { value: any; source: 'default'|'global'|'project'|'env'|'cli' }>;
}
```

---

## Config File Schema

**Minimal local override** (inherits provider/model/auth from global):

```json
{
  "version": 2,
  "activeProfile": "default",
  "profiles": {
    "default": {
      "codeMieProject": "frontend-app",
      "codeMieIntegration": { "id": "frontend-456", "alias": "frontend-team" }
    }
  }
}
```

**Global config** (full example):

```json
{
  "version": 2,
  "activeProfile": "default",
  "profiles": {
    "default": { "provider": "bedrock", "authMethod": "sso", "model": "claude-3-5-sonnet", "awsRegion": "us-east-1" },
    "work":    { "provider": "sso", "codeMieProject": "work-project" }
  }
}
```

---

## Common Patterns

### Different projects per repository

Keep global config with provider/model. Each repo's local config sets only `codeMieProject` and `codeMieIntegration`. All other fields inherit from global.

### Team project context with a selected provider profile

`codeMieUrl`, `codeMieProject`, and `codeMieIntegration` come from the workspace of the scope
the profile in use belongs to. A local profile (defined in `.codemie/codemie-cli.config.json`)
uses the local workspace, falling back to the global one when the local config has none. A
global profile always uses the global workspace, even inside a repository with a local config.

```bash
codemie-claude                      # repo's local profile: repo's CodeMie URL and project
codemie-claude --profile anthropic  # global profile: global CodeMie URL and project
```

### Which CodeMie URL is used

Two URLs can point at the CodeMie platform, and they have different jobs:

| URL | Field | Used for |
|---|---|---|
| Profile URL (P) | profile `baseUrl` | Direct platform interaction: stored-credential lookup, `codemie profile login/logout/refresh`, model lists, health/doctor |
| Workspace URL (W) | `workspace.codeMieUrl` (`codeMieUrl`) | Analytics/metrics sync (`syncCodeMieUrl`, `CODEMIE_SYNC_API_URL`) and the fallback when a lookup under P finds nothing |

For `ai-run-sso` and `bearer-auth` profiles, P is tried first and W second (a same-origin P and W is looked up once).
Subscription providers (`anthropic-subscription`, `moonshot-subscription`) use W only, because their `baseUrl` is a vendor endpoint, not CodeMie.
The resolver lives in `src/providers/core/codemie-auth-helpers.ts` (`getPlatformUrl`, `getStoredPlatformCredentials`); agent-side code resolves from `CODEMIE_PROFILE_CONFIG` because `CODEMIE_BASE_URL` is rewritten to the local proxy before the agent starts.

### CI/CD overrides

```bash
export CODEMIE_PROVIDER=bedrock
export CODEMIE_MODEL=claude-3-5-sonnet
```

Environment variables override both global and local config for the fields `ConfigLoader.loadFromEnv` reads (`CODEMIE_PROVIDER`, `CODEMIE_BASE_URL`, `CODEMIE_API_KEY`, `CODEMIE_MODEL`, `CODEMIE_TIMEOUT`, `CODEMIE_DEBUG`, `CODEMIE_ALLOWED_DIRS`, `CODEMIE_IGNORE_PATTERNS`, `CODEMIE_URL`, `CODEMIE_AUTH_METHOD`, integration id/alias). No local config file is needed in CI.

`CODEMIE_PROJECT` is not one of them: `loadFromEnv` never reads it, so it does not override `codeMieProject` from config. It is only passed through to the agent's child environment (and from there to the `X-CodeMie-Project` header and session records) when the active profile has no `codeMieProject` of its own; a profile that sets one always re-exports its own value.

---

## Best Practices

| Do | Avoid |
|---|---|
| Override only the fields that differ from global | Duplicating global fields in local config |
| Commit `.codemie/codemie-cli.config.json` for team project/integration settings | Committing `.codemie/credentials.json` |
| Gitignore `.codemie/credentials.json` and `.codemie/cache/` | Storing tokens in the config file |
| Use env vars for CI/CD overrides | Hardcoding CI values in local config |
| Keep `activeProfile` consistent across global and local (usually `"default"`) | Mismatched profile names causing missed merges |

---

## CLI Commands

```bash
codemie setup                          # Interactive setup (choose global or local)
codemie profile                        # List all profiles (local + global)
codemie profile status --show-sources  # Show each field with its source
codemie profile switch <name>          # Switch active profile
codemie profile delete <name>          # Delete a profile
```

---

## Claude Code ANTHROPIC_BASE_URL Override

Claude Code reads `~/.claude/settings.json` at startup. If that file contains an
`ANTHROPIC_BASE_URL` key under the `env` block, Claude Code uses it instead of any
environment variable.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-proxy.example.com"
  }
}
```

`codemie-code` detects this at startup and prints a visible warning showing:
- **Profile URL** — the URL the active profile tried to inject
- **Active URL** — the settings.json URL that will actually be used

**Precedence chain (highest wins):**
`~/.claude/settings.json` > `env.ANTHROPIC_BASE_URL` (codemie-code profile)

To avoid silent overrides: remove `ANTHROPIC_BASE_URL` from `~/.claude/settings.json`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Local config ignored | Wrong directory or JSON syntax error | Verify path is `.codemie/codemie-cli.config.json` at repo root; run `cat .codemie/codemie-cli.config.json \| jq .` |
| Field not overriding | Env var or CLI arg takes precedence | Check `env \| grep CODEMIE_`; use `--show-sources` |
| Profile fields missing | Profile name mismatch between global and local | Confirm `activeProfile` value matches a profile key in both files |
| "CODEMIE_* is required" error | No global config and local config incomplete | Run `codemie setup` globally, or add all required fields to local config |

---

## Related Guides

- [Development Practices](.ai-run/guides/development/development-practices.md) — config loading patterns
- [Security Practices](.ai-run/guides/security/security-practices.md) — credential management
- [Project adapters and MR/ticket integration](.ai-run/guides/project.md) — ticket adapter, MR adapter
