# Reset Claude Desktop MCP sign-ins (EPMCDME-17434) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** `codemie proxy reset-mcp-auth --claude-desktop` removes `custom3pMcpOAuth` from Claude Desktop's `<Claude-3p>/config.json`, leaving every other key and the daemon untouched.

**Architecture:** A file-logic module taking `baseDir` returns a closed result and throws for no table row. A handler beside `disconnect-orchestrator.ts` alone owns message text, logs and `process.exitCode`. A new subcommand in `index.ts` wires them. `disconnect` is not touched.

**Tech Stack:** TypeScript ES modules (`.js` import suffix, `@/` alias), commander, chalk, `writeJsonFileAtomic`.

**Spec:** `docs/superpowers/tasks/2026-11-18-epmcdme-17434-reset-claude-desktop-mcp-sign-ins/spec.md` (Behavior table, AC1-AC13).

Commit per task using the repository's existing convention. AC10 and AC13 are manual per-OS runs recorded in the merge request by the calling flow; they are not tasks here.

## Global Constraints

- File: `config.json` directly in `getClaudeDesktopBaseDir()`; import it from `@/telemetry/clients/claude-desktop/claude-desktop.paths.js`, not the wrapper in `connectors/desktop.ts`.
- Write with `writeJsonFileAtomic` (`src/utils/atomic-write.ts:49`), without `refuseUnparsable`.
- Nothing printed or logged holds a token value, an excerpt of `config.json`, `error.message` or a stack. No `printProxyError`, no `process.exit`.
- Logs carry path, outcome and server count, never server names.

## Review Focus

- Entry is an array, string, number or `true`: removed, no names printed.
- Empty or truncated `config.json`: `invalid-json`, no excerpt anywhere.
- Server name holding escape sequences: printed through `JSON.stringify`, cannot overwrite the closing steps.
- Hundreds of servers: names capped, "and N more".
- `EACCES` on a non-Windows write: failure text only, no quit-first hint.

---

### Task 1: File logic `clearDesktopMcpSignIns`

**Files:** Create `src/cli/commands/proxy/connectors/desktop-mcp-auth.ts`.

**Produces:** (`config.json` is a private named constant, `DESKTOP_CONFIG_FILE_NAME`, joined to `baseDir`)

```ts
export const MCP_OAUTH_KEY = 'custom3pMcpOAuth';
export type ResetResult =
  | { outcome: 'cleared'; path: string; servers: string[] } // empty when the entry was not an object
  | { outcome: 'nothing' | 'missing' | 'invalid-json' | 'not-object'; path: string }
  | { outcome: 'unreadable' | 'write-failed'; path: string; code?: string };
export async function clearDesktopMcpSignIns(baseDir: string): Promise<ResetResult>;
```

- [ ] Implement per the spec Behavior table. `ENOENT` on read is `missing`; any other read error is `unreadable` with its string `code`. Parse inside `try { JSON.parse } catch { }` with the error unbound. A parsed value that is not a plain object is `not-object`. Entry absent, `null` or `{}` is `nothing` and the file is not written. Any other entry is removed whatever its type; `servers` is `Object.keys` only for a plain object. Write the remaining keys with `writeJsonFileAtomic`; a throw becomes `write-failed` with its `code`, message dropped. Never throws for these rows.

Test-first: no — tests only on explicit request (AGENTS.md); proving test if requested: `desktop-mcp-auth.test.ts` with temp-dir `baseDir`, one case per result row, a sentinel string in invalid and valid files asserted absent from every result field, other keys and file mode preserved after `cleared`.

### Task 2: Handler `resetMcpAuth`

**Files:** Create `src/cli/commands/proxy/reset-mcp-auth-orchestrator.ts` (beside `disconnect-orchestrator.ts:1-87`, whose `error.message` forwarding at `:81-86` is not the template).

**Consumes:** `clearDesktopMcpSignIns`, `ResetResult`, `MCP_OAUTH_KEY` (Task 1); `getClaudeDesktopBaseDir`.

**Produces:**

```ts
export const RESET_RESTART_STEPS =
  'Fully quit Claude Desktop, start it again, then press Reconnect on each MCP server under Customize → Connectors.';
export const RESET_RERUN_HINT =
  'If the sign-ins come back, quit Claude Desktop, run this command again, then start Claude Desktop.';
export const RESET_NEXT_STEPS = `${RESET_RESTART_STEPS}\n${RESET_RERUN_HINT}`;
export async function resetMcpAuth(opts: { claudeDesktop?: boolean }): Promise<void>;
```

