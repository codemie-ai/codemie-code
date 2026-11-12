# Analytics sync: install, run, status, uninstall — Story

**Date**: 2026-10-28
**Status**: Approved
**Ticket**: [EPMCDME-16488](https://jiraeu.epam.com/browse/EPMCDME-16488)
**Parent**: ../../story.md
**Feature**: analytics-collector

---

## Context

- Today a developer gets daily analytics delivery by pasting the standalone collector's command. It clones the collector, registers a daily OS job, and the job runs `codemie analytics` and POSTs the priced JSON report to the team's webhook.
- The collector already handles the hard parts, and they work in production. Runs missed while the laptop sleeps are caught up (launchd on macOS, a systemd user timer on Linux, Task Scheduler on Windows; plain cron is avoided because it silently skips them). A rolling lookback window (7 days by default) protects long sessions, because the CLI selects sessions by start time only. A last-sent marker moves only after the webhook accepts the file. Nothing is sent when there is nothing new. Every run writes one log line, and the webhook signature never appears in output.
- The CLI's `analytics` command already produces the report the collector sends and writes no file when no sessions match. It has no scheduling, webhook, marker or status code. Its only subcommand today is `otel`.
- Running the CLI from a background job raises three risks the collector worked around. A CLI start can check for updates or prompt. With no terminal and no configured email, the export file is named without a user slug. And the CLI keeps the email's case in file names, while downstream harvesting expects lowercase.
- Developers who already run the standalone collector use the same `~/.codemie` state files (settings, last-sent marker, log). A second job on the same machine would send the same data twice.
- The lead-side `bootstrap` wizard that prints the install command is the sibling story (bootstrap-wizard). It reuses this story's webhook delivery and produces this story's install command.

---

## Complexity

**Size**: L (24/36) · **Recommended flow**: sdlc-standard

A new `analytics sync` sub-tree (per-OS scheduler registration, run orchestration with marker and lookback, status, uninstall with take-over) with no precedent in the CLI. The tested standalone collector is a close reference to port.

---

## Story

**As a** developer whose team collects CodeMie usage, **I want** one CLI command that installs a daily job delivering my analytics to the team's webhook, and commands to check, trigger and remove it, **so that** my usage reaches the team's reporting without a separate collector to download, clone or update.

---

## Background

Developers already have the CodeMie CLI and keep it updated, so the delivery job belongs there instead of in a separate cloned tool with its own update mechanism. This story ports the collector's developer side: installing the scheduled job, the run itself, and removing it, plus a status view the collector never had. Delivery must stay identical to the collector's, so existing Power Automate flows and downstream harvesting keep working.

---

## Acceptance Criteria

### Command surface

- [ ] Given the CLI is installed, when a user runs `codemie analytics sync --help`, then it lists `install` (developer: register the daily job), `status`, `run` (send now) and `uninstall`.
- [ ] Given the `--help` output of the `sync` group and of each subcommand, when a user reads it, then the group's description says it sends this machine's analytics reports one way to the team's webhook on a daily schedule, and every subcommand's description says who runs it and what it changes. For example, `install` reads "Developer: register the daily delivery job on this machine".
- [ ] Given the `analytics` command's existing options and its `otel` subcommand, when the `sync` subcommands are added, then `codemie analytics` with its export options and `codemie analytics otel` behave exactly as before.
- [ ] Given `codemie analytics` has its own `--include-external` switch and filter options, when a user types `codemie analytics sync install --include-external windows` (or any `sync` subcommand with an option of the same name as one of `analytics`), then the value applies to that subcommand as typed, and no "unexpected argument" error occurs.

### Install

- [ ] Given an install command with `--webhook <url>` (as printed by bootstrap, or typed by hand), when a developer runs it on macOS, Linux (systemd user session) or Windows, then a daily per-user job is registered at 03:00 local time (or the time given with `--at HH:MM`). The job catches up a run missed while the machine was asleep or off, and on Linux it also runs while the user is logged out.
- [ ] Given install accepts `--lookback-days <1-30>` and `--include-external windows|always|never`, when they are omitted, then the CLI default lookback (7 days, which follows CLI updates) and the `windows` policy apply.
- [ ] Given the install succeeds, when it finishes, then it prints the run time, the lookback, the include-external policy, the webhook host (signature masked), the email the reports will carry, and a hint to verify with `codemie analytics sync run` and `status`.
- [ ] Given an existing install, when the developer runs install again with different options, then the existing job and settings are replaced, not duplicated, and the last-sent marker is kept.
- [ ] Given the settings file holding the webhook URL, when install writes it, then only the current user can read it.
- [ ] Given no email is configured for the CLI, when install runs in a terminal, then it asks for the email and saves it to the CLI config. Without a terminal it fails with instructions to set the email, and registers nothing.
- [ ] Given a Linux machine without a systemd user session, or another unsupported platform, when install runs, then it fails with a clear explanation and registers nothing.
- [ ] Given an invalid `--at`, `--lookback-days`, `--include-external` or `--webhook` (missing, not https, not a valid URL), when install runs, then it fails before touching the scheduler, with a message naming the bad option.

### Taking over from the standalone collector

- [ ] Given the standalone collector's daily job is registered on the machine, when the developer runs install, then the standalone job is removed before the CLI job is registered. The existing last-sent marker is kept, so the next run neither re-sends delivered sessions nor leaves a gap. The output says the old collector folder can be deleted.
- [ ] Given a machine that ran the standalone collector and then the CLI install, when the next scheduled time arrives, then exactly one delivery is made.

### Scheduled and manual runs

- [ ] Given an install, when the scheduled job (or a manual `codemie analytics sync run`) starts, then it exports the window since the last successful send (never less than the lookback) as the priced JSON report and POSTs it to the webhook in the same message shape and with the same attachment name as the collector: `codemie-analytics-<lowercased email slug>-<date>.report.json`. Existing downstream flows keep working unchanged.
- [ ] Given the webhook accepts the file, when the run ends, then the last-sent marker moves to the run's time and one `ok sent` line is appended to the run log.
- [ ] Given no sessions in the window, when the run executes, then nothing is sent, the marker does not move, and a `skip` line is logged.
- [ ] Given the webhook rejects the file, is unreachable, or the export fails, when the run executes, then the marker does not move (so the next run covers the same sessions), a `fail <export|send|setup>` line is logged without the webhook signature, and `run` exits non-zero.
- [ ] Given an export larger than the webhook's 70 MB limit, when the run executes, then nothing is sent and the failure is logged with the size.
- [ ] Given the run is started by the scheduler with no terminal, when the CLI starts, then it performs no update check, no update install and no prompt of any kind; a missing email is a logged `fail setup`, not a hang.
- [ ] Given `run` is invoked with no install on the machine, when it starts, then it fails with the command to set up delivery, and sends nothing.

### Status

- [ ] Given an install, when the user runs `codemie analytics sync status`, then it shows: enabled or disabled (whether the OS job is actually registered and enabled), the daily run time, the lookback window, the include-external policy, the webhook host with the signature masked, the time and outcome of the last run (sent, skipped, or failed with its reason), and the time of the last successful send.
- [ ] Given settings exist but the OS job was removed or disabled outside the CLI, when status runs, then it reports disabled and tells the user to run install again.
- [ ] Given nothing is installed, when status runs, then it reports "not installed" with the command to set it up, and exits successfully.
- [ ] Given a run has never happened yet, when status runs, then the last-run fields say "never" instead of failing.

### Uninstall

- [ ] Given an install, when the developer runs `codemie analytics sync uninstall`, then the OS job and the settings holding the webhook are removed, and status reports "not installed". Running uninstall again reports nothing to remove and succeeds.

### Documentation

- [ ] Given the CLI command reference, when this ships, then it documents `install`, `status`, `run` and `uninstall`, the per-platform behaviour, and the migration from the standalone collector.

---

## Out of Scope

- The lead-side `bootstrap` wizard and the generated install command (sibling story bootstrap-wizard).
- Auto-update of anything from the scheduled job; the CLI's existing update workflow covers updates.
- Backfill of a past period (`--last 90d`, `--from/--to`); follow-up story.
- Any analytics change: new metrics, the start-time-only session filter, the Windows ownership issue behind the `windows` include-external default, report format changes.
- Changes to the codemie-onboarding collector or keeping it in sync with the CLI.
- Plain-cron fallback for Linux machines without a systemd user session.

---

## Decisions

- D1: What happens to a standalone collector already installed on the machine? → The CLI install takes over: removes the standalone job, keeps the last-sent marker, tells the user the old folder can be deleted. — user
- D2: How does the background run handle CLI updates? → Never: no update check, install or prompt during a scheduled run; updates happen in interactive use. — user
- D3: What does the install command fix? → Webhook (required), lookback days and include-external policy, like the collector. Run time defaults to 03:00 local, and each developer can override it with `--at`. — user
- D4: Is send-now or backfill in scope? → Send-now (`run`) yes; it is also what the scheduler invokes. Backfill is a follow-up. — user
- D6: Command names → `codemie analytics sync bootstrap|install|status|run|uninstall`; this story delivers all but `bootstrap`. The group sits under `analytics`, next to `otel`. `sync` follows `codemie skill sync`, which already means a one-way push to a target, and the names the standalone collector gives its OS job and state files (`analytics-sync`, "CodeMie Analytics Sync"), which the CLI takes over (D9). The group's help says the sync is one-way: reports go to the team's webhook, nothing comes back. Rejected: `collector` (the user disliked the wording), `codemie proxy analytics` (the job does not use the proxy daemon, and `proxy status` already means the daemon), no group (`analytics run` and `analytics status` read as the report itself), `export` and `report` (confused with `--export` and the deprecated `--report`), `delivery` (accurate, but used nowhere else in the CLI). — user
- D7: Per-OS scheduler → launchd (macOS), systemd user timer with lingering (Linux), Task Scheduler (Windows), each with catch-up of missed runs; no plain cron. — proposed by PO: the collector's design rejects cron because it silently skips runs during sleep (technical-analysis.md §3).
- D8: Delivery contract → same webhook message shape, attachment name (lowercase slug), 70 MB ceiling, no retry (the rolling window self-heals), lookback default 7 days. — proposed by PO: downstream Power Automate flows and harvesting must keep working unchanged (technical-analysis.md §6, §8).
- D9: State location and format → settings, marker and log live under the CodeMie home folder and remain readable after take-over from the standalone collector, so migration keeps delivery continuous. — proposed by PO: required by D1.
- D10: Identity → a report is never sent without a user email; install asks for or requires it, and a background run fails with `fail setup` if it is missing. — proposed by PO: the collector fails the same way, and unattributed files overwrite each other downstream (technical-analysis.md §6).
- D14: Options shared with `codemie analytics` → an option typed after a `sync` subcommand belongs to that subcommand, even where `analytics` has an option of the same name (its own on/off `--include-external`, its filters). — proposed by PO: the CLI's command parser currently hands such options to `analytics`, so `install --include-external windows` would fail (technical-analysis.md §6).

---

## Open Questions

- None
