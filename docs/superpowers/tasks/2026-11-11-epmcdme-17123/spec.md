# Spec: Analytics sync bootstrap — delivery target choice (EPMCDME-17123)

## Why

`sync install` already delivers to a webhook, a git repository, or both
(`src/cli/commands/analytics/sync/install.ts`, `install-command.ts`,
`run-sync.ts` — technical-analysis.md §2 Purpose A). `sync bootstrap`, the
lead-side setup wizard, only knows the webhook: its 8 numbered steps, its
resume/reuse logic and its non-interactive mode are all keyed to webhook
fields and to fixed step indices (`bootstrap/{steps,guided,guided-late-steps,
state-store,run-bootstrap}.ts`). A lead who wants git delivery has to tell
developers to hand-edit `--git-repo` onto the printed command, and nothing
checks the repository first. This spec adds target selection, a git check
step, and target-aware resume/reuse/printing to bootstrap, so the lead gets
one tested command for whatever targets the team actually uses.

## Approach

- **Target selection becomes the first wizard step**, replacing the fixed
  8-step model with one ordered, target-tagged step-descriptor list — each
  step tagged with the target(s) (webhook, git, both, or neither/always-shown)
  it belongs to. `stepHeading`, `firstUnansweredStep`, `checkReuse`'s step
  indices, `discardStaleAnswers`'s thresholds, and the guided-flow step gates
  (`runGuided`/`runStepsFiveThroughEight`) are all derived by filtering that
  one list against the chosen targets, instead of each recomputing its own
  view of which steps show; "Step N of M" uses the count of steps the
  filtered list yields (D4, D13; story AC1, AC2, AC5).
- **A new git step group** (repository URL, branch, folder) runs only when
  git is chosen, reusing `install`'s git validators — exported for this
  purpose (D10) — and reuses `install`'s branch/folder defaults (D7) so
  the two never disagree.
- **A lead-side git check** calls `GitTarget.testPush()` against a
  temporary working copy (the existing `dir` override parameter), never
  the developer's own `~/.codemie/analytics-sync-repo`, and removes the
  copy afterwards whether the push succeeds or fails (D1; story AC6, AC8).
  The lead's own installed sync settings and working copy, if any, are
  untouched (story AC8).
- **Credential-bearing URLs are rejected before anything is saved or
  printed, on every path that could produce one** — fresh guided entry,
  the Reuse path re-validating a saved `git.repoUrl` the same way
  `checkReuse` already re-validates the saved webhook URL, and the
  non-interactive `--git-repo` path — all via `install`'s existing (now
  exported) rule, failing closed (no command printed, non-zero exit on
  the non-interactive path) and never echoing the value (D5, D15; story
  AC10).
- **Email for the test-push folder** comes from the same resolver `install`
  uses; if none is found, guided mode asks for one without saving it, and
  non-interactive mode fails with no command printed (D9; story AC7).
