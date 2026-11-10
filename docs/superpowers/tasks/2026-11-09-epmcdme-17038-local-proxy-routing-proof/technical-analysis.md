# Technical Research

**Task**: analytics evidence routing proxy
**Generated**: 2026-11-09
**Research path**: filesystem

---

## 1. Original Context

Ticket EPMCDME-17038 (Bug, Major): [CLI Analytics] Claude Desktop sessions (and Claude Code sent through the local CodeMie proxy) do not appear in project analytics unless the folder is connected: they are stored as private personal sessions.

Precondition: CLI 0.16.6 on main (contains EPMCDME-16849 commit 9f910c36), profile with ai-run-sso provider, Claude Code analytics connected with `codemie proxy connect --claude-code-otlp`. Clients whose model requests go to the local CodeMie proxy http://127.0.0.1:4001: Claude Desktop connected with `codemie proxy connect --claude-desktop`; Claude Code in a terminal started with ANTHROPIC_BASE_URL=http://127.0.0.1:4001 and the gateway key in ANTHROPIC_AUTH_TOKEN (the two variables `codemie proxy connect --vscode-claude-code` writes).

Actual: in a folder not connected via `codemie proxy analytics connect-folder`, the session is stored as personal (project origin personal, subscription type unknown). In a connected folder it reaches the project but with subscription type unknown and cost in the unknown funding group. The CLI evidence record of every session has routed_via_codemie: false, routing_proof: unproven, funding_route: unknown.

Expected: a Claude Code session whose model requests go through the local CodeMie proxy is recorded as CodeMie-routed and API-funded: funding_route api_based, subscription type codemie; published to the profile project without folder consent like a codemie-claude session; cost in the api_based group.

Cause (confirmed by reproduction): routedViaCodemie (src/agents/core/evidence/routing.ts) accepts a native session's endpoint only when it is under the profile's remote CodeMie URL. The local proxy check exists only for managed codemie-claude launches (CODEMIE_SESSION_ID + CODEMIE_BASE_URL loopback + CODEMIE_TARGET_API_URL equal to profile URL). Desktop/VS Code clients use the local proxy, so the hook records unproven / unknown.

Chosen fix (option A, approved by the user): keep routedViaCodemie pure. Add an optional `localProxy?: { url: string; targetUrl?: string }` to RoutingInput. The claude-code-otlp plugin's extractHookContext (src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts) fills it from the proxy daemon state (readState + isDaemonAlive in src/cli/commands/proxy/daemon-manager.ts, state file ~/.codemie/proxy-daemon.json with url, port, pid, startedAt, targetUrl, profile, provider). A native session is proven routed when codemieProvider is true, the effective endpoint is loopback and its identity equals identity(localProxy.url), and identity(localProxy.targetUrl) equals identity(profile base URL). A loopback endpoint that is not the running CodeMie proxy (or the daemon is dead, or serves a different target) stays unproven. fundingRoute then yields api_based and classify yields codemie with no changes of their own.

Tests to add (ticket): Unit — routedViaCodemie: a native session whose ANTHROPIC_BASE_URL is the running local CodeMie proxy is routed and proven; a loopback endpoint that is not the CodeMie proxy stays unproven; fundingRoute: a session routed through the local proxy gets api_based; classification: such a session is codemie, not unknown. Plus plugin-level test that extractHookContext reads the daemon state.

Investigate: existing tests for routing/funding (src/agents/core/evidence/__tests__/), claude-evidence-inputs tests in claude-code-otlp/__tests__, whether importing daemon-manager from the agents layer violates architecture layering (agents -> cli/commands); if so, find or propose a lower-layer accessor for daemon state (e.g. something under src/utils or src/providers/plugins/sso/proxy). Check hook latency concerns of isDaemonAlive (it may do a network /health check on fallback). Check other callers that construct RoutingInput.

---

## 2. Codebase Findings

### Existing Implementations

