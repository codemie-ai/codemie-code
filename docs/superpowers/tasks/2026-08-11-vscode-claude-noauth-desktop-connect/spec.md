# Spec: VS Code Claude Code extension support for `proxy connect desktop`

## Problem

`codemie proxy connect desktop` configures the native Claude Desktop (3P) app to talk to CodeMie's
local proxy gateway, but does nothing for the VS Code Claude Code extension. The extension bundles
its own Claude Code CLI binary and does not inherit shell environment variables, so a terminal setup
that already works against CodeMie's proxy does not automatically make the VS Code extension skip
Claude.ai's OAuth login prompt. Users who want the VS Code extension to work need to hand-edit VS
Code's `settings.json` themselves.

## Goal

Add an opt-in flag to `codemie proxy connect desktop` that writes the VS Code user
`settings.json` keys the Claude Code extension reads (`claudeCode.disableLoginPrompt`,
`claudeCode.environmentVariables`) so the extension routes through the same local gateway daemon
`connect desktop` already starts, without requiring a Claude.ai browser login.

## Non-goals

- No Bedrock/Vertex passthrough branch. The local gateway daemon (`state.url` / `state.gatewayKey`)
  is the only backend `connect desktop` talks to today, and it already presents a bearer-token
  gateway shape — there is nothing else to branch on.
- No "disconnect"/uninstall counterpart that removes the written keys. Out of scope for this change;
  can be a follow-up if needed.
- No changes to the existing `proxy connect vscode` subcommand (VS Code's native Copilot Chat BYOK
  provider, `chatLanguageModels.json`) — that is a separate, already-shipped integration surface.

## Design

### Auth shape

Gateway-only, mirroring exactly what `connect desktop` already gives the native Claude Desktop app
via `buildGatewayConfig()`:

- `ANTHROPIC_BASE_URL` = `state.url` (the local gateway daemon's base URL)
- `ANTHROPIC_AUTH_TOKEN` = `state.gatewayKey` (bearer token)

### New module: `src/cli/commands/proxy/connectors/vscode-claude-code.ts`

Sits alongside `desktop.ts` and `vscode.ts`, following the existing one-connector-per-target
pattern.

```ts
writeVsCodeClaudeCodeConfig(
  gatewayUrl: string,
  gatewayKey: string,
  insiders?: boolean,
): Promise<{ written: boolean; path: string }>
```

- Resolves `<VsCodeProductDir>/User/settings.json` — a new file target, distinct from `vscode.ts`'s
  `chatLanguageModels.json`.
- Read-existing → merge → write, the same convention every connector in this directory already
  follows:
  - `claudeCode.disableLoginPrompt` → set to `true` (simple overwrite).
  - `claudeCode.environmentVariables` → an array of `{name, value}` objects. Upsert-by-`name` only
    the two CodeMie-managed entries (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`), preserving any
    other entries the user already has — mirrors `vscode.ts`'s `mergeManagedProviders`
    preserve-user-fields pattern, at array-item granularity.
  - Any other top-level `settings.json` keys are left untouched.
- Atomic write via the existing temp-file + `rename()` helper.

### Reused helpers — export from `vscode.ts`

`vscode.ts` currently keeps two helpers private that the new module needs:

- `getVsCodeProductDir(insiders)` — per-OS user-data-dir resolver (darwin / win32 / linux).
- `writeAtomically()` — temp-file + `rename()` atomic write.

Both become exported so `vscode-claude-code.ts` reuses them instead of duplicating per-OS path
logic or write semantics.

### CLI wiring — `src/cli/commands/proxy/index.ts`

- `connect desktop` subcommand gets a new option:
  `.option('--vscode-claude-code', 'Also configure the VS Code Claude Code extension to skip Claude.ai login')`
- Reuse the `--insiders` flag (currently only wired to `connect vscode`) so it's meaningful when
  combined with the new flag, targeting VS Code Insiders' user-data dir.
- In the `connect desktop` action, after the existing `writeDesktopConfig(...)` call: if
  `options.vscodeClaudeCode`, call
  `writeVsCodeClaudeCodeConfig(state.url, state.gatewayKey, options.insiders)`.
- Opt-in, not automatic — the flag must be passed explicitly.

### Error handling

- Non-fatal by design: the call is wrapped in try/catch. A failure (VS Code not installed,
  permission error, unwritable path) logs a warning through the existing `printProxyError`-style
  path and does **not** fail the rest of `connect desktop` — Desktop app config and daemon startup
  already succeeded and should not be rolled back over a secondary, opt-in target.
- On success, print a confirmation line with the written path and a reminder to reload VS Code,
  consistent with the existing Desktop-config confirmation message.
- Errors use `ConfigurationError` from `@/utils/errors.js`.
- `gatewayKey` / the `ANTHROPIC_AUTH_TOKEN` value is always passed through `sanitizeLogArgs()`
  before logging — never interpolated raw into a log message, matching every other connector in
  this directory.

### Testing

New `src/cli/commands/proxy/connectors/__tests__/vscode-claude-code.test.ts`, following
`vscode.test.ts`'s Vitest + real-`mkdtemp()`-fixture pattern (not `fs` mocks):

- Creates `settings.json` from scratch when it doesn't exist.
- Preserves unrelated existing keys and env-var entries when `settings.json` already exists.
- Upserts (doesn't duplicate) the two managed env-var entries on repeat runs — idempotency.
- Confirms no raw secret value ever appears in captured log output.

## Open items resolved during brainstorming

- **Auth mode**: gateway-only (no Bedrock branch) — confirmed.
- **Module location**: new `connectors/vscode-claude-code.ts` — confirmed.
- **Trigger**: opt-in via `--vscode-claude-code` flag, not automatic — confirmed.
- **Flag name**: `--vscode-claude-code` (distinct from the existing `connect vscode` subcommand,
  which targets a different integration) — confirmed.
