# Technical Research

**Task**: proxy connect connectors codex desktop config toml
**Generated**: 2026-08-18
**Research path**: codegraph

---

## 1. Original Context

Add a new `codemie proxy connect` target that redirects the Codex desktop app (the ChatGPT desktop app's embedded Codex) to CodeMie models through the local CodeMie proxy daemon, mirroring the existing --claude-desktop connector. Approach decided in docs/stories/2026-08-18-codex-desktop-proxy-connect.md: write a `[model_providers.codemie]` custom provider block plus `model_provider = "codemie"` into the USER-LEVEL ~/.codex/config.toml (Codex forbids project-local provider overrides), with base_url pointing at the local proxy, wire_api = "responses", and a static Authorization bearer header carrying the daemon gateway key (NOT written to ~/.codex/auth.json). Pin a single model via `model = "<slug>"` because the Codex desktop model picker filters locally-configured catalog entries. Platforms: macOS + Windows. Must support backup of the pre-existing ~/.codex/config.toml and a disconnect that restores it, preserving unrelated keys and rolling back on partial failure.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/proxy/index.ts` — Commander wiring. `createProxyCommand()` declares the connect target flags (`--claude-desktop`, `--vscode`, `--vscode-claude-code`) plus `--profile/--force/--verbose/--insiders`, and the deprecated `desktop`/`vscode` subcommand aliases. `UnifiedConnectOptions` is at line 31; the new `--codex-desktop` flag belongs at lines 246-266.
- `src/cli/commands/proxy/connect-orchestrator.ts` — the single source of the connect lifecycle: `ConnectTargets` (L47), `ConnectOptions` (L54), `EffectiveClientType` (L63), `deriveDaemonIdentity` (L85), `resolveSsoProxyConfig` (L135), `verifySsoCredentials` (L204), `hasAnyTarget`/`describeTargets` (L250-263), `rollbackDaemon` (L265), `ensureDaemon` (L283), the per-target runners `runClaudeDesktop`/`runVscodeByok`/`runVscodeClaudeCode` (L359-490), and `connectTargets` (L498).
- `src/cli/commands/proxy/connectors/desktop.ts` — closest analogue. `fetchClaudeModels` (L80) queries `/v1/llm_models?include_all=true` through the local proxy with a bearer gateway key; `selectPreferredClaudeModels` (L170); `buildGatewayConfig` (L638); `getDesktopBaseDir` (L653, per-platform split); `describeManagedSettingsOverride` (L665); `getDesktopConfigPath` (L681); `writeDesktopConfig` (L702) implements read-merge-preserve-unrelated-keys with delete-then-rewrite of owned keys.
- `src/cli/commands/proxy/connectors/vscode.ts` — the atomic-write pattern to copy: `writeAtomically` (L204) uses tmp + `rename`, preserves file mode, unlinks tmp on failure; `readProviders` (L173) rejects malformed config with `ConfigurationError` before any write; `writeVsCodeLanguageModelsConfigAtPath` (L236) takes an injectable path for tests.
- `src/agents/plugins/codex/codex.plugin.ts` — the exact provider block to mirror, currently emitted as CLI `--config` overrides in `enrichArgs` (L296-308): `model_provider="codemie"` plus `model_providers.codemie.{name,base_url,env_key,wire_api}`. The header comment (L7-14) documents why a custom provider bypasses `~/.codex/auth.json`.
- `src/agents/plugins/codex/codex.paths.ts` — `getCodexHomePath()` (L30) resolves `CODEX_HOME || ~/.codex`, homedir-based with no Windows-specific branch.
- `src/agents/plugins/codex/codex-models.ts` — `isCodexCompatibleModelName` (L106) and `resolveCodexModel` (L256) for choosing and validating the pinned model slug.
- `src/agents/plugins/kimi/kimi.hook-config-injector.ts` — the only existing TOML read/modify/write in the repo: dynamic `import('@iarna/toml')` behind `loadTomlModule()` (L176), `backupConfig()` writing a `.codemie-backup` sibling (L186), `restore()` via `copyFile` (L155), and a `MANAGED_MARKER` comment header (L41).
- `src/cli/commands/proxy/daemon-manager.ts` — `DaemonState` (L9) carries `url`, `port`, `gatewayKey`, `telemetryMode`, `clientType`, `syncCodeMieUrl`; atomic `writeState` (L43); `checkStatus` (L69).
- `src/providers/plugins/sso/proxy/plugins/index.ts` — `registerCorePlugins()` (L28). `GatewayKeyPlugin` (priority 7) validates the static bearer and strips it before forwarding upstream; `CodexEncryptedContentSanitizerPlugin` (priority 16) already handles Responses-API reasoning state.

### Architecture and Layers Affected

CLI (Commander command in `src/cli/commands/proxy/index.ts`) → orchestrator (`connect-orchestrator.ts`, daemon lifecycle and per-target dispatch) → connector (a pure config writer under `connectors/` with injectable paths) → daemon/proxy plugin pipeline (`src/providers/plugins/sso/proxy`). This matches the repo's `CLI -> Registry -> Plugin` rule. The connector layer must stay scoped to file writes so `connectTargets` retains ownership of rollback.

The proxy pipeline itself needs **no change**: `/v1/responses` already passes through and the Codex encrypted-content sanitizer already covers Responses-API reasoning state.

### Integration Points

- Local proxy daemon on `DEFAULT_DAEMON_PORT = 4001`; state in `~/.codemie/proxy-daemon.json`.
- Model discovery goes through the local proxy (`/v1/llm_models?include_all=true` with the bearer gateway key), never the backend directly.
- CLI-owned marker state under `~/.codemie` via `getCodemiePath()` — the `desktop-managed-mcp-state.json` precedent is directly reusable for recording which keys CodeMie added to `config.toml`.
- External: the Codex desktop app is neither installed nor managed by CodeMie; only its config file is written.

### Patterns and Conventions

- One daemon per connect run. `deriveDaemonIdentity` collapses all targets onto exactly two `EffectiveClientType` values.
- Each per-target runner returns `TargetResult {label, ok, error}` and never throws. Failures are logged with `sanitizeLogArgs`, printed in yellow, and summarized; exit code 1 on any failure. `rollbackDaemon()` runs only when every target failed and the daemon was started this run.
- Config writers: read existing file → raise `ConfigurationError` on malformed input → delete only CodeMie-owned keys → spread-merge → atomic write.
- The gateway key is never an env var for GUI targets. It is written as a static value into the client's own config (Desktop `inferenceGatewayApiKey`, VS Code secret prompt). The new `Authorization` header follows this same rule.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — 5-layer plugin architecture and dependency flow.
- `.ai-run/guides/integration/exposed-api.md` — CLI surface, `CodeMieProxy`/`ProxyConfig`, plugin contracts.
- `.ai-run/guides/integration/external-integrations.md` — provider/agent conventions. Does **not** cover a Codex-desktop connector.
- `.ai-run/guides/usage/project-config.md` — `ConfigLoader`, profiles, env vars, `getCodemiePath`.
- `.ai-run/guides/testing/testing-patterns.md` — Vitest structure and dynamic-import mocking.
- `.ai-run/guides/security/security-practices.md` — credential handling, `sanitizeLogArgs`, path validation.
- `.ai-run/guides/quality-gates.md` — lint/typecheck/build/test gates.
- `docs/stories/2026-08-18-codex-desktop-proxy-connect.md` — the story driving this task, including upstream research links.

### Architectural Decisions

- `codex.plugin.ts:7-14` records why the Codex CLI plugin uses a custom provider rather than `~/.codex/auth.json`.
- `codex.plugin.ts:159` records that the CLI plugin deliberately redirects `CODEX_HOME` to a CodeMie-isolated home **so the native CLI and the Codex desktop app keep the default home**. The new connector must therefore write the default home, not the isolated one.

### Derived Conventions

- GUI-target connectors write static credentials into the client's own config file rather than relying on environment inheritance.
- Marker/ownership state lives under `~/.codemie`, never inside the third-party config.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/proxy/__tests__/connect-wiring.test.ts` — CLI surface only: target-flag to `ConnectTargets` mapping, deprecated-alias notices, option exposure. Mocks `../connect-orchestrator.js`. The new `--codex-desktop` flag test belongs here.
- `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` — daemon identity/matching and orchestration behaviour.
- `src/cli/commands/proxy/__tests__/index.test.ts` — proxy command tree.
- `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts` — connector writer tests with injectable `baseDir` and `managedStatePath`.
- `src/cli/commands/proxy/connectors/__tests__/vscode.test.ts` — atomic-write, merge, and malformed-input cases. Closest template for a TOML writer test.
- `src/cli/commands/proxy/__tests__/daemon-manager.test.ts` — state read/write.
- `src/agents/plugins/codex/__tests__/codex.paths.test.ts` — `CODEX_HOME` resolution.
- `tests/helpers/temp-workspace.ts` — `TempWorkspace` helper for filesystem-writer tests.

### Testing Framework and Patterns

Vitest `^4.1.5` with `unit` / `cli` / `agent` projects (`npm run test:unit`, `test:integration`, `test:all`). Unit tests are co-located in `__tests__/`; integration tests live under `tests/integration/`. Dynamic `import()` after spy setup is the mandated mocking style.

### Coverage Gaps

- **No test covers `KimiHookConfigInjector`** — the repo's only TOML writer. There is no TOML round-trip regression suite at all.
- Codegraph flags `writeDesktopConfig`, `ConnectTargets`, `ConnectOptions`, `ensureDaemon`, and `DesktopGatewayConfig` as having no covering tests — the orchestrator paths a new target touches are thinly covered.
- No test exists for any disconnect/restore path, because no such path exists.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEX_HOME` — resolved by `getCodexHomePath()`. The `codex` CLI plugin redirects it to `~/.codex/codemie/home`; the desktop connector must target the **default** home.
- `CODEMIE_CODEX_MODEL_CATALOG_JSON`, `CODEMIE_CODEX_AVAILABLE_MODELS`, `CODEMIE_CODEX_BIN` — existing Codex-related knobs.
- `CODEMIE_DEBUG` — debug logging.

### Configuration Files

- `~/.codex/config.toml` — the target file for this feature.
- `~/.codex/auth.json` — must not be touched; writing a key there flips the app into API-key auth mode.
- `~/.codemie/proxy-daemon.json` — `DaemonState` including `gatewayKey`.
- `~/.codemie/proxy/desktop-managed-mcp-state.json` — the CLI-owned marker-state precedent.
- `~/.codemie/codemie-cli.config.json` — profiles and `activeProfile`.

### Feature Flags and Deployment Concerns

No feature flags. `DEFAULT_DAEMON_PORT = 4001` is the shared daemon port. The gateway key is a credential at rest in a third-party config file — `sanitizeLogArgs` must cover any logging path that touches it.

---

## 6. Risk Indicators

- **No disconnect path exists anywhere.** `connect-orchestrator.ts` only writes; nothing under `src/cli/commands/proxy/` removes a target's config. `proxy disconnect` is greenfield CLI surface, and it is a hard acceptance criterion.
- **`@iarna/toml` `stringify` is comment- and formatting-lossy.** A naive round-trip of a user's `~/.codex/config.toml` destroys comments and key order, which directly strains the "unrelated settings preserved" criterion. Either splice text surgically or adopt a documented lossy-with-backup contract.
- **`EffectiveClientType` (`connect-orchestrator.ts:63`) is a closed two-value union** wired into `daemonMatchesRequest` and daemon telemetry. Adding a Codex-app identity is cross-cutting; reusing an existing identity is cheaper but mislabels telemetry.
- **Rollback semantics diverge from the ticket.** The orchestrator rolls back only the daemon, and only when every target failed. The story demands per-target config rollback to pre-run state, which `TargetResult` does not currently express.
- **The Kimi backup pattern is a trap.** `backupConfig` (`kimi.hook-config-injector.ts:186-196`) creates the backup once and skips if one exists — copying it means a stale backup silently restores an ancient config on disconnect.
- **The Kimi TOML write is non-atomic** (plain `writeFile`). Use `vscode.ts:writeAtomically` instead.
- **`fetchClaudeModels`/`selectPreferredClaudeModels` filter to `^claude-`** (`desktop.ts:128`) — unusable as-is for pinning a GPT/Codex slug. Needs a parallel selector or generalization.
- **`getCodexHomePath()` is homedir-only.** Windows support is an explicit story requirement and must be verified, and no helper exists to detect whether the Codex desktop app is installed.
- **Thin existing coverage** on exactly the orchestrator symbols a new target touches.
- **No telemetry/session ingestion for a Codex-app surface.** `inspect-desktop.ts` is Claude-Desktop-specific and `telemetryMode` is `'none' | 'claude-desktop'`; the story marks this out of scope, but `DaemonState.telemetryMode` typing will surface the gap.
- Codegraph found **no** existing Codex-desktop connector, `proxy disconnect` command, or `~/.codex/config.toml` writer — the feature is genuinely greenfield in this repo.

---

## 7. Summary for Complexity Assessment

This task spans four layers but adds meaningful new code to three of them. The CLI layer gains one flag and its wiring. The orchestrator gains a per-target runner and — the largest unknown — a decision about whether to extend the closed `EffectiveClientType` union or reuse an existing daemon identity. The connector layer gains a genuinely new artifact: the repo's first TOML config writer that must merge into a file the user's own Codex CLI depends on. The proxy pipeline needs nothing, because `/v1/responses` pass-through and Codex reasoning-state sanitization already exist. Expected surface is roughly 5-9 files including tests.

Technical novelty is concentrated in two places. First, TOML round-tripping: the only precedent (`KimiHookConfigInjector`) is untested, non-atomic, uses a create-once backup that would silently restore stale state, and relies on a stringifier that discards comments and key order. Meeting the "preserve unrelated settings" bar likely requires surgical text splicing rather than parse-and-restringify, which is a design decision the plan must settle explicitly. Second, disconnect: no `proxy disconnect` command exists in any form, so backup, ownership tracking, restore, and per-target rollback are all new surface rather than extensions of an existing path.

Test coverage posture is weak precisely where this work lands. The orchestrator symbols a new target touches are flagged as uncovered, the repo's sole TOML writer has no tests at all, and there is no round-trip regression suite to inherit. Counterbalancing that, the connector-writer test template (`vscode.test.ts`) and the `TempWorkspace` helper are strong, well-established patterns to build on. The dominant risks are the lossy TOML round-trip against a user-owned file, the greenfield disconnect/rollback contract, the cross-cutting client-type union, and unverified Windows path resolution.
