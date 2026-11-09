# CodeMie Analytics Sync

A small daily job on each developer's machine, built into the CodeMie CLI. Once a day it
builds that machine's priced CodeMie analytics report and delivers it to the team: to a
Power Automate webhook, to a git repository, or to both. The flow behind the webhook saves
the file to a SharePoint folder and logs it in a Teams channel, where an analysis tool
picks it up.

```
your machine, daily ──HTTPS POST──> Power Automate flow ──> SharePoint folder (the file)
                   │                                    └─> Teams channel (monthly thread)
                   └──git push────> team repository (<path>/<your email slug>/…)
```

It has to run on each machine: the report is built from session logs stored only there.
It needs no extra credentials: the webhook URL carries its own signature, and git pushes
use the developer's existing git setup. Developers can't open the SharePoint folder; only
the analytics owner can.

`sync` is one-way: reports go to the team, nothing comes back.

## Quickstart

**You need:** the `codemie` CLI (Node.js 20+). For a git target, also `git` and push
access to the team repository.

There are two roles. A **team lead** connects the team's Teams channel and SharePoint folder
once, and gets one install command back. Each **developer** runs that command once.

### Team lead: connect the team (once)

```bash
codemie analytics sync bootstrap
```

A guided setup walks you through 8 steps. Each step shows its position ("Step 2 of 8"):

1. **Teams channel**: paste the link from the channel's **⋯ → Get link to channel**.
2. **SharePoint folder**: open the folder in the browser and paste the address bar. Type
   `manual` to give the site and the folder path separately. The simplest choice is a folder
   in the team's own site: Teams → channel → **Files** → **Open in SharePoint** →
   **+ New → Folder**.
3. **Time zone**: a Windows time zone name, e.g. `W. Europe Standard Time` (default `UTC`).
   It is used for the timestamps the flow posts in Teams.
4. **Import the flow**: the CLI writes `codemie-analytics-flow.zip` into the current
   folder, pre-filled with your channel, folder and time zone. In Power Automate:
   **My flows → Import → Import Package (Legacy)**, upload the zip, map the Teams and
   SharePoint connections, import, then turn the flow **On**. Open the HTTP trigger, set
   **Who can trigger** to **Anyone**, and copy its URL.
5. **Trigger URL**: paste it. The CLI test-sends a small `setup-check-<stamp>.json` and
   tells you where the file and the Teams reply should appear.
