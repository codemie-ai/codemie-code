# Spec: reject invalid model values at launch and in the local proxy

## Goal

A malformed `model` value (oversized, multi-line, padded, empty, non-text) must never leave the user's machine on the Claude path. `codemie-claude` refuses it at startup. The local proxy refuses it per request with an Anthropic-style error. Both use one rule, so they cannot disagree. Background: a ~7,500-char value reached LiteLLM through this path and broke spend aggregation.

## The rule (one shared check)

New util `src/utils/model-value.ts` (`@/utils/...`; both `src/agents/core` and the proxy plugin may import from Utils, per the layering guide). It exposes a pure `validateModelValue(value: unknown)` returning `null` or a violation, and a message builder. A violation is the first match in this order:

1. `not_text`: the value is not a string (null, number, boolean, array, object). Reported with its JSON type.
2. `empty`: length 0.
3. `too_long`: more than 256 Unicode code points (256 is valid).
4. `invalid_characters`: contains any `\p{White_Space}`, any `\p{Cc}`, U+FEFF or U+200B, anywhere. Nothing is trimmed.

Message shape: `Invalid model value: <rule description>. Received length: <n>.` Non-text reports the type instead of a length. Neither the value nor any part of it is ever included.

## Launcher (`codemie-claude` only)

- In `AgentCLI.handleRun` (`src/agents/core/AgentCLI.ts`), under the existing Claude-only name check (`:138` pattern), before `ConfigLoader.load` (`:235`).
- The validated value is the one the user supplied: `options.model` if it is not `undefined`, else `process.env.CODEMIE_MODEL` if it is not `undefined`. This uses `!== undefined`, not truthiness, so `-m ''` and `CODEMIE_MODEL=''` are caught (today four truthy checks treat them as absent: `AgentCLI.ts:416,442`, `config.ts:631,228`; those stay as they are).
- On violation: `console.error(chalk.red(message))`, `logger.error` (same message), `process.exit(1)`, as the `--reasoning-effort` check does (`AgentCLI.ts:281-289`). Claude Code is not launched.
- The options debug log at `AgentCLI.ts:114` runs before `handleRun`. It must log `model` as its length when the value is invalid, so the value is not echoed.
- Not validated: the profile `model` and the tier env vars (NG3). They are still checked when they appear in a request.

## Proxy hook

- New plugin in `src/providers/plugins/sso/proxy/plugins/`, registered in `plugins/index.ts`. It implements `handleRequest` (a throw from `onRequest` is swallowed, `sso.proxy.ts:636`; a "blocked" answer is always 200, `:345`).
- `clients`: the normalizer's four: `codemie-claude`, `codemie-copilot`, `claude-desktop`, `vscode-claude-code`. The list is defined once in `proxy-clients.ts` and used by the new hook. The existing duplicates stay untouched, and a test asserts they are equal.
- Priority: strictly between client attribution (8, which may rewrite `agentName` to `claude-desktop`) and SSO/JWT auth (10). The hook therefore sees the final client. The plan picks the number and updates `plugin-order.test.ts`. Every `handleRequest` runs before any `onRequest`, so rejected bodies never reach the normalizers, the desktop alias rewrite or the body logger.
- Behavior: if the already-read body is JSON, an object, and has its own `model` key, validate it; otherwise pass (`return false`). A missing `model` stays valid (it means "use config.model"). Non-JSON, non-object and unparsable bodies pass; this hook only judges `model`. No URL filter, as in the normalizer.
- On violation: status 400, `Content-Type: application/json`, body `{"type":"error","error":{"type":"invalid_request_error","message":<message>}}` (same envelope as `gateway-key.plugin.ts:62-68`, `otlp.plugin.ts:53`), return `true`. The request is not forwarded.
- Its own log line (`logger.warn`) carries the rule, the client and the length only.
- A `claude-x-<hash>` desktop alias and any value the normalizer passes through to the gateway are valid under the rule. The normalizer is unchanged.

## Shared test-value table (D5)