- [ ] Implement `resetMcpAuth`. No flag: print a list of resettable clients (`--claude-desktop`, same shape as `DISCONNECT_TARGET_LIST` at `disconnect-orchestrator.ts:49-64`), change nothing, exit 0. With the flag: one `try/catch` around the whole body including `getClaudeDesktopBaseDir()`; the catch prints fixed text naming `process.platform` and the error `code` when it is a string, logs only that code via `logger.warn('[proxy] ...', ...sanitizeLogArgs({ code }))`, and sets `process.exitCode = 1`. Render each result as the spec table says (exit 0 for `cleared` and `nothing`, 1 otherwise): `cleared` prints names, each through `JSON.stringify`, capped at a named constant with "and N more", or "sign-ins cleared" with no names when `servers` is empty, then `RESET_NEXT_STEPS`; `nothing` prints `No saved sign-ins (${MCP_OAUTH_KEY}) in <path>; file not changed`; `missing` names the path checked; `unreadable`, `invalid-json`, `not-object` name the path, the kind and "file was not changed"; `write-failed` names the path, kind, code and "file left as it was", plus `RESET_RERUN_HINT` when `process.platform === 'win32'` and the code is `EBUSY`, `EPERM` or `EACCES`. Log one `logger.info` line per result with path, outcome and `servers.length` only. Import nothing from the daemon, `configLibrary` or `connectors/desktop.ts`.

Test-first: no — tests only on explicit request (AGENTS.md); proving test if requested: `reset-mcp-auth-orchestrator.test.ts` mocking the file logic, asserting text, `process.exitCode` and logger calls per row, a throwing `getClaudeDesktopBaseDir` with a sentinel in its message appearing in no console or logger call, and the bare call writing nothing.

### Task 3: Register `proxy reset-mcp-auth`

**Files:** Modify `src/cli/commands/proxy/index.ts`: import beside `:12`; new subcommand after the `disconnect` registration ending `:432`, before the deprecated aliases at `:434`.

**Consumes:** `resetMcpAuth`, `RESET_NEXT_STEPS` (Task 2).

- [ ] `proxy.command('reset-mcp-auth').description('Clear the saved MCP sign-ins of a client so they can be redone')`, `.option('--claude-desktop', ...)`, `.addHelpText('after', RESET_NEXT_STEPS)`, and an action calling `resetMcpAuth({ claudeDesktop: Boolean(opts.claudeDesktop) })`. Leave `disconnect`, `DisconnectTargets` and `analytics-clients.ts` unchanged.

Test-first: no — tests only on explicit request (AGENTS.md); proving test if requested: a `connect-wiring.test.ts`-style case (`:453`) that `parseAsync(['reset-mcp-auth','--claude-desktop'])` calls `resetMcpAuth` with `claudeDesktop: true` and bare `['reset-mcp-auth']` with `false`.

### Task 4: Docs

**Files:** Modify `docs/COMMANDS.md` (command list `:86-102`, plus one paragraph after `:105`); `README.md` (after the `proxy disconnect` paragraph at `:732`).

- [ ] Add `codemie proxy reset-mcp-auth --claude-desktop` to the COMMANDS.md list. In both files add a short paragraph naming `config.json` in the Claude-3p directory and quoting `RESET_NEXT_STEPS` verbatim (restart, Reconnect, and the re-run line). Do not edit `openwiki/`.

Test-first: no — documentation only.

---

## Self-review

- Coverage: AC1/AC3/AC7/AC8/AC11 and the table rows Tasks 1-2; AC2 Task 1 via `getClaudeDesktopBaseDir`; AC4 Tasks 1-2; AC5 Task 2 imports; AC6 Task 2; AC9/AC12 Tasks 2-4; AC10/AC13 manual, outside the plan.
- negative-constraints: NG1/NG6 no probe or relaunch in Task 2; NG3 no backup in Task 1; NG4/NG5 flag and whole entry in Tasks 1-3; NG7 only `getClaudeDesktopBaseDir` paths; AC4/D8 unbound catch (Task 1) and fixed text (Task 2); AC5 no daemon or `configLibrary` import (Task 2); not folded into `disconnect` (Task 3). No task violates any.
- Plan notes: wording constant, escaped and capped names, nothing-to-clear line naming key and path, and the paths-module import are in Tasks 1-4. Not carried: refuse-as-root-on-foreign-file. It needs an eighth result kind and exit row the approved spec's closed contract does not list, and the review rates it low with `sudo` HOME behaviour unverified.
