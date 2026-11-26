# Delivery target choice in `analytics sync bootstrap` — Story

**Date**: 2026-11-10
**Status**: Approved
**Architecture review**: intent, 2026-11-11, a85296fb16eb
**Ticket**: —

---

## Context

- PR #765 (`feat/analytics-sync`, open on 2026-11-10) moves the analytics collector from codemie-onboarding into the CLI as `codemie analytics sync`. It ships three pieces together: developer `sync install | status | run | uninstall`, a git export target, and the lead's `sync bootstrap` wizard. This story is a follow-up PR on top of it, built after #765 merges.
- The developer side already supports every target combination. `sync install` accepts a webhook only, a git repository only (`--git-repo`, `--git-branch`, `--git-path`), or both. It test-pushes to the repository before saving, and every run delivers to all configured targets. The shared command builder can already print the git flags. The standalone collector never had a git target, so there is nothing to port.
- The lead side knows only the webhook. Bootstrap's 8 numbered, resumable steps are: Teams channel, SharePoint folder, time zone, flow package import, trigger URL with test send, external-sessions policy, lookback, and the printed install command. Steps 1–5 exist only to build and test the Power Automate webhook. Steps 6–7 apply to any target. Resume, the "Reuse them?" offer and the first question ("already imported the flow?") all assume a saved webhook. Non-interactive mode reacts only to `--webhook` / `--webhook-b64`.
- Today a lead who wants git delivery has to tell developers to add the `--git-repo` flags to the install command by hand. Nothing checks the repository first, so a wrong URL, a missing branch or a protected branch surfaces only when each developer runs `install`.
- Git authentication uses each person's own SSH key or credential helper, prompt-free. The CLI never stores a token, and `install` rejects repository URLs with credentials in them. The printed command contains only what the lead enters, so the same rejection must happen before bootstrap prints anything.

---

## Complexity

**Size**: L (21/36) · **Recommended flow**: sdlc-standard

