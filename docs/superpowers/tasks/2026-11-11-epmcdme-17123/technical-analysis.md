# Technical Research

**Task**: analytics sync bootstrap wizard guided steps git target webhook target install command delivery targets
**Generated**: 2026-11-10
**Research path**: filesystem

---

## 1. Original Context

Lets create a story to add a git target configuration to the analytics collector migration from the codemie-onboarding repository to the codemie CLI. Current work is happening in https://github.com/codemie-ai/codemie-code/pull/765 (branch feat/analytics-sync, checked out locally in /Users/Oleksandr_Voievodin1/projects/AI_RUN/codemie-dev/codemie-code). I expect this to be a separate PR, built after the merge of the original one. Git target is already built in scope of that one (sync install --git-repo/--git-branch/--git-path). The story should add a setup wizard step (codemie analytics sync bootstrap), which will allow the lead to select the desired targets (either git or webhook or both).

---

## 2. Codebase Findings

**Baseline note:** the local checkout (HEAD `05bde5d9`) is 45 commits behind PR #765's head (`998d279f`, PR still OPEN). Files below were read locally and diffed against the PR head through the GitHub API. Where they differ, the PR-head behaviour is marked **(head)**. Paths are relative to `src/cli/commands/analytics/sync/`.

### Existing Implementations

**Purpose A: a lead chooses where developers' reports go (webhook, git, or both)**
- `install` already accepts either target or both. `validateInstallOptions` (`config-store.ts:262-270`) needs at least one of `--webhook`/`--webhook-b64` **(head)** or `--git-repo`. If neither is given, it throws "At least one sync target is required". A git-only install is valid. `runInstall` skips the test push when `settings.git` is unset (`install.ts:178-181`). `run-sync.ts:111-120` delivers to every configured target (webhook first, then git).
- `buildInstallCommand` (`install-command.ts:83-99`) already emits `--git-repo/--git-branch/--git-path`. It needs at least one of `webhook`/`gitRepo`. Pinned test: "builds a git-only install command" (`__tests__/install-command.test.ts:14`). **(head)** It prints the webhook as `--webhook-b64 <base64url>` (`webhook-encoding.ts`).
- Bootstrap never passes git flags to the builder. `toInstallCommandOptions` (`bootstrap/state-store.ts:206-212`) maps only `webhookUrl`, `includeExternal` and `lookbackDays`. `BootstrapState` (`state-store.ts:29-46`) has no target-selection or git field. Bootstrap's only target is the webhook.
- The standalone collector (`../codemie-onboarding/codemie-analytics-collector/src/wizard.js:50-59`) has the same 8 `STEPS` and no git target. Nothing exists to port.

**Purpose B: prove the chosen target works before printing the command**
- Webhook: `testSendLoop` (`bootstrap/guided-late-steps.ts:50-87`), with retry, different URL and skip. `runWebhookMode` (`bootstrap/run-bootstrap.ts:80-119`) prints the command only after a 2xx. The payload is `setupCheckReport` (`bootstrap/setup-check.ts:24`).
- Git: `GitTarget.testPush()` (`targets/git-target.ts:100-109`) commits `.codemie-sync-check` to `<git-path>/<emailSlug(email)>/` and pushes it.
  - Needs: an email, a `GitRunner` (`targets/git-client.ts:142`) and a working-copy dir. The dir defaults to `gitWorkingCopyPath()` = `~/.codemie/analytics-sync-repo` (`git-target.ts:62`); the constructor's 4th parameter `dir` overrides it (`:82`).
  - Only `install` calls it today (`install.ts:272`). `install` removes the working copy on failure (`install.ts:188`) and keeps it on success.
  - `ensureWorkingCopy` (`git-target.ts:143-158`) deletes and re-clones the dir when its `origin` differs from `repoUrl`.
- `BootstrapDeps` (`bootstrap/types.ts:31-41`) has `send` (webhook) but no git runner, no identity resolver and no working-copy cleanup.
- The lead's email can come from `resolveSyncIdentity` (`identity.ts:39`): config email, then `git config --global user.email`.

**Purpose C: keep secrets out of the printed command and output**
- `validateGitRepoUrl` (`config-store.ts:81-97`) and `hasEmbeddedCredentials` (`:64-76`):
  - reject any userinfo on `http(s)://` (`https://<token>@…`) and `user:pass@` on ssh/scp;
  - allow a bare ssh user (`git@host:org/r.git`);
  - never echo the value.
  - Both functions and `validateGitSettings` (`:181`) are module-private. Only `validateInstallOptions` is exported.