`src/utils/__tests__/model-value-cases.ts` exports rows `{ name, value, valid, rule? }`. It is consumed by the util test, the launcher test and the hook test; the backend child receives the same list. Large values are built in code, not inlined.

- Rejected: 257 chars; 7,500 chars; newline and CRLF inside; tab; NBSP U+00A0; leading space; trailing space; U+3000; U+2028; U+0085; NUL; U+FEFF; U+200B; empty string; and, proxy only, `null`, number, boolean, array, object.
- Accepted: exactly 256 chars; plain names (`claude-sonnet-4-5`); a Bedrock-style id with `.`, `:` and `-`; an `@`-dated id; a `claude-x-<hash>` alias; short router aliases (`sonnet`).
- Tests: util (every row); launcher via the `AgentCLI` `handleRun` spy pattern (string rows, `-m` and env; asserts exit 1, no `run`, message has rule and length but not the value); hook via the gateway-key `handleRequest` mock pattern (every row, 400 envelope, `true`, no value in body or captured logs; absent `model` passes; unlisted client is skipped); one real-proxy test that a bad value is not forwarded to the upstream.

## Decisions

- One util `validateModelValue` in `src/utils/` over separate copies in the launcher and the hook (the D2 mechanism).
- Whitespace set is `\p{White_Space}` plus `\p{Cc}` plus U+FEFF and U+200B over JS `\s` alone. It is a superset of `\s` and `White_Space`, and it closes the two invisible edge cases. Other format characters (e.g. U+200C) are accepted and not pinned.
- Length counted in code points over UTF-16 units.
- Violation order is not_text, empty, too_long, invalid_characters; the first match is the one reported.
- Non-text values report their JSON type, since no length exists.
- Launcher validates the winning raw input (`-m`, else env), checked with `!== undefined`, over validating `config.model` after load (which loses empties and can differ under `--profile`).
- An invalid `CODEMIE_MODEL` is rejected even when `--profile` makes `ConfigLoader` ignore it. This is fail-safe: a set but invalid variable is never silently tolerated.
- Hook is a new plugin over editing the normalizer, so the normalizer's deliberate pass-through stays untouched.
- Hook priority is between 8 and 10 over below 8 or after auth.
- Error response is 400 `invalid_request_error` over the `ProxyError` envelope of a thrown error.
- Absent `model` in a request is valid over rejecting it.
- Launcher scope is `codemie-claude` only; `claude-acp` is not covered (NG2), and it is not in the proxy client list either.

## Acceptance criteria

- AC1: `codemie-claude -m <v>` or `CODEMIE_MODEL=<v>` with an empty, over-256, whitespace-bearing or control-character-bearing value exits 1 before Claude Code starts, printing the rule and received length but not the value.
- AC2: on `codemie-claude`, `codemie-copilot`, `claude-desktop` and `vscode-claude-code` traffic, a request whose `model` breaks the rule or is not text gets a 400 Anthropic-style error with the rule and length, and is not forwarded.
- AC3: valid names and router aliases, requests without `model`, and unresolved models the normalizer passes through behave exactly as before.
- AC4: for every rejected row, the console output, the 400 body and captured logs (launcher debug log included) never contain the value or a prefix of it.
- AC5: the shared table runs green in the util, launcher and hook tests: every bad row rejected, every valid row accepted.

## Non-goals

- NG1: checking the model against the catalog.
- NG2: launcher checks for other agents; proxy checks for agents without the Claude normalizer (codex, opencode, gemini, kimi, claude-acp).
- NG3: launch-time validation of tier env vars and the profile `model`.
- NG4: any backend, UI or SDK change.
- Removing the existing echoes of the full value in Copilot/Codex/Kimi/Gemini messages.
- Changing the normalizer, `runHook` swallowing or the "blocked" 200 behavior.

## Risks

- Claude Code is assumed to render the Anthropic-style error text; this is unverified in the repo.
- Rejecting an empty `CODEMIE_MODEL=` breaks setups that export it empty today; D1 requires it.
- The plan must confirm no proxy code logs the request body before `handleRequest` runs (AC4); the debug logger runs in `onRequest`.
- Protects only versions that include the check; the backend child covers the rest.
