# Analytics Sync Bootstrap — Delivery Target Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a lead running `codemie analytics sync bootstrap` choose webhook, git, or both
delivery targets, check each chosen target before printing the developer install command, and
persist the choice in a versioned state with Reuse / Change targets / Start over.

**Architecture:** One ordered, target-tagged step-descriptor list replaces the fixed 8-step
model and becomes the single source `stepHeading`, resume, reuse and the guided-flow gates all
filter against (D13/AR-1). `BootstrapState` gains a version bump and an explicit `targets`
field (D11). A new git-step module reuses `install`'s exported validators, defaults and
`GitTarget.testPush()` against a temporary working copy (D1, D7, D9, D10). Non-interactive mode
gains the three git flags and checks both targets concurrently (D2, D14).

**Tech Stack:** TypeScript, Commander, Vitest, inquirer (via `BootstrapPrompter`).

**Spec:** `docs/superpowers/tasks/2026-11-11-epmcdme-17123/spec.md`

Commit per task using the repository's existing convention (Conventional Commits per
`.ai-run/guides/standards/git-workflow.md`); no separate commit-block steps below.

## Global Constraints

- Never store, echo, or print a credential-bearing git URL anywhere — state file, stdout, logs
  (D5, D15; NG2).
- Reject a credential-bearing `--git-repo`/saved `git.repoUrl` on every path that could print
  one: fresh guided entry, Reuse re-validation, non-interactive `--git-repo` (D5, D15).
- Lead-side git test push uses a temporary working copy, never
  `~/.codemie/analytics-sync-repo` or the lead's own installed sync settings (D1; story AC8).
- Non-interactive webhook+git checks run concurrently, never sequentially, each keeping its own
  existing timeout (`WEBHOOK_TIMEOUT_MS`, `NETWORK_TIMEOUT_MS`); no combined deadline (D2, D14).
- Turning a target off via Change targets keeps its saved data; it is omitted from printing and
  reuse-checks only (D3).
- No new target kinds, no credential storage, no flow-template changes, no multi-team/multi-repo
  support, no collector back-port (NG1, NG3-NG6). `install`/`status`/`run`/`uninstall` and
  `GitTarget`'s own behavior are unchanged — only validators are exported (NG1, D10).
- `negative-constraints`: covered above — Task 3 (NG1 export-only), Task 4/6/7 (NG2, credential
  rejection + no token), Task 1 (NG3, two-kind `TargetKind`), untouched files (NG4, NG6), single
  state slot unchanged (NG5).

## Review Focus