6. **External sessions**: `never` (recommended), `always` or `windows`. See
   [Platform notes](#platform-notes).
7. **Lookback**: the CLI default (7 days today, which follows CLI updates) or a fixed
   1–30 days.
8. **Developer command**: one line to share with your team:

```
codemie analytics sync install --webhook-b64 aHR0cHM6Ly9wcm9k… --include-external "never"
```

The webhook is printed base64url-encoded, so the line runs unchanged in bash/zsh, PowerShell
and cmd. **Treat it as a secret:** the encoding is not encryption, and anyone with the line
can post into your folder. Share it directly with developers, not in a ticket or a public
channel.

Already have a flow? Answer **yes** to "flow already imported?" and the wizard starts at the
trigger URL. Ran it before? It shows the saved settings with the webhook masked and offers
to reuse them. An interrupted run resumes with your earlier answers as defaults.

No terminal, or scripting it? Skip the questions:

```bash
codemie analytics sync bootstrap --webhook "<trigger URL>" [--lookback-days 14] [--include-external always]
```

It test-sends, and prints the command only after the webhook accepts the file. On Windows,
pass the URL as `--webhook-b64` instead (see [Platform notes](#platform-notes)).

### Developer: install (once)

Paste the command your team lead sent:

```bash
codemie analytics sync install --webhook-b64 <value> --include-external "never"
```

Your team lead's output names the minimum CodeMie CLI version for this command. If your CLI is older, or you see `unknown command 'sync'`, update first with `codemie self-update`.

Install asks for your email only if neither the CodeMie CLI config nor
`git config --global user.email` has one.

**Check it once.** Run it by hand and read the result line:

```bash
codemie analytics sync run
codemie analytics sync status
```

`ok sent …` means the webhook accepted your file. `skip … no sessions …` means there was
nothing to send yet, which is fine. Anything starting with `fail` is explained under
[Troubleshooting](#troubleshooting).

From now on it runs every day at 03:00. If the machine is asleep or off at that time, it
runs on the next wake. It updates along with the CLI, so you don't need to come back to it.

### Delivering to a git repository

A team can collect into a repository instead of, or as well as, a webhook:

```bash
codemie analytics sync install --git-repo git@github.com:acme/analytics.git --git-branch main --git-path reports
```

Install test-pushes a placeholder file first. If that fails, it prints the likely cause
(authentication, an untrusted SSH host key, an unreachable remote, a missing or protected
branch) and installs nothing. Give `--webhook-b64`/`--webhook` and `--git-repo` together,
and every run delivers to both.

---

The rest of this page goes into more detail. The most common tasks come first.

- [Everyday tasks](#everyday-tasks)
- [Troubleshooting](#troubleshooting)
- [How a run works](#how-a-run-works)
- [Platform notes](#platform-notes)
- [Security](#security)
- [Known gaps](#known-gaps)
- [Reference: settings and files](#reference-settings-and-files)
- [Moving from the standalone collector](#moving-from-the-standalone-collector)

## Everyday tasks

### Change the run time, lookback or policy

Re-run install with the new values; it replaces the existing job instead of adding a
second one, and keeps the last-sent marker:

```bash
codemie analytics sync install --webhook-b64 <value> --at 09:30 --lookback-days 14
```

Install always takes the full set of options: anything you leave out goes back to its
default (`--at 03:00`, the CLI's lookback, `--include-external never`).

### See what it is doing

```bash
codemie analytics sync status
```

It shows whether the OS job is actually registered and enabled, the run time, lookback,
policy, the webhook host (signature masked), the git target, the last run's outcome, and
the last successful send. "disabled" means the job was removed outside the CLI; run install
again.

### Send now

```bash
codemie analytics sync run
```

This is exactly what the scheduled job runs. It sends the window since the last
successful send, as the daily run would.

### Updates

They come with the CLI: `codemie self-update`, or your usual npm update. The scheduled job
always runs the installed CLI, so there is nothing to re-install after an update. A fixed
`--lookback-days` stays as you set it; the default follows the CLI.

### Uninstall

```bash
codemie analytics sync uninstall
```

This removes the scheduled job, the settings file that holds the webhook, and the git
working copy (`analytics-sync-repo/`). It's safe to run when nothing is installed, and safe
to run twice.

What stays:

- The last-sent marker(s) and the run log, so a later re-install neither re-sends nor
  duplicates what was already delivered.
- A team lead's saved bootstrap answers, `~/.codemie/analytics-sync-bootstrap.json`. They
  belong to `bootstrap`, not to the installed job. Delete the file when setup is done.

## Troubleshooting

Each run appends one line per delivery target to `~/.codemie/logs/analytics-sync.log`, and
`sync run` also prints it. The webhook signature is always redacted.

| Log line | What it means | What to do |
| --- | --- | --- |
| `ok sent <name> <bytes> target=…` | The target accepted the file. | Nothing. |
| `skip no sessions in window … target=…` | There were no CodeMie sessions in the window. | Nothing. Nothing was sent, and the next run covers this period too. |
| `fail setup No sync identity configured …` | No email in the CodeMie CLI config or in git. | Run `codemie profile login`, or `git config --global user.email you@example.com`, then run install again. |
| `fail setup No sync target configured …` | This machine has nowhere to send to. | Run the install command again. |
| `fail export …` | The report could not be built, or it is above the 70 MB limit. | Run `codemie analytics --last 1d` by hand to see why. See [Export size limit](#export-size-limit). |
| `fail send … target=webhook` | The webhook refused the request, or the network failed. | The next run retries the whole gap. If it keeps failing, the flow may be off or its URL rotated; ask your team lead. |
| `fail send … target=git` | The push failed. | Check `git push` works from this machine without a prompt. For an unknown SSH host key, run `ssh -T <host>` once. |

**No line for today at all?** The scheduler didn't run the job. Start the _scheduled_ job
yourself:

```bash
launchctl kickstart "gui/$(id -u)/com.epam.codemie.analytics-sync"   # macOS
systemctl --user start codemie-analytics-sync.service                # Linux
schtasks /Run /TN "CodeMie Analytics Sync"                           # Windows
```

**Logged `ok`, but the file never appeared?** The webhook answers `202 Accepted` when the
flow _starts_, not when it has saved anything. A failure after that shows only in the flow's
run history, which the flow owner can see.

**Team lead: the test send fails with HTTP 4xx?** Check that the flow is **On**, that its
trigger allows **Anyone**, and that you copied the whole URL.

## How a run works

`codemie analytics sync run` does the following, in order:

1. **Resolve your email** from the CodeMie CLI config, falling back to
   `git config --global user.email`. There's no anonymous fallback: without an email the run
   fails.
2. **Work out the window** per target, since that target's last confirmed send (see below).
3. **Build the report** in process: the same priced JSON that `codemie analytics --export json`
   writes.
4. **Skip** a target without sending, and without moving its marker, when the window has no
   sessions.
5. **Deliver**: one HTTPS POST to the webhook (5-minute timeout, no redirects), and/or a
   commit and push to the repository.
6. **Record** the run's start time in that target's marker, only after it accepted the file.
7. **Log** one line per target.

A failed run exits non-zero, so the OS scheduler records it. It doesn't retry: the next run
covers the gap anyway. A scheduled run (`sync run --scheduled`, which the job passes) skips
the update check and the "what's new" notice.

### The window looks back a week

A session is included only if it _started_ inside the window, and it is exported with its
totals so far. A window of just the time since the last send would therefore never send a
session again once it had been sent, and whatever it did after that run would be lost. So
every run covers **at least the lookback, 7 days by default**, and a session is re-sent with
its later activity by every run in the week after it started.

The job runs at 03:00 for the same reason: at that hour almost every session is finished, so
the first copy sent is already complete. A machine asleep at 03:00 runs the job when it
wakes, normally before work resumes.

The marker records when the last send was confirmed. After an outage longer than the
lookback, the run covers the time since then, so a laptop shut for three weeks sends three
weeks on its next run. The marker holds an ISO timestamp as file content, is written only
after the target accepts the file, and falls back to the lookback on a machine that has never
sent. That makes an outage heal itself instead of leaving a permanent hole.

### What gets sent to the webhook

The body is a Teams webhook message with the report as its only attachment:

```json
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/json",
      "name": "codemie-analytics-<email-slug>-<date>.report.json",
      "contentBytes": "<base64 of the report>"
    }
  ]
}
```

**That shape is the contract with the flow.** The flow reads `attachments[0].name` and
`attachments[0].contentBytes`. It is the same shape the standalone collector sent, so
existing flows keep working.

### The file name

```text
codemie-analytics-<lowercased email slug>-<UTC date>.report.json
```

Every developer's file lands in the same folder, so the email slug keeps them apart. The
result is one file per developer per day. A second run on the same UTC day sends a file with
the same name, which replaces the earlier one (see [Known gaps](#known-gaps)).

In a git repository the file goes to `<git-path>/<email slug>/<file name>`. Each developer
writes only inside their own folder, so pushes from different developers never conflict on
content.

### Export size limit

A run refuses a report above 70 MB. Power Automate accepts at most 100 MB per request, and the
report travels base64-encoded (4/3 of its size) inside a small JSON envelope, so 70 MB of
report is about 93 MB on the wire. The run logs `fail export` with the size and doesn't move
the marker. A fixed `--lookback-days` above the default makes this likelier, so reinstall
without it. After a long outage the window since the last send can still be too big; `sync`
has no flag to shorten a single run (see [Known gaps](#known-gaps)).

## Platform notes

Install registers a per-user daily job that **catches up a missed run** instead of skipping
the day:

| OS | Job | Catch-up |
| --- | --- | --- |
| macOS | launchd agent `com.epam.codemie.analytics-sync` | `StartCalendarInterval` fires on wake |
| Linux | systemd user timer `codemie-analytics-sync.timer` | `Persistent=true`, plus `loginctl enable-linger` so it also runs while you are logged out |
| Windows | Task Scheduler task `CodeMie Analytics Sync` | `StartWhenAvailable`; also runs on battery |

The job records the **absolute** paths to `node` and to the CLI's real entry script, because
schedulers don't run with your interactive `PATH`. On Windows it never goes through a `.cmd`
shim.

**External sessions are left out by default, on every platform.** "External" means an agent
session CodeMie did not launch, e.g. running `claude` directly. `always` includes them on every
machine; `windows` includes them on Windows machines only.

The standalone collector defaulted to `windows`, because the CLI used to miss CodeMie's own
sessions there and the Windows report came back empty. CodeMie's sessions now come from its
own session records, so on Windows `windows` only adds non-CodeMie sessions, and it counts a
CodeMie session twice when the agent recorded its transcript path in a different case (opening
the same project once from `c:` and once from `C:`). That is why the default is now `never`.

**Windows and raw URLs.** When `codemie` resolves to a `.cmd` shim, PowerShell cuts a raw
trigger URL at `&` and cmd.exe expands its `%…%` runs, even inside double quotes. That is why
`bootstrap` prints `--webhook-b64`. A team lead on Windows can use the guided mode (the URL is
pasted into a prompt, not onto the command line), or encode the URL for `--webhook-b64`:

```powershell
$url = '<trigger URL>'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($url)).TrimEnd('=').Replace('+','-').Replace('/','_')
codemie analytics sync bootstrap --webhook-b64 $b64
```

## Security

The webhook URL's `sig` parameter is its only authorization: anyone with the URL can post into
that folder. Nobody can use it to read anything. The CLI removes `sig` from every line it
prints or logs, and from every error. The full URL appears only in the install command
`bootstrap` prints and in two files readable only by you (mode 600):
`analytics-sync.json` (the developer's settings) and `analytics-sync-bootstrap.json` (the team
lead's saved answers). On Windows those files are protected by your user profile's
permissions.

`--git-repo` must not embed credentials (`user:token@…`). No token is ever requested or stored,
and git never prompts: an unattended run fails instead of hanging.

## Known gaps

**No file can mean two things.** A developer who did no work and a laptop that never woke up
both produce no file for that day.

**`ok` means accepted, not saved.** See [Troubleshooting](#troubleshooting).

**A second run on the same UTC day replaces the first.** It sends a file with the same name.
The replacement covers the same week or more, so no session drops out.

**A session can still arrive incomplete.** A session open at 03:00 is sent as it is then.
Later runs re-send it with its later activity, but an analysis tool that keeps the first copy
it reads keeps the incomplete one.

**A window too large to send can't be split.** After a long outage the window since the last
send can exceed the 70 MB limit, and every run fails the same way until the marker moves.
There is no flag to send it in parts.

**No manual backfill.** The standalone collector's `--last`/`--from`/`--to` backfill isn't
part of `sync`. For a one-off longer period, export it with `codemie analytics --export json`
and share the file directly.

## Reference: settings and files

`sync` reads no `ANALYTICS_*` environment variables; the settings file and CLI flags are the
only configuration. Every path below is under the CodeMie home, `~/.codemie` by default.

| Path | Written by | Holds |
| --- | --- | --- |
| `analytics-sync.json` | `sync install` | webhook URL, git target, run time, lookback (when fixed), policy (mode 600) |
| `analytics-last-sent` | each successful webhook delivery | the time of the last confirmed send |
| `analytics-last-sent-git` | each successful git delivery | the same, for the git target |
| `analytics-sync-repo/` | each git delivery | a shallow working copy of the team repository |
| `logs/analytics-sync.log` | each run | one line per target per run |
| `logs/analytics-sync.launchd.log` | macOS only | launchd's own stdout/stderr |
| `analytics-sync-bootstrap.json` | `sync bootstrap` (team leads only) | saved wizard answers, including the webhook URL (mode 600) |

Commands and every option: [COMMANDS.md](COMMANDS.md#team-lead-setup-analytics-sync-bootstrap).
Delivery contract and per-platform scheduler detail:
[ANALYTICS-REPORT.md](ANALYTICS-REPORT.md#scheduled-delivery-analytics-sync).

## Moving from the standalone collector

`sync` replaces the standalone analytics collector. It uses the same job names, the same state
files and the same message shape, so the move is one command:

- **Developers:** run the install command your team lead sends. Install unregisters the
  collector's job, keeps its last-sent marker, and registers the CLI's job, so the next run
  neither re-sends nor leaves a gap. Then delete the collector's folder,
  `~/.codemie/codemie-onboarding`.
- **Team leads:** your existing Power Automate flow keeps working. Run
  `codemie analytics sync bootstrap`, answer **yes** to "flow already imported?", paste the
  flow's trigger URL, and share the new install command. The collector's saved answers
  (`~/.codemie/analytics-setup.json`) aren't reused; delete that file when done.
- **Windows figures change.** The collector included external sessions on Windows by default;
  `sync` doesn't. A Windows developer's report now holds only CodeMie's sessions, comparable
  with macOS and Linux. A team that wants the old behaviour passes `--include-external windows`.
- **External clients** no longer need a collector archive: everyone installs through the CLI.
