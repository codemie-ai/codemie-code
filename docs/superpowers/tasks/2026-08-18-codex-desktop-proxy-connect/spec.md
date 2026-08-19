# Codex Desktop Proxy Connect — Design Spec

**Date**: 2026-08-18
**Status**: Approved
**Story**: `docs/stories/2026-08-18-codex-desktop-proxy-connect.md`
**Research**: `technical-analysis.md`
**Sizing**: L (23/36)

---

## 1. Goal

Add a `--codex-desktop` target to `codemie proxy connect` that points the Codex desktop app
(the ChatGPT desktop app's embedded Codex) at CodeMie models through the local proxy daemon,
plus a `codemie proxy disconnect` counterpart that reverses it.

The Codex desktop app embeds the same `codex-core` as the Codex CLI and reads the same
user-level `~/.codex/config.toml`. That shared file is the entire integration seam — CodeMie
never installs, launches, patches or calls the app.

---

## 2. Fixed decisions

These were settled with the user and are not open for re-litigation during implementation.

| Decision | Choice |
|---|---|
| Redirect strategy | Custom `[model_providers.codemie]` provider — **not** the `openai_base_url` override |
| Platforms | macOS + Windows (no Linux) |
| Model | Pin a single slug via top-level `model`; the app's picker showing "Custom" is expected |
| Auth | Static `Authorization: Bearer <gatewayKey>` in `config.toml` `http_headers`; **never** touch `~/.codex/auth.json` |
| Codex home | The **default** home the app reads, not the CodeMie-isolated `CODEX_HOME` the CLI plugin uses |
| TOML write | Marker-delimited text splice, with a parse pass for validation only |
| Daemon identity | Extend `EffectiveClientType` with a third `codex-desktop` value |
| Rollback | Atomic write + write-ahead marker state; the shared `TargetResult` contract is untouched |
| App detection | Hard-fail when the app is absent, bypassable with the existing `--force` flag |

Non-negotiable constraint from upstream Codex: `wire_api` **must** be `"responses"`. Codex
removed `"chat"` in February 2026. The proxy already passes `/v1/responses` through and
`CodexEncryptedContentSanitizerPlugin` already handles Responses-API reasoning state.

> **Revised after live testing (2026-08-19).** This spec originally stated the proxy pipeline
> needed no change. That was wrong, and section 11 records what testing found: the desktop app
> overwrites the pinned `model`, so a proxy-side normalizer is required. The user approved the
> change in conversation.

---

## 3. Architecture

Five units. The dependency direction is CLI → orchestrator → connector → pure helpers, matching
the repo's `CLI -> Registry -> Plugin` rule.

| Unit | Kind | Responsibility |
|---|---|---|
| `src/cli/commands/proxy/connectors/codex-config-toml.ts` | new | Pure string functions, zero IO |
| `src/cli/commands/proxy/connectors/codex-desktop.ts` | new | Connector: paths, app detection, model choice, backup, atomic write, marker state |
| `src/cli/commands/proxy/connect-orchestrator.ts` | edit | Target plumbing, third client type, `runCodexDesktop` |
| `src/cli/commands/proxy/disconnect-orchestrator.ts` | new | Marker-driven surgical removal |
| `src/cli/commands/proxy/index.ts` | edit | `--codex-desktop` flag; new `disconnect` subcommand |

### 3.1 `codex-config-toml.ts` — the pure layer

No filesystem access, no network, no logging. Everything here is a total function over strings,
which is what makes the risky part of this feature exhaustively testable.

- `findManagedRegions(text)` → the character ranges of the header and table regions, or absent.
- `stripManagedRegions(text)` → text with both regions removed and displaced keys un-commented.
- `spliceManagedBlocks(text, blocks)` → text with both regions inserted at their required
  positions, replacing any existing regions in place.

### 3.2 The managed-block format

TOML permits top-level keys only *before* the first table header. The managed content is both
top-level (`model_provider`, `model`) and a table (`[model_providers.codemie]`), so it cannot be
one contiguous block appended to a file that already contains tables. Hence **two** regions:

- **Header region — prepended to the top of the file.** Holds `model_provider` and `model`.
- **Table region — appended to the end of the file.** Holds `[model_providers.codemie]` with
  `name`, `base_url`, `wire_api`, and `http_headers.Authorization`.

Each region is delimited by sentinel comments:

- open: `# >>> codemie proxy connect (codex-desktop) - managed block, do not edit`
- close: `# <<< codemie proxy connect (codex-desktop)`

Everything outside the two regions is preserved byte-for-byte. Comments, blank lines, key order
and formatting all survive, because the file is never re-stringified.

### 3.3 Displaced keys

If the file already declares an unmanaged top-level `model_provider` or `model` outside our
regions, leaving it in place would produce a duplicate key and an unparseable file. Each such line is
rewritten in place as a comment carrying a recognizable prefix, so the original text survives
verbatim inside the file. The line stays where the user had it; it is not moved into a managed
region. `stripManagedRegions` recognizes that prefix and restores the line to its original form
on disconnect, so the user's own values come back without relying on the backup.

An unmanaged `model_provider` naming a *different* custom provider is a conflict, not a
displacement: the connector refuses unless `--force`, and names the provider it would displace.

### 3.4 Orchestrator changes

- `ConnectTargets` gains `codexDesktop?: boolean`.
- `EffectiveClientType` becomes `'claude-desktop' | 'vscode-byok' | 'codex-desktop'`.
- `deriveDaemonIdentity` priority: `claude-desktop` (also covers `vscodeClaudeCode`) >
  `codex-desktop` > `vscode-byok`. The Codex identity spawns with no telemetry mode, matching
  `vscode-byok`'s shape but keeping its own label so `daemonMatchesRequest` stays honest and
  analytics do not attribute Codex-app traffic to VS Code.
- `hasAnyTarget` and `describeTargets` learn the new flag; `TARGET_LIST` gains a line.
- `runCodexDesktop(state, config, options)` joins the existing per-target dispatch and returns a
  `TargetResult` exactly like its siblings. The `TargetResult` interface itself does not change.

### 3.5 Config path resolution

A dedicated resolver, not `getCodexHomePath()`.

The two are easy to confuse, so to be precise about what "default home" means in the decision
table: the `codemie-codex` CLI plugin sets `CODEX_HOME` to a CodeMie-isolated path **in the
environment of the child process it spawns**. It never mutates the CLI's own environment. So a
`CODEX_HOME` visible to the `proxy connect` process is one the *user* set, and upstream documents
the desktop app respecting it.

The resolver therefore honours a user-set `CODEX_HOME` and otherwise resolves
`~/.codex/config.toml` from the home directory on both macOS and Windows. What it must never do
is inherit the plugin's isolated home, which is why it does not call `getCodexHomePath()`. The
resolved path is always printed so the user can see which file was touched.

### 3.6 App detection

macOS and Windows each get a candidate list of install locations for the ChatGPT desktop app.
Absence is a hard `ConfigurationError` naming the app and the locations checked, bypassable with
`--force`. Detection is advisory in nature — a false negative must never permanently block a
user, which is exactly what `--force` is for.

### 3.7 Model selection

`codex-models.ts` already owns GPT/Codex compatibility predicates and ranking
(`isCodexCompatibleModel`, the ranking comparator). Those are reused. What differs is the source:
the connector fetches from the **local proxy** (`/v1/llm_models?include_all=true` with the bearer
gateway key), matching the connector convention, rather than calling the backend directly.

The top-ranked compatible model is pinned. A `--model <slug>` option on connect overrides it,
validated against the discovered set. `desktop.ts`'s selectors are `^claude-` bound and are left
untouched.

---

## 4. Connect flow

1. `resolveSsoProxyConfig` → `verifySsoCredentials` (existing shared preamble).
2. `deriveDaemonIdentity` → `ensureDaemon` (existing shared lifecycle).
3. `runCodexDesktop`:
   1. Detect the app. Hard-fail unless `--force`.
   2. Resolve and print the config path.
   3. Discover and rank models through the proxy; resolve the pinned slug.
   4. Read the existing file and **parse it to validate**. Malformed → fail, write nothing.
   5. Detect conflicts and displacements.
   6. Take a backup if our marker is absent; keep the existing backup if it is present.
   7. Write marker state (**write-ahead**, before the config write).
   8. Splice and write atomically via tmp + `rename`.
   9. Return a `TargetResult` carrying the path, the pinned model, and the restart hint.

### 4.1 Why write-ahead marker state is safe

If step 7 succeeds and step 8 fails, the marker claims keys that were never written. Disconnect's
removal is idempotent — stripping regions that do not exist is a no-op — so the over-claim is
harmless. The inverse order would be genuinely unsafe: a written config with no marker is a
config CodeMie cannot later identify as its own.

### 4.2 Rollback

Atomicity makes a half-written `config.toml` impossible, so "rolled back to pre-run state" holds
by construction rather than by compensating action. Every pre-write failure writes nothing at
all. The existing daemon-level rollback (all targets failed, daemon started this run) is
unchanged.

---

## 5. Disconnect flow

New subcommand: `codemie proxy disconnect --codex-desktop`. Bare invocation prints the target
list, mirroring `connect`. The flag vocabulary matches `connect` so other targets can be added
later without a second command shape.

1. Read marker state. Absent → report "nothing to disconnect" and exit 0.
2. Read the config file and parse it.
3. `stripManagedRegions` — remove both regions, un-comment displaced keys.
4. Verify the result parses and that no CodeMie-owned key survives.
5. Write atomically.
6. Clear the marker state.
7. Print the restart hint.

If step 3, 4 or 5 fails, fall back to restoring the backup wholesale.

### 5.1 Deviation from the story, and why

The story's acceptance criterion says the prior configuration is "restored from backup". A blind
backup restore would discard any edits the user made to their Codex config *while connected* —
their file, their edits, silently reverted. So the surgical strip is the primary path and the
backup is the fallback. The end state is identical for the criterion's purpose (plain Codex
behaves exactly as before the first connect), without the collateral data loss.