- **`BootstrapState` gains a version bump and a recorded target
  selection** (which targets, plus their fields) that drives the resume
  step, the reuse summary, the Reuse/Change targets/Start over menu, and
  which targets get printed and re-checked — not field presence (D11;
  story AC15, AC17, AC19-AC22). A v1 (PR #765) file is read as
  webhook-only with no migration prompt (D6; story AC16, AC22). A new
  file is unreadable by an older CLI, which starts fresh instead of
  misreading it (story AC22).
- **Reuse re-checks every chosen target** before printing — webhook via
  the existing test-send loop (which already re-validates the saved
  trigger URL), git via the test push plus the same credential-embedding
  re-check on the saved `git.repoUrl` (D5, D15) — each only if that
  target is chosen, printing only once every check passes or is
  explicitly skipped (D12; story AC10, AC17, AC18).
- **Non-interactive mode accepts `--git-repo`/`--git-branch`/`--git-path`**
  alongside the existing webhook flags, through the same exported git
  validators (including the credential-embedding rule) guided mode uses;
  a credential-bearing `--git-repo` fails closed before any check runs,
  with no command printed and no value echoed (D2, D5, D15). When both a
  webhook flag and `--git-repo` are given, the webhook test-send and the
  git test-push run **concurrently, not sequentially** — each keeps its
  own existing per-target timeout unchanged (webhook's
  `WEBHOOK_TIMEOUT_MS`, git's `NETWORK_TIMEOUT_MS`), with no combined or
  overall deadline added; the command prints only if every given target's
  check passes (D2, D14; story AC12-AC14).
- **The printed command gets a one-line developer-access note** when git
  is included: push access comes from each developer's own SSH key or
  credential helper, verified by `install` (D8; story AC11).
- Docs (`docs/COMMANDS.md`, `docs/ANALYTICS-SYNC.md`,
  `.ai-run/guides/security/security-practices.md`) are updated to
  describe the three-way target choice in both modes (story AC24).

### New state shape (sketch)

```ts
// bootstrap/state-store.ts — version bump, target selection added
interface BootstrapStateV2 {
  version: 2;
  targets: { webhook: boolean; git: boolean };
  // existing webhook-flow fields (unchanged), present iff ever answered
  // existing git fields: repoUrl?, branch?, path?
  includeExternal?: ...;   // unchanged, target-agnostic
  lookbackDays?: ...;      // unchanged, target-agnostic
}
```

A v1 file (no `version: 2`) maps to `{ webhook: true, git: false }` with
its existing fields carried over (D6).

## Acceptance Criteria

- Fresh guided run's first step asks webhook / git / both. (story AC1)
- Git-only choice skips Teams/SharePoint/time-zone/flow-import/trigger-URL
  steps; asks repo URL, branch, folder, then external-sessions policy and
  lookback; step count reflects only shown steps. (story AC2)
- Webhook-only choice runs today's webhook steps unchanged, including the
  "already imported the flow?" shortcut, and prints no git flags. (story AC3)
- Both-targets choice prints a command carrying webhook and git; running
  it delivers to both. (story AC4)
- Empty branch/folder fall back to `sync install`'s own defaults. (story AC5)
- Entered git details get a test push to the lead's folder from a
  temporary working copy, removed after; wizard proceeds only on success.
  (story AC6)
- The test-push folder uses `sync install`'s email resolution; missing
  email prompts (unsaved) in guided mode, fails non-interactively with no
  command printed. (story AC7)
- A test push leaves the lead's own installed sync settings and working
  copy unchanged. (story AC8)
- A failed test push shows `install`'s hint for that failure and offers
  retry / different details / skip; no credential prompt ever appears.
  (story AC9)
- A credential-bearing repo URL is rejected without being echoed, with an
  explanation and a re-ask, on every path that could print one: fresh
  guided entry, the Reuse path re-validating a saved URL, and the
  non-interactive `--git-repo` path (fails closed, no command printed);
  nothing with that URL is ever saved or printed. (story AC10)
- A printed command that includes git carries a note that each developer
  needs their own push access, verified by `install`. (story AC11)
- `--git-repo` with no webhook flag: no questions, test-push, git-only
  command on success. (story AC12)
- Webhook flag + `--git-repo` together: both checked concurrently, each
  keeping its own existing timeout; command prints only if both pass; a
  failure names which target failed (webhook signature masked) and exits
  non-zero. (story AC13)
- No TTY and no target flag: exit message names both `--webhook`/
  `--webhook-b64` and `--git-repo`. (story AC14)
- Any saved setup opens with a summary (targets, masked details, policy,
  lookback; an off target shown as off) and Reuse/Change targets/Start
  over. (story AC15)
- A PR #765 webhook setup, read after this change, is treated as
  webhook-only and prints with no extra questions beyond the re-check.
  (story AC16)
- Reuse re-checks every chosen target (webhook test-send, git test-push,
  each including its credential/shape re-validation) with the same
  retry/change/skip options, printing only once each check passes or is
  skipped. (story AC17)
- Change targets keeps every saved answer, asking only the newly added
  target's steps. (story AC18)
- Adding git to a saved webhook setup via Change targets asks only git
  details, runs its test push, skips the webhook steps, and prints both
  targets. (story AC19)
- Turning webhook off via Change targets omits it from the printed
  command and from later Reuse checks, but keeps it saved for a later
  re-enable. (story AC20)
- A saved git-only setup opens with its summary and the three-way menu,
  not the flow-import question. (story AC21)
- A file written by this change is unreadable by an older (#765-only)
  CLI, which starts fresh rather than printing for the wrong targets.
  (story AC22)
- Interrupting after the target choice or after a successful git check
  resumes at the first unanswered step for the chosen targets. (story AC23)
- Bootstrap help text, `docs/COMMANDS.md`, `docs/ANALYTICS-SYNC.md` and
  the security guide describe the three-way choice in both modes. (story AC24)

## Non-goals

- Changes to developer-side `sync install | status | run | uninstall` or
  the git target's own behavior; only its validators are exported, unchanged.
  (story NG1)
- Granting or managing developers' repository access, or any token/credential
  storage. (story NG2)
- Other target kinds (S3, plain HTTP, etc.). (story NG3)
- Changes to the Power Automate flow template or its import steps. (story NG4)
- Multiple teams or repositories per lead machine — bootstrap keeps one
  saved setup. (story NG5)
- Back-porting to the standalone `codemie-onboarding` collector. (story NG6)

## Decisions

- D1: Bootstrap test-pushes to the repository (temporary working copy,
  removed after) before printing, with retry/different-details/skip on
  failure, over trusting the URL unchecked. — user
- D2: Non-interactive mode gains `--git-repo`/`--git-branch`/`--git-path`
  and checks every given target before printing, over leaving git
  non-interactive-only via hand-edited flags. — user
- D3: Changing targets on a saved webhook setup keeps the webhook and
  asks only the new target's steps; turning the webhook off keeps it in
  saved state over deleting it. — user
- D4: Target choice sits as the first wizard step, driving which later
  steps show and the "Step N of M" count, over leaving the 8-step
  sequence fixed and inserting target logic mid-flow. — user, proposed by PO
- D5: A credential-bearing repository URL is rejected pre-save/print
  using `install`'s existing rule, over writing a second rule for
  bootstrap. — user, proposed by PO
- D6: A PR #765 (`version: 1`) state file is read as webhook-only with no
  migration prompt, over asking every existing lead to re-answer. — user, proposed by PO
- D7: Branch/folder defaults come from `sync install`, over bootstrap
  defining its own. — user, proposed by PO
- D8: The printed command gets a one-line developer-access note, over
  relying on `install`'s own later check to surface it. — user, proposed by PO
- D9: The test-push email is `install`'s resolved identity; missing it
  prompts (unsaved) in guided mode and fails non-interactively, over
  saving a lead-entered email as config. — user, proposed by PO
- D10: `install`'s private git URL/branch/folder validators are exported
  for bootstrap to reuse unchanged, over duplicating the credential rule.
  — user, proposed by PO
- D11: The saved state records the target selection itself (not derived
  from field presence) and drives start/resume/summary/reuse/print, over
  continuing to infer the selection from which fields are filled.
  — user, architecture review plan A
- D12: Reuse re-checks every chosen target before printing, over trusting
  a previously-passed check indefinitely. — user, architecture review recommendation
- D13: The step-numbering rule scattered across `steps.ts`, the 8
  hardcoded call-site indices in `guided.ts`/`guided-late-steps.ts`, and
  `state-store.ts`'s presence-based inference is unified behind one
  ordered, target-tagged step-descriptor list that all four mechanisms
  filter against, over leaving each to compute its own view of which
  steps show for a given target combination — architecture review AR-1
  (root fix; changes only this spec's own Approach wording, no code or
  contract outside the spec).
- D14: Non-interactive dual-target mode (`--webhook`/`--webhook-b64` +
  `--git-repo`) runs the webhook test-send and the git test-push
  concurrently rather than sequentially, each keeping its own existing
  per-target timeout, with no combined/overall deadline added. — user,
  answers AR-3
- D15: Credential-bearing-URL rejection (D5) is specified to run on every
  path that could print a saved or entered git URL — fresh guided entry,
  the Reuse path re-validating a saved `git.repoUrl` the same way
  `checkReuse` already re-validates the saved webhook URL, and the
  non-interactive `--git-repo` path — not only on first entry. — user,
  answers AR-2

## Open Risks

- Hard-coded step indices exist at 8 call sites today (`stepHeading(0..7)`
  across `guided.ts`/`guided-late-steps.ts`) and are pinned by
  `guided.test.ts:154-163`; replacing them with the target-tagged
  step-descriptor list (D13) touches every one of those call sites and
  that whole pinned test block in one pass — the edit volume is the same
  either way, but correctness now derives from one filtered list instead
  of four independently maintained views.
- `state-store.test.ts`'s `COMPLETE_STATE` fixture and ~25 tests assume a
  webhook-only shape; the v1→v2 read path needs its own fixture alongside
  the existing one rather than a one-line edit.
- No existing test runs a git test push outside `install`; the lead-side
  path (temporary dir, cleanup-always) is new test surface, not an
  extension of covered code.