- `buildInstallCommand` applies only the printable-value rule (`assertPrintableValue`, `install-command.ts:45-61`). It does no credential check. A credential-bearing `gitRepo` given to it is printed as-is.
- `redactSecrets` (`redact.ts:19-24`) masks `sig=` and URL userinfo. The install summary prints the repo through it (`install.ts:80`).
- Git authentication uses the developer's own SSH key or credential helper. No token is requested or stored. Every call is prompt-free: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `SSH_ASKPASS_REQUIRE=never`, ssh `BatchMode=yes` (`git-client.ts:38-59`). On an unknown host key, auth failure or protected branch, the call fails with a `gitHint` (`git-client.ts:99-119`).

**Purpose D: numbered, resumable wizard**
- `STEPS` (8 titles) and `stepHeading(i)` → "Step N of 8 · title" (`bootstrap/steps.ts:13-33`). Each step function hard-codes its index: `stepHeading(0..3)` in `guided.ts:50,134,159,200` and `stepHeading(4..7)` in `guided-late-steps.ts:97,136,159,206`.
- Resume works from field presence: `firstUnansweredStep` (`state-store.ts:118-151`) maps steps 1-4 to the Teams/SharePoint/timeZone/flowImported fields and steps 5-7 to webhookUrl+webhookTest/includeExternal/lookbackDays. Step 8 means done. `checkReuse` (`:165-197`) re-validates steps 5-7. `skippedSetup` bypasses steps 1-4.
- Start logic (`guided.ts:267-295`):
  - With no saved `webhookUrl`, the first question is "Have you already imported the flow and copied its trigger URL?" No → step 1; yes → step 5.
  - With a saved webhook: "Reuse them?" → step 8, or resume at `resumeAt`.
  - `discardStaleAnswers` (`:247-255`) uses numeric thresholds (`startStep > 5`, `<= 4`).
- `runGuided` gates each step with `startStep <= N` (`guided.ts:321-343`). `runStepsFiveThroughEight` gates with `fromStep <= N` (`guided-late-steps.ts:222-242`).

**Other touched code**
- `bootstrap/run-bootstrap.ts:132-143` `runBootstrap`: dispatches to the non-interactive path on `--webhook` **(head: or `--webhook-b64`)**. With no TTY, it prints `NO_TTY_MESSAGE` (`:56-59`), which names only `--webhook`. Otherwise it runs `runGuided`.
- `../index.ts:97-112` (head `:99-118`) registers `bootstrap` with `--webhook`, **(head)** `--webhook-b64`, `--lookback-days` and `--include-external`. Description: "Lead: connect a Teams channel and SharePoint folder … (installs nothing on this machine)".
- `bootstrap/types.ts:13-17` `BootstrapOptions`: no git flags.

### Decisions Already in the Code
- Bootstrap test-sends before printing a command, in both modes (`run-bootstrap.ts:99-118`, `guided-late-steps.ts:105`). Install test-pushes git before touching the scheduler (`install.ts:5-14`). Recorded in the bootstrap and git-target specs.
- Git credentials never go in a URL or in storage (git-target spec non-goal "No storing tokens or credential-bearing URLs", `docs/superpowers/tasks/2026-11-03-analytics-sync-git-target/spec.md:97`; code `config-store.ts:90-94`).
- Only the install command goes to stdout; everything else goes to stderr, and prompts draw on stderr (`run-bootstrap.ts:16-19,147-150`).
- Bootstrap "installs nothing on this machine" (`index.ts:100`) and never sets `--at` (`state-store.ts:204`).
- The lead state is a single slot, `~/.codemie/analytics-sync-bootstrap.json` (0o600). Its `version: 1` shape check covers only `version` (`state-store.ts:61-66`). The security guide sanctions it as a webhook store (`.ai-run/guides/security/security-practices.md:113-118`).
- `guided.ts` must never import `run-bootstrap.ts`. Shared types live in `bootstrap/types.ts` and shared helpers in `setup-check.ts`/`guided-support.ts`, to avoid an import cycle (`bootstrap/types.ts:5-8`).
- Printed values are double-quoted, and values unsafe in any shell are rejected. Bootstrap decision: "git-repo commands change too" (bootstrap `spec.md:98`). **(head)** The webhook goes out as base64url because of PowerShell `.cmd` and cmd.exe `%` expansion.
- Data direction: the state stores step answers keyed to the webhook flow. Target selection has no stored field, and `firstUnansweredStep` derives the resume step only from webhook-flow fields.