One CLI subsystem (bootstrap wizard, state store, runner, command registration, plus install's exported git validators). It is L, not M, because the step sequence, resume and reuse logic currently keyed to the webhook and to fixed step numbers must follow a recorded target choice, the lead's saved settings move to a new version, and many files plus pinned wizard tests change.

---

## Story

**As a** team lead setting up analytics delivery for my team, **I want** `codemie analytics sync bootstrap` to let me choose the delivery targets (the Teams/SharePoint webhook, a git repository, or both) and check each one before it prints the install command, **so that** developers get one command that delivers where the team actually keeps its analytics, with no hand-edited flags and no setup for targets we don't use.

---

## Background

Some teams keep analytics in a git repository instead of, or as well as, a SharePoint folder fed by the Power Automate flow. PR #765 lets developers deliver to git, but the lead wizard cannot set it up. A git-only team still has to walk through Teams, SharePoint and flow-import steps it does not need, then hand-edit the printed command. Bootstrap is the one place where a lead validates the setup once for the whole team, so the target choice belongs there.

---

## Acceptance Criteria

**Choosing targets (guided mode)**

- [ ] Given a lead runs `sync bootstrap` in a terminal with no saved bootstrap state, when the wizard starts, then the first step asks which delivery targets to use: webhook (Teams/SharePoint), git repository, or both.
- [ ] Given the lead chooses git only, when the wizard continues, then it skips the Teams channel, SharePoint folder, time zone, flow import and trigger URL steps. It asks for the repository URL, branch and folder, then for the external-sessions policy and the lookback, and the step headings count only the steps actually shown.
- [ ] Given the lead chooses the webhook only, when the wizard runs, then it walks through today's webhook steps unchanged, including the "already imported the flow?" question that skips straight to the trigger URL, and prints a command with no git flags.
- [ ] Given the lead chooses both targets, when the wizard finishes, then the printed command carries the webhook and the git repository, branch and folder, and a developer who runs it delivers every report to both.
- [ ] Given the lead leaves the branch or the folder empty, when the command is printed, then the defaults are the same ones `sync install` uses.

**Checking the repository before printing**

- [ ] Given the lead has entered the git details, when the wizard checks them, then it test-pushes to the lead's own folder in the repository from a temporary working copy, removes that copy afterwards, and moves on only after the push succeeds.
- [ ] Given the lead chooses git, when the wizard names the lead's folder for the test push, then it uses the email `sync install` would use. If no email is found, guided mode asks for one and does not save it, and non-interactive mode prints no command, exits non-zero and tells the lead to set `git config --global user.email`.
- [ ] Given the lead's own sync is installed on the same machine, when bootstrap runs its test push, then the lead's installed sync settings and working copy are unchanged afterwards.
- [ ] Given the test push fails (unknown host, no access, missing branch, protected branch), when the wizard reports it, then it shows the same hint `sync install` shows for that failure and offers to retry, enter different git details, or skip the check. No password or token prompt appears at any point.
- [ ] Given the lead enters a repository URL with credentials in it (`https://<token>@…` or `user:pass@…`), when the wizard validates it, then it rejects the URL without echoing it, explains that access must come from each person's SSH key or credential helper, asks again, and nothing is saved or printed with that URL.
- [ ] Given the command includes git, when it is printed, then the wizard also tells the lead that each developer needs push access to the repository and branch through their own SSH key or credential helper, and that `install` checks this on each machine.

**Non-interactive mode**

- [ ] Given a lead runs `sync bootstrap --git-repo <url>` (with optional `--git-branch`, `--git-path`, `--lookback-days`, `--include-external`) and no webhook flag, when it runs, then it asks no questions, test-pushes, and prints a git-only install command only after the push succeeds.
- [ ] Given a lead passes both a webhook flag and `--git-repo`, when it runs, then it checks both targets and prints the command only if both succeed. If either fails it prints no command, reports which target failed with the webhook signature masked, and exits non-zero.
- [ ] Given `sync bootstrap` runs without a terminal and without any target flag, when it exits, then its message names both ways to supply a target: `--webhook` / `--webhook-b64`, and `--git-repo`.

**Re-running with saved settings**

- [ ] Given any saved setup, when the lead re-runs bootstrap, then the wizard shows the saved summary (chosen targets, each target's masked details, policy and lookback; a target that is off is shown as off) and offers Reuse, Change targets or Start over.
- [ ] Given a lead saved a webhook setup with PR #765's bootstrap, when they run bootstrap after this change and answer Reuse, then the saved setup is read as a webhook-only choice and the command is printed with no questions other than the re-check below.
- [ ] Given a lead answers Reuse, when the wizard prepares the command, then it test-sends to the saved webhook and test-pushes to the saved repository (each only if chosen), with the same retry, change-details and skip options as a fresh run, and prints the command only once every check has passed or been explicitly skipped.
- [ ] Given a saved setup, when the lead chooses Change targets, then the wizard returns to the target step with every saved answer kept, and asks only the steps of a newly added target.
- [ ] Given a saved webhook setup, when the lead chooses Change targets and adds git, then the wizard asks only for the git details and runs the test push. The Teams, SharePoint, time zone, flow and trigger URL steps are not repeated, and the printed command carries both targets.
- [ ] Given a saved setup with both targets, when the lead chooses Change targets and turns the webhook off, then the printed command has no webhook, and later Reuse runs neither check nor print it. The webhook stays in the lead's saved state, so turning it back on later does not require re-importing the flow.
- [ ] Given a saved git-only setup, when the lead re-runs bootstrap, then the wizard opens with the saved summary (repository, branch and folder) and the Reuse / Change targets / Start over choice, instead of asking whether the flow is already imported.
- [ ] Given a lead's saved settings were written by this change, when an older CLI that only knows PR #765's format reads them, then it treats them as unknown and starts fresh, instead of printing a command for the wrong targets.
- [ ] Given the wizard is interrupted after the target choice or after a successful git check, when the lead runs it again, then it resumes at the first unanswered step for the chosen targets.

**Docs**

- [ ] Given the bootstrap help text, `docs/COMMANDS.md` and `docs/ANALYTICS-SYNC.md`, when a lead reads them, then they describe choosing webhook, git or both in guided and non-interactive mode. The security guide's description of the lead state file is updated to match.

---

## Out of Scope

- Changes to developer-side `sync install | status | run | uninstall` or to the git target itself. Both ship in PR #765. Exporting install's existing git validators so bootstrap can reuse them is in scope; their rules do not change.
- Granting or managing developers' repository access, or any token or credential storage.
- Other target kinds (S3, a plain HTTP endpoint, etc.).
- Changes to the Power Automate flow template or its import steps.
- Several teams or several repositories per lead machine. Bootstrap keeps one saved setup.
- Back-porting to the standalone collector in codemie-onboarding.

---

## Decisions

- D1: Should bootstrap test-push to the git repository before printing the command? → Yes, from a temporary working copy into the lead's own folder in the repository, removed afterwards. On failure the lead can retry, enter different git details, or skip. Developers still test-push on their own `install`. — user
- D2: Does non-interactive mode support git? → Yes. `--git-repo`, `--git-branch` and `--git-path` are added. Webhook, git or both work, and the command is printed only when every given target passes its check. — user
- D3: What happens when a lead with a saved webhook setup re-runs and changes targets? → The saved webhook is kept and only the new target's details are asked. Turning the webhook off removes it from the command but keeps it in the saved state. — user
- D4: Where does the target choice sit in the guided wizard? → As the first step, because it decides which steps follow. The "already imported the flow?" question comes right after it and is still asked whenever the webhook is among the chosen targets. Steps that don't apply to the chosen targets are hidden, and the "Step N of M" count reflects only the steps shown. — proposed by PO: steps 1–5 serve only the webhook (technical-analysis.md §2 "Task Statements Checked Against the Code"); wording corrected by the architecture review.
- D5: How is a credential-bearing repository URL handled? → It is rejected before anything is saved or printed, using the same rule `sync install` applies, and the value is never echoed. — proposed by PO: the printed command must stay secret-free, and install already rejects such URLs (technical-analysis.md §2 Purpose C, §6).
- D6: How is a bootstrap state saved by PR #765 read? → As a webhook-only target choice, with no migration prompt. — proposed by PO: those files only ever held a webhook, and leads who ran #765's bootstrap must not be asked again (technical-analysis.md §6, `version: 1` state).
- D7: Branch and folder defaults? → The same as `sync install`, so the bootstrap and developer sides never disagree. — proposed by PO: one source of defaults (technical-analysis.md §2 Purpose A).
- D8: Should the wizard explain developer repository access? → Yes, a short note next to the printed command: each developer needs push access through their own SSH key or credential helper, and `install` verifies it. — proposed by PO: the lead's test push only proves the lead's own access (technical-analysis.md §6).
- D9: Which email names the lead's folder for the test push? → The one `sync install` would use. If none is found, guided mode asks for it without saving it, and non-interactive mode fails without printing a command. — proposed by PO: architecture review (bootstrap installs nothing on the lead's machine).
- D10: Can bootstrap reuse install's private git URL, branch and folder validators? → Yes. Exporting them is in scope and their rules do not change, so there is one credential rule rather than a copy that can drift. — proposed by PO: architecture review.
- D11: Should the saved bootstrap settings record which targets are chosen? → Yes. The start, the resume step, the summary, the reuse check and the printed command follow the recorded choice, not which fields are filled. Any saved setup opens with its summary and offers Reuse, Change targets or Start over. Change targets keeps every saved answer and asks only the steps of a newly added target. A target that is off is shown as off and is never checked or printed. PR #765 files are read as "webhook chosen" (D6). New files carry a new version number, so an older CLI starts fresh instead of misreading them. — user (architecture review plan A)
- D12: Does Reuse test the saved targets again before printing? → Yes, every chosen target. The webhook gets the trigger URL test send (retry, different URL or skip) and git gets the test push. The command is printed only once each check passes or the lead explicitly skips it. — user (architecture review recommendation)

---

## Open Questions

- None

---

## Sources

- https://github.com/codemie-ai/codemie-code/pull/765 · PR the story builds on
- `docs/superpowers/tasks/2026-11-03-analytics-sync-git-target/` · documents (git target spec, non-goal "No bootstrap command")
- `docs/superpowers/tasks/2026-11-04-analytics-sync-bootstrap/` · documents (bootstrap spec)
- `docs/stories/2026-10-28-analytics-collector-scheduler/` · documents (parent story, EPMCDME-16476)