**Purpose 1 — prove a session's model requests went through CodeMie.**
- `routedViaCodemie` — `src/agents/core/evidence/routing.ts:166-201`. Pure. Rules:
  - `settingsUnknown` or non-scalar settings value → UNPROVEN (`:168-169`); unknown cloud-flag spelling → UNPROVEN (`:176`); Foundry on → UNPROVEN (`:180`).
  - Endpoint = Bedrock/Vertex base URL when cloud flag on, else effective `ANTHROPIC_BASE_URL` (settings.json `env` wins over process env, `effectiveEndpointEnv` `:91-110`).
  - **Managed branch** (`CODEMIE_SESSION_ID` set, `codemieProvider`) `:185-193`: proven routed iff endpoint identity == `identity(env.CODEMIE_BASE_URL)`, that URL is loopback (`isLoopback` `:58-64`, set `127.0.0.1|localhost|[::1]` `:31`), and `identity(env.CODEMIE_TARGET_API_URL) === identity(profileUrl)`; otherwise UNPROVEN. This is the exact shape the task's new native check mirrors, but fed from env, not daemon state.
  - **Native branch** `:197-199`: proven routed only when endpoint is `underBase` the profile base URL (remote gateway).
  - Fallback `:200`: direct (absent or api.anthropic.com) → PROVEN(false), anything else (including any loopback) → UNPROVEN.
  - `identity()` `:38-45` wraps `apiIdentity` (`src/agents/core/evidence/api-identity.ts:7-19`): lowercases host, drops default port, collapses/strips trailing slashes. It does **not** map `localhost` ↔ `127.0.0.1`.
  - `profileUrl()` `:47-56`: `profileBaseUrl`, else `CODEMIE_PROFILE_CONFIG.baseUrl`.
- `RoutingInput` — `routing.ts:7-21`: `env`, `settingsEnv?`, `settingsUnknown?`, `codemieProvider`, `profileBaseUrl?`. No daemon-related field today.
- Only production constructor of `RoutingInput`: `ClaudeCodeOtlpPlugin.extractHookContext` — `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:108-136`. Builds `routingInput` (`:117-123`) from `process.env`, `readClaudeSettingsEnv(cwd)`, `loadHookConfig(cwd)`; `codemieProvider` = provider authType `sso` or `authMethod jwt` (`:115-116`).

**Purpose 2 — say who pays (funding route).**
- `fundingRoute` — `routing.ts:151-164`: proven+routed → `api_based` (`:153`); no other change needed for a routed result. `oauthAccountPays` `:132-139` — false whenever `ANTHROPIC_AUTH_TOKEN` is present (the VS Code connector writes one), so organization is withheld for these sessions regardless.

**Purpose 3 — classify / publish to the profile project.**
- `classify` — `src/agents/core/evidence/classify.ts:36-54`: `routed_via_codemie` true → `codemie`/`routed` (`:37`), independent of everything else.
- Record is frozen at first stamp: `hookTimeFields` `src/agents/core/evidence/stamp.ts:33-61` copies `routing.routed`, `routing_proof`, `funding_route`; existing records are returned unchanged (`stamp.ts:~130-134`).
- Wire: `evidence-send.ts:82-90` sends `routedViaCodemie` and `contract.fundingRoute`; `subscriptionType: result.class` (`evidence-send.ts:83`); headers in `header-injection.plugin.ts:84-118` (`X-CodeMie-Routed-Via-CodeMie`, funding header, consent header only with consent+project).

**Purpose 4 — know the running local proxy and its upstream.**
- `DaemonState` / `readState` / `isDaemonAlive` — `src/cli/commands/proxy/daemon-manager.ts:12-36, 88-103`. State file `join(getCodemieHome(),'proxy-daemon.json')` (`:51`, honours `CODEMIE_HOME`, resolved at module load). Written by `src/bin/proxy-daemon.ts:241-257` with `url`, `port`, `pid`, `targetUrl: config.targetApiUrl`, `profile`, `provider`, `startedAt`, `gatewayKey`.
- Daemon `url` form: `http://${bindHost}:${port}` (`src/providers/plugins/sso/proxy/sso.proxy.ts:228`), daemon host `127.0.0.1` (`proxy-daemon.ts:90`); default port 4001 (`connect-orchestrator.ts:68`).
- `checkStatus` `daemon-manager.ts:274-286` = readState + isDaemonAlive, but **clears the state file** when dead (side effect).
- Existing hook-time readers of daemon state: `resolveHookCredentials` `src/agents/core/hook-credentials.ts:1,25`; `forwardOtlpEventsToSpool` `src/agents/plugins/utils.ts:2,27`; `resolveAnalyticsEndpoint` `otlp-spool/classification.ts:133` (dynamic import). None calls `isDaemonAlive`.

