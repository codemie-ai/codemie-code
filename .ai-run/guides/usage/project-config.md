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

## Profile Resolution (2-Level Lookup)

Profile lookup is two-level: global base + local overlay.

1. Load the global profile as a base.
2. Overlay the local profile of the same name on top (field-by-field merge).
3. Result: local fields win; global fields fill gaps.

| Scenario | Source of provider/model | Source of codeMieProject |
|---|---|---|
| Only global config | global | global |
| Local overrides project fields | global | local |
| `--profile <global-name>` with local team profile | global (selected profile) | local team profile |

**Key rule**: `activeProfile` switches are stored in local config when `.codemie/` exists; the profile data itself can come from either source.

`file:src/env/config-loader.ts` — `loadWithSources()` implements the merge.

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

**Method signatures** — `file:src/env/config-loader.ts`:

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

### Team profile with personal provider

Repository commits a local `team` profile with `codeMieProject`/`codeMieIntegration`. Each developer keeps their own global profile (`kimi`, `anthropic`, etc.) and passes `--profile <their-profile>` at runtime. The selected global profile supplies provider + credentials; the local team profile supplies project context.

```bash
codemie-kimi   --profile kimi       # uses global kimi profile + local project fields
codemie-claude --profile anthropic  # uses global anthropic profile + local project fields
```

> **URL precondition.** Project-context preservation (`codeMieProject`, `codeMieIntegration`, `codeMieUrl`) applies only when the selected global profile and the local team profile target the same `codeMieUrl` (compared after stripping trailing slashes and lower-casing). When the URLs differ, the user is switching CodeMie environments and the team's project/integration IDs would reference the wrong env's records — so the local project context is dropped and the selected global profile supplies everything. This is enforced in `ConfigLoader.load()` and `ConfigLoader.loadWithSources()`.

### CI/CD overrides

```bash
export CODEMIE_PROVIDER=bedrock
export CODEMIE_MODEL=claude-3-5-sonnet
export CODEMIE_PROJECT=ci-project
```

Environment variables override both global and local config. No local config file is needed in CI.

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
`ANTHROPIC_BASE_URL` key, Claude Code uses it instead of any environment variable.

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