### Task Statements Checked Against the Code
- "Git target is already built (sync install --git-repo/--git-branch/--git-path)": **holds** (`index.ts:123-125`, `config-store.ts:181-195`, `targets/git-target.ts`).
- "Current work … checked out locally": **partly contradicted**. The local branch is 45 commits behind the PR head. Missing locally: `--webhook-b64` (`a4e6c34e`, `1a148dda`), the include-external default changed to `never` (`7531bc67`), the versioned `updateHint` (`9b0572a4`), and install restoring the previous job (`23f10651`).
- "Separate PR built after the merge of the original one": **unverified**. PR #765 is OPEN on 2026-11-10.
- "Add a setup wizard step … select git or webhook or both": **keeps a mechanism in place**. The `install` CLI and `buildInstallCommand` already support all three combinations (Purpose A). Bootstrap's 8-step flow, its webhook-keyed resume (`firstUnansweredStep`, `resolveStartStep`) and its non-interactive dispatch all assume a webhook (Purposes B and D).
- Caller asked whether steps 1-5 are webhook-specific: **holds**. Steps 1-3 collect values only for `writeFlowPackage` (`guided.ts:202-208`). Step 4 writes and imports the Power Automate flow. Step 5 asks for its trigger URL and test-sends it. Steps 6-7 (include-external, lookback) map to install flags for any target.

### Consumers of Changed Contracts
Searched by symbol name across `src/`, `docs/` and `.ai-run/`.
- `BootstrapState` / `toInstallCommandOptions` / `firstUnansweredStep` / `checkReuse` / `summarizeState`: used in `guided.ts:28,282,288`, `guided-late-steps.ts:21,209` and `bootstrap/__tests__/state-store.test.ts` (25 tests; fixture `COMPLETE_STATE` has only webhook fields).
- `STEPS` / `stepHeading`: 8 call sites (above); `guided.test.ts:154-163` pins all eight "Step N of 8" headings, and `:347` pins "Step 5 of 8 · Trigger URL".
- `BootstrapOptions` / `runBootstrap` / `BootstrapDeps`: used in `index.ts` (bootstrap action), `createRealBootstrapDeps` (`run-bootstrap.ts:182`) and the fakes in `run-bootstrap.test.ts` (16 tests) and `guided.test.ts` (32 tests).
- `buildInstallCommand`: `run-bootstrap.ts:111` and `guided-late-steps.ts:209`; tests in `install-command.test.ts` (11).
- `GitTarget` / `gitWorkingCopyPath`: `install.ts`, `run-sync.ts:258` and `uninstall.ts:20,73-81` (uninstall deletes `analytics-sync-repo/`).
- Docs:
  - `docs/COMMANDS.md:747-790` describes bootstrap as Teams/SharePoint only.
  - **(head)** `docs/ANALYTICS-SYNC.md` "Delivering to a git repository" shows the developer typing `--git-repo` themselves.
  - Security guide `:113-118` describes the lead state as holding the webhook.

### Architecture and Layers Affected
CLI command layer only: Commander registration in `analytics/index.ts`; the bootstrap runner, guided wizard and state store in `sync/bootstrap/`; shared sync utilities (`install-command.ts`, `config-store.ts` validators, `targets/git-target.ts`, `targets/git-client.ts`, `identity.ts`). There is no backend, plugin or provider layer.

### Integration Points
- External: Power Automate trigger (HTTPS, `targets/webhook-target.ts`) and a team git remote (the `git` binary through `@/utils/exec.js`).
- Internal: `bootstrap/*` → `config-store.ts` (validators), `install-command.ts`, `trigger-url.ts`, `redact.ts`; `install.ts` → `targets/git-target.ts` → `report/report-generator.ts` (`emailSlug`).

