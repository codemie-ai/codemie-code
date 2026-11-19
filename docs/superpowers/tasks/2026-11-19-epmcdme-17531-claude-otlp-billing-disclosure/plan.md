# EPMCDME-17531 --claude-otlp stops rerouting configured Claude clients — Implementation Plan

**Goal:** `codemie proxy connect --claude-otlp` installs analytics for every Claude client but routes the VS Code extension / Claude Desktop through the CodeMie gateway (billed to the CodeMie budget) only when that client is not configured yet. Explicit `--vscode-claude-code` / `--claude-desktop` still route it, and the output says that the CodeMie budget pays.

**Architecture:** A new detector module (`claude-client-config-state.ts`) reads each client's current configuration. Before dispatch, the orchestrator turns that into a per-client route decision and narrows `activeTargets`, so the existing `run*` functions stay unchanged. Explicit flags come from Commander's `getOptionValueSource(...) === 'cli'` (an `.implies` value reads `'implied'`). Layering stays CLI → orchestrator → connector.

**Tech Stack:** TypeScript (ES modules, `.js` imports, `@/` alias), Commander, chalk, Vitest.

## Global Constraints
- `--claude-otlp` must never overwrite a client config it did not write. When the detector is unsure (timeout, non-zero exit, unparseable output), the client counts as configured and is not rerouted; the cause goes to `logger.debug(..., ...sanitizeLogArgs(...))`.
- No new CLI flag. `disconnect --claude-otlp` behaviour does not change.
- Billing line text, verbatim: `  Its model requests now use your CodeMie budget (profile <state.profile>), not your Claude login.` It is printed only after a successful route. It is never printed on skipped or failed targets, and never for `--claude-code-otlp` alone.
- Use `exec()` from `src/utils/exec.ts` (never `child_process`), with a timeout of about 5 s. No `any`, explicit return types, no `console.log` debug output.
- Bare-list rows stay at 100 chars or fewer (`__tests__/target-lists.test.ts:62`).
- Tests use scratch HOME and injected seams only. Never touch the real keychain, `~/.claude*` or the real VS Code settings.
- Commit per task using the repository's existing convention.