The backup file is retained after a successful disconnect for manual recovery.

---

## 6. Error handling

Every one of these is a `ConfigurationError` raised **before any write**, surfaced through the
runner as `TargetResult{ok:false}`. The runner never throws into the orchestrator.

| Condition | Behaviour |
|---|---|
| Codex desktop app not found | Fail, naming the app and locations checked; `--force` bypasses |
| `config.toml` is malformed TOML | Fail, naming the path; file untouched |
| Unmanaged `model_provider` names a different provider | Fail, naming it; `--force` bypasses |
| Proxy exposes no Codex-compatible model | Fail, pointing at CodeMie model enablement |
| `--model` slug not in the discovered set | Fail, listing what is available |
| Atomic write fails | Temp file unlinked, original intact, failure reported |

The gateway key is a credential at rest in a third-party file. Every log path that could touch
it goes through `sanitizeLogArgs`.

---

## 7. State and ownership

| Path | Purpose |
|---|---|
| `~/.codex/config.toml` | The file written. User-owned. |
| `~/.codex/config.toml.codemie-backup` | Backup. Refreshed only when our marker is absent. |
| `~/.codemie/proxy/codex-desktop-state.json` | Marker state: config path, backup path, pinned model, written-at. Follows the `desktop-managed-mcp-state.json` precedent. |
| `~/.codex/auth.json` | **Never touched.** Writing a key there flips the app into API-key auth mode and disables ChatGPT-account features. |

