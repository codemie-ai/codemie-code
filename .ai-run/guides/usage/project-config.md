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

`codeMieUrl`, `codeMieProject`, and `codeMieIntegration` resolve differently depending on the
scope of the profile in use. A local profile (defined in `.codemie/codemie-cli.config.json`)
uses the local workspace's own identity when it has one. A local profile with no local
workspace identity falls back to the global *workspace* object's identity — migration 008
clones that identity onto every eligible global profile but deliberately never deletes it from
the shared workspace object afterward, so this fallback keeps working for local profiles with
no identity of their own, exactly as it did before global profiles got their own per-profile
copy. A global profile of the same name is picked up through profile-name matching first (a
separate, higher-priority path), so the shared-workspace fallback only matters when no such
profile exists. A **global** profile resolves its own identity directly from the profile
itself — each global profile stores its own `codeMieUrl`/`codeMieProject`/`codeMieIntegration`,
so switching between global profiles never leaks one profile's identity onto another. The
identity trio is treated as a unit everywhere it is gap-filled from the shared workspace
(migration 008 and this read-time fallback alike): a profile that already owns *any* one of
the three fields gets none of the others filled in from the shared value, since the shared
object may be a leftover from a different profile's environment — filling only the gaps could
pair this profile's own field with another environment's. Only non-identity workspace fields
(`hooks`, `plugins`, `assistants`, `skillsSearchUrl`, `claudeAutocompactPct`, `metrics`) remain
scope-level shared across global profiles.

**Policy note — the shared fallback is a permanent, frozen snapshot, by design.** Once migration
008 has run, `saveProfile()` no longer writes to the shared workspace's identity fields at all —
whatever value was there at migration time (or whatever a pre-migration config last wrote to it)
stays there forever, unchanged by later profile edits. This is intentional: it is the only way a
local profile with no identity of its own, or a vendor-subscription/split-host global profile
created at any point afterward, can still receive an ambient identity the way they always could
before this fix. The trade-off is accepted, not accidental: `canUseSharedIdentity()`'s
origin/sibling check (applied consistently to both the global-profile and the local-profile
fallback paths) is the only guard against it leaking into the wrong environment, and that check's
answer can change if a sibling profile is later added or removed — a profile can gain or lose the
fallback as the sibling set changes. There is no provenance record of which profile originally
donated the shared value, and no expiry. If a team needs a guaranteed-fresh identity, they should
assign it directly to the profile (`saveProfile()` with the identity trio set explicitly) rather
than relying on the shared fallback.

**Policy note — a profile's saved identity is never cleared, only replaced as a whole trio.**
`saveProfile()` treats `codeMieUrl`/`codeMieProject`/`codeMieIntegration` as a unit: if an update
supplies *any* one of the three, none of the others carry forward from the profile's previous
value (to avoid pairing a new field with a stale one) — but if an update supplies *none* of the
three, the existing trio carries forward unchanged, including across a provider switch. There is
currently no way to explicitly clear a profile's identity (e.g. back to "unset") short of deleting
and recreating the profile; retention across edits is the intended behavior, not an oversight.

```bash
codemie-claude                      # repo's local profile: repo's CodeMie URL and project
codemie-claude --profile anthropic  # global profile: that profile's own CodeMie URL and project
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
