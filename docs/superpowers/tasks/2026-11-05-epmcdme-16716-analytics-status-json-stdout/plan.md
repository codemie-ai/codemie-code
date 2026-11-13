# `--json` stdout purity on a clean CODEMIE_HOME Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (sdlc-light runs these inline in the current conversation via `superpowers:test-driven-development`.)

**Goal:** `codemie proxy analytics status --json` (and every other `--json` invocation) prints only valid JSON to stdout on the first run in an empty `CODEMIE_HOME`.

**Architecture:** The banner comes from `MigrationRunner.runPending({ silent })` in `src/migrations/runner.ts`, called from the plain-JS wrapper `bin/codemie.js` before commander parses anything. `silent` is keyed only on `isHookProcess`. Add a small pure, unit-testable helper `isMachineOutputInvocation(argv)` in `src/utils/`, and use it in `bin/codemie.js` as a second reason (beside `isHookProcess`) to run migrations silently and to skip the update check and the what's-new notice. Details still go to the file log, as for hooks (PR #721 precedent). Silence, not stderr, so `2>&1` callers stay clean.

**Tech Stack:** Node >= 20, ESM TypeScript, Vitest 4 (`unit` and `cli` projects), plain-JS `bin/codemie.js` importing from `dist/`.

**Spec:** none (sdlc-light). Inputs: Jira EPMCDME-16716 (acceptance criteria below) and `technical-analysis.md` in this directory.

## Global Constraints

- AC1: `codemie proxy analytics status --json` on a clean `CODEMIE_HOME` prints only valid JSON to stdout.
- AC2: the migration banner never appears on stdout when `--json` is used.
- Scope is the `--json` flag only. `--format json`, `--print-config`, `--version`, `--task` are out of scope; the existing `version` / `--version` control tests keep asserting the banner appears.
- Hook behaviour (`hook`, `sound`) must not change.
- A failed migration must still never block the command; its warning stays on stderr (`console.error`), never stdout.
- ESM, `.js` import extensions, `@/` alias in `src/`, no `console.log` for debug, no `any`, explicit return types on exports.
- Commits: Conventional Commits, scope from `cli|proxy|analytics|tests|utils|...`, subject <= 100 chars, ticket in the body footer (`Refs: EPMCDME-16716`), never `--no-verify`. Stage only the task's own files: `.codemie/codemie-cli.config.json` carries an unrelated staged change and must NOT be committed.
- Integration (`cli` project) tests run against a prebuilt `dist/`: run `npm run build` before them and again after every source change.

## Review Focus

1. `--json` after the `--` terminator (e.g. `codemie run claude -- --json`) is an argument for the agent, not a CLI flag: must NOT silence. Pinned in Task 1.
2. Look-alikes `--jsonl`, `--no-json`, `-j` must NOT match. Pinned in Task 1.
3. `--json=<value>` and `--json <path>` (sdk commands take a file path) are treated as machine-output (migrations go silent; details remain in the file log). Accepted trade-off, pinned for `--json=` in Task 1.
4. Update check: an available update prints a boxed banner to stdout via `console.log` in `cli-updater.ts`; `--json` must skip it, otherwise AC1 breaks whenever a newer version exists. Pinned in Task 2 (local registry records zero hits).
5. Migrations must still run and be recorded on a silent `--json` first run (`migrations.json` written, `[MigrationRunner] Found` in the file log), not skipped. Pinned in Task 2.

---

### Task 1: `isMachineOutputInvocation` helper

**Files:**
- Create: `src/utils/machine-output.ts`
- Test: `src/utils/__tests__/machine-output.test.ts`

**Interfaces:**
- Produces: `export function isMachineOutputInvocation(argv: readonly string[]): boolean`. `argv` is the CLI arguments after the script name (`process.argv.slice(2)`). Task 2 imports it from `dist/utils/machine-output.js`.

Test-first: yes - `machine-output.test.ts` fails with "Cannot find module" until the file exists, then on each case below.

- [ ] **Step 1: Write the failing test** `src/utils/__tests__/machine-output.test.ts` (Vitest, static import of `../machine-output.js`). Table of cases, `isMachineOutputInvocation(argv)` returns:
  - `true`: `['proxy','analytics','status','--json']`, `['skills','list','--json']`, `['--json','proxy','status']`, `['assistants','get','--json=out.json']`
  - `false`: `[]`, `['version']`, `['--version']`, `['proxy','analytics','status']`, `['run','claude','--','--json']`, `['--jsonl']`, `['--no-json']`, `['-j']`, `['--json-schema']`
- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run --project unit src/utils/__tests__/machine-output.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `isMachineOutputInvocation(argv: readonly string[]): boolean` in `src/utils/machine-output.ts`. Walk `argv`; stop at the first `--`; return true when an arg equals `--json` or starts with `--json=`. Short doc comment: why it exists (start-up output must stay off stdout when the caller asked for machine-readable output; argv is the only signal before commander parses), and that `--json <path>` is knowingly matched.
- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS (all cases).
- [ ] **Step 5: Lint and typecheck.** Run: `npx eslint src/utils/machine-output.ts src/utils/__tests__/machine-output.test.ts --max-warnings 0 && npm run typecheck`. Expected: clean.
- [ ] **Step 6: Commit**

```bash
git add src/utils/machine-output.ts src/utils/__tests__/machine-output.test.ts
git commit -m "fix(cli): add helper to detect machine-readable output invocations" -m "Refs: EPMCDME-16716"
```