### Decisions Already in the Code
- `routing.ts` is pure by design (header comment `:3-6`: "callers pass process env, the settings.json env block, and profile facts"). Alternative (I/O in routing) not taken; reason recorded only in that comment.
- Loopback proof requires target equality with profile URL (managed branch `:189-191`); comment `:186` "the preserved upstream must be the configured model route".
- "Analytics URL is never proof" (`:195-196`); tests assert analytics URL as target → unproven (`routing.test.ts:110-114`).
- Agents/providers already import `cli/commands/proxy/daemon-manager.js` directly (three sites above) — established convention despite the guide's `CLI → Registry → Plugin → Core → Utils` direction (`.ai-run/guides/architecture/architecture.md:149-155`). No `src/utils` or `src/providers` accessor for daemon state exists.
- `isDaemonAlive` cost: `process.kill(pid,0)`; then on POSIX `isOwnerAlive` spawns `ps -o etime=` (`src/utils/processes.ts:185-196`, `PS_TIMEOUT_MS = 1000` `:168`); only if start time mismatches, `fetchProxyHealth` to `127.0.0.1:<port>/health` with 1500 ms timeout (`health-check.ts:61-62`, `SHALLOW_TIMEOUT_MS`). Windows: pid only.
- `extractHookContext` runs on every forwarded hook (`src/agents/core/OtlpAgentAdapter.ts:142`), after `isTracked`/`transitionGate`; only the first stamp's routing is kept.

### Task Statements Checked Against the Code
- "routedViaCodemie accepts a native session's endpoint only when under the profile's remote URL" — **holds** (`routing.ts:197-200`).
- "Local proxy check exists only for managed launches (CODEMIE_SESSION_ID + loopback CODEMIE_BASE_URL + CODEMIE_TARGET_API_URL == profile)" — **holds** (`routing.ts:185-193`).
- "State file ~/.codemie/proxy-daemon.json with url, port, pid, startedAt, targetUrl, profile, provider" — **holds** (`proxy-daemon.ts:241-257`; path via `getCodemieHome`, so `CODEMIE_HOME` relocates it).
- "fundingRoute then yields api_based and classify yields codemie with no changes of their own" — **holds** (`routing.ts:153`, `classify.ts:37`).
- "Published to the profile project without folder consent like a codemie-claude session" — **unverified** in this repo: backend applies the publication rule; client sends routed flag + funding header (`header-injection.plugin.ts:84-118`). A recorded backend contract sample would settle it.
- "isDaemonAlive may do a network /health check on fallback" — **holds** (`daemon-manager.ts:93`), plus a `ps` spawn first (`processes.ts:189`).
- "Importing daemon-manager from agents violates layering" — **contradicted as practice**: `hook-credentials.ts:1` (agents/core) and `plugins/utils.ts:2` already do; the guide text says direction is CLI→…→Utils.
- "Claude Desktop sessions reach the hook with the endpoint = local proxy" — **unverified**: Desktop connector writes `inferenceGatewayBaseUrl: proxyUrl` (`connectors/desktop.ts:95,710`), not `ANTHROPIC_BASE_URL`; how Desktop exposes that to the hook process's env/settings is outside the repo (ticket says reproduced).

### Consumers of Changed Contracts
- `RoutingInput` (adding optional field): `claude-code-otlp.plugin.ts:117-131` (also spread into `oauthAccountPays` and `fundingRoute` — extra field harmless there); tests `routing.test.ts`, `funding-route.test.ts`, `matrix.test.ts`, `attribution-headers.test.ts`, `publication-wire.test.ts`. Optional field → all still compile.
- `routedViaCodemie` result: `stamp.ts:49-50`, `classify` via `classification.ts:63`, `evidence-send.ts:82`, `header-injection.plugin.ts:42,87,101`. Only the value changes for native+loopback sessions.
- `daemon-manager` module, if moved/re-exported: importers `hook-credentials.ts`, `plugins/utils.ts`, `classification.ts`, `proxy-daemon.ts:22`, ~15 `src/cli/commands/proxy/*` files; test mocks of `@/cli/commands/proxy/daemon-manager.js` in `OtlpAgentAdapter.test.ts:61-68`, `hook-credentials.test.ts`, `otlp-forward.test.ts`.

### Architecture and Layers Affected
- Core: `src/agents/core/evidence/routing.ts`.
- Plugin: `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts` (`extractHookContext`).
- CLI-layer module used as a library: `src/cli/commands/proxy/daemon-manager.ts`.

### Integration Points
- Proxy daemon state file (written by `src/bin/proxy-daemon.ts`), proxy `/health`, `ps`. Downstream: OTLP spool → forwarder → analytics API headers.

