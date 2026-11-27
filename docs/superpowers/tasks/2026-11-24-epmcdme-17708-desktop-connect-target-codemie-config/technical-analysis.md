# Technical Research

**Task**: claude-desktop proxy connect configLibrary
**Generated**: 2026-11-24
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-17708 (Bug) — "codemie proxy connect --claude-desktop updates only the active Claude Desktop inference configuration when several configurations exist". QA returned it: FAILED (Return to Dev).

Ticket description (verbatim essentials):
Preconditions: Claude Desktop configuration library contains more than one inference configuration; one configuration other than codemie-proxy is currently active; the codemie-proxy configuration was created earlier by `codemie proxy connect --claude-desktop`; its MCP configuration may have been modified by the user.
Expected: On connect the CLI (1) looks for the codemie-proxy configuration — `_meta.json` contains this information; (2) ensures all fields in that configuration's ${UUID}.json are set as expected, taking into account the user might have modified the MCP configuration; (3) activates the codemie-proxy inference configuration if it is not activated yet.
Acceptance criteria:
AC1: Given several inference configurations exist, when connect runs, the CLI finds the codemie-proxy configuration using the information in _meta.json.
AC2: Given codemie-proxy is found, all fields in its ${UUID}.json are set as expected.
AC3: Given the user modified the MCP configuration in codemie-proxy, those modifications are taken into account and not lost.
AC4: Given codemie-proxy is not active, it is activated.
AC5: Given codemie-proxy is already active, it is not re-activated unnecessarily.
AC6: Given another inference configuration is active, that configuration's ${UUID}.json is not modified.

QA verification (CLI main 6213ddcc, macOS, 2026-11-23): with another config active, connect exits 0 and reports success but overwrites the active "QA Other Gateway" config with CodeMie gateway settings and 42 MCP servers, leaves CodeMie Proxy unchanged (stale port 61111, missing setting), and does not activate it. AC1, AC4, AC6 FAILED; AC5 PASSED; AC2/AC3 passed only when CodeMie Proxy was already active.

ALREADY REPRODUCED in this session (branch fix/epmcdme-17708-desktop-connect off main 5edd7e24) with /tmp/epmcdme-17708-repro/repro.mjs driving dist writeDesktopConfig against a temp configLibrary: written file = QA Other Gateway, appliedId stays QA Other, QA Other baseUrl overwritten, CodeMie Proxy baseUrl stale 61111 and inferenceCredentialKind missing.
Confirmed root cause: src/cli/commands/proxy/connectors/desktop.ts:758 `const configId = appliedConfigId(meta) ?? randomUUID();` — writes whatever config is applied; the name 'CodeMie Proxy' (line 898) is only used when appending a new entry, never to look one up. getDesktopConfigPath (line 711, used by connect-orchestrator.ts:504 for reporting) has the same flaw. writeDesktopConfig also rebuilds _meta.json as {appliedId, entries}, dropping unknown meta fields.

Proposed solution (user-approved direction, research should validate/refine):
1. One resolver for "the CodeMie config" used by writeDesktopConfig and getDesktopConfigPath: (a) the _meta.json entry named 'CodeMie Proxy' with a safe id (file recreated if missing); (b) else the applied entry only if it already points at CodeMie's own local proxy (isDesktopPointedAtLocalProxy / desktopGatewayOfEntry) — covers a renamed entry, still leaves other local gateways alone per EPMCDME-17531; (c) else new UUID + new 'CodeMie Proxy' entry.
2. Write that file and set appliedId to it (only if not already — AC5); preserve every other entry, every other config file, and unknown _meta.json fields; managed MCP reconcile must keep user-added servers (AC3).
3. Report in connect output when the active config was switched (e.g. from "QA Other Gateway" to "CodeMie Proxy").
4. USER DECISION: ALSO include `codemie proxy disconnect --claude-desktop` (removeDesktopConfig, line ~989): locate the CodeMie Proxy entry by the same resolver (not just the applied one) and clean it even when another config is active; must not touch other configs; decide what happens to appliedId when the removed CodeMie entry was not the applied one (leave it) vs was applied (current behaviour: drop appliedId).
5. moveDesktopToNamedKey and readDesktopGateway/readDesktopGatewayState (telemetry claude-desktop.gateway.ts) read the applied entry — assess whether they need the resolver or are correct as-is (they describe what Desktop actually uses).