- A v1 (`version: 1`, PR #765) state file must read as `{webhook:true, git:false}` with its
  fields intact and no migration prompt — pin a fixture test for this (D6; AC16).
- A hand-edited or future-written state file carrying a credential-bearing `git.repoUrl` must
  never reach a Reuse print — this is a second door past fresh-entry validation (AR-2/D15; AC10).
- `--git-repo` with no webhook flag must ask no questions and print a git-only command on
  success (AC12) — the non-interactive dispatch must not assume webhook-only.
- Two targets given non-interactively, one unreachable, must fail in roughly the slower target's
  own timeout, not the sum (AR-3/D14; AC13) — a sequential implementation silently regresses this.
- `Step N of M` and resume-step must stay correct for every target combination (fresh git-only,
  fresh both, saved git-only reopened) — the four previously-independent mechanisms (heading,
  resume, reuse, gates) must all read the same filtered list (AR-1/D13; AC2, AC21, AC23).

---

### Task 1: Target-tagged step-descriptor model

**Files:**
- Create: `src/cli/commands/analytics/sync/bootstrap/step-model.ts`
- Remove: `src/cli/commands/analytics/sync/bootstrap/steps.ts` (superseded)
- Test: `src/cli/commands/analytics/sync/bootstrap/__tests__/step-model.test.ts`

**Interfaces:**
- Produces: `TargetKind = 'webhook' | 'git'`; `TargetSelection = { webhook: boolean; git: boolean }`;
  `StepDescriptor = { id: string; title: string; targets: TargetKind[] | 'always' }`;
  `ALL_STEPS: StepDescriptor[]` (ids: `target`, `channel`, `folder`, `timezone`, `flow`,
  `trigger-url`, `git-repo`, `external`, `lookback`, `developers` — the first 5 tagged
  `['webhook']`, `git-repo` tagged `['git']`, the rest `'always'`); `stepsFor(selection:
  TargetSelection): StepDescriptor[]` (filters `ALL_STEPS`, preserving order);
  `stepHeading(steps: StepDescriptor[], id: string): string` → `"Step N of M · <title>"`, 1-based
  on `id`'s position in `steps`.

- [ ] **Step 1: Write failing tests** covering `stepsFor({webhook:true,git:false})` (today's 8
  steps plus `target`), `stepsFor({webhook:false,git:true})` (4 steps: `target`, `git-repo`,
  `external`, `lookback`, `developers`), `stepsFor({webhook:true,git:true})` (all 10), and
  `stepHeading` producing `"Step 1 of 5 · Delivery target"` for the git-only list.
- [ ] **Step 2: Run tests, confirm failure** (module does not exist).
- [ ] **Step 3: Implement `step-model.ts`** with the interfaces above; delete `steps.ts` and its
  test file (content is superseded, not extended).
- [ ] **Step 4: Run tests, confirm pass.**
- Test-first: yes — `stepsFor`/`stepHeading` behavior for all three target combinations has no
  prior implementation.

---

### Task 2: State store v2 — target field, v1 compatibility, descriptor-driven resume/reuse

**Files:**
- Modify: `bootstrap/state-store.ts` (whole file: `BootstrapState`, `isBootstrapStateShape`,
  `loadBootstrapState`, `firstUnansweredStep`, `checkReuse`, `toInstallCommandOptions`,
  `summarizeState`)
- Test: `bootstrap/__tests__/state-store.test.ts` (add a v2/git fixture alongside
  `COMPLETE_STATE`, per the spec's own Open Risk; keep the existing webhook-only fixture)

**Interfaces:**
- Consumes: `stepsFor`, `StepDescriptor` (Task 1); `validateGitRepoUrl`/`validateGitSettings`
  (Task 3, exported).
- Produces: `BootstrapState` v2 — `version: 2; targets: TargetSelection; gitRepoUrl?: string;
  gitBranch?: string; gitPath?: string; gitTest?: 'passed' | 'skipped'; …existing fields
  unchanged`. `firstUnansweredStep(state): string` now returns a step **id**, not a number.
  `ReuseCheck = { ok: true; options: InstallCommandOptions } | { ok: false; resumeAt: string }`.
  `toInstallCommandOptions` emits `gitRepo`/`gitBranch`/`gitPath` when `targets.git` is true.

- [ ] **Step 1: Write failing tests**: a `version: 1` fixture (today's `COMPLETE_STATE`, no
  `targets` field) loads via `loadBootstrapState` as `{ ...fields, version: 2, targets:
  {webhook:true, git:false} }` (AC16); a fresh git-only v2 state's `firstUnansweredStep` returns
  `'git-repo'` then `'external'`/`'lookback'`/`'developers'` as fields fill in; `checkReuse` on a
  v2 state with `targets.git: true` and a credential-bearing `gitRepoUrl` returns `{ok:false,
  resumeAt:'git-repo'}` without throwing (AR-2 prep for Task 6's full re-check).
- [ ] **Step 2: Run tests, confirm failure.**
- [ ] **Step 3: Implement.** `isBootstrapStateShape` accepts `version === 1` (no `targets`,
  defaulted at read time to `{webhook:true,git:false}`, never written back until the next save)
  or `version === 2` (requires a `targets` object); anything else is treated as absent, per
  today's "unexpected shape" notice. `firstUnansweredStep`/`checkReuse` are rewritten against
  `stepsFor(state.targets)`, walking the filtered list in order and checking each step id's
  field(s) the same way the current numeric branches do. `toInstallCommandOptions` adds the git
  flags only when `targets.git`.
- [ ] **Step 4: Run tests, confirm pass.**
- Test-first: yes — v1→v2 read compatibility and id-based resume for a git-only state have no
  existing coverage (confirmed gap, technical-analysis.md §4).

---

### Task 3: Export install's git validators; one `hasAnyTarget` predicate

**Files:**
- Modify: `sync/config-store.ts:70-201` (export `hasEmbeddedCredentials`, `validateGitRepoUrl`,
  `validateGitBranch`, `validateGitPath`, `validateGitSettings`, unchanged bodies; add and
  export `hasAnyTarget(webhookUrl: string | undefined, git: GitSettings | undefined): boolean`)
- Modify: `sync/install-command.ts:87-90` — replace the inline `webhook === undefined &&
  gitRepo === undefined` check with `hasAnyTarget`
- Test: `sync/__tests__/config-store.test.ts` (new cases for the exported functions),
  `sync/__tests__/install-command.test.ts` (no behavior change, confirm still green)

**Interfaces:**
- Produces: the five validator exports above, plus `hasAnyTarget` — Task 4, 6 and 7 import these
  instead of duplicating credential/shape checks (D10; arch-review plan note on the
  three-times-duplicated "at least one target" rule).

- [ ] **Step 1: Write failing test** asserting `hasEmbeddedCredentials('https://tok@host/r')` and
  `validateGitRepoUrl` are importable from `config-store.ts` (currently module-private) and
  behave identically to today's private versions (reuse existing private-function test cases).
- [ ] **Step 2: Run test, confirm failure** (not exported).
- [ ] **Step 3: Implement** — add `export` to the five functions (no body change: NG1), add
  `hasAnyTarget`, and call it from `validateInstallOptions` (`config-store.ts:283`) and
  `buildInstallCommand` (`install-command.ts:88`) in place of their separate checks.
- [ ] **Step 4: Run tests, confirm pass**, including the existing `install-command.test.ts` git-only
  case (`__tests__/install-command.test.ts:14`) still green.
- Test-first: yes — the export surface itself is new, even though the logic is not.

---

### Task 4: Git step group — repo/branch/path entry, temporary-copy test push, email resolution

**Files:**
- Create: `bootstrap/git-step.ts`
- Test: `bootstrap/__tests__/git-step.test.ts`

**Interfaces:**
- Consumes: `validateGitRepoUrl`/`validateGitBranch`/`validateGitPath` (Task 3);
  `resolveSyncIdentity`, `realIdentityDeps` (`sync/identity.ts`); `GitTarget`, `gitHint`,
  `createGitRunner` (`sync/targets/{git-target,git-client}.ts`).
- Produces: `askGitDetails(deps: BootstrapDeps, saved?: {repoUrl,branch,path}):
  Promise<{repoUrl: string; branch?: string; path?: string}>` (prompts repo URL retried via the
  exported credential/shape validators — a credential-bearing value is rejected and re-asked,
  never echoed; branch/path left `undefined` on blank input, so `install`'s own defaults apply
  per D7); `testGitCheck(deps: BootstrapDeps, git: GitSettings, email: string | undefined):
  Promise<'passed' | 'skipped' | 'retry'>` — resolves email via `resolveSyncIdentity`, prompting
  (unsaved) in guided mode on `SyncIdentityMissingError`; runs `testPush()` against a fresh
  `fs.mkdtemp`-based temp dir passed as `GitTarget`'s `dir` override, always `rm`s it in a
  `finally` regardless of outcome; on failure prints `gitHint(err.gitCause)` and offers
  retry/different-details/skip (mirrors `testSendLoop`'s shape, never a credential prompt — D1,
  D9; AC6, AC7, AC9).

- [ ] **Step 1: Write failing tests**: `askGitDetails` rejects a credential-bearing repo URL
  without echoing it and re-asks (AC10); `testGitCheck` creates and removes a temp dir distinct
  from `gitWorkingCopyPath()` on both success and failure (AC8); a missing email with no TTY
  fallback throws/fails closed in the non-interactive caller (Task 7 wires that path; this task
  tests the guided-mode prompt-fallback branch only, AC7).
- [ ] **Step 2: Run tests, confirm failure** (module does not exist).
- [ ] **Step 3: Implement**, following `testSendLoop`'s (`guided-late-steps.ts:50-87`) retry/url/
  skip shape and `install.ts`'s `testGitTarget`/`printGitFailure` (`install.ts:184-199,143-148`)
  for the hint and cleanup pattern, but cleaning up the temp dir on **both** outcomes (install
  only removes on failure; this module must remove on success too — AC8).
- [ ] **Step 4: Run tests, confirm pass.**
- Test-first: yes — no existing test runs a git test push outside `install` (confirmed gap,
  technical-analysis.md §4, §6).

---

### Task 5: Target selection as step 1; guided flow driven by the filtered descriptor list

**Files:**
- Modify: `bootstrap/guided.ts` (whole file: `resolveStartStep`, `discardStaleAnswers`,
  `runGuided`, all 4 `stepHeading(n)` call sites)
- Modify: `bootstrap/guided-late-steps.ts` (`runStepsFiveThroughEight` → driven by the filtered
  list; `step8Developers` prints the git branch/path flags and, when git is included, the D8
  developer-access note)
- Test: `bootstrap/__tests__/guided.test.ts` (headings/sequence rewritten for 3 selections: AC1,
  AC2, AC3), `bootstrap/__tests__/guided-late-steps.test.ts` if present, else folded into
  `guided.test.ts`

**Interfaces:**
- Consumes: `stepsFor`, `stepHeading` (Task 1); `askGitDetails`, `testGitCheck` (Task 4);
  `firstUnansweredStep` returning a step id (Task 2).
- Produces: a new `step0Target` asking `select('webhook'|'git'|'both')`, saving
  `state.targets`; `runGuided` now iterates `stepsFor(state.targets)` by id instead of 4
  hardcoded `if (startStep <= N)` branches, calling the matching step function (webhook steps
  unchanged in content; `git-repo` calls Task 4's `askGitDetails`/`testGitCheck`).

- [ ] **Step 1: Write failing tests**: fresh git-only run asks target choice then only
  `git-repo`/`external`/`lookback`/`developers`, with headings `"Step 1 of 5"`..`"Step 5 of 5"`
  (AC2); fresh webhook-only run's headings and prompts are byte-identical to today's except the
  new leading target step and renumbered "of 9" (AC3); both-targets run prints a command with
  both `--git-repo` and `--webhook-b64` (AC4); empty branch/path produce no `--git-branch`/
  `--git-path` token (AC5).
- [ ] **Step 2: Run tests, confirm failure.**
- [ ] **Step 3: Implement.** Replace the 4 `stepHeading(0..3)`/`stepHeading(4..7)` literal calls
  with `stepHeading(stepsFor(state.targets), '<id>')`; `runGuided`/`runStepsFiveThroughEight`
  gate each step by `shown.some(s => s.id === '<id>')` instead of a numeric `startStep <= N`.
  `step8Developers` appends the D8 note (`"Push access comes from each developer's own SSH key
  or credential helper, verified by install."`) only when `state.targets.git`.
- [ ] **Step 4: Run tests, confirm pass**, including the full pre-existing 32-test suite
  (headings at `guided.test.ts:154-163,347,675`) updated for the new leading step and the two
  new target combinations.
- Test-first: yes — the per-combination step sequence and headings have no prior coverage.

---

### Task 6: Saved-setup summary, Reuse / Change targets / Start over, target-aware reuse re-checks

**Files:**
- Modify: `bootstrap/state-store.ts:summarizeState` (list an off target as "off"; mask
  `gitRepoUrl` the same way `webhookUrl` is masked)
- Modify: `bootstrap/guided.ts:resolveStartStep` (3-way menu replacing today's binary
  reuse/restart confirm)

**Interfaces:**
- Consumes: `checkReuse` (Task 2, extended here to re-run `validateGitRepoUrl` on
  `state.gitRepoUrl` and, when it still validates, `testGitCheck` — D12, D15); `stepsFor`.
- Produces: `resolveStartStep` now offers `Reuse / Change targets / Start over` whenever any
  saved target exists (not only webhook — AC15, AC21); **Reuse** re-checks every target in
  `state.targets` (webhook via the existing `testSendLoop`, git via Task 4's `testGitCheck` plus
  the credential re-validation) before returning `startStep: 'developers'`, printing only once
  every check passes or is explicitly skipped (D12); **Change targets** re-asks the target-choice
  step, keeps every existing field, and runs only the newly-added target's steps — turning a
  target off clears it from `state.targets` without deleting its fields (D3; AC18-AC20).

- [ ] **Step 1: Write failing tests**: a saved git-only setup opens with its summary and the
  3-way menu, not the flow-import question (AC21); Reuse on a both-targets setup with a since-
  revoked git credential (an embedded-credential value written by an older build) resumes at
  `git-repo` rather than printing (AR-2/D15); Change targets, adding git to a saved webhook-only
  setup, asks only git questions and prints both targets (AC19); turning webhook off keeps
  `state.webhookUrl` on disk but omits `--webhook-b64` from the print and from the next Reuse
  check (AC20).
- [ ] **Step 2: Run tests, confirm failure.**
- [ ] **Step 3: Implement**, extending `checkReuse`'s existing webhook-only re-validation
  (`state-store.ts:165-197`) with the git branch described above, and `resolveStartStep`'s
  binary confirm (`guided.ts:267-295`) with the 3-way select.
- [ ] **Step 4: Run tests, confirm pass.**
- Test-first: yes — D12's "re-check every chosen target" and D3's "off keeps saved data" are
  both new behavior with no prior test.

---

### Task 7: Non-interactive mode — git flags, concurrent dual-target check, fail-closed credential rejection

**Files:**
- Modify: `bootstrap/types.ts:13-19` (`BootstrapOptions` gains `gitRepo?`, `gitBranch?`,
  `gitPath?`)
- Modify: `bootstrap/run-bootstrap.ts` (`runWebhookMode` → generalized dual-target runner;
  `NO_TTY_MESSAGE`; `runBootstrap`'s dispatch predicate uses `hasAnyTarget`, Task 3)
- Modify: `analytics/index.ts:99-117` (`createSyncBootstrapCommand` — add the 3 git options,
  mirroring `install`'s option text at `:130-132`)
- Test: `bootstrap/__tests__/run-bootstrap.test.ts`

**Interfaces:**
- Consumes: `validateGitSettings`, `hasAnyTarget` (Task 3); `GitTarget`, `createGitRunner`
  (git-target/git-client); `resolveSyncIdentity`.
- Produces: `runBootstrap` dispatches to non-interactive mode whenever `hasAnyTarget` of the raw
  options is true (webhook or git, not only webhook as today); the non-interactive runner
  validates every given option first (fail closed, no network call, no command — same as
  today's webhook-only ordering), then runs the webhook test-send and the git test-push **via
  `Promise.allSettled`** for whichever targets were given, each keeping its own existing
  timeout; on any target's failure, prints which target failed (webhook message pre-redacted as
  today) and returns 1; on all-pass, prints the command (with Task 5's D8 note when git is
  included) and returns 0. `NO_TTY_MESSAGE` names `--webhook`/`--webhook-b64` and `--git-repo`.

- [ ] **Step 1: Write failing tests**: `--git-repo` alone (no webhook flag) asks nothing, test-
  pushes, prints a git-only command (AC12); `--webhook <url> --git-repo <bad-but-unreachable-url>`
  fails naming the git target, webhook signature masked, non-zero exit, and the elapsed time in
  the fake clock reflects the slower target alone, not their sum (AC13 — assert via injected
  deps' call ordering/timing, not a real network wait); no TTY and no target flag's message
  names both `--webhook`/`--webhook-b64` and `--git-repo` (AC14); a credential-bearing
  `--git-repo` fails before any network call, with no command printed and the URL never in
  `deps.err`/`deps.out` output (D5/D15).
- [ ] **Step 2: Run tests, confirm failure.**
- [ ] **Step 3: Implement.** Keep `resolveWebhookOption`'s existing validation first; add
  `validateGitSettings` validation for the three new flags before any network call; run the
  given checks with `Promise.allSettled([...])`, not sequential `await`s.
- [ ] **Step 4: Run tests, confirm pass**, including the existing 16 `run-bootstrap.test.ts`
  cases (webhook-only paths unchanged).
- Test-first: yes — D14's concurrency and the fail-closed credential path on this entry point
  have no prior coverage.

---

### Task 8: Documentation — three-way target choice in both modes

**Files:**
- Modify: `docs/COMMANDS.md:747-830` (bootstrap section: target choice, git flags, both modes)
- Modify: `docs/ANALYTICS-SYNC.md` (bootstrap section: replace "developer types `--git-repo`
  themselves" framing with the lead-side wizard choice; keep the existing developer-side
  install examples unchanged — NG1)
- Modify: `.ai-run/guides/security/security-practices.md:105-118` (lead state file now may also
  hold a git repo URL/branch/path; still 0o600, still no credentials)

- [ ] **Step 1: Update `docs/COMMANDS.md`** — describe the target-choice step, the git step
  group, and the non-interactive `--git-repo`/`--git-branch`/`--git-path` flags (AC24).
- [ ] **Step 2: Update `docs/ANALYTICS-SYNC.md`** — same, in the lead-facing bootstrap section.
- [ ] **Step 3: Update the security guide** — note the lead state's new `targets`/git fields,
  still no credential storage (NG2).
- Test-first: no — documentation only, nothing to assert against.

---

## Self-Review

1. **Spec coverage:** AC1-AC9 → Tasks 4, 5. AC10 → Tasks 2, 6, 7. AC11 → Tasks 5, 7 (D8 note).
   AC12-AC14 → Task 7. AC15-AC23 → Tasks 2, 5, 6. AC24 → Task 8. NG1-NG6 → Global Constraints,
   enforced by Tasks 3 (export-only) and 4/6/7 (no credential storage/new targets). D1-D15 are
   each cited in the task that implements them.
2. **Step scan:** every code step names an exact file, function, and the behavior change; no
   step reads "handle edge cases" or leaves a type undefined.
3. **Type consistency:** `TargetSelection`/`TargetKind` (Task 1) are the only names used for the
   choice everywhere downstream (Tasks 2, 5, 6, 7); `firstUnansweredStep`'s id-string return
   type is consistent from Task 2 through Tasks 5-6; `GitSettings`'s existing shape
   (`repoUrl`/`branch`/`path`) is reused unchanged by Task 2's state fields and Task 4's
   `askGitDetails` return type.
4. **Review Focus:** the 5 listed risks each have an owning task and test, above.
5. **Proportion:** this plan is longer than its ~2KB default because the spec's own novelty
   score (L, 21) and 15+ touched files are real; code blocks are limited to new type/interface
   shapes, not bodies — no fenced block exceeds a few lines, well under 40% of the document.
