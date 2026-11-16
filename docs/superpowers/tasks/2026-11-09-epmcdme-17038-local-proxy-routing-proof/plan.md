# EPMCDME-17038 Local Proxy Routing Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native Claude Code / Claude Desktop session whose endpoint is the running local CodeMie proxy is recorded as routed + proven, so it gets `funding_route: api_based` and is classified `codemie`.

**Architecture:** `routedViaCodemie` stays pure. It gets an optional `localProxy` input (the live daemon's `url` and `targetUrl`), which the caller resolves. The `claude-code-otlp` plugin resolves it from daemon state, and only when the effective endpoint is loopback on a native launch.

**Tech Stack:** TypeScript (ESM), Vitest.

## Global Constraints

- ES modules with `.js` import extensions; `@/` alias; no `any`; explicit return types on exports; `logger.debug`, never `console`.
- Do not change the managed branch of `routedViaCodemie`, `fundingRoute`, or `classify`.
- Never call `checkStatus` (it deletes the state file). Never log `gatewayKey` or URLs.
- Any failure while resolving daemon state means no `localProxy`, which leaves the session unproven (fail closed).
- Plugin tests must mock `@/cli/commands/proxy/daemon-manager.js` so the real `~/.codemie/proxy-daemon.json` is never read.
- Commit per task using the repository's existing convention (Conventional Commits, see `.ai-run/guides/standards/git-workflow.md`), and only if the flow requires commits.

## Acceptance criteria

- A native session with `ANTHROPIC_BASE_URL` = the live daemon URL, `codemieProvider` true, and daemon `targetUrl` matching the profile base URL is `{routed: true, routing_proof: 'proven'}`, `funding_route` `api_based`, class `codemie`.
- `localhost` and `127.0.0.1` (and `[::1]`) on the same port, scheme and path count as the same proxy.
- These stay unproven: a loopback endpoint on another port, no `localProxy`, daemon `targetUrl` ≠ profile URL, or a dead daemon. With `codemieProvider` false the session is never proven routed.
- A settings.json `env.ANTHROPIC_BASE_URL` that points at the proxy is also proven.
- A non-loopback endpoint never reads daemon state.

---

### Task 1: Prove native local-proxy routing in `routedViaCodemie`

**Files:**
- Modify: `src/agents/core/evidence/routing.ts:7-21` (RoutingInput), `:58-64` (helpers), `:195-200` (native branch)
- Test: `src/agents/core/evidence/__tests__/routing.test.ts`, `funding-route.test.ts`, `classify.test.ts`

**Interfaces:**
- Produces: `RoutingInput.localProxy?: { url: string; targetUrl?: string }`. Doc comment: "the running CodeMie proxy daemon, from its state file, only when alive; resolved by the caller, keeps this function pure".
- Produces: `export function localProxyCandidate(input: RoutingInput): boolean`. It returns true iff the launch is native, `codemieProvider` is true, `settingsUnknown` is false, `effectiveEndpointEnv` resolves, no cloud flag is on, and the effective `ANTHROPIC_BASE_URL` is loopback. Task 2 uses it as the gate, so the plugin does not duplicate the effective-env logic.

Test-first: yes — a native env `{ANTHROPIC_BASE_URL: 'http://127.0.0.1:4001', ANTHROPIC_AUTH_TOKEN: 'gw'}` with `codemieProvider: true`, `profileBaseUrl: GATEWAY` and `localProxy: {url: 'http://127.0.0.1:4001', targetUrl: GATEWAY}` expects `{routed: true, routing_proof: 'proven'}`. It currently gets `unproven`.

- [ ] **Step 1: Write the failing tests.** Add a `describe('routedViaCodemie - native via local proxy daemon')` block to `routing.test.ts` that uses the existing `input()` helper (`:52`). Cover:
  - the proven case above;
  - endpoint `http://localhost:4001` with daemon `http://127.0.0.1:4001` → proven;
  - endpoint `http://127.0.0.1:4002` → `unproven`;
  - no `localProxy` → `unproven`;
  - `targetUrl` `https://other.example.com` → `unproven`;
  - `codemieProvider: false` → `routed` is false;
  - `settingsEnv: {ANTHROPIC_BASE_URL: 'http://127.0.0.1:4001'}` with empty process env → proven;
  - `localProxyCandidate`: true for the loopback native case; false for a remote endpoint, a managed launch (`CODEMIE_SESSION_ID`), and `codemieProvider: false`.

  In `funding-route.test.ts`, use the `base()`/`funding()` helpers to show the same native local-proxy input gives `api_based`. In `classify.test.ts`, feed the `routedViaCodemie` result for that input into the file's existing classify helper and expect class `codemie`.
- [ ] **Step 2: Run `npx vitest run src/agents/core/evidence/__tests__/routing.test.ts`.** The new cases should FAIL (`unproven`, or `localProxyCandidate` not exported).
- [ ] **Step 3: Implement.** Add the `localProxy` field. Add a private `sameLocalProxy(endpoint, proxyUrl): boolean`: both URLs must be loopback; rewrite each URL's hostname to `127.0.0.1`; then compare `identity()` of the rewritten URLs (this covers same scheme, same port with default-port normalization, and same normalized path); any parse error → false. Add `localProxyCandidate`, which reuses `effectiveEndpointEnv`, `flagState` and `isLoopback`. In `routedViaCodemie`, insert just before the existing native check at `:197`:

```ts
if (launchMode(env) === 'native' && input.codemieProvider && input.localProxy &&
    sameLocalProxy(endpoint, input.localProxy.url)) {
  const target = identity(input.localProxy.targetUrl);
  if (target && target === identity(profileUrl(input))) return PROVEN(true);
}
```

  When this block does not return, execution falls through to the existing logic, so a loopback endpoint that is not the proxy stays `UNPROVEN`. Guard `!cloud` too, so a Bedrock/Vertex base URL is never compared.
- [ ] **Step 4: Run `npx vitest run src/agents/core/evidence/__tests__/`.** All tests should PASS, including the existing managed, native and matrix cases.

### Task 2: Resolve the live daemon in `extractHookContext`

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/event-fields/local-proxy.ts`
- Modify: `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:64,117-124`
- Test: `src/agents/plugins/claude-code-otlp/__tests__/claude-evidence-inputs.test.ts`

**Interfaces:**
- Consumes: `localProxyCandidate`, `RoutingInput.localProxy` (Task 1); `readState(): Promise<DaemonState | null>` and `isDaemonAlive(state): Promise<boolean>` from `@/cli/commands/proxy/daemon-manager.js` (same import precedent as `src/agents/core/hook-credentials.ts:1`).
- Produces: `export async function resolveLocalProxy(): Promise<{ url: string; targetUrl?: string } | undefined>`.

Test-first: yes — with `vi.mock('@/cli/commands/proxy/daemon-manager.js')`, process env `ANTHROPIC_BASE_URL=http://127.0.0.1:4001`, `ANTHROPIC_AUTH_TOKEN=gw`, a profile with `baseUrl: GATEWAY`, `readState` returning `{url:'http://127.0.0.1:4001', targetUrl: GATEWAY, pid, port:4001, startedAt}` and `isDaemonAlive` true, expect `routing` `PROVEN_ROUTED` and `funding_route` `api_based`. It currently gets `UNPROVEN`/`unknown`.

- [ ] **Step 1: Write the failing tests.** In `claude-evidence-inputs.test.ts`, add `readStateMock`/`isDaemonAliveMock` and mock the daemon-manager module next to the existing mocks (`:3-12`). In `beforeEach`, make `readStateMock` resolve `null` by default. Cover:
  - the live-daemon case above;
  - `isDaemonAlive` false → `routing` `UNPROVEN`, `funding_route` `unknown`;
  - `readState` rejects → `UNPROVEN`;
  - `settings({ ANTHROPIC_BASE_URL: GATEWAY })` (non-loopback) → `readStateMock` is not called.

  Add `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` cleanup to an `afterEach` in the new describe block.
- [ ] **Step 2: Run `npx vitest run src/agents/plugins/claude-code-otlp/__tests__/claude-evidence-inputs.test.ts`.** The new cases should FAIL.
- [ ] **Step 3: Implement.** In `local-proxy.ts`, `resolveLocalProxy`: call `readState()`; if there is no state or `state.url` is not a string → `undefined`; if `!(await isDaemonAlive(state))` → `undefined`; otherwise return `{ url: state.url, targetUrl: state.targetUrl }`. Wrap all of it in try/catch → `undefined`, with `logger.debug('[claude-code-otlp] local proxy state unavailable')` and no URLs or keys. In `extractHookContext`, build `routingInput` as today, then: `if (localProxyCandidate(routingInput)) routingInput.localProxy = await resolveLocalProxy();`. Type `routingInput` as `RoutingInput` so the optional field can be assigned. The `oauthAccountPays`/`fundingRoute` spreads stay unchanged.
- [ ] **Step 4: Run `npx vitest run src/agents/plugins/claude-code-otlp/`.** All tests should PASS, including `claude-code-otlp.plugin.test.ts`. Those tests use no loopback endpoints, so they never reach `readState`.