## Assumptions and alignment notes
- **Desktop 1p (unverified live):** Desktop counts as 1p (own Claude account) when the 1p data dir exists (macOS `~/Library/Application Support/Claude`, Windows `%APPDATA%\Claude`, Linux `${XDG_CONFIG_HOME:-~/.config}/Claude`) and `Claude-3p/claude_desktop_config.json` lacks `deploymentMode: "3p"`. Open questions: does writing a Claude-3p config actually switch a 1p user, and is there a reliable 1p sign-in marker (the session lives in Electron cookies)? This does not block the work.
- **PO alignment:** this reverses part of EPMCDME-17392 (#833, commit 252233ba), which made `--claude-otlp` always route Desktop and the extension. The PO must confirm the behaviour change. The CHANGELOG states it.
- Users already routed by #833 keep their route. Connect and status print the way back (`codemie proxy disconnect --vscode-claude-code` / `--claude-desktop`).

## Acceptance criteria
- [ ] Extension, `--claude-otlp`: the route is written (and the billing line printed) only when `claude auth status` with `ANTHROPIC_*` stripped reports `authMethod: "none"` and no foreign `claudeCode.environmentVariables` route exists. Our own existing route is refreshed. Otherwise there is no write, the line `✓ VS Code Claude Code extension: analytics on (uses your Claude login; model routing unchanged)` is printed, and settings.json is byte-identical.
- [ ] Desktop, `--claude-otlp`: the gateway is written when there is no applied Claude-3p config, or when the applied config already points at the local proxy (refresh). It is skipped (with the skip line naming `codemie proxy connect --claude-desktop`) when Desktop uses another gateway, a non-gateway applied config, or 1p. "Configured, not installed yet" is printed only when there is neither a 1p dir nor a 3p config.
- [ ] Explicit `--vscode-claude-code` / `--claude-desktop` (with or without `--claude-otlp`) always route the client and print the billing line.
- [ ] Claude Code hooks and OTel are unchanged. `--claude-code-otlp` alone prints nothing about billing.
- [ ] `proxy analytics status`: the extension is `connected` when the hooks are installed. Being routed through CodeMie is shown as a note together with the disconnect hint.
- [ ] The interactive `--claude-otlp` confirmation names the clients that will be routed (billed to CodeMie), and says nothing when none will be.
- [ ] Help, README, docs and CHANGELOG describe the new behaviour. `--claude-desktop` help mentions the model route.

---

### Task 1: Client-configuration detector

**Files:**
- Modify: `src/utils/exec.ts:11-17,75`: add `unsetEnv?: string[]` to `ExecOptions` and delete those keys from the merged env. Passing env can only add keys, so this is the only way to strip `ANTHROPIC_*`.
- Modify: `src/telemetry/clients/claude-desktop/claude-desktop.paths.ts`: add `getClaudeDesktopFirstPartyDir(): string`, next to `getClaudeDesktopBaseDir` (same per-platform branches, dir `Claude`; Windows uses `%APPDATA%`).
- Modify: `src/cli/commands/proxy/connectors/vscode-claude-code.ts:315-338`: add `readVsCodeClaudeCodeRouteState(insiders): Promise<'none'|'ours'|'foreign'>`. It returns `ours` for a loopback `ANTHROPIC_BASE_URL` (same check as `readVsCodeClaudeCodeGateway`), `foreign` for any other `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` entry, and `none` otherwise or when there is no product dir.
- Create: `src/cli/commands/proxy/claude-client-config-state.ts`
- Test: `src/cli/commands/proxy/__tests__/claude-client-config-state.test.ts`, `src/utils/__tests__/exec.test.ts` (one `unsetEnv` case)

**Interfaces (produces):**
```ts
export type ClaudeLoginState = 'logged-out' | 'configured';
export type VsCodeRouteDecision = 'route' | 'refresh' | 'skip';
export type DesktopRouteDecision = 'route' | 'refresh' | 'skip-other-gateway' | 'skip-1p';
export interface ClaudeClientConfigSeams {
  exec?: typeof exec;
  resolveClaudeBinary?: () => Promise<string | null>; // PATH via getCommandPath, else newest ~/.vscode{,-insiders}/extensions/anthropic.claude-code-*/resources/native-binary/claude[.exe]
  claudeJsonPath?: string;   // default resolveHomeDir('.claude.json')
  desktop3pDir?: string; desktop1pDir?: string;
}
export async function detectClaudeLogin(seams?: ClaudeClientConfigSeams): Promise<ClaudeLoginState>;
export async function decideVsCodeRoute(insiders: boolean, seams?: ClaudeClientConfigSeams): Promise<VsCodeRouteDecision>;
export async function decideDesktopRoute(seams?: ClaudeClientConfigSeams): Promise<DesktopRouteDecision>;
```
- `detectClaudeLogin` runs `<bin> auth status --json` with `timeout: 5000` and `unsetEnv` set to every `ANTHROPIC_*` key in `process.env`. `authMethod === 'none'` gives `logged-out`. Any other method, an exec error, a non-zero exit or unparseable output gives `configured` (logged via `logger.debug`). With no binary it falls back to `~/.claude.json`: an `oauthAccount` key gives `configured`, an absent file or key gives `logged-out`.
- `decideVsCodeRoute`: route state `ours` gives `refresh`, `foreign` gives `skip`, and `none` gives `route` when logged out, otherwise `skip`.
- `decideDesktopRoute`: read `configLibrary/_meta.json` → `appliedConfigId` and `readDesktopGatewayState(desktop3pDir)`. A loopback `gateway` gives `refresh`. An applied config that is not a loopback gateway (foreign gateway, other provider, unreadable) gives `skip-other-gateway`. No applied config, with the 1p dir present and no `deploymentMode: "3p"` in `claude_desktop_config.json`, gives `skip-1p`. Otherwise `route`.

- [ ] Step 1: Write failing tests:
  - Login: stubbed exec returning `none` / `claude.ai` / `oauth_token` / `api_key` → logged-out / configured / configured / configured.
  - With `process.env.ANTHROPIC_BASE_URL` set, the exec call receives `unsetEnv` containing it.
  - Exec rejects or times out → configured.
  - Binary missing: scratch `.claude.json` with `oauthAccount` → configured; without it → logged-out.
  - VS Code decision table over route state × login.
  - Desktop table over scratch dirs: empty → route; loopback gateway → refresh; foreign gateway → skip-other-gateway; 1p dir without 3p config → skip-1p; 1p dir plus `deploymentMode: "3p"` → route.
  - `exec` deletes `unsetEnv` keys.
- [ ] Step 2: Run `npx vitest run src/cli/commands/proxy/__tests__/claude-client-config-state.test.ts src/utils/__tests__/exec.test.ts` and confirm it fails.
- [ ] Step 3: Implement. Step 4: Re-run and confirm it passes.

Test-first: yes — the decision functions return `route` for a logged-in user (claude.ai) and for a foreign Desktop gateway, and the `ANTHROPIC_*` stripping test fails because `exec` has no `unsetEnv`.

### Task 2: Route decision in connect, skip lines and billing line

**Files:**
- Modify: `src/cli/commands/proxy/index.ts:356-382`: pass `explicitRoutes: { claudeDesktop: connect.getOptionValueSource('claudeDesktop') === 'cli', vscodeClaudeCode: connect.getOptionValueSource('vscodeClaudeCode') === 'cli' }`.
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts`:
  - Add `explicitRoutes?` to the connect options type.
  - Add the decision step after `activeTargets` (:976), before `membersNotFound` (:977) and `failDesktopWithoutCodeMieUrl` (:1021).
  - Billing line in the success branches of `runVscodeClaudeCode` (:715) and `runClaudeDesktop` (:620).
- Test: `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` (mock `../claude-client-config-state.js`; reuse `printed()` and the mocked connectors at :84), `__tests__/index.test.ts` (explicit vs implied source)

**Interfaces:**
- Consumes: Task 1's `decideVsCodeRoute`, `decideDesktopRoute`.
- Produces: `resolveClaudeRoutes(activeTargets, aggregates, explicitRoutes, insiders): Promise<ClaudeRoutePlan>`, module-private in the orchestrator. `ClaudeRoutePlan = { routed: AnalyticsMember[]; skipped: { member: AnalyticsMember; line: string }[] }`. It runs only for members that `claude-otlp` set and that `explicitRoutes` did not set. A skip clears `activeTargets[member]`, so neither `membersNotFound` nor the run functions see it. Skip lines are printed right after the profile line. `refresh` keeps the target and adds the hint `To use your Claude login instead: codemie proxy disconnect --<flag>`. Also produces `routeBillingLine(profile: string): string`.
- Skip line texts:
  - Extension: `✓ VS Code Claude Code extension: analytics on (uses your Claude login; model routing unchanged)`.
  - Desktop 1p: `– Claude Desktop: skipped — uses your own Claude account. Desktop analytics needs the CodeMie gateway; to switch it (billed to your CodeMie budget): codemie proxy connect --claude-desktop`.
  - Desktop other gateway: `– Claude Desktop: skipped — it uses another gateway. …` with the same switch command.

- [ ] Step 1: Write failing tests:
  - `--claude-otlp` with the extension in each decision state: skip → `writeVsCodeClaudeCodeConfig` not called and the skip line is printed; route → called and the billing line follows the `✓ … configured` line; refresh → called, and the hint is printed.
  - Desktop route / skip-other-gateway / skip-1p: Desktop writer called or not called, with the matching skip line. A skipped Desktop with no `codeMieUrl` is not recorded as failed.
  - `--claude-otlp --vscode-claude-code --claude-desktop`: the decision functions are not consulted, both clients are routed, and two billing lines are printed.
  - Skipped (`ClientNotInstalledError`) and failed writes print no billing line.
  - `--claude-code-otlp` alone: no `CodeMie budget` in the output.
  - `index.test.ts`: `explicitRoutes` is false for implied values and true for typed flags.
- [ ] Step 2: Run `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts src/cli/commands/proxy/__tests__/index.test.ts` and confirm it fails.
- [ ] Step 3: Implement. Step 4: Re-run and confirm it passes.

Test-first: yes — `--claude-otlp` for a logged-in user still calls `writeVsCodeClaudeCodeConfig`, and the configured extension and Desktop print no billing line.

### Task 3: Interactive confirmation names the routed clients

**Files:**
- Modify: `src/cli/commands/proxy/prompts/analytics-confirmation.ts:9-18,94-106`
- Modify: `src/cli/commands/proxy/claude-code-otlp-flow.ts:20-23,65-94` (pass the field through)
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts:1028-1035` (`otlpDisplay`)
- Test: the existing analytics-confirmation prompt test (find it with `Glob src/cli/commands/proxy/**/analytics-confirmation*.test.ts`), plus one case in `connect-orchestrator.test.ts`

**Interfaces:** Adds `routedClients?: string[]` (labels from `MEMBER_LABELS`) to `AnalyticsConfirmationOptions` and `ClaudeCodeOtlpDisplay`, filled from `ClaudeRoutePlan.routed` (Task 2). When it is non-empty, `buildAnalyticsConfirmationMessage` appends a note wrapped like `INVALID_ALLOWLIST_NOTE`: `<A and B> will be routed through the CodeMie proxy; their model requests are billed to your CodeMie budget, not your Claude login.` Nothing is added when it is empty or absent. Other prompt lines are not reworded (EPMCDME-17530 owns them).

- [ ] Step 1: Write failing tests: the message with `routedClients: ['Claude Desktop']` contains `CodeMie budget` and `Claude Desktop`; with `[]` it does not. The orchestrator passes `routedClients` equal to the planned routes, and passes empty when both clients are skipped.
- [ ] Step 2: Run both files and confirm they fail. Step 3: Implement. Step 4: Re-run and confirm they pass.

Test-first: yes — a `--claude-otlp` confirmation with a client planned for routing has no billing mention.

### Task 4: Analytics status — extension connected by hooks

**Files:**
- Modify: `src/cli/commands/proxy/analytics-clients.ts:139-142,330-375`: extension `connected: hooks`. Add `routed: boolean` to `AnalyticsClientRow` (extension: `isExtensionRouted(...)`; Desktop: `desktopConnected`; others: false). Keep `isExtensionRouted` for `routed`, and update the doc comment at :339-342.
- Modify: the status renderer that consumes the rows (`analytics-clients.ts:~395-410`, next to the `otherGateway` hint): print `routed through CodeMie (billed to your CodeMie budget) — to use your Claude login: codemie proxy disconnect --vscode-claude-code` for a routed extension row.
- Test: `src/cli/commands/proxy/__tests__/analytics-clients.test.ts`

- [ ] Step 1: Write failing tests: hooks on with no route → extension `connected: true, routed: false`; hooks on plus a loopback route → `routed: true` and the rendered hint contains `disconnect --vscode-claude-code`; hooks off plus a route → `connected: false`.
- [ ] Step 2: Run and confirm it fails. Step 3: Implement. Step 4: Re-run and confirm it passes.

Test-first: yes — with hooks on and no route, the extension row reports `connected: false`.

### Task 5: Help, list texts, docs, CHANGELOG

**Files:**
- Modify: `src/cli/commands/proxy/analytics-clients.ts:61-69`: claude-otlp `connectDescription`. New content: analytics for every Claude client; the extension and Desktop are routed through CodeMie (billed to the CodeMie budget) only when they are not configured yet; `--vscode-claude-code` / `--claude-desktop` route them explicitly. Update `connectListLine` if needed, keeping it at 100 chars or fewer.
- Modify: `src/cli/commands/proxy/index.ts:332,334`: the `--claude-desktop` help says it routes Desktop's model requests through the CodeMie gateway and writes MCP servers, billed to the CodeMie budget. The `--vscode-claude-code` help adds the billing note too.
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts:~363`: `CONNECT_TARGET_LIST` note (split into two rows if it exceeds 100 chars).
- Modify: `README.md:722`, `docs/COMMANDS.md:104,1874`, `docs/PROXY-AND-ANALYTICS.md:42`, and `CHANGELOG.md` (entry: `--claude-otlp` no longer switches already-configured Claude clients to the gateway; the explicit flags do and say the CodeMie budget pays).
- Test: `__tests__/analytics-clients.test.ts`, `__tests__/index.test.ts`, `__tests__/target-lists.test.ts:77-86`

- [ ] Step 1: Write failing tests: the claude-otlp `connectDescription` contains `not configured` and `CodeMie budget`; the `--claude-desktop` and `--vscode-claude-code` `Option.description` contain `CodeMie budget`, and the Desktop one mentions the model route; update the verbatim note pin in `target-lists.test.ts`.
- [ ] Step 2: Run the three files and confirm they fail. Step 3: Implement the strings, then update the docs with the same sentence. Step 4: Re-run and confirm they pass.

Test-first: yes — the help descriptions still say that `--claude-otlp` always routes Desktop and the extension, and they lack `CodeMie budget`.

### Task 6: Opt-in real-CLI integration test

**Files:**
- Create: `tests/integration/proxy-connect-claude-route-decision.test.ts`

**Interfaces:** Consumes `runIsolatedCli`, `realDir`, `describeRun` from `tests/helpers/isolated-cli.ts`, and seeds `codemie-cli.config.json` the way `tests/integration/hook-proxy-cold-start-profile.test.ts:118-133` does.

Design:
- `describe.skipIf(!process.env.CODEMIE_IT_SSO_BASE_URL)`, skipped on win32. A header comment explains how to run it.
- Each case gets a fresh `realDir(mkdtemp)` for `HOME` and `CODEMIE_HOME`, with `XDG_CONFIG_HOME=<home>/.config` and `PATH` stripped of `claude`, so the `~/.claude.json` fallback decides.
- Credentials are only read. The test runs no login/logout.
- Seed the VS Code `User/settings.json` as `{\n\t"editor.fontSize": 13\n}\n`.
- (a) Logged-out HOME: `proxy connect --claude-otlp --yes` → loopback route in settings.json and the billing line after the extension `✓` line. Then `proxy disconnect --claude-otlp` → settings.json bytes equal the seed.
- (b) HOME with `~/.claude.json` `{"oauthAccount":{}}` → the skip line is printed, settings.json is byte-identical to the seed, and there is no billing line under the extension.
- `afterEach`: run `proxy stop` with the same homes, then `rmSync`.

- [ ] Step 1: Write the test, then run it with the env var set where available; without the env var, confirm it reports skipped.

Test-first: no — it confirms Tasks 1–5 end to end and depends on the environment.

---

negative-constraints:
- "`--claude-otlp` does NOT overwrite client configs when already configured" → Tasks 1–2 (skip clears the target before any writer runs; Task 6 (b) checks the bytes).
- "never reroute when unsure" → Task 1 (failure → `configured`).
- "No new flag" → explicit intent read via `getOptionValueSource` (Task 2).
- "Not printed on skipped/failed" and "`--claude-code-otlp` alone prints nothing about billing" → Task 2 tests.
- "disconnect unchanged" → no task modifies the disconnect path.
- "not child_process" → Task 1 uses `exec()`.
- "Never touch the real keychain/VS Code settings" → Tasks 1 and 6 use seams and scratch HOME.