---

## 8. Testing

Vitest, unit tests co-located in `__tests__/`, dynamic `import()` after spy setup.

**`connectors/__tests__/codex-config-toml.test.ts`** — carries the weight, since it needs no IO:
empty input; file with only top-level keys; file with tables already present; comments and blank
lines preserved verbatim; keys-before-tables ordering enforced; idempotent re-splice (splicing
twice equals splicing once); the round-trip property `strip(splice(x)) === x`; displaced-key
comment and un-comment; malformed input rejected.

**`connectors/__tests__/codex-desktop.test.ts`** — over `TempWorkspace` with injectable paths:
fresh write; merge into an existing config; backup taken when marker absent; backup preserved
when marker present; atomic-write failure leaves the original intact; marker state written ahead
of the config; app-detection failure writes nothing.

**Existing suites extended** — `connect-wiring.test.ts` for the `--codex-desktop` flag mapping
and the `disconnect` subcommand surface; `connect-orchestrator.test.ts` for identity derivation
and the three-way priority.

**Disconnect** — surgical removal restores the pre-connect file; backup fallback triggers on a
strip failure; absent marker is a clean no-op.

---

## 9. Out of scope

Linux support; the `openai_base_url` strategy; command-backed rotating credentials; generating a
model catalog for the app picker; telemetry or session ingestion for a Codex-app surface; any
patching of the app bundle; per-thread provider switching; MCP provisioning for the Codex app.

