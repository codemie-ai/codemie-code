# VS Code Claude Code Extension Support for `proxy connect desktop` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `--vscode-claude-code` flag to `codemie proxy connect desktop` that writes VS Code's `settings.json` (`claudeCode.disableLoginPrompt`, `claudeCode.environmentVariables`) so the bundled Claude Code extension routes through the local gateway daemon without a Claude.ai OAuth login.

**Architecture:** New connector `connectors/vscode-claude-code.ts` follows the existing one-connector-per-target pattern (`desktop.ts`, `vscode.ts`): read-existing → merge → atomic write. It reuses two helpers newly exported from `vscode.ts` (per-OS user-data-dir resolution, atomic write) instead of duplicating them. CLI wiring in `index.ts`'s `connect desktop` action calls the new writer non-fatally after `writeDesktopConfig` succeeds.

**Tech Stack:** TypeScript, Node `fs/promises`, Commander, Vitest (`mkdtemp` real-filesystem fixtures, no `fs` mocks).

Commit per task using the repository's existing convention.

---

## Non-goals

- No Bedrock/Vertex env var branch — gateway-only (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`).
- No changes to `proxy connect vscode` or `chatLanguageModels.json`/`vscode-models.ts`.
- No disconnect/uninstall counterpart.
- No whole-suite lint/build/test gate or manual/browser verification tasks — those run in later pipeline stages.

---

### Task 1: Export shared VS Code helpers

**Files:**
- Modify: `src/cli/commands/proxy/connectors/vscode.ts:65` (`getVsCodeProductDir`), `:204` (`writeAtomically`)

- [ ] Add `export` to both function declarations. No signature or behavior change: `getVsCodeProductDir(insiders: boolean): string` and `writeAtomically(configPath: string, content: string): Promise<void>` stay otherwise identical.
- [ ] Commit.

Test-first: no — pure re-export of existing, already-covered behavior; nothing new to assert.

---

### Task 2: `vscode-claude-code.ts` connector

**Files:**
- Create: `src/cli/commands/proxy/connectors/vscode-claude-code.ts`
- Create: `src/cli/commands/proxy/connectors/__tests__/vscode-claude-code.test.ts`

Public API:

```ts
export function writeVsCodeClaudeCodeConfig(
  gatewayUrl: string,
  gatewayKey: string,
  insiders?: boolean,
): Promise<{ written: boolean; path: string }>
```

Behavior:
- Resolve `<getVsCodeProductDir(insiders)>/User/settings.json`. Unlike `vscode.ts`'s `getVsCodeLanguageModelsPath`, do **not** throw when the product/`User` dir is missing — `writeAtomically` already `mkdir(dirname, {recursive:true})`s.
- File missing → treat as `{}`. File present → `JSON.parse`; invalid JSON throws `ConfigurationError` (`@/utils/errors.js`) and leaves the file untouched (mirrors `vscode.ts`'s `readProviders`).
- Set `claudeCode.disableLoginPrompt = true` (overwrite).
- `claudeCode.environmentVariables`: read existing value; if not an array treat as `[]`. Upsert-by-`name` only `ANTHROPIC_BASE_URL` (value = `gatewayUrl`) and `ANTHROPIC_AUTH_TOKEN` (value = `gatewayKey`) — replace a matching-`name` entry in place, else append. Every other entry and every other top-level key is left untouched.
- Write atomically via the now-exported `writeAtomically()`.
- Log through `logger`, passing `gatewayKey` through `sanitizeLogArgs()` (`@/utils/security.js`) — never raw.
- Return `{ written: true, path: configPath }`.

- [ ] Write failing tests in `vscode-claude-code.test.ts` (Vitest, `@group unit` header, `mkdtemp(join(tmpdir(), 'codemie-vscode-claude-code-'))` fixture in `beforeEach`, `rm(..., {recursive:true,force:true})` in `afterEach` — same shape as sibling `connectors/__tests__/vscode.test.ts`):
  - Creates `settings.json` from scratch (and the `User` dir) when neither exists.
  - Preserves unrelated existing top-level keys and unrelated `claudeCode.environmentVariables` entries when the file already exists.
  - Upserts (not duplicates) `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` on a second call with different values — array length unchanged, values updated.
  - Invalid existing JSON rejects with `ConfigurationError` and leaves the file byte-for-byte unchanged.
  - No raw `gatewayKey` value appears in captured `logger` output (spy on `logger.info`/`logger.warn`; assert the sanitized placeholder appears instead).
- [ ] Run `npx vitest run src/cli/commands/proxy/connectors/__tests__/vscode-claude-code.test.ts` — expect FAIL (module doesn't exist yet).
- [ ] Implement `vscode-claude-code.ts` per the behavior above, importing `getVsCodeProductDir`/`writeAtomically` from `./vscode.js`, `ConfigurationError` from `@/utils/errors.js`, `sanitizeLogArgs` from `@/utils/security.js`, `logger` from `@/utils/logger.js`.
- [ ] Re-run the same test command — expect PASS.
- [ ] Commit.

Test-first: yes — the five cases above, written before the implementation.

---

### Task 3: Wire `--vscode-claude-code` / `--insiders` into `connect desktop`

**Files:**
- Modify: `src/cli/commands/proxy/index.ts:21-24` (imports), `:330-508` (`connect desktop` command)

- [ ] Add import: `import { writeVsCodeClaudeCodeConfig } from './connectors/vscode-claude-code.js';` alongside the existing connector imports at `index.ts:21-24`.
- [ ] After the `--force` option (`index.ts:335`), add on the `connect desktop` command, matching the wording style already used for `--insiders` on the sibling `connect vscode` command (`index.ts:514`):
  - `.option('--vscode-claude-code', 'Also configure the VS Code Claude Code extension to skip Claude.ai login')`
  - `.option('--insiders', 'Configure VS Code Insiders instead of stable VS Code')`
- [ ] After the existing `writeDesktopConfig(...)` success block (ends `index.ts:491`, before the action's outer `catch`), add: if `opts.vscodeClaudeCode`, call `writeVsCodeClaudeCodeConfig(state!.url, state!.gatewayKey, Boolean(opts.insiders))` inside its **own** try/catch — not the outer one. The outer `catch` calls `printProxyError`, which `process.exit(1)`s (`index.ts:184-195`), and a failure here must not exit the process or trigger the outer catch's `stopDaemon()` rollback (Desktop app config and daemon startup already succeeded and this is a secondary, opt-in target). On success, print a confirmation line with the written path and a VS Code reload reminder, matching the style of the existing `'  Restart Claude Desktop to apply changes.'` line (`index.ts:491`). On failure, `logger.warn(...sanitizeLogArgs({...}))` plus a `chalk.yellow` console warning line — no rethrow.
- [ ] Commit.

Test-first: no — the new writer's behavior is already covered test-first in Task 2; this task is Commander option/plumbing wiring, a layer with no existing unit-test harness anywhere in this file (the sibling `connect vscode` action has none either) to extend without inventing new test infrastructure out of scope for this change.

---

## Spec coverage check

- Opt-in flag, non-automatic → Task 3 (flag gates the call).
- Gateway-only auth shape (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` from `state.url`/`state.gatewayKey`) → Task 2, Task 3 call site.
- New module location and exported signature → Task 2.
- Exported `getVsCodeProductDir`/`writeAtomically` reuse → Task 1, consumed by Task 2.
- Upsert-by-name env vars, preserve other keys/entries → Task 2.
- Atomic write → Task 2 (reuses `writeAtomically`).
- Non-fatal error handling, no rollback of Desktop config → Task 3.
- Confirmation message with path + reload reminder → Task 3.
- `sanitizeLogArgs` on all secret logging → Task 2, Task 3.
- New Vitest suite with the four required scenarios → Task 2.
- Non-goals (no Bedrock branch, no `connect vscode` changes, no disconnect) → honored by omission; no task touches Bedrock, `connect vscode`'s action (`index.ts:510-664`), or adds an uninstall path.