Open questions to answer from code: the ticket says "codemie-proxy" but the code writes name 'CodeMie Proxy' — confirm the actual name in history/tests and whether any other name variant must be matched; how _meta.json entries look in real Desktop (fields besides id/name); whether duplicate 'CodeMie Proxy' entries are possible and how to pick; existing tests for writeDesktopConfig/removeDesktopConfig/getDesktopConfigPath and connect/disconnect orchestrator output to extend; atomic write helpers (writeFileAtomic) and symlink handling already used in this file.

---

## 2. Codebase Findings

All `desktop.ts` refs are `src/cli/commands/proxy/connectors/desktop.ts`; `gateway.ts` is `src/telemetry/clients/claude-desktop/claude-desktop.gateway.ts`.

### Existing Implementations

**Purpose A — find the config CodeMie owns in `configLibrary`.**
- `appliedConfigId(meta)` `gateway.ts:36` — returns `meta.appliedId` only if `isSafeSessionId` (`src/agents/core/session-id.ts:9`: non-empty, no `/`, `\`, `..`). The only id selector in the repo; every reader/writer selects by *applied*, none by name.
- `writeDesktopConfig` `desktop.ts:734` — selects `appliedConfigId(meta) ?? randomUUID()` (`:758`). Name `'CodeMie Proxy'` appears only at `:898` when appending an entry whose id is absent. No lookup by name anywhere in `src/` (grep `'CodeMie Proxy'` → only `:898` plus comment banners in unrelated files).
- `getDesktopConfigPath` `desktop.ts:711` — same applied-or-random-UUID rule, read-only. Consumer: `claudeConnectTargets` `connect-orchestrator.ts:504` → `desktop.configFile` → `paths.desktopApplied` (`src/agents/plugins/claude/cloud-provider-conflict/adapter-check.ts:39`) → Bedrock-override gate reads that file for `inferenceBedrock*` keys (`resolver.ts:91,339,386`). It is the Bedrock-conflict input, not only reporting.
- `removeDesktopConfig` `desktop.ts:989` — applied entry only (`:1009`); acts only if `isCodeMieGatewayConfig` (`gateway.ts:52`, loopback gateway) and `isDesktopPointedAtLocalProxy` (`gateway.ts:112`, key = daemon key or `.claude-desktop` or sealed). Returns "no applied Claude Desktop config" otherwise.

**Purpose B — recognise "this entry is CodeMie's local proxy" by content.**
- `desktopGatewayOfEntry` `gateway.ts:60` (loopback gateway with port → `{port, apiKey|sealed}`), `isDesktopPointedAtLocalProxy` `gateway.ts:112`, `isDesktopConnectedTo` `gateway.ts:121`. Pure functions taking a parsed entry — usable on any entry, not only the applied one. Local key = `readState()?.gatewayKey ?? DEFAULT_GATEWAY_KEY` (`'codemie-proxy'`, `daemon-manager.ts:24`).

**Purpose C — describe what Desktop actually uses (applied entry).**
- `readDesktopGatewayState` / `readDesktopGatewayConfig` `gateway.ts:84,104`. Consumers: `DesktopConnection.ts:35` (telemetry collection gate), `client-targets.ts:111` (`proxy clients` connected state), `analytics-clients.ts:362,372`, `claude-client-config-state.ts:192` (`decideDesktopRoute`).
- `readDesktopGateway` `desktop.ts:970`. Consumers: `connect-orchestrator.ts:285` (port reuse), `analytics-connectors.ts:114`, `analytics-targets.ts:228`, `analytics-delivery-lines.ts:31`, `analytics-clients.ts:305`.
- `hasAppliedProviderConfig` `claude-client-config-state.ts:162` and `decideDesktopRoute` `:189` — `--claude-otlp` routing; another applied gateway → `skip-other-gateway` (EPMCDME-17531). Only runs when Desktop is not an explicit route (`connect-orchestrator.ts:222`).
- `moveDesktopToNamedKey` `desktop.ts:918` — rewrites only `inferenceGatewayApiKey` of the applied entry when it is a loopback gateway on the daemon port; caller `client-targets.ts:168`. Writes with `writeFileAtomic`.

**Purpose D — keep user MCP edits (AC3).**
- `reconcileManagedMcpServers` `desktop.ts:573` + global marker `getManagedMcpStatePath` `:618` (`readManagedMcpState`/`writeManagedMcpState` `:622,634`). Marker is one file, not per config id; it is applied to whichever file `writeDesktopConfig` targets. Keeps entries not in managed set / not previously managed; strips Desktop's `source` key (`:550`).

Other touched code: `runClaudeDesktop` `connect-orchestrator.ts:769` (prints `✓ Claude Desktop configured`, `Config:` only in verbose, no applied-switch line); `disconnectClaudeDesktop` `disconnect-orchestrator.ts:71` (prints `result.configPath`, `reason`).

### Decisions Already in the Code
- Selection by applied id, not by name — `desktop.ts:758,711,1009`, `gateway.ts:88`; alternative: by `_meta` entry name; reason: none found (dates to `823479c0`).
- Existing entry name is never rewritten — test `desktop.test.ts:691-706` asserts a reused applied entry named `'Default'` keeps its name ("not changed to CodeMie Proxy").
- `_meta.json` write in `writeDesktopConfig` is a rebuild `{appliedId, entries}` (`:900-904`) — drops unknown top-level fields. `removeDesktopConfig` instead spreads `...meta` (`:1073-1077`) and deletes `appliedId`. Two conventions in one file.
- Writes: `writeDesktopConfig` and `removeDesktopConfig` use plain `fs.writeFile` for config and meta (`:877,904,1078,1080`) — follows a symlink, not atomic. `moveDesktopToNamedKey` uses `writeFileAtomic` (`src/utils/atomic-write.ts`, writes through symlink via `realpath`, keeps mode, 0600 new). Linked config on delete: `isSymbolicLink` (`connectors/vscode.ts:326`) → target emptied, link removed (`:1062-1072`). Marker uses temp+rename (`:643-645`).
- Safe-id guard: unsafe `appliedId` → new UUID file, foreign path untouched (tests `desktop.test.ts:708,722,1584`).
- "Other gateway is the user's" rule (EPMCDME-17531): loopback gateway with another key is not CodeMie's (`removeDesktopConfig:1031`, `decideDesktopRoute:195`).

### Task Statements Checked Against the Code
- Root cause at `desktop.ts:758`; name only used on append (`:898`) — **holds**.
- `getDesktopConfigPath` same flaw, "used for reporting" — **holds** for the flaw; **contradicted** on role: it feeds the Bedrock-conflict gate's `desktopApplied` layer (`adapter-check.ts:39`), not only reporting.
- `_meta.json` rebuilt dropping unknown fields — **holds** (`:900-903`).
- Ticket name "codemie-proxy" vs `'CodeMie Proxy'` — code writes `'CodeMie Proxy'` since `823479c0` (only variant in history; `git log -S`). `codemie-proxy` is `DEFAULT_GATEWAY_KEY` (`daemon-manager.ts:24`), the gateway key, not an entry name. No other name variant in code/tests.
- Real Desktop `_meta.json` shape — local `~/Library/Application Support/Claude-3p/configLibrary/_meta.json` holds only `{appliedId, entries:[{id,name}]}` (one CodeMie entry). Whether Desktop writes other fields with several entries — **unverified**; a multi-entry sample written by Desktop would settle it.
- Duplicate `'CodeMie Proxy'` entries possible — **holds** for current code: with no/unsafe `appliedId` and an existing CodeMie entry, `:758` makes a new UUID and `:897` appends a second `'CodeMie Proxy'`. Whether Desktop lets users create same-named entries — **unverified**.
- Proposed resolver (b) "applied entry pointing at our local proxy" — Purpose B helpers exist and take any entry; **holds** that they can express it.
- Point 5 (readers describe what Desktop uses) — **keeps Purpose C in place**: consumers listed under Purpose C; after connect sets `appliedId` to CodeMie's entry they read that entry.
- AC5 "already active not re-activated" — current code always rewrites `appliedId` with the same value (`:901`); file content unchanged in that case.

### Consumers of Changed Contracts
- `writeDesktopConfig` return path: `connect-orchestrator.ts:789` (logged, verbose `Config:`); mocked in `connect-orchestrator.test.ts:69,818-833,1146`, `connect-orchestrator.bedrock-gate.test.ts:43,151-438`. Return type `Promise<string>` — a switched-from name needs a new channel.
- `getDesktopConfigPath`: `connect-orchestrator.ts:504` → Bedrock gate (`resolver.ts:339,386`); mocked as `.../applied.json` in both orchestrator tests; tests `desktop.test.ts:1681-1713`.
- `removeDesktopConfig` / `RemoveDesktopConfigResult` (`desktop.ts:952`): `disconnect-orchestrator.ts:73`; mocked `disconnect-orchestrator.test.ts:264`; tests `desktop.test.ts:1414-1595`.
- `_meta.json` itself: read by `gateway.ts:87`, `claude-client-config-state.ts:166`, `desktop.ts:716,750,927,1001`.
- `desktop.test.ts` writeDesktopConfig fixtures: 8 cases seed `{appliedId, entries:[{name:'X'}]}` with a non-gateway or stale file (e.g. `:734-747` `inferenceGatewayBaseUrl:'http://stale'`, `:691` no file at all) and assert the *applied* file is written — they encode current selection.

### Architecture and Layers Affected
- CLI connector layer: `connectors/desktop.ts` (resolver, write, remove, path).
- CLI orchestration: `connect-orchestrator.ts` (`runClaudeDesktop`, `claudeConnectTargets`), `disconnect-orchestrator.ts`.
- Telemetry client helpers (read-only use): `claude-desktop.gateway.ts`.

### Integration Points
- Claude Desktop 3P `configLibrary/` (`_meta.json`, `<UUID>.json`) — external app-owned files.
- Bedrock-conflict gate in Claude agent plugin via `ProviderSettingsConnectTargets.desktop.configFile`.
- Daemon state (`readState`) for local gateway key; managed-MCP marker under `getCodemiePath`.

### Patterns and Conventions
- Errors: `ConfigurationError` for unreadable meta/config in remove (`:1003,1021`); writer silently resets corrupt JSON to `{}`.
- Logging: `logger.info` + `sanitizeLogArgs`. Imports via `@/` with `.js`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
No `.ai-run/guides/` file mentions Claude Desktop or `configLibrary`. `docs/COMMANDS.md:240-262` documents connect paths per platform; `:95` disconnect; `:277` "collection follows Claude Desktop's config" (applied config) — wording depends on applied-entry semantics.

### Architectural Decisions
None recorded for applied-vs-named selection. Prior analyses (`docs/superpowers/tasks/2026-11-18-epmcdme-17434-.../technical-analysis.md:27`) describe the applied-only remove behaviour.

### Derived Conventions
Pure entry-classifier helpers in `gateway.ts`; side-effecting I/O in `connectors/desktop.ts`; tests use real temp dirs (`tmpdir()` + `mkdir`) with `node:fs/promises` partially mocked (`desktop.test.ts:13`).

---

## 4. Testing Landscape

### Existing Coverage
- `connectors/__tests__/desktop.test.ts` — `writeDesktopConfig` `:594-1412`, `removeDesktopConfig` `:1414-1595` (incl. symlink `:1479,1517`, unsafe id `:1584`, non-CodeMie name `'Local'` `:1449`), `getDesktopConfigPath` `:1681`, `readDesktopGateway` `:1847`, moveDesktopToNamedKey symlinks `:2076-2092`.
- `telemetry/clients/claude-desktop/__tests__/claude-desktop.gateway.test.ts`; `claude-client-config-state.test.ts`; orchestrator tests (mocked desktop module).

### Testing Framework and Patterns
Vitest; temp-dir fixtures; dynamic import after `vi.mock`.

### Coverage Gaps
No test seeds more than one `_meta` entry with a non-CodeMie applied one (the QA scenario); none checks other config files stay byte-identical; none checks unknown `_meta` fields survive a write; no orchestrator output test for Desktop applied-config switching.

---

## 5. Configuration and Environment

### Environment Variables
None specific; base dir from `getClaudeDesktopBaseDir()` (`claude-desktop.paths.ts`; XDG on Linux).

### Configuration Files
`<Claude-3p>/configLibrary/_meta.json`, `<UUID>.json`; managed-MCP marker (`getManagedMcpStatePath`); MDM managed-settings presence check (`describeManagedSettingsOverride` `:695`).

### Feature Flags and Deployment Concerns
None.

---

## 6. Risk Indicators

- Bedrock gate reads `getDesktopConfigPath()` as "applied" file (`adapter-check.ts:39`); changing its target changes which file the gate inspects. See Consumers.
- 8+ `writeDesktopConfig` tests and `:691` encode applied-entry selection (incl. "name preserved") — they will contradict a name-based resolver.
- Speculative: resolver rule (b) with no file for the applied id (`:691` fixture) cannot classify by content.
- Duplicate `'CodeMie Proxy'` entries can already exist from current code (no/unsafe appliedId path); pick rule undefined.
- Real multi-entry `_meta.json` shape unverified; rebuild at `:900` drops unknown fields.
- Global managed-MCP marker is not per-config; reconciling a different file than last time uses names recorded against the other file.
- Non-atomic `writeFile` for config/meta in writer/remover vs `writeFileAtomic` elsewhere in same file.
- `docs/COMMANDS.md` has no text on multiple configurations or applied switching.
- Purpose C readers (telemetry, `proxy clients`, `decideDesktopRoute`) stay applied-based — task point 5 keeps them; see Task Statements.

---

## 7. Summary for Complexity Assessment

The change is confined to the CLI connector `connectors/desktop.ts` (`writeDesktopConfig`, `getDesktopConfigPath`, `removeDesktopConfig`, possibly a shared resolver) plus small output changes in `connect-orchestrator.ts` (`runClaudeDesktop`) and `disconnect-orchestrator.ts`. The content classifiers needed to recognise CodeMie's local-proxy entry already exist as pure functions in `claude-desktop.gateway.ts` and accept any entry. No code today selects a `_meta.json` entry by name; `'CodeMie Proxy'` is the only name ever written (since `823479c0`); `codemie-proxy` in the ticket is the default gateway key.

Novelty is low (file-library bookkeeping), but there are shared-contract touch points: `getDesktopConfigPath` feeds the Bedrock-conflict gate, `writeDesktopConfig` returns only a path, and applied-entry readers (telemetry, `proxy clients`, `--claude-otlp` routing) stay as they are. Two `_meta.json` write conventions coexist (rebuild vs spread).

Test coverage is dense (`desktop.test.ts` ~2100 lines, real temp dirs), but every writer case uses a single applied entry; around 9 existing cases encode applied-entry selection. No test covers multi-entry libraries, untouched sibling configs, or unknown meta fields. Key risks: Bedrock gate target, existing-test contradictions, duplicate CodeMie entries, unverified real multi-entry meta shape.

---

## 8. External References

None named by the task as a source of truth. Referenced artifacts checked: `/tmp/epmcdme-17708-repro/repro.mjs` (resolved) — seeds `_meta` `{appliedId: OTHER, entries:[{id:CODEMIE,name:'CodeMie Proxy'},{id:OTHER,name:'QA Other Gateway'}]}`, CodeMie file at `http://127.0.0.1:61111` without `inferenceCredentialKind`, calls `writeDesktopConfig(PROXY,'gwkey',base,[],marker)`. Local real Desktop `_meta.json` (resolved): `{appliedId, entries:[{id,name:'CodeMie Proxy'}]}` only.
