# Technical Research

**Task**: cli auth sso non-interactive error-handling (EPMCDME-14148)
**Generated**: 2026-09-03
**Research path**: filesystem (codegraph MCP not available in this environment)

---

## 1. Original Context

EPMCDME-14148 (Bug, Major) — "CLI non-interactive SSO failure hangs on prompt and can crash with readline error"

Repository: `/Users/Evgenii_Kurdakov/Desktop/projects/codemie-dev/codemie-code` (the `codemie` CLI, `@codemieai/code`). Branch EPMCDME-14148, based on origin/main @ 1d5cc22b (v0.15.0).

Ticket description verbatim:

```
## Summary
CLI non-interactive SSO failure hangs on prompt and can crash with readline error.
## Description
When SSO credentials are missing in a non-TTY session, CLI prompts for re-authentication and may crash with ERR_USE_AFTER_CLOSE. Non-interactive automation should fail cleanly with actionable remediation.
## Preconditions
- CLI has no valid SSO session.
- Standard input is non-interactive.
## Steps to Reproduce
1. Ensure there is no valid CLI SSO session.
2. Run any `codemie sdk ...` command with stdin redirected from /dev/null.
3. Observe authentication prompt behavior and process termination.
## Expected Result
CLI exits non-zero with an actionable message such as "run codemie setup".
## Actual Result
CLI hangs on a re-authentication prompt and can crash with ERR_USE_AFTER_CLOSE if killed.
## Acceptance Criteria
- Non-TTY stdin skips interactive prompt.
- CLI exits non-zero with clear remediation.
- Optional --non-interactive or --ci behavior is supported or documented.
- Killing during prompt does not produce readline lifecycle crash.
```

Reproduction has already been performed; full evidence at `docs/superpowers/tasks/2026-09-03-epmcdme-14148-non-interactive-sso-hang/reproduction.md`. Confirmed inputs to this research:

- The non-TTY hang is ALREADY FIXED on main by commit `5b2de4b7` (PR #471), via `src/utils/interactive.ts` `isNonInteractiveEnvironment()` consumed by `src/providers/core/auth-validation.ts` `handleAuthValidationFailure()`.
- The RESIDUAL live defect: `src/utils/auth.ts` `promptReauthentication()` line 76 throws `ConfigurationError('Authentication expired. Please re-authenticate.')` uncaught — Node prints a raw stack trace and exits 1. Two problems: (a) no error boundary between the throw and Node's default handler; (b) the actionable remediation string produced upstream by `getCodemieClient` is discarded.
- Shared blast radius beyond the sdk commands.
- No `--non-interactive` or `--ci` flag exists anywhere in `src/`.
- ERR_USE_AFTER_CLOSE was NOT reproduced in 2 attempts.

---

## 2. Codebase Findings

### 2.0 Correction to the ticket premise — READ FIRST

The reproduction note states there is "no try/catch at the command action layer (`src/cli/commands/sdk/assistants.ts`)". **That is not accurate, and the distinction changes the shape of the fix.**

`src/cli/commands/sdk/assistants.ts` **does** import and use `handleSdkError` in all 6 of its actions. The real defect is **statement ordering**:

- `src/cli/commands/sdk/assistants.ts:65` — `const client = await getSdkClient();` sits **outside and above** the `try {` at line 68.
- The `try/catch` therefore guards only the *post-auth* API call. Auth acquisition itself is unguarded, so the `ConfigurationError` escapes the action, escapes commander, and reaches Node's default handler.
- **This is systemic.** All 8 SDK command files place `await getSdkClient()` before their `try {`. A grep for `try {` within two lines above any `await getSdkClient()` returns **zero** matches across the tree.

**Blast radius: ~50 SDK command actions across 8 files, every one unguarded at the auth step.**

### 2.1 Failure chain (verified end to end)

1. `src/utils/sdk-client.ts:73-75` throws `ConfigurationError('SSO authentication required. Please run "codemie setup" with SSO provider first.')` — **the actionable message**.
2. `src/utils/auth.ts:46` catches it, matches `error.message.includes('SSO authentication required')` (brittle string coupling), calls `promptReauthentication(config)`.
3. `src/utils/auth.ts:67` — SSO `validateAuth` returns `{ valid: false, ... }`.
4. `src/utils/auth.ts:68` — `handleAuthValidationFailure` → `src/providers/core/auth-validation.ts:34` guard `setupSteps?.promptForReauth && !isNonInteractiveEnvironment()` is **false** in non-TTY → prompt correctly skipped → prints `chalk.red("\n✗ <error>\n")` via `console.log` (**stdout**, line 39) → returns `false`.
5. `src/utils/auth.ts:76` throws `ConfigurationError('Authentication expired. Please re-authenticate.')` — **the step-1 actionable message is discarded**: never re-thrown, never attached as `cause`.
6. Nothing catches it → raw stack trace, exit 1.

The `validationResult.error` printed at step 4 contains genuinely useful text produced by `src/providers/plugins/sso/sso.setup-steps.ts:236-239` (`No SSO credentials found for <baseUrl>. Please run: codemie profile login --url <baseUrl>`) — but that string is only *printed*, never propagated into the exception. That is the second half of the "message discarded" complaint.

### 2.2 Existing Implementations

**Auth core**
- `src/utils/auth.ts` (77 lines) — two exports, no non-interactive awareness of its own.
  - `getAuthenticatedClient(config): Promise<CodeMieClient>` L22-54. JWT branch L23-41 (throws at L26-29, L32-34; no prompting). SSO branch L43-53: `try { return await getCodemieClient(); } catch { ... }`.
  - `promptReauthentication(config): Promise<boolean>` L63-77. **L76 is the uncaught throw.** Control-flow note: this function can only return `true` or throw — the declared `Promise<boolean>` is misleading and the `false` branch at `auth.ts:48` is dead code. Confirmed by `src/utils/__tests__/auth.test.ts:142-176`.
  - JSDoc at L61 already documents `@throws ConfigurationError if re-authentication is not available`.
  - L71 does `console.log(chalk.green(...))` — Utils layer doing user output, an existing layering smell.
- `src/utils/sdk-client.ts` `getCodemieClient(quiet = false)` L23-110. Throws at L37-39, **L73-75 (the discarded actionable message)**, L106-108. Starts an `ora` spinner at L26 unless `quiet`; `getAuthenticatedClient` always calls it non-quiet, so a spinner is spawned even in non-TTY.
- `src/providers/core/auth-validation.ts` (41 lines) — sole export `handleAuthValidationFailure`. Guard at L34. Fallback L39: `console.log(chalk.red(...)); return false;`.
- `src/utils/interactive.ts` (16 lines) — sole export `isNonInteractiveEnvironment(): boolean { return !process.stdin.isTTY; }` (L15). Consults **stdin only** — not stdout, not `process.env.CI`, not `TERM`.

**SDK command layer**
- `src/cli/commands/sdk/utils/cli-utils.ts` (145 lines):
  - `getSdkClient(): Promise<CodeMieClient>` L15-18 — `ConfigLoader.load()` → `getAuthenticatedClient(config)`. **No try/catch.** Sole bridge from the SDK CLI to `src/utils/auth.ts`; single choke point for all ~50 actions.
  - `handleSdkError(error: unknown, operation: string): never` L88-119 — extracts `error.message` (else `String(error)`); `logger.error("SDK operation failed", ...sanitizeLogArgs({operation, error: msg}))`; branches on `ApiError` status 401/403 (prints `Run "codemie setup" to re-authenticate if your session expired.` at L102), 404, `ZodError`; **else branch L116** prints `chalk.red("❌ " + msg)`; always writes to **stderr**; ends `process.exit(1)` L118.
  - Consequence: a `ConfigurationError` already falls into the `else` branch and would exit 1 cleanly with a red message. **Moving `getSdkClient()` inside the existing `try` fixes the stack trace — but the message would still be the useless one.** Both halves must be fixed.
  - Siblings in the same file: `parseDataInput` L23-35, `parseJsonFileInput` L40-49, `parseDataOrJsonFile` L55-76, `outputJson` L81-83, `getResponseMessage` L124-129, `parseConfigInput` L134-145.

**handleSdkError adoption audit** — `path` — uses handleSdkError — try/catch in action — notes:
- `src/cli/commands/sdk/assistants.ts` — yes (import L23; L106,151,183,212,228,280) — **partial** — `getSdkClient()` at L65,115,166,198,220,240 all precede `try {` at L68,118,169,200,222,243. 6/6 actions unguarded for auth.
- `src/cli/commands/sdk/categories.ts` — yes (L22) — partial — 5/5 unguarded.
- `src/cli/commands/sdk/datasources.ts` — yes (L10) — partial — 7/7 unguarded.
- `src/cli/commands/sdk/integrations.ts` — yes (L22) — partial — 6/6 unguarded.
- `src/cli/commands/sdk/llm.ts` — yes (L9) — partial — 1/1 unguarded (`getSdkClient()` L39 vs `try` L43).
- `src/cli/commands/sdk/skills.ts` — yes (L38, 18 call sites) — partial — 18/18 unguarded.
- `src/cli/commands/sdk/users.ts` — yes (L5) — partial — 2/2 unguarded.
- `src/cli/commands/sdk/workflows.ts` — yes (L21) — partial — 5/5 unguarded.
- `src/cli/commands/sdk/index.ts` — no — n/a — pure `Command` composition.
- `src/cli/commands/sdk/utils/{render,datasource-types,file-utils}.ts` — no — n/a.
- `src/cli/commands/sdk/services/*.ts` (9 files) — no — n/a — thin SDK pass-through; deliberately lets errors propagate to the command layer.

### 2.3 Call-site census

**`getCodemieClient`** (def `src/utils/sdk-client.ts:23`):
- `src/utils/auth.ts:44` — in `getAuthenticatedClient` — try/catch **yes** (L43-53); catch string-matches then calls `promptReauthentication`, else rethrows original at L52.
- `src/utils/auth.ts:49` — inside that catch, after successful re-auth — try/catch **no**; a second failure propagates raw.
- `src/cli/commands/skills/setup/sync.ts:36` — try/catch **yes**; catch is `logger.debug` only, fully swallowed by design.

**`getAuthenticatedClient`** (def `src/utils/auth.ts:22`):
- `src/cli/commands/sdk/utils/cli-utils.ts:17` — in `getSdkClient` — try/catch **no**. Hot path for all ~50 SDK actions. **Primary fix location.**
- `src/cli/commands/assistants/chat/index.ts:91` — no try/catch at the line, but the commander action at L47-63 wraps it: catch L58-62 does `createErrorContext` → `logger.error` → `console.error(formatErrorForUser(context))` → `process.exit(1)`. **Clean exit, no stack trace.**
- `src/cli/commands/assistants/setup/index.ts:68` — guarded at the caller; action L47-57 → `handleSetupError(error, 'setup assistants')` L55.
- `src/cli/commands/skills/setup/index.ts:107` — guarded at the caller → `handleSetupError(error, 'setup skills')` L32.

**`promptReauthentication`** (def `src/utils/auth.ts:63`):
- `src/utils/auth.ts:47` — in the catch of `getAuthenticatedClient` — **no** guard; its L76 throw escapes and shadows the original error.
- `src/cli/commands/assistants/chat/index.ts:423` — in `handleChatError`, reached from L265/L314 inside existing catches, all under the action-level boundary at L56-62. Only invoked when `error.message.includes('401'|'403')` (L422).

**Correction on blast radius.** `src/agents/core/AgentCLI.ts` and `src/cli/commands/profile/index.ts` are **not** call sites of the three symbols. They call `handleAuthValidationFailure` directly:
- `src/agents/core/AgentCLI.ts:293-294` and `:323-324` (dynamic imports). Both inside try/catch. On `reauthed === false` (L296-299): `console.log(chalk.yellow('\n⚠️  Authentication required\n'))` + `process.exit(1)` — **already a clean non-zero exit**.
- `src/cli/commands/profile/index.ts:130` — inside try L123 / catch L143-145 (`logger.error` only, execution continues). On `reauthed === false` (L138-140): prints a yellow warning and `return`s — **exit code 0**. An inconsistency worth noting, arguably out of scope.

So the uncaught-throw defect is confined to the `getAuthenticatedClient` → `promptReauthentication` path, whose only unguarded consumer is `getSdkClient`.

### 2.4 Architecture and Layers Affected

Project layer taxonomy (`.ai-run/guides/architecture/architecture.md` L65-88): **CLI (`src/cli/`) → Registry → Plugin (`src/*/plugins/`) → Core (`src/*/core/`) → Utils (`src/utils/`)**. Never skip layers, never reverse direction (L147-155).

Documented error flow (L159-171), directly load-bearing here:

```
Plugin Error (throws) → Registry (catches, adds context) → re-throws → CLI (catches, formats for user)
```

⇒ **Formatting for the user is the CLI layer's job, not `src/utils/auth.ts`'s.** `auth.ts` already violates this (chalk output at L71) and the fix should not deepen it.

Layers touched by a fix:
- **CLI** — `src/cli/commands/sdk/utils/cli-utils.ts` (error sink + auth gate); optionally the 8 sdk command files; optionally `bin/codemie.js` (process-level net).
- **Utils** — `src/utils/auth.ts` (message preservation); possibly `src/utils/errors.ts` if `cause` support is added.
- **Core** — `src/providers/core/auth-validation.ts` (stdout→stderr only, cosmetic).

### 2.5 Top-level error handling — there is none

- `bin/codemie.js` (41 lines): try/catch around `MigrationRunner` L13-22 (non-fatal warning); try/catch around `checkAndPromptForUpdate()` L28-34 (swallowed); `import('../dist/cli/index.js').catch(err => { console.error('Error:', err.message); process.exit(1); })` L37-40. **That `.catch` only covers module-load/top-level-await rejections.** `program.parse()` is synchronous and returns immediately; commander async action rejections never reach this chain. **No `process.on('uncaughtException')`, no `process.on('unhandledRejection')`.**
- `src/cli/index.ts` (148 lines): `new Command()` L44; `program.parse(process.argv)` L147 — plain **sync** `parse`, not `parseAsync`, not awaited. **No `.exitOverride()`, no `program.error()`, no `.configureOutput()`, no `.showHelpAfterError()`.**
- Whole-tree grep: `uncaughtException` and `unhandledRejection` each have exactly **one** hit, both in `bin/codemie-mcp-proxy.js:75` and `:79` — a ready-made in-repo template if a process-level net is wanted. `exitOverride` appears only in two test files. `process.exit` appears at 162 non-test sites across ~29 command files.

**Conclusion: no centralised CLI error boundary exists.** Anything escaping a commander action prints a raw stack.

### 2.6 Established clean-exit patterns (exemplars a fix should imitate)

Four competing conventions exist. Ranked by fit:

**(a) `handleSdkError` — the in-domain convention.** `src/cli/commands/sdk/utils/cli-utils.ts:88-119`. Already imported by all 8 SDK files. `logger.error` + `sanitizeLogArgs` → `chalk.red('❌ …')` to stderr → `process.exit(1)`.

**(b) `requireAuthenticatedSession` / `failAuth` — the closest semantic analogue.** `src/cli/commands/skills/lib/require-auth.ts:24-51`:
```ts
function failAuth(message: string): never {
  console.error(chalk.red(`\n${message}\n`));
  process.exit(1);
}
```
with `NOT_AUTHENTICATED_MESSAGE` (L15-16) = `'CodeMie SSO authentication required. Run "codemie setup" or "codemie profile login" first.'` — **precisely the actionable text EPMCDME-14148 says is being discarded.** Used as the first statement of 5 skills actions: `find.ts:48`, `list.ts:30`, `add.ts:49`, `update.ts:32`, `remove.ts:41`. Note L41-44: it treats a *thrown* auth check as unauthenticated rather than letting it escape — exactly the defensive posture missing from `getSdkClient`. **This path already never prompts and already exits non-zero cleanly.**

**(c) `printProxyError` — the `ConfigurationError`-aware formatter.** `src/cli/commands/proxy/connect-orchestrator.ts:250-262`: known project error → terse one-line `chalk.red('✗ …')`; unknown error → `formatErrorForUser(context, { showSystem: false })`; then `process.exit(1)`. Used at `connect-orchestrator.ts:673` and `proxy/index.ts:173`. **Best model for the discrimination this fix needs.**

**(d) `handleSetupError` — the guide-canonical generic boundary.** `src/cli/commands/shared/helpers.ts:64-69`: `createErrorContext` → `logger.error` → `console.error(formatErrorForUser(context))` → `process.exit(1)`. Used at `assistants/setup/index.ts:55` and `skills/setup/index.ts:32`; the same shape is inlined at `assistants/chat/index.ts:58-62`. Caveat: `formatErrorForUser` defaults `showSystem: true`, printing an OS/Node/version block — verbose for a simple "you're not logged in".

### 2.7 Error class hierarchy — `src/utils/errors.ts` (566 lines)

Flat, single base, all `constructor(message: string)`. **No `code`, no `exitCode`, no `isOperational` on the base.**

| Class | Line | Constructor |
|---|---|---|
| `CodeMieError extends Error` | L1-6 | `(message)`, sets `this.name` |
| `ConfigurationError extends CodeMieError` | L8-13 | `(message)` |
| `AgentNotFoundError` | L15-20 | `(agentName)` |
| `AgentInstallationError` | L22-27 | `(agentName, reason)` |
| `ToolExecutionError` | L29-34 | `(toolName, reason)` |
| `PathSecurityError` | L36-41 | `(path, reason)` |
| `AnalyticsSourceError` | L43-48 | `(message)` |
| `NpmError extends CodeMieError` | L64-73 | `(message, code: NpmErrorCode, originalError?)` — **only subclass with a `code`** |

**No constructor accepts an `options`/`cause` argument.** Preserving the upstream error via `{ cause }` therefore requires a constructor change or a post-hoc `.cause` assignment.

Exported helpers: `parseNpmError` L81, `getErrorMessage` L133, `createErrorContext` L302, `formatErrorForUser` L358 (plain string, **no chalk**; `❌ <message>` wrapped at 97 chars + System Information block, `showSystem` defaults **true**), `formatErrorForLog` L424, `getErrorExplanation` L434, `formatErrorWithExplanation` L529. **Caution: `getErrorExplanation`'s generic fallback (L512-519) says "Metrics collection encountered an issue"** — metrics-specific and wrong for auth errors, so avoid `formatErrorWithExplanation` here.

`instanceof` checks against project error classes exist at only **5 non-test sites**: `src/utils/auth.ts:46`, `proxy/connect-orchestrator.ts:254`, `proxy/connectors/vscode.ts:197`, `proxy/connectors/desktop.ts:155`, `proxy/connectors/vscode-claude-code.ts:68`.

### 2.8 Integration Points

- `codemie-sdk` (`CodeMieClient`, `ApiError`) — constructed in `src/utils/sdk-client.ts` and `src/utils/auth.ts:36-40`; consumed by all sdk services.
- `ProviderRegistry` (`src/providers/core/registry.ts`) → `getSetupSteps` → SSO plugin `src/providers/plugins/sso/sso.setup-steps.ts` (`validateAuth` L~230, `promptForReauth` L268 with an `inquirer.prompt` confirm at L274-281). Interface declared at `src/providers/core/types.ts:390`.
- `SecureStorage` (`src/utils/security.ts`) — OS keychain via lazily-imported `keytar`, AES-256-CBC machine-keyed file fallback. `FALLBACK_FILE = getCodemiePath('sso-credentials.enc')` L258, `CREDENTIALS_DIR = getCodemiePath('credentials')` L259; per-URL `credentials/<urlKey>.enc` and `credentials/jwt-<urlKey>.enc`.
- `ConfigLoader` (`src/utils/config.ts`) — global `~/.codemie/codemie-cli.config.json`, project-local `.codemie/codemie-cli.config.json`, precedence at L113-117.
- `logger` + `sanitizeLogArgs` — used by `handleSdkError`.
- `chalk`, `ora`, `inquirer`, `commander` — presentation and prompting.

### 2.9 Patterns and Conventions

- **Shared-gate fix pattern** (established by PR #471): fix once at the single shared gate, not per-caller.
- `never`-returning error sinks that own `process.exit(1)` — `handleSdkError`, `failAuth`, `printProxyError`, `handleSetupError`.
- `.js` extensions on all relative imports; `@/` alias preferred over deep `../../..` (AGENTS.md pitfalls table). Note the inconsistency: `src/utils/auth.ts` uses `@/`, `src/providers/core/auth-validation.ts` uses relative `../../utils/`.
- Explicit return types on all exported functions; `interface` over `type`.
- `src/cli/commands/sdk/utils/cli-utils.ts` uses **double quotes** throughout, contradicting the single-quote guidance — ESLint does not enforce quote style, so **do not mass-reformat**.

---

## 3. Documentation Findings

### Guides and Architecture Docs

All present under `.ai-run/guides/`.

**`development/development-practices.md`** — Error Handling L13-76. Exception hierarchy table L17-25. Canonical pattern L29-43 (citing `src/cli/commands/execute.ts:30-38`): `createErrorContext` → `logger.error` → `console.error(formatErrorForUser(context))`. Rules L45-51 verbatim:
- ✅ Use specific error classes (not bare `Error`)
- ✅ Always add context via `createErrorContext()`
- ✅ Log errors with `logger.error()`
- ✅ Format errors for user with `formatErrorForUser()`
- ❌ Expose internal implementation details
- ❌ Log stack traces to console (use `logger.debug()`)

Defensive-null precedent L53-76 (return instead of throw when the caller can degrade). Logging L80-130: WARN/ERROR/SUCCESS go to console and file; always `sanitizeLogArgs()`; never log tokens. TypeScript rules L194-203. **No prompt/UX section, and no explicit exit-code rule** — exit codes are conventional (`process.exit(1)`) only.

**`standards/code-quality.md`** — explicit return types on exports (L35); `.js` extensions and `import type` (L49); ESLint: `no-explicit-any` **off**, `no-unused-vars` warn, **`no-useless-catch` warn — "Avoid catch-and-rethrow"** (a bare re-throw in `auth.ts` would trip this and, under `--max-warnings=0`, fail the gate); functions **under 50 lines**, files **under 500** (L95-99); comment the *why*, JSDoc with `@throws` on public APIs (L105-110); pre-commit checklist L145-152 includes **no `console.log()` left in code**.

**`quality-gates.md`** — literal commands, fastest-to-slowest, stop at first failure:

| Gate | Command |
|---|---|
| License headers | `npm run license-check` |
| Lint | `npm run lint` (`eslint '{src,tests}/**/*.ts' --max-warnings=0`) |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) |
| Build | `npm run build` |
| Unit | `npm run test:unit` |
| Integration | `npm run test:integration` |
| Secrets (local) | `npm run validate:secrets` |
| Commitlint | `npm run commitlint:last` |
| Pre-commit aggregate | `npm run check:pre-commit` |
| Full CI | `npm run ci` |

Guide text for the test scripts is **stale** vs `package.json` (actual: `vitest run --project unit` / `--project cli`). Hooks: husky pre-commit = lint-staged → typecheck; `.claude/settings.json` PostToolUse auto-runs `npm run format` after every Edit/Write; Stop runs `npm run check:pre-commit`.

**`architecture/architecture.md`** — layer taxonomy and error flow, summarised in §2.4.

**`project.md`** — Jira, prefix `EPMCDME`; GitHub `codemie-ai/codemie-code`, target `main`, PRs via `gh`, squash-merge default.

**`standards/git-workflow.md`** — branch `EPMCDME-<NNNN>[_kebab-description]`; Conventional Commits `<type>(<scope>): <subject>`; **allowed scopes** (commitlint `scope-enum`): `cli, agents, providers, assistants, config, proxy, workflows, ci, analytics, utils, deps, tests, skills, kimi`. **`fix(auth)` and `fix(sdk)` would be rejected** — use `fix(cli)` or `fix(utils)`. Never `--no-verify`.

**`AGENTS.md`** (canonical; `CLAUDE.md` imports it) — "Check Guides First"; precedence: guides win for process, source wins for facts. **"Tests Only On Explicit Request"** and **"Git Operations Only On Explicit Request"**. Task classifier: `error, exception, validation` → P0 development-practices; `cli, command, commander` → P0 architecture.

**`CONTRIBUTING.md`** — no error-handling or CLI-UX section. Conventional Commits required for commits *and PR titles*; `npm run ci` fails if the last commit is non-conforming.

### Architectural Decisions

**PR #471 / commit `5b2de4b7`** — `fix(providers): skip interactive re-auth prompt in non-interactive environments (#471)`, Aug 7 2026. 16 files, +1045/−5. Substantive changes:
- `src/utils/interactive.ts` — **new**, 16 lines, sole export `isNonInteractiveEnvironment()`, JSDoc naming ERR_USE_AFTER_CLOSE as the motivation.
- `src/providers/core/auth-validation.ts` — one behavioural line: guard became `if (setupSteps?.promptForReauth && !isNonInteractiveEnvironment())`.
- `docs/AUTHENTICATION.md` +15 — new section, now at **L104-117**.
- `src/providers/core/__tests__/auth-validation.test.ts` — new, 104 lines, 5 tests.
- `src/utils/__tests__/interactive.test.ts` — new, 33 lines, 3 tests.

**Approach precedent this fix must extend, not replace**: fix at the single shared gate; TTY-only detection; no new flag; provider setup-steps untouched; co-located unit tests; documentation change is part of the deliverable.

**Prior task `docs/superpowers/tasks/2026-08-06-non-interactive-sso/` (EPMCDME-13953)** — the decision record that governs this ticket:
- `spec.md` "Out of scope": *"No new `--non-interactive` CLI flag or `CI` env var detection (**explicit decision — TTY check only**)."*
- `spec.md` asserted the callers "already handle a failed/`false` result correctly today (… `utils/auth.ts` throws `ConfigurationError`)" — **this assumption is exactly what reproduction.md falsifies.**
- `code-review-final.json` — decision `request-changes`, CR-001 (major, docs). Deferred/dismissed list explicitly records *"a pre-existing missing try/catch explicitly out of scope"*, plus *"TTY-only detection: no stdout check, pseudo-TTY containers still hang"*. **The missing try/catch was knowingly deferred in Aug 2026 and is the live defect now.**

**`docs/AUTHENTICATION.md:104-117`** — the documented promise, verbatim in substance: the prompt is "automatically skipped", the CLI "fails fast with a clear message … and exits non-zero instead of hanging", and (L113) *"There is no separate `--non-interactive` flag to set — detection is automatic, based solely on whether `stdin` is a TTY."* **This documented promise is precisely what the CLI does not currently deliver** — the gap is in the message, not the exit code.

**`docs/superpowers/specs/2026-07-01-EPMCDME-12992-session-origin-validation-design.md:97`** — non-interactive (piped stdin / `--yes` / `CODEMIE_NO_PROMPTS=1`) → behave as if the user declined → exit 1. Three-way precedent worth mirroring.

**Inline decision markers**: `grep -rnE 'TODO:|HACK:|NOTE:|FIXME:|XXX|@deprecated'` over `src/utils/auth.ts`, `src/utils/interactive.ts`, `src/providers/core/auth-validation.ts`, `src/cli/commands/sdk/`, `sso.setup-steps.ts`, `AgentCLI.ts`, `profile/index.ts`, `errors.ts` → **zero matches.** No inline decision debt; all recorded decisions live in the SDLC task dirs.

**No CHANGELOG.md exists** anywhere in the repo. `docs/AUTHENTICATION.md` is the only user-facing surface for this behaviour.

### Derived Conventions

- Auth failures are surfaced by a `never`-returning helper that logs, prints one chalk-red line, and exits 1. Four such helpers exist; **reuse, do not invent a fifth.**
- Non-interactivity is detected once, in `src/utils/interactive.ts`, and consumed at the gate — never re-derived at call sites.
- Utils-layer modules should throw; the CLI layer formats and exits.

---

## 4. Testing Landscape

### Existing Coverage

- **`src/utils/__tests__/auth.test.ts`** (177 lines) — covers `getAuthenticatedClient` (success L52, retry-after-reauth L63, throw when reauth fails L90, non-auth rethrow L108) and `promptReauthentication` (success L126, **throws `'Authentication expired. Please re-authenticate.'` at L142-155**, no setupSteps L157, no validateAuth L166). Mocks `../sdk-client.js`, `../../providers/core/registry.js`, `../../providers/core/auth-validation.js` (L9-21). **L142-155 encodes the current buggy behaviour and will have to change.** Does not cover the JWT branch (`auth.ts:23-41`) at all.
- **`src/utils/__tests__/interactive.test.ts`** (33 lines) — 3 tests; assigns `process.stdin.isTTY` directly, restores in `afterEach`.
- **`src/providers/core/__tests__/auth-validation.test.ts`** (104 lines) — the PR #471 guard test; the template (see below).
- **`src/agents/core/__tests__/`** — 5 AgentCLI test files, none about SSO/auth.
- **`src/cli/commands/sdk/**` — NO TESTS AT ALL.** All 22 files untested; there is no `src/cli/commands/sdk/__tests__/` directory. **`cli-utils.ts` — containing `getSdkClient()` and `handleSdkError()` — is entirely untested.** This is the natural home for the fix's tests and is greenfield.
- **`bin/codemie.js` — no direct tests**; exercised only as a subprocess via `tests/helpers/cli-runner.ts`. `bin/` is excluded from coverage (`vitest.config.ts:43`), so a process-level handler there cannot be unit-tested — it needs a cli-project subprocess test.

### Testing Framework and Patterns

- **Vitest 3+ style**, single `vitest.config.ts` (100 lines, no `vitest.workspace.ts`), three `defineProject` entries. All alias `@` → `/src`; all set `FORCE_COLOR=1`, `NODE_ENV=test`, `CODEMIE_HOME=<tmpdir>/codemie-test-home-<pid>`.
  - **unit**: `include: ['src/**/*.test.ts', 'src/**/*.spec.ts']`, `globals: true`, node env, 30 s timeouts, `isolate: true`, **no setupFiles**.
  - **cli**: `include: ['tests/integration/**/*.test.ts']`, excludes `agent-*`.
  - **agent**: `include: ['tests/integration/agent-*.test.ts']`, `globalSetup: tests/setup/agent-build-setup.ts`.
  - Coverage on the unit project only, provider `v8`, **no `thresholds` configured** — the 80/90 % numbers in the guide are advisory, not machine-enforced.
- **Guide mandates** (`.ai-run/guides/testing/testing-patterns.md`): unit tests co-located at `src/[module]/__tests__/*.test.ts` (L9-13); AAA (L21); `vi.mock()` at module level, `vi.spyOn()` in `beforeEach` + `vi.restoreAllMocks()` in `afterEach` (L46-66); **CRITICAL — import the module under test *inside the test body* via `await import('../auth.js')` after mocks are set** (L70-94), because static top-level imports are cached before `beforeEach`; async errors via `await expect(fn()).rejects.toThrow(ErrorClass)` (L115-122); assert **both** error class and code (L128-138); no hardcoded POSIX paths (L145-154); critical paths incl. `src/utils/` 90 %+ (L256-262). **No TDD mandate** — and AGENTS.md sets a stronger repo policy: *"Tests Only On Explicit Request."*
- **Template — `src/providers/core/__tests__/auth-validation.test.ts`**: explicit named imports from `vitest` despite `globals: true` (L1-3); a single top-level `vi.mock('../../../utils/interactive.js', () => ({ isNonInteractiveEnvironment: vi.fn() }))` (L5-7); **it does NOT touch `process.stdin.isTTY` or env** — it mocks the *function* and drives it with `mockReturnValue(true|false)` per test (L26, L41, L63, L78, L94). **Inject non-interactivity at the seam, not at the process level.** Per-test dynamic import inside each `it()` (L24-28, L39-44). Console captured via `vi.spyOn(console, 'log').mockImplementation(() => {})` and asserted with `expect.stringContaining(...)` (L55-57, L88) plus `toHaveBeenCalledTimes(1)` (L72) to prove no extra output path was taken. `afterEach` calls only `vi.restoreAllMocks()`. No `process.exit` or thrown-error assertion in this file — for the exit-code half of the fix, take that from the CLI exemplars below.
- **CLI command test exemplars**: `src/cli/commands/skills/__tests__/commands.test.ts` is the best all-round template — hoisted `vi.fn()`s behind `vi.mock()` factories (L22-46); `process.exit` spy that **records the code then throws** so the action aborts, with `exitCalls[]` capturing the first meaningful code (L67-78); `process.stderr.write` silenced (L79); `vi.resetModules()` in `afterEach` (L87); commander driven via `command.exitOverride(); await command.parseAsync([...])` (L96-101). Also `src/cli/commands/proxy/__tests__/index.test.ts` (canonical `{ from: 'user' }` argv form) and `src/agents/core/__tests__/AgentCLI-resume.test.ts` (`class ExitError extends Error` carrying the exit code, L9-13; `vi.spyOn(console, 'error')` + `expect.stringContaining` for remediation text, L115-122).
- **SDK client mocking**: only one file in the repo mocks it — `src/utils/__tests__/auth.test.ts:9-11` mocks `../sdk-client.js`. There is **no `vi.mock('codemie-sdk')` anywhere**. For `cli-utils.ts` tests, mock `@/utils/auth.js`'s `getAuthenticatedClient`.
- **`@clack/prompts` is not mocked anywhere**; the repo standardises on `inquirer` in tests (10 files). `vi.stubEnv` is used in exactly one file — manual save/restore of `process.env` is the house style.
- **Integration harness**: `tests/helpers/cli-runner.ts` — `CLIRunner` wraps `execSync('node ./bin/codemie.js <cmd>')`. **`runSilent()` returns `{ output, exitCode, error }` without throwing** (L43-59) — exactly the tool for asserting a non-zero exit plus remediation text. Exemplar: `tests/integration/cli-commands/error-handling.test.ts:24-35`. stdin redirection from `/dev/null` is **not currently done anywhere but is fully supported** — `runSilent(cmd, options)` spreads options into `execSync`, so `{ stdio: ['ignore','pipe','pipe'] }` or `{ input: '' }` yields a non-TTY stdin. Caveat: the spread lands *after* `encoding: 'utf-8'`. Real-TTY cases use node-pty via `tests/helpers/pty-session.ts`. `bin/codemie.js` imports from `../dist/`, so cli-project tests require a prior `npm run build`; the **cli project has no globalSetup** — `npm run ci` relies on `build` preceding `test:integration`.

### Coverage Gaps

- `src/cli/commands/sdk/**` — zero tests across 22 files, including the `getSdkClient` / `handleSdkError` choke point the fix will modify.
- `src/utils/auth.ts` JWT branch (L23-41) — untested.
- `bin/codemie.js` — untested and excluded from coverage.
- No test anywhere manipulates a `CI` env var; a `CI=true`-with-TTY scenario is currently undetectable and untested.
- **Orphaned test files — verified via `npx vitest list`**: the unit project collects 3 956 tests from `src/**` and **zero** from `tests/unit`; the cli project collects 37 files, all under `tests/integration/`. These 5 files match **no** project glob and **never execute**:
  - `tests/unit/cli/commands/assistants/chat/index.test.ts`
  - `tests/unit/cli/commands/assistants/chat/historyLoader.test.ts`
  - `tests/unit/cli/commands/assistants/chat/utils.test.ts`
  - `tests/skills/pattern-invocation.test.ts`
  - `tests/scripts/test-proxy-endpoint.test.ts`

  This matters directly: `src/cli/commands/assistants/chat/index.ts:423` is the second `promptReauthentication` call site and its only test file is in that dead zone. **Any new unit test placed under `tests/unit/` will silently never run.**

---

## 5. Configuration and Environment

### Environment Variables

No central registry or allowlist of `CODEMIE_*` names exists. `src/env/manager.ts` (`EnvManager`) is a key/value store over `~/.codemie/codemie-cli.config.json` with precedence `process.env[key]` > global config (L38-44); it does **not** declare env vars.

Relevant to this task:
- `CODEMIE_NO_PROMPTS` — opt out of interactive prompts, value `'1'` — `src/agents/core/AgentCLI.ts:756`. **The only non-test consumer, and the only env-var escape hatch precedent in the repo.**
- `CI` — **written, never read as detection** — `src/cli/commands/skills/lib/run-skills-cli.ts:89`.
- `CODEMIE_HOME` — overrides `~/.codemie` — `src/utils/paths.ts:356-361` (99 references, the most-used var; used for test isolation).
- `CODEMIE_JWT_TOKEN`, `CODEMIE_AUTH_METHOD` — JWT auth path — `src/agents/core/AgentCLI.ts:~206-207`.
- `CODEMIE_URL`, `CODEMIE_BASE_URL`, `CODEMIE_API_KEY`, `CODEMIE_PROVIDER`, `CODEMIE_MODEL`, `CODEMIE_TIMEOUT`, `CODEMIE_PROFILE_CONFIG`, `CODEMIE_PROFILE_NAME` — `src/utils/config.ts`, `src/utils/profile.ts`.
- `CODEMIE_INSECURE` — read at `src/utils/auth.ts:39` (`verify_ssl: process.env.CODEMIE_INSECURE !== '1'`).
- `CODEMIE_DEBUG` (30 refs), `DO_NOT_TRACK`, `DISABLE_TELEMETRY`, `NODE_OPTIONS`.

**Zero hits anywhere in `src/` or `bin/` for**: `CODEMIE_NON_INTERACTIVE`, `TERM=dumb`, `FORCE_COLOR` (as a read), `noninteractive`.

### Configuration Files

- Global: `~/.codemie/codemie-cli.config.json` — declared twice (`src/env/manager.ts:11`, `src/utils/config.ts:57`).
- Project-local: `.codemie/codemie-cli.config.json` — `src/utils/config.ts:62`, created at L886-911; precedence documented at L113-117.
- Credentials: `src/utils/security.ts` — keychain (keytar) primary, `~/.codemie/credentials/<urlKey>.enc` AES-256-CBC fallback.
- `vitest.config.ts`, `commitlint.config.cjs` (`scope-enum`), `.claude/settings.json` (format/pre-commit hooks).

### Feature Flags and Deployment Concerns

**Definitive: no `--non-interactive`, `--ci`, `--no-input`, `--headless`, or `--batch` option exists anywhere in `src/` or `bin/`.** A targeted grep for those as commander `option(...)` registrations returns zero matches.

The root program (`src/cli/index.ts`, `new Command()` L44) registers **exactly one** option: `.option('--task <task>', …)` at L61. Everything else at L80-106 is `program.addCommand(...)`. There is no root `--yes`, `--force`, or `--quiet`.

Non-interactive detection census:
- **Predicates**: `src/utils/interactive.ts:15` (`!process.stdin.isTTY`, canonical); `src/agents/core/AgentCLI.ts:755-756` `shouldBlockNonInteractiveResume()` = `!process.stdin.isTTY || process.env.CODEMIE_NO_PROMPTS === '1'` (**the only predicate with an env escape hatch**); `src/cli/commands/skills/add.ts:52` `const interactive = !options.yes && process.stdin.isTTY === true` (**flag ∧ TTY — the closest thing to a `--non-interactive` flag**); `src/agents/core/AgentCLI.ts:176` `const isNonInteractiveMode = !!options.task`; `src/cli/commands/analytics/index.ts:154` — the only use of `stdout.isTTY` as a prompt gate.
- **Consumers**: `src/providers/core/auth-validation.ts:34` (sole consumer of the shared helper); `src/agents/core/AgentCLI.ts:707`; `src/cli/commands/skills/lib/agent-detection.ts:76-82`. Raw-mode guards (not prompt skips) at `shared/selection/interactive-prompt.ts:34,66`, `profile/index.ts:259,267`, `shared/agent-targets.ts:177,207`.
- **Forcing sites**: `src/cli/commands/skills/lib/run-skills-cli.ts:89` — `baseEnv.CI = process.env.CI ?? '1'` (note it *respects* an inherited `CI`), gated on `if (!interactive)` where interactive is the default (L64); the L84-90 comment explains that forcing `CI` on interactive runs interferes with Clack/inquirer prompts. Also `speckit.plugin.ts:162` (`--force`), `bmad.plugin.ts:213` (`--yes`), `native-installer.ts:102`, `processes.ts:161`, `claude.plugin.ts:656`.
- **Flag naming precedent**: `-y, --yes` "skip interactive confirmations" on subcommands — `skills/add.ts:46`, `skills/remove.ts:39`, `skills/update.ts:30`, `profile/index.ts:377`, `log/index.ts:144`; `--force` at `setup.ts:129`, `workflow.ts:155`, `proxy/index.ts:297,330,350`. Machine-output precedent `--json` at `proxy/index.ts:196`, `skills/find.ts:42`, `skills/list.ts:28`.

**Verdict on AC 3**: introducing `--non-interactive` or `--ci` would be **novel and contrary to a recorded decision**. `docs/AUTHENTICATION.md:113` documents the flag's absence as intentional, and EPMCDME-13953's spec lists it as explicitly out of scope. AC 3 is worded "supported **or documented**" and is arguably **already satisfied by documentation**; the honest options are (a) cite the existing docs and close AC 3, or (b) if an opt-out is wanted, follow `CODEMIE_NO_PROMPTS=1` / `-y, --yes` rather than inventing a new global flag.

Prompt-surface risk: there are **46 `inquirer.prompt` call sites across 19 non-test files**, and **only the `promptForReauth` path is guarded** by `isNonInteractiveEnvironment()`. Unguarded prompt-bearing modules include `providers/core/codemie-auth-helpers.ts`, `providers/plugins/jwt/jwt.setup-steps.ts`, `cli/commands/setup.ts`, `install.ts`, `update.ts`, `utils/cli-updater.ts`, `agents/core/BaseAgentAdapter.ts`, `assistants/chat/index.ts`. These are latent instances of the same class of bug, out of scope here but worth flagging.

---

## 6. Risk Indicators

- **Ticket premise is partly wrong.** `assistants.ts` *does* use `handleSdkError`; the defect is `await getSdkClient()` sitting outside the `try`. A plan written from the ticket text alone will fix the wrong thing.
- **Blast radius is ~50 actions across 8 files, not one.** `assistants.ts:65,115,166,198,220,240` plus 44 analogous lines in `categories/datasources/integrations/llm/skills/users/workflows`. Fixing only `assistants list` leaves 50 identical paths broken. PR #471's shared-gate precedent argues for fixing inside `getSdkClient()` (`cli-utils.ts:15-18`) rather than at 50 call sites.
- **Two independent defects must both be fixed.** Wrapping `getSdkClient` alone removes the stack trace but still prints the useless `'Authentication expired. Please re-authenticate.'`. Preserving the message alone still leaves the throw uncaught. AC 2 ("clear remediation") fails on *clear*, not on *non-zero* — the CLI already exits 1.
- **`ConfigurationError`'s constructor accepts only `message`** (`src/utils/errors.ts:8-13`). Preserving the upstream error via `{ cause }` requires a constructor change (touching a base class used repo-wide) or a post-hoc `.cause` assignment. Neither is established practice here.
- **`no-useless-catch` is an ESLint warn and the lint gate runs `--max-warnings=0`.** A naive catch-and-rethrow in `auth.ts` will fail CI.
- **`promptReauthentication`'s `Promise<boolean>` return type is a lie** — it can only return `true` or throw, making `auth.ts:48`'s `if (reauthed)` false branch dead code (`auth.ts:52` unreachable via that route). Changing the throw to a `false` return would revive dead code paths and change `src/cli/commands/assistants/chat/index.ts:423` behaviour.
- **Regression pressure on an existing test.** `src/utils/__tests__/auth.test.ts:142-155` asserts the exact buggy message. Any message change breaks it; the test must be updated deliberately, not incidentally.
- **`src/cli/commands/sdk/**` has zero test coverage** across 22 files, including the choke point being modified. Tests there are greenfield — no local conventions to copy, must borrow from `skills/__tests__/commands.test.ts`.
- **Orphaned test directory.** Five test files under `tests/unit/` and `tests/skills/` match no vitest project glob and never run. A new unit test placed under `tests/unit/` would silently never execute. Unit tests must go in `src/**/__tests__/`.
- **No process-level error boundary exists.** `src/cli/index.ts:147` uses sync `program.parse` with no `.exitOverride()`; `bin/codemie.js`'s `.catch` covers only module-load rejections. Any future uncaught async rejection in any of ~29 command files prints a raw stack. A `process.on('unhandledRejection')` net (template at `bin/codemie-mcp-proxy.js:75-82`) would be defence in depth — but `bin/` is excluded from coverage and cannot be unit-tested.
- **`auth-validation.ts:39` writes the diagnostic to stdout via `console.log`**, polluting piped output and breaking `--json` consumers. Cosmetic but in scope-adjacent.
- **Layering.** `src/utils/auth.ts` (Utils) already reaches into `ProviderRegistry` (Core) and does chalk console output (L71), contradicting `architecture.md` L159-171 ("CLI catches, formats for user"). The fix must not deepen this — user-facing formatting belongs in `cli-utils.ts`.
- **AC 3 conflicts with a recorded decision.** EPMCDME-13953's spec put `--non-interactive`/`--ci` explicitly out of scope, and `docs/AUTHENTICATION.md:113` documents the absence as intentional. Adding the flag now would contradict shipped documentation; resolving AC 3 is a product decision, not an implementation one.
- **AC 4 (ERR_USE_AFTER_CLOSE on kill) is unproven, not disproven.** Two attempts failed to reproduce. The reproduction also observed an ora escape-sequence flood (73 MB capture) under `script`, attributed to a pty with no usable `stdout.columns` — flagged as needing a real-terminal recheck before being treated as a finding. Note `src/utils/sdk-client.ts:26` starts an ora spinner even in non-TTY, which is a plausible contributor.
- **The same class of bug is latent in 45 other prompt sites.** Only `promptForReauth` is TTY-guarded; 46 `inquirer.prompt` call sites exist across 19 non-test files.
- **`docs/AUTHENTICATION.md:104-117` currently makes a promise the CLI does not keep.** If the fix changes the emitted message, that section must be updated in the same change — PR #471's precedent makes the doc update part of the deliverable, and CR-001 on the prior ticket was closed *specifically* on that doc addition.
- **Commit scope constraint**: `fix(auth)` / `fix(sdk)` are **not** in commitlint's `scope-enum` and will be rejected. Use `fix(cli)` or `fix(utils)`.
- **`cli-utils.ts` uses double quotes** against the guide's single-quote rule; ESLint does not enforce quote style. Do not mass-reformat — it would balloon the diff.
- **Repo policy: "Tests Only On Explicit Request"** (AGENTS.md). Coverage thresholds in the testing guide are advisory; `vitest.config.ts` configures **no** thresholds.

---

## 7. Summary for Complexity Assessment

**Layers and file surface.** The task touches three layers: CLI (`src/cli/commands/sdk/utils/cli-utils.ts`, and potentially 8 sdk command files), Utils (`src/utils/auth.ts`, possibly `src/utils/errors.ts`), and Core (`src/providers/core/auth-validation.ts`, a one-line stdout→stderr change). The minimal correct implementation is small — the entire defect funnels through a single 4-line function, `getSdkClient()` at `cli-utils.ts:15-18`, which is the sole bridge from all ~50 sdk actions into the auth path. A shared-gate fix there plus a message-preservation change in `auth.ts:76` is roughly **2-3 source files, well under 100 changed lines**. The tempting alternative — moving `await getSdkClient()` inside the `try` in each action — is ~50 mechanical edits across 8 files and should be rejected in favour of the gate, consistent with the precedent set by PR #471. Documentation (`docs/AUTHENTICATION.md:104-117`) must be updated in the same change; the prior ticket's code review was closed specifically on that doc surface, so omitting it repeats a known review failure.

**Technical novelty: low, but the design space has traps.** Every ingredient already exists in-repo. `isNonInteractiveEnvironment()` is the sanctioned detector; `handleSdkError`, `failAuth` (`skills/lib/require-auth.ts:24-51`), `printProxyError` and `handleSetupError` are four existing `never`-returning error sinks, and `require-auth.ts`'s `NOT_AUTHENTICATED_MESSAGE` is verbatim the actionable text the ticket asks for. Nothing needs inventing. The traps are: (1) `ConfigurationError`'s constructor takes only `message`, so preserving the upstream error as `cause` means touching a repo-wide base class; (2) ESLint's `no-useless-catch` warn under `--max-warnings=0` makes a naive catch-and-rethrow a CI failure; (3) `promptReauthentication`'s declared `Promise<boolean>` is unreachable-`false`, so switching from throw to return revives dead code and changes behaviour at `assistants/chat/index.ts:423`; (4) AC 3 (`--non-interactive`/`--ci`) contradicts an explicit recorded out-of-scope decision from EPMCDME-13953 and shipped text in `docs/AUTHENTICATION.md:113` — it is a product call, not an implementation one, and should be escalated rather than implemented unilaterally.

**Test posture: mixed, tilting bad at the point of change.** `src/utils/auth.ts` and `src/providers/core/auth-validation.ts` are well covered, and `src/utils/__tests__/auth.test.ts:142-155` currently asserts the *buggy* message — so a fix necessarily edits an existing green test, which reviewers must not mistake for a regression. Conversely `src/cli/commands/sdk/**` has **zero tests across all 22 files**, so tests for the primary fix location are greenfield. The templates are unambiguous: `src/providers/core/__tests__/auth-validation.test.ts` for mocking the non-interactive seam (mock the function, not `process.stdin`), `src/cli/commands/skills/__tests__/commands.test.ts` for the `process.exit` spy-and-throw pattern, and `tests/helpers/cli-runner.ts`'s `runSilent()` for an end-to-end non-zero-exit assertion with stdin redirected. Two landmines: unit tests must live in `src/**/__tests__/` because five existing files under `tests/unit/` match no vitest glob and silently never run; and `bin/` is excluded from coverage, so any process-level `unhandledRejection` net cannot be unit-tested and needs a cli-project subprocess test.

**Risk factors for scoring.** Complexity is inflated above the raw line count by: a partially incorrect ticket premise that must be corrected before planning; a 50-call-site blast radius that makes "fix the reported symptom" the wrong answer; one acceptance criterion (AC 3) that conflicts with a documented prior decision; another (AC 4) that was never reproduced and may not be a real defect; a required change to an existing passing test; zero test coverage at the primary fix location; and a mandatory documentation update. Nothing here is architecturally hard — the difficulty is entirely in scoping discipline and in not regressing the four adjacent auth paths (`assistants/chat`, `assistants/setup`, `skills/setup`, `AgentCLI`) that already handle this correctly.