---

## 10. Known upstream limitations to document, not fix

- The app's model picker applies a client-side allowlist that filters locally-configured catalog
  entries, so it displays "Custom" rather than the pinned slug. Requests still use the pinned
  model. This is why a single model is pinned rather than a catalog written.
- The app and the `codemie-codex` CLI plugin use different Codex homes by design. Settings and
  history will differ between the two surfaces; the docs must say so.

---

## 11. Revision: the app owns the `model` key (found in live testing, 2026-08-19)

### What testing showed

Connecting worked, but every turn failed with
`/responses: Invalid model name passed in model=gpt-5.6-luna`, and the app then cascaded through
further models that failed the same way.

The connector's marker state recorded a pinned model of `gpt-5-2025-08-07`, while
`~/.codex/config.toml` had been changed to `model = "gpt-5.6-luna"`. Nothing in CodeMie writes
that value. **The Codex desktop app writes its model-picker selection back into the same
`config.toml` the connector manages, overwriting the pinned model.**

The names the picker offers come from the app's own bundled catalog and are undated
(`gpt-5.6-luna`, `gpt-5.5`, `gpt-5.2`). Every CodeMie deployment is dated
(`gpt-5.6-luna-2026-07-09`). Verified directly against the gateway: undated names are rejected,
dated names succeed.

This invalidates section 2's assumption that pinning a model is sufficient and that the picker is
merely cosmetic. The picker is authoritative and persists its choice.

### Two defects, both fixed

**1. No ranking (ours).** `discoverCodexModels` returned the gateway's first entry, which is the
oldest GPT-5, so connect pinned a stale model. Ranking could not reuse `extractVersionParts`,
which reads the version and the release date from one string — `gpt-5-2025-08-07` parses as
version `[5, 2025, 8]` and outranks `gpt-5.6-luna-2026-07-09`'s `[5, 6, 0]`. That inversion is
also why the CLI ranking path carries a hardcoded gpt-5.4 bonus. Added
`splitDeploymentVersion` and `rankCodexModelIdsByRecency`, which strip the date before reading
the version. The CLI path's own bug is filed separately rather than changed here, since CLI model
selection is user-visible.

**2. The picker overwrites the pin.** Fixed with `CodexRequestNormalizerPlugin` (priority 14, the
fourth instance of the existing `*-request-normalizer` pattern), gated on the `codex-desktop`
client type. It rewrites the request's `model` to a deployment the gateway has, matching on model
identity (major, minor, variant) after stripping the release date — so `gpt-5` resolves to
`gpt-5-2025-08-07` rather than colliding with `gpt-5-2` or `gpt-5-mini`. When CodeMie carries
nothing matching, it substitutes the newest available deployment and logs the substitution at
`info`.

The fallback deliberately does **not** read `ProxyConfig.model`: the daemon is spawned before the
connector resolves a model, because discovery goes through the proxy, so that field is routinely
absent. Depending on it made the substitution path dead code.

The resolver is self-contained rather than importing the Codex agent plugin's helpers, because the
proxy must not depend on an agent plugin that installs independently.

### Verified live against the gateway

| Requested | Served by |
|---|---|
| `gpt-5.6-luna` | `gpt-5.6-luna-2026-07-09` |
| `gpt-5.6-sol` | `gpt-5.6-sol-2026-07-09` |
| `gpt-5.6-terra` | `gpt-5.6-terra-2026-07-09` |
| `gpt-5.5` | `gpt-5.5-2026-04-24` |
| `gpt-5.2` | `gpt-5-2-2025-12-11` |
| `gpt-5` | `gpt-5-2025-08-07` |
| `gpt-4o-does-not-exist` | `gpt-5.6-luna-2026-07-09` (substituted, logged) |

### Consequence for section 10

The "picker shows Custom" limitation is now less relevant: the picker remains non-provider-aware,
but selecting any model in it works, because the proxy resolves whatever it sends. `model_catalog_json`
was considered and rejected — upstream filters locally-configured catalog entries out of the picker
(#19694) and a local catalog replaces the bundled one (#29156), and it could not fix
`gpt-5.2` → `gpt-5-2` if the app ignores the catalog.