---

### Task 2: Wire the helper into `bin/codemie.js` (regression test first)

**Files:**
- Modify: `bin/codemie.js:8` (import), `:25-28` area (new flag), `:36-49` (migration `silent`), `:55` and `:69` (skip update check and what's-new notice)
- Test: `tests/integration/hook-stdout.test.ts` (new `describe('--json invocations')` block after the `codemie sound` test, reusing its `freshHome`, `run`, `fileLog`, `registryHits`)

**Interfaces:**
- Consumes: `isMachineOutputInvocation(argv: readonly string[]): boolean` from `../dist/utils/machine-output.js` (Task 1).
- Produces: nothing for other tasks; behaviour: `--json` runs are silent at start-up.

Test-first: yes - on an empty home, `proxy analytics status --json` currently prints the `migration(s)...` banner before the JSON, so `JSON.parse(stdout)` throws.

- [ ] **Step 1: Write the failing test.** Inside the existing top-level `describe`, add `describe('--json invocations', ...)` with one test, `proxy analytics status --json on a fresh home writes only JSON to stdout, still runs migrations, and skips the update check`. Using `freshHome()` and `await run(home, ['proxy','analytics','status','--json'], '')`: expect `res.code` to be `0`; `() => JSON.parse(res.stdout)` not to throw; `res.stdout` not to contain `migration(s)`; `existsSync(join(home,'migrations.json'))` true; `fileLog(home)` to contain `[MigrationRunner] Found`; `registryHits` to be `0`.
- [ ] **Step 2: Build and run to verify it fails.** Run: `npm run build && npx vitest run --project cli tests/integration/hook-stdout.test.ts -t "--json invocations"`. Expected: FAIL at the `JSON.parse` / `not.toContain('migration(s)')` assertion. If the test errors for another reason (e.g. the command needs extra env in this harness), fix the test setup first so it fails only on the banner.
- [ ] **Step 3: Implement in `bin/codemie.js`.**
  - Add `import { isMachineOutputInvocation } from '../dist/utils/machine-output.js';` next to the logger import.
  - Define `const isMachineOutput = isMachineOutputInvocation(process.argv.slice(2));` right after `isHookProcess`, with a comment that `--json` stdout is the command's answer and that console output is not nulled (only start-up chatter is suppressed).
  - `runPending({ silent: isHookProcess || isMachineOutput })`; update the inline comment. Leave the `catch` branches unchanged (warning stays on stderr).
  - Add `&& !isMachineOutput` to both the update-check condition and the what's-new condition; update their comments.
- [ ] **Step 4: Rebuild and run to verify it passes.** Run: `npm run build && npx vitest run --project cli tests/integration/hook-stdout.test.ts`. Expected: PASS, including the unchanged `version` / `--version` control tests and the hook/sound tests.
- [ ] **Step 5: Manual check of the ticket repro** (bash): `export CODEMIE_HOME="$(mktemp -d)"; node bin/codemie.js proxy analytics status --json > out.txt; node -e "JSON.parse(require('fs').readFileSync('out.txt','utf8'))" && echo OK`. Expected: `OK`. Also run with `--version` on a second fresh home and confirm the banner still prints there.
- [ ] **Step 6: Commit**

```bash
git add bin/codemie.js tests/integration/hook-stdout.test.ts
git commit -m "fix(cli): keep start-up output off stdout for --json invocations" -m "Run migrations silently and skip the update check and what's-new notice when --json is passed, so the first run on a clean CODEMIE_HOME prints only JSON." -m "Refs: EPMCDME-16716"
```

---

### Task 3: Docs and stale workaround comment

**Files:**
- Modify: `docs/COMMANDS.md:1271`
- Modify: `tests/integration/analytics/claude-analytics-disable.test.ts:165-176`

**Interfaces:** none.

Test-first: no - a documentation paragraph and a comment rewrite; the behaviour is covered by Task 2. Verified by re-running the existing suite unchanged.

- [ ] **Step 1: `docs/COMMANDS.md:1271`.** After the hook paragraph's sentence about migrations, add one sentence: a command run with `--json` also runs pending migrations silently (file log only) and skips the update check and what's-new notice, so its stdout carries only the JSON. Keep the hook sentence intact.
- [ ] **Step 2: `claude-analytics-disable.test.ts:165-169`.** Replace the "Known product defect tracked in EPMCDME-16716" comment with one saying the template home is primed once only to avoid paying the first-run migrations in every test (the banner no longer reaches `--json` stdout). Leave the priming code as is.
- [ ] **Step 3: Verify.** Run: `npm run build && npx vitest run --project cli tests/integration/analytics/claude-analytics-disable.test.ts`. Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add docs/COMMANDS.md tests/integration/analytics/claude-analytics-disable.test.ts
git commit -m "docs(cli): document silent start-up for --json and drop stale defect note" -m "Refs: EPMCDME-16716"
```

---

## Self-Review

- Spec coverage: AC1 and AC2 -> Task 2 (regression test plus wiring); cross-command blast radius -> helper keyed on `--json` in Task 1/2; docs -> Task 3; stale workaround -> Task 3. Update-check interaction -> Task 2.
- Signatures consistent: `isMachineOutputInvocation(argv: readonly string[]): boolean` is the only new symbol, used identically in Tasks 1 and 2.
- Out of scope, deliberately: `--format json`, `--print-config`, routing the runner through `logger` (technical-analysis option c), migration 008 test gap, openwiki pages (generated).