### Patterns and Conventions
- Injected deps (`*Deps` interface + `createReal*Deps()`), so runners never throw or call `process.exit`.
- `BootstrapPrompter` (input/confirm/select) with an `askValidated` retry loop (`guided-support.ts:23`).
- Save after every step through the `SaveBootstrapState` closure.
- Errors: `SyncConfigError`, `SyncGitError` with `gitCause`, `BootstrapInputError`; every message goes through `errorMessage`/`redactSecrets`.
- Lazy `await import()` of heavy modules in commands and real deps.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/security/security-practices.md:105-118`: the 0o600 sync state files are sanctioned webhook stores.
- `docs/COMMANDS.md:747-830` covers bootstrap and install.
- **(head)** `docs/ANALYTICS-SYNC.md` is the 410-line lead and developer guide. Git is a developer-typed install option, and the guide says "Give `--webhook-b64`/`--webhook` and `--git-repo` together, and every run delivers to both."

### Architectural Decisions
- `docs/superpowers/tasks/2026-11-04-analytics-sync-bootstrap/spec.md` non-goals (`:84-94`): no change to the flow template, no collector parity, one team per lead machine. Decisions (`:96-100`): double quotes for all values, including git.
- `docs/superpowers/tasks/2026-11-03-analytics-sync-git-target/spec.md`: AC2 (test push), AC3 (no credential-bearing URL), AC8 (prompt-free failure). Non-goal `:90`: "No bootstrap command … only the reusable command builder."
- `decisions.jsonl` (both runs): HITL approvals. Bootstrap AR-3 stores the full webhook in 0o600 state.

### Derived Conventions
- No TODO/HACK markers in `sync/`. File headers cite the spec section and plan task each module implements.

---

## 4. Testing Landscape

### Existing Coverage
- `bootstrap/__tests__/`: guided (32), state-store (25), run-bootstrap (16), links (17), flow-package (8), timezones (7).
- `__tests__/`: install (17; "git target test push" block at `:265-320`), install-command (11, including git-only), config-store, git-client, run-sync, status, uninstall; `targets/__tests__/` covers the git target.

### Testing Framework and Patterns
- Vitest. Fake `BootstrapPrompter` scripted with answers. Injected `send`/`openUrl`/`out`/`err` capture lines. The temp `statePath` lives per test. `InstallDeps` fakes stand in for the scheduler and `testGitPush`.

### Coverage Gaps
- No bootstrap test produces a command with `--git-repo`. No test runs a git test push outside `install`. No test covers a `BootstrapState` without a webhook reaching step 8.

---

## 5. Configuration and Environment

### Environment Variables
- `GIT_SSH_COMMAND`, `GIT_SSH` and `core.sshCommand` are read. `GIT_TERMINAL_PROMPT`, `GCM_INTERACTIVE`, `SSH_ASKPASS_REQUIRE` and `GIT_SSH_COMMAND` (with BatchMode) are set (`git-client.ts:38-59,121-132`).
- `CODEMIE_HOME` is not passed to the OS job (PR known gap).

### Configuration Files
- `~/.codemie/analytics-sync.json`: developer settings, 0o600; `webhookUrl?`, `git?`.
- `~/.codemie/analytics-sync-bootstrap.json`: lead state, 0o600.
- `~/.codemie/analytics-sync-repo/`: shared git working copy.
- `~/.codemie/analytics-last-sent-git`: git marker.

### Feature Flags and Deployment Concerns
- None. **(head)** The Windows installer `.cmd` shims no longer re-expand `%` in arguments (for example `%20` in `--git-repo`); existing installs need the installer re-run (PR known gap).

---

## 6. Risk Indicators

- The local checkout is 45 commits behind the PR head. Stories and specs written against local files would miss `--webhook-b64`, the `never` default and `updateHint` (Section 2, Task Statements).
- Speculative: a printed git-only command contains no secret only if the repo URL is credential-free. Today only `install` checks that, through module-private validators (`config-store.ts:81,181`). `buildInstallCommand` does not check it.
- Speculative: a lead-side `GitTarget.testPush()` with the default dir would clone into `~/.codemie/analytics-sync-repo`. If the lead's own installed sync points at another repo, `ensureWorkingCopy` would delete and re-clone that copy (`git-target.ts:143-158`). That conflicts with "installs nothing on this machine". The `dir` parameter exists (`:82`).
- Speculative: a lead's test push proves only the lead's credentials and pushes `.codemie-sync-check` into the lead's own slug folder. Each developer's access is proven again by their own `install` test push (`install.ts:178-191`).
- Step numbers are hard-coded in 8 `stepHeading(i)` calls, numeric gates in `runGuided`/`discardStaleAnswers`, `firstUnansweredStep` and `checkReuse`. All headings are pinned in `guided.test.ts:154-163` (Existing Implementations, Purpose D).
- `resolveStartStep` decides on `state.webhookUrl === undefined`, and its first question is about the flow (`guided.ts:267-279`). A saved git-only state would never reach the "Reuse them?" branch.
- `BootstrapState` is `version: 1` with a presence-only shape check. A new field changes the meaning of existing saved files.
- Non-interactive mode has no git flags. `NO_TTY_MESSAGE` and `runWebhookMode` both assume a webhook (`run-bootstrap.ts:56-59,80-119`).
- The bootstrap command description and the docs (`COMMANDS.md`, `ANALYTICS-SYNC.md`, security guide) describe a Teams/SharePoint-only lead flow.

---

## 7. Summary for Complexity Assessment

The change sits entirely in the CLI command layer under `src/cli/commands/analytics/sync/bootstrap/` plus the `bootstrap` registration in `analytics/index.ts`. The developer side already supports every combination: `sync install` accepts webhook-only, git-only or both; `buildInstallCommand` already emits `--git-repo/--git-branch/--git-path` and has a pinned git-only test; `run-sync` delivers to every configured target. What is missing is lead-side wiring. `BootstrapState`, `toInstallCommandOptions`, `BootstrapOptions` and `BootstrapDeps` carry no git or target-selection data. The 8-step wizard's steps 1-5 (Teams channel, SharePoint folder, time zone, flow import, trigger URL with test send) exist only for the webhook. Steps 6-7 are target-agnostic, and step 8 prints the command.

Novelty is moderate. Every building block exists: git URL/branch/path validators (module-private in `config-store.ts`), `GitTarget.testPush` with a `dir` override, `resolveSyncIdentity`, the prompter, and the save-per-step pattern. But step numbering ("Step N of 8"), resume (`firstUnansweredStep`/`checkReuse`/`discardStaleAnswers`) and the start question are all keyed to the webhook flow and to fixed numeric indices. The non-interactive mode dispatches only on `--webhook`/`--webhook-b64`. Git credentials are never stored or embedded, and install rejects credential-bearing URLs. A git URL in the printed command carries no secret only when that same check runs before printing.

Test coverage is dense: about 105 bootstrap tests plus install, git-client and git-target suites. Fixtures and heading assertions pin the webhook-only 8-step sequence, and no test covers git in bootstrap. Key risks: the local checkout trails the PR head by 45 commits; a lead-side test push could reuse and wipe the shared `~/.codemie/analytics-sync-repo` working copy; saved `version: 1` state has to stay compatible; and the docs and the security guide describe a Teams/SharePoint-only lead flow.

---

## 8. External References

- **PR https://github.com/codemie-ai/codemie-code/pull/765**: resolved through `gh`. State OPEN, head `998d279f`, base `main`. It combines three pieces of work: install/status/run/uninstall, the git export target, and bootstrap. Facts used:
  - Non-interactive mode is "`--webhook <url>` or `--webhook-b64 <value>` (plus optional `--lookback-days` and `--include-external`)", and prints the command "only after a 2xx".
  - The printed line is "`codemie analytics sync install --webhook-b64 … --include-external "windows"`".
  - "`sync` therefore defaults to `never` on every platform".
  - "Secrets: the webhook signature appears only in the printed install command and in the lead's 0600 state file".
  - Known gap: installer `.cmd` shims "re-expanded `%` in every argument … (e.g. `%20` in a `--git-repo` URL)", now fixed when the installer is re-run.
- **Local checkout `/Users/Oleksandr_Voievodin1/projects/AI_RUN/codemie-dev/codemie-code`**: resolved. Branch `feat/analytics-sync`, HEAD `05bde5d9`, 45 commits behind the PR head. PR-head copies of the changed sync files were fetched to compare.
- **Prior artifacts** `docs/superpowers/tasks/2026-11-03-analytics-sync-git-target/` and `…/2026-11-04-analytics-sync-bootstrap/`: resolved. Facts are cited in Section 3.
- **codemie-onboarding collector** `/Users/Oleksandr_Voievodin1/projects/AI_RUN/codemie-dev/codemie-onboarding/codemie-analytics-collector/src/wizard.js:50-59`: resolved. Same 8 steps, and no git target in the collector.