### Patterns and Conventions
- Never-throw hook helpers returning `null` on failure (`hook-credentials.ts:31-34`, `readState` `:96-103`).
- `@/` alias + `.js` imports; tests use `vi.mock` + dynamic `await import` after mocks (`claude-evidence-inputs.test.ts:3-14`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/architecture/architecture.md` (layer direction `:149-155`). `docs/ARCHITECTURE-OTLP-PLUGIN.md` (adapter contract; AGENTS.md: common fields resolved at hook time inside `processOtlpEvent`).

### Architectural Decisions
- Purity comment `routing.ts:3-6`; `fundingRoute` doc `routing.ts:143-150` (api_based only on positive proof).

### Derived Conventions
- Proof checks compare `apiIdentity` strings; unproven never yields personal (`classify.ts:51-52`).

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/core/evidence/__tests__/routing.test.ts` (264 lines): managed loopback cases using real `setupProxy` env (`:64-121`), native, direct cases; helper `input(env, extra)` `:51-53`.
- `funding-route.test.ts` (91): `base()`/`funding()` helpers; managed loopback → api_based `:19-28`.
- `classify.test.ts` (69), `matrix.test.ts` (184, routing × launch mode × scope), `routing-contract.test.ts` (290).
- `claude-code-otlp/__tests__/claude-evidence-inputs.test.ts` (132): mocks settings, org, `loadHookConfig`, `ProviderRegistry`; asserts full `evidenceInputs`. Does **not** mock `daemon-manager`.

### Testing Framework and Patterns
- Vitest; `vi.mock` before dynamic import; process.env cleaned in `beforeEach`.

### Coverage Gaps
- No test of a native session with a loopback endpoint other than "unproven" fallback; nothing exercises daemon state in routing. `claude-code-otlp.plugin.test.ts` and `claude-evidence-inputs.test.ts` would hit the real `~/.codemie/proxy-daemon.json` if `extractHookContext` begins reading it unmocked.

---

## 5. Configuration and Environment

### Environment Variables
- `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CODEMIE_SESSION_ID`, `CODEMIE_BASE_URL`, `CODEMIE_TARGET_API_URL`, `CODEMIE_PROFILE_CONFIG`, `CODEMIE_HOME` (state-file location).

### Configuration Files
- `~/.codemie/proxy-daemon.json` (daemon state, includes `gatewayKey`); Claude `settings.json` `env` block; VS Code settings written by `connectors/vscode-claude-code.ts:156-157`; Desktop config `inferenceGatewayBaseUrl` (`connectors/desktop.ts`).

### Feature Flags and Deployment Concerns
- None found for routing.

---

## 6. Risk Indicators

- Layering: `daemon-manager.ts` lives in `src/cli/commands/proxy/`; three non-CLI modules already import it (see Decisions). A new import repeats the pattern; any relocation touches all importers and test mocks (see Consumers).
- Hook latency: `isDaemonAlive` spawns `ps` (≤1 s) and may fetch `/health` (≤1.5 s) on each forwarded hook, since `extractHookContext` runs per hook (`OtlpAgentAdapter.ts:142`); routing is used only at first stamp.
- `checkStatus` deletes the state file when the daemon looks dead — a side effect if used from the hook instead of `readState`+`isDaemonAlive`.
- Identity mismatch: daemon `url` is `http://127.0.0.1:<port>`; a client configured with `http://localhost:4001` has a different `apiIdentity` and stays unproven (`api-identity.ts:17-19`).
- `targetUrl` vs profile base URL: daemon target comes from the profile used at `proxy connect`; a hook resolving a different profile (`loadHookConfig(cwd)`) yields unproven.
- Desktop endpoint visibility to the hook (`inferenceGatewayBaseUrl`, not `ANTHROPIC_BASE_URL`) is unverified in-repo.
- Existing plugin tests read the real daemon state file unless `daemon-manager` is mocked (Coverage Gaps).
- Speculative: records created before the fix stay frozen unproven (first-wins stamp, `stamp.ts`), so in-flight sessions do not change.

---

## 7. Summary for Complexity Assessment

The change touches the Core evidence layer (`routing.ts` — `RoutingInput` and the native branch of `routedViaCodemie`) and the `claude-code-otlp` plugin's `extractHookContext`, which is the only production builder of `RoutingInput`. The proof shape already exists for managed launches (loopback endpoint == proxy URL, target == profile URL, `routing.ts:185-193`); the task feeds the same comparison from daemon state instead of env. `fundingRoute` and `classify` already map a proven routed result to `api_based` / `codemie`, and the wire/header path consumes the record unchanged.

Daemon state access has a precedent: `hook-credentials.ts` (agents/core) and `plugins/utils.ts` already import `readState` from `src/cli/commands/proxy/daemon-manager.ts`; no lower-layer accessor exists. `isDaemonAlive` is new at hook time and costs a `ps` spawn plus a possible 1.5 s `/health` fetch per hook.

Tests are well established and helper-based (`routing.test.ts`, `funding-route.test.ts`, `classify.test.ts`, `claude-evidence-inputs.test.ts`); none cover a native loopback endpoint proven via daemon state, and the plugin tests would need a `daemon-manager` mock. Key risks: localhost/127.0.0.1 identity mismatch, profile/target mismatch, hook latency, and unverified Desktop endpoint exposure.

---

## 8. External References

None named by the task (all named paths are in this repository and covered in Section 2).
