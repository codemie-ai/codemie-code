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

**A machine with no CodeMie profile** (the CLI installed for this command alone, `codemie setup`
never run) has no CodeMie session records; its report is built from the clients' own logs. On
such a machine `install` turns on the [local analytics mode](#local-analytics-mode) when it can set up a supported client: a local proxy
gathers the analytics of Claude Code, Copilot CLI and Copilot Chat into
`~/.codemie/analytics/sessions/`, and the daily job delivers an OTLP file,
`codemie-analytics-<email slug>-<UTC date>.otlp.jsonl.gz` — or several, each no larger than 70 MB,
when one would be larger — beside the JSON report, which it goes on delivering as on any other
machine. Nothing is sent anywhere else. A machine where `install` finds none of the three clients
gets the job without the mode and delivers the JSON report alone.

Command groups and worked use cases: [Proxy and Analytics Commands](PROXY-AND-ANALYTICS.md).

## Quickstart

**You need:** the `codemie` CLI (Node.js 20+). For a git target, also `git` and push
access to the team repository.

There are two roles. A **team lead** connects the team's Teams channel and SharePoint folder
once, and gets one install command back. Each **developer** runs that command once.

### Team lead: connect the team (once)

```bash
codemie analytics sync bootstrap
```

A guided setup starts by asking where developer machines should deliver their reports:
the **Teams webhook**, a **git repository**, or **both**. The other steps are filtered to
that choice, and each shows its position ("Step 2 of 9"; the total depends on the choice).
For the webhook target:

1. **Delivery target**: webhook, git or both.
2. **Teams channel**: paste the link from the channel's **⋯ → Get link to channel**.
3. **SharePoint folder**: open the folder in the browser and paste the address bar. Type
   `manual` to give the site and the folder path separately. The simplest choice is a folder
   in the team's own site: Teams → channel → **Files** → **Open in SharePoint** →
   **+ New → Folder**.
4. **Time zone**: a Windows time zone name, e.g. `W. Europe Standard Time` (default `UTC`).
   It is used for the timestamps the flow posts in Teams.
5. **Import the flow**: the CLI writes `codemie-analytics-flow.zip` into the current
   folder, pre-filled with your channel, folder and time zone. In Power Automate:
   **My flows → Import → Import Package (Legacy)**, upload the zip, map the Teams and
   SharePoint connections, import, then turn the flow **On**. Open the HTTP trigger, set
   **Who can trigger** to **Anyone**, and copy its URL.
6. **Trigger URL**: paste it. The CLI test-sends a small `setup-check-<stamp>.json` and
   tells you where the file and the Teams reply should appear.

For the git target, one step takes the place of steps 2 to 6:

- **Git repository**: the repository URL (SSH or HTTPS), then an optional branch and an
  optional path inside the repository. Leave branch and path blank to get `install`'s own
  defaults (the repository's default branch, the repository root). A URL with embedded
  credentials (`user:token@…`) is refused, and never stored or printed. The CLI then
  test-pushes a placeholder file to the repository, using a temporary working copy (not your
  own sync copy or settings). If no report email is configured, it asks for one for the test
  and does not save it. On failure it prints the likely cause and lets you try again, enter
  different repository details, or skip the test.

Whatever you chose, the last steps are:

- **External sessions**: `never` (recommended), `always` or `windows`. See
  [Platform notes](#platform-notes), and [Reference](#reference-settings-and-files) for what
  `never` means in the local mode.
- **Lookback**: the CLI default (7 days today, which follows CLI updates) or a fixed
  1–30 days.
- **Developer command**: one line to share with your team:

```
codemie analytics sync install --webhook-b64 aHR0cHM6Ly9wcm9k… --include-external "never"
```

A git target adds `--git-repo <url>` to that line, with `--git-branch` and `--git-path` when
you set them. The CLI follows it with a note that push access comes from each developer's own
SSH key or credential helper, which `install` verifies.

The webhook is printed base64url-encoded, so the line runs unchanged in bash/zsh, PowerShell
and cmd. **Treat it as a secret:** the encoding is not encryption, and anyone with the line
can post into your folder. Share it directly with developers, not in a ticket or a public
channel.

Already have a flow? Answer **yes** to "flow already imported?" and the wizard starts at the
trigger URL. Ran it before? It shows the saved settings with the webhook masked and offers
three choices: **Reuse** (re-checks every chosen target live, then prints the command),
**Change targets** (add a target or turn one off; the saved details of a target you turn off
are kept for later but left out of the printed command and of the reuse checks) and **Start
over**. An interrupted run resumes with your earlier answers as defaults.

No terminal, or scripting it? Skip the questions and name the targets as options:

```bash
codemie analytics sync bootstrap --webhook "<trigger URL>" [--lookback-days 14] [--include-external always]
codemie analytics sync bootstrap --git-repo git@github.com:acme/analytics.git [--git-branch main] [--git-path reports]
```

Give `--webhook`/`--webhook-b64`, `--git-repo`, or both. It checks every target you named
(with both, the webhook test send and the git test push run at the same time) and prints the
command only after all of them pass. `--git-repo` alone prints a git-only command. A
`--git-repo` with embedded credentials is refused before anything is sent, and a missing
report email fails instead of prompting. With no terminal and no target option, it stops and
names `--webhook`/`--webhook-b64` and `--git-repo`. On Windows, pass the webhook URL as
`--webhook-b64` instead (see [Platform notes](#platform-notes)).

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

**What install does depends on the machine.**

- The CodeMie CLI config (`~/.codemie/codemie-cli.config.json`) holds a profile: install works as
  described above and the job delivers the JSON report. It prints `Local analytics mode not turned
  on: this machine has a CodeMie CLI profile (<names>). To turn it on, delete the profile and run
  this command again.` A CodeMie proxy running with an upstream has the same effect: ``Local
  analytics mode not turned on: a CodeMie proxy is running on this machine (<its URL>), started
  from a project's own CodeMie config. To turn it on, delete that project's profile (run `codemie
  profile delete` in the project), stop the proxy (`codemie proxy stop`) and run this command
  again.``
- The config holds no profile, or there is none: install turns on the
  [local analytics mode](#local-analytics-mode). Before it registers the job it writes the
  settings with `local: true`, starts the local proxy, and writes the hooks of each client it finds
  on the machine: Claude Code (its hooks and telemetry settings in `~/.claude/settings.json`),
  Copilot CLI and Copilot Chat (their hook files and `~/.codemie/copilot-connectors.json`). The
  summary lists the clients set up, skipped (with the reason) and not installed. When no client
  could be set up, the install undoes these steps, registers the job without the local mode and
  says so in its summary: the machine delivers the JSON report alone, and a later install turns the
  mode on once a supported client is there. On a machine that is local already such an install
  fails, and leaves the mode, the job and the settings as they were. No sign-in is asked for.

The check for a profile and for a proxy with an upstream comes first on every install. A machine
that is local already and passes it installs as before. One that has a profile or such a proxy by
then ends ``Install failed: This machine runs the local analytics mode and has a CodeMie CLI profile
(<names>). Delete the profile, or run `codemie analytics sync uninstall` to leave the local mode.``
(for a proxy, the same with the proxy's own text) and changes nothing. A config file that exists
and is not valid JSON stops install before it changes anything.

### Delivering to a git repository

A team can collect into a repository instead of, or as well as, a webhook. The team lead
chooses the git target in `bootstrap` (above) and shares the command it prints; a developer
can also run `install` with the options directly:

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
- [Local analytics mode](#local-analytics-mode)
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

### Name the scheduled job

By default the job uses the fixed name shown in [Platform notes](#platform-notes). Give it your
own full name with `--task-name`; the name is used as-is, with no prefix or suffix added:

```bash
codemie analytics sync install --webhook-b64 <value> --task-name "Team A analytics"
```

In a terminal, install asks `Scheduler task name (Enter for default "<default>"):` when you
don't pass the flag; press Enter to keep the default. Without a terminal and without the flag,
install uses the default and never prompts.

| OS | Default | Used as |
| --- | --- | --- |
| macOS | `com.epam.codemie.analytics-sync` | launchd label and `<name>.plist` file name |
| Linux | `codemie-analytics-sync` | systemd unit base name (`<name>.service` and `<name>.timer`) |
| Windows | `CodeMie Analytics Sync` | Task Scheduler task name (`schtasks /TN`) |

A name may hold spaces and other printable characters, but not control characters, `/`, `\`,
`..`, a leading `-` or `.`, or more than 100 characters. The OS can narrow this further:
systemd accepts only letters, digits, `:`, `_`, `.` and `-`, and Task Scheduler rejects
`: * ? " < > |`; install reports this before it touches anything. A custom name is saved as
`taskName` in `analytics-sync.json`; a name equal to the platform default, or no name, writes
nothing.

**Existing tasks.** Before it replaces anything, install checks whether a scheduler task with
the chosen name already exists, enabled or not. A task named like the previously installed job
or the platform default is yours to replace and is replaced silently. Any other existing task
triggers the warning `The following task already exists and will be deleted and overwritten
by this one: <name>`:

- In a terminal, with the name typed at the prompt, install asks `y/N` (default No). No stops
  the install and changes nothing.
- With `--task-name`, or without a terminal, install refuses and exits non-zero. Re-run with
  `--force` to overwrite the task.

If the check itself fails, install says it could not tell whether the task exists and treats
it the same way. The check runs before any existing job is removed, so a refusal leaves
everything as it was.

The name works the same in the [local analytics mode](#local-analytics-mode); there
`codemie proxy doctor` checks the job of the saved name in its `Local analytics` group.

Reinstalling under a new name replaces the old job (and the default-name job), so one job
remains. `sync uninstall` and `sync status` resolve the name from the saved settings; if the
settings file can't be read, they report that instead of guessing a name. `sync status` prints
the resolved name on an `OS job name` line.

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

In the local mode the proxy of the earlier version keeps running after an update until the next
hook event replaces it, or until `codemie proxy restart`. The job runs the Node and the CLI entry
it was installed with; if either moves (another Node, the CLI installed elsewhere),
`codemie proxy doctor` reports it and a re-install points the job at the new place.

### Uninstall

```bash
codemie analytics sync uninstall
```

This removes the scheduled job, the settings file that holds the webhook, and the git
working copy (`analytics-sync-repo/`). It's safe to run when nothing is installed, and safe
to run twice.

On a machine in the local mode it also removes, in this order: the hooks of Claude Code,
Copilot CLI and Copilot Chat; then, holding the daemon lock, the local proxy, the moves into the
folder left half-done and the local spool (`~/.codemie/analytics/spool/`, with the sessions not yet
moved); then the job and the settings; and the exclusion marks (`~/.codemie/analytics/excluded/`)
last. It removes the same on a machine whose settings no longer say `local` — replaced or removed
by hand — when the machine has no CodeMie CLI profile, no CodeMie proxy running with an upstream,
and still holds something of the local mode: its proxy's state, the local spool or the exclusion
marks.
A session still in its grace in the local spool has not been moved into the folder yet and is
never delivered.
A client that holds nothing only CodeMie writes is not touched: for Claude Code that is CodeMie's hooks, or the local proxy's telemetry endpoint with its header — telemetry settings of your own, an endpoint on another host included, stay as they are. A client set up before the install
loses its CodeMie hooks too, since the install rewrote them to the local proxy.
A Claude Code settings file that cannot be read or does not parse stops the uninstall before
anything is removed: `Uninstall failed: …`, exit 1, the settings kept.
A step that fails stops the uninstall with exit 1 and the settings kept, so the local mode stays in
place and `uninstall` can be run again. The clients' hooks are already removed by then, so nothing
is gathered until `uninstall` is run again and finishes, or `sync install` is run again and writes
them back. A failure to remove the exclusion marks is logged and does not fail the uninstall: the
job and the settings are gone by then.

- Hooks left by a CLI of an earlier version are removed with `codemie proxy disconnect --all`.
- A settings file that does not load stops `uninstall` before it removes anything. Fix or remove
  `~/.codemie/analytics-sync.json` and run `uninstall` again.
- A job installed under a name of its own (`--task-name`) is not found once its settings are gone:
  run `codemie analytics sync install --task-name <name> --force`, then `uninstall`.
- Settings that no longer say `local` on a machine with nothing of the local mode left to tell it
  by — its proxy stopped with `codemie proxy stop` and no session in the local spool: `uninstall`
  removes the job and the settings alone. Run `codemie analytics sync install` again, then
  `uninstall`.

What stays:

- The analytics folder, `~/.codemie/analytics/sessions/`: nothing stored is removed by itself,
  `sync uninstall` included.
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
| `ok sent <n> files <total bytes> target=…` | Local mode: the target accepted every file of the run, the OTLP files and the JSON report. | Nothing. |
| `ok sent <name> <bytes> (warning: OTLP files not built, the marker stays and the next run tries them again: …) target=…` | Local mode: the analytics folder could not be read, and the target accepted the JSON report alone. The last-sent marker stays. | The detail names the cause. The next run's window covers the time since the last run that moved the marker: it sends the report again and tries the OTLP files again. |
| `ok sent … (warning: JSON report not built, the marker stays and the next run tries it again: …) target=…` | Local mode: the JSON report could not be built, and the target accepted the OTLP files alone. The last-sent marker stays. | The detail names the cause; run `codemie analytics --last 1d` by hand to see it. The next run sends the OTLP files again — a reader keeps one copy of a line by its id — and tries the report again. |
| `ok sent … (warning: OTLP files built without <n> session(s), the marker stays and the next run tries them again: <session> (<error>), …) target=…` | Local mode: the files of the named sessions could not be read; the other sessions were delivered. The last-sent marker stays. | The detail names the first three sessions and why. The next run tries them again; a file that can never be read holds the marker until it is removed from the analytics folder. |
| `ok sent … (warning: OTLP files built without <n> session(s): <session> (Export size … exceeds limit …), …) target=…` | Local mode: each named session holds a single line whose gzip alone is above 70 MB, which no run can deliver; the other sessions were delivered and the marker moved. | Nothing delivers those sessions. See [Export size limit](#export-size-limit). |
| `skip no sessions in window … target=…` | There were no CodeMie sessions in the window. In the local mode: neither the JSON report nor `~/.codemie/analytics/sessions/` has a session in the window. In the local mode the line can carry the note `(warning: OTLP files built without <n> session(s): <session> (Export size … exceeds limit …), …)` of the row above, when the only sessions of the window were ones no run can deliver. | Nothing. Nothing was sent, a `skip` moves no marker, and the next run covers this period too. In the local mode, see [Limitations](#limitations) for why a session may be missing. |
| `fail setup No sync identity configured …` | No email in the CodeMie CLI config or in git. | Run `codemie profile login`, or `git config --global user.email you@example.com`, then run install again. |
| `fail setup No sync target configured …` | This machine has nowhere to send to. | Run the install command again. |
| `fail export …` | The report could not be built, or it is above the 70 MB limit. In the local mode a report that cannot be built fails the run only when the analytics folder has no OTLP file to deliver, and an analytics folder that cannot be read fails it only when the window has no JSON report. A run that built no file at all while a session's files could not be read is a `fail export` too, and its line carries that warning. | For the JSON report, run `codemie analytics --last 1d` by hand to see why. In the local mode the line's detail names the cause. See [Export size limit](#export-size-limit). |
| `fail send … target=webhook` | The webhook refused the request, or the network failed. | The next run retries the whole gap. If it keeps failing, the flow may be off or its URL rotated; ask your team lead. |
| `fail send … target=git` | The push failed. | Check `git push` works from this machine without a prompt. For an unknown SSH host key, run `ssh -T <host>` once. |

**No line for today at all?** The scheduler didn't run the job. Start the _scheduled_ job
yourself:

```bash
launchctl kickstart "gui/$(id -u)/com.epam.codemie.analytics-sync"   # macOS
systemctl --user start codemie-analytics-sync.service                # Linux
schtasks /Run /TN "CodeMie Analytics Sync"                           # Windows
```

These use the default names. If you installed with `--task-name`, use the resolved name
instead (see `OS job name` in `codemie analytics sync status`), for example
`<name>`, `<name>.service` or `"<name>"`.

**Logged `ok`, but the file never appeared?** The webhook answers `202 Accepted` when the
flow _starts_, not when it has saved anything. A failure after that shows only in the flow's
run history, which the flow owner can see.

**Local mode: nothing in the folder?** Run `codemie proxy doctor`; its `Local analytics` group
shows the folder, the job and the last delivery per target. With `--include-external never` the
local mode gathers nothing (see
[Reference](#reference-settings-and-files)). A session moves into the folder only 15 minutes
after it ends (60 minutes after its last event when no end came).

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
   commit and push to the repository. In the local mode: one POST per file — every file is
   attempted, a file that fails does not stop the ones after it, and the target fails after the
   last — and all the files in one commit and one push.
6. **Record** the run's start time in that target's marker, only after it accepted the file — in
   the local mode, every file of the run; a failure at any file leaves the marker, and the next run
   sends the window again.
7. **Log** one line per target.

In the [local analytics mode](#local-analytics-mode) step 3 builds the report and, beside it, the
`.otlp.jsonl.gz` from the analytics folder; the run sends the OTLP files first and the report last.
The OTLP files hold the sessions whose newest line in the folder was written inside the
window, each file taken up to its last newline, in the order hooks, logs, metrics, traces, the
sessions sorted by id, cut into files no larger than 70 MB gzipped when one would be
larger; a session larger than that is cut at a line. A session whose move into the folder is in
progress is left for the next run. Steps 1, 2, 4 and 7 are the same.

A failed run exits non-zero, so the OS scheduler records it. It doesn't retry: the next run
covers the gap anyway. A scheduled run (`sync run --scheduled`, which the job passes) skips
the update check and the "what's new" notice.

### The window looks back a week

A session is included only if it _started_ inside the window, and it is exported with its
totals so far. A window of just the time since the last send would therefore never send a
session again once it had been sent, and whatever it did after that run would be lost. So
every run covers **at least the lookback, 7 days by default**, and a session is re-sent with
its later activity by every run in the week after it started.

In the local mode the window is read from the folder's write times: a session is in a run when its
newest line in the folder was written inside the window, and the whole of it is sent. A line
repeated by the overlapping windows carries the same line id (see [The file name](#the-file-name)).

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

In the local mode the run sends the `.otlp.jsonl.gz` files first, each with
`"contentType": "application/gzip"`, then the report as above: one request per file, each with
that file as its only attachment; the rest of the shape is the same.

**That shape is the contract with the flow.** The flow reads `attachments[0].name` and
`attachments[0].contentBytes` of each request. It is the same shape the standalone collector sent, so
existing flows keep working.

### The file name

```text
codemie-analytics-<lowercased email slug>-<UTC date>.report.json
```

Every developer's file lands in the same folder, so the email slug keeps them apart. The
result is one file per developer per day. A second run on the same UTC day sends a file with
the same name, which replaces the earlier one (see [Known gaps](#known-gaps)).

In the local mode the run delivers, beside the report under that name,
`codemie-analytics-<lowercased email slug>-<UTC date>.otlp.jsonl.gz`: one gzip stream, no archive.
When the run's lines do not fit in 70 MB they are cut at a line into
`codemie-analytics-<lowercased email slug>-<UTC date>.part-<k>-of-<n>.otlp.jsonl.gz`
(`part-01-of-03`), each a gzip stream of whole lines by itself, read in any order. After a repeated
run of a UTC day whose lines are cut differently, the parts of the earlier cut lie beside the new
ones: a reader takes every file and keeps one copy of a line by its id.
Unpacked, every line is one OTLP JSON export request (`resourceLogs`, `resourceMetrics` or
`resourceSpans`); the hook events are OTLP log records. Every `resource` carries the attribute
`codemie.line_id` = `<the session file's name in the folder>:<the first 32 hex digits of the SHA-256
of the line as the local spool held it>`. A
session's file holds that session's records alone: a telemetry export with records of two
sessions (a Claude Code process that changed its session id) is divided between their files, and
what names no session stays with the session of its request. The id is computed when the line is
moved into the folder and is stored in it, so a line keeps its id in every file it reaches — also
when the folder was deleted and the line is moved again — and a reader keeps one copy of a line
the overlapping windows repeat. Two lines of one file share an id only when the spool held the
same bytes twice.

In a git repository the file goes to `<git-path>/<email slug>/<file name>`; in the local mode the
OTLP files of a run and the JSON report go there together, in one commit. Each developer
writes only inside their own folder, so pushes from different developers never conflict on
content.

### Export size limit

A run refuses a report above 70 MB. Power Automate accepts at most 100 MB per request, and the
report travels base64-encoded (4/3 of its size) inside a small JSON envelope, so 70 MB of
report is about 93 MB on the wire. The run logs `fail export` with the size and doesn't move
the marker. A fixed `--lookback-days` above the default makes this likelier, so reinstall
without it. After a long outage the window since the last send can still be too big; `sync`
has no flag to shorten a single run (see [Known gaps](#known-gaps)).

The JSON report is one document: above 70 MB the run fails as described here, in the local mode
too, after the target took the OTLP files. A report that cannot be built fails the run; in the
local mode it does not hold the OTLP files back — the run delivers them with a warning in its log
line and leaves the marker, and only with no OTLP file to deliver it fails with `fail export`. The
local mode's OTLP output is cut into files no larger than 70 MB after compression, for the webhook
and for git. A session with a single line whose gzip alone is above 70 MB can be delivered by no
run: it is left out whole and named in the run's log line, and the other sessions are delivered.
A session whose file cannot be read is left out of that run and named in its log line; the marker
stays and the next run tries it again — a file that can never be read holds the marker until it is
removed from the folder. When the analytics folder itself cannot be read, the run delivers the
JSON report, if there is one, with a warning in its log line, and leaves the marker; with no
report it fails with `fail export`. A target's marker moves only after it accepted every file of
a run whose log line carries no `the marker stays` warning. The OTLP lines compress well
(about 18 to 1 measured on four day-long sessions), so a day of work is a few MB.

## Local analytics mode

The mode of a machine whose CodeMie CLI config holds no profile: `sync install` turns it on when it
sets up at least one supported client, and keeps it in the settings (`local: true`) until
`sync uninstall`. It gathers Claude Code (its hook
events and its own OTLP logs, metrics and traces), Copilot CLI and Copilot Chat (their hook
events), and its daily job delivers their OTLP files beside the JSON report, which it goes on
delivering as on any other machine. It does not gather Codex, Gemini or Pi, which stay in the
JSON report, nor Claude Desktop Cowork or the model clients of the proxy. One machine runs one
mode: on a machine in the local mode `codemie proxy connect` and `codemie proxy disconnect`
refuse and name `codemie analytics sync uninstall`.

### Commands, and what runs under each

**The team lead** runs `codemie analytics sync bootstrap` as above and shares the line it
prints. Nothing in it is about the mode: the same line turns the local mode on on a machine with
no profile where it finds a supported client, and installs the JSON report alone on any other.

**The developer** runs that line, `codemie analytics sync install …`. On a machine with no
profile it:

1. decides the mode: the global CLI config holds no profile and no CodeMie proxy runs with an
   upstream — checked first, also on a machine whose settings already hold `local: true`;
2. creates the analytics folder `~/.codemie/analytics/sessions/` when it is absent, then writes
   `~/.codemie/analytics-sync.json` with the targets, the options and `local: true`;
3. starts the local proxy (`codemie proxy` in `--mode local`, on port 4001 or a free one), or
   keeps the one that runs;
4. writes, for each client found on the machine: Claude Code's hooks and its telemetry settings
   (the `env` of `~/.claude/settings.json`, pointing at the local proxy); Copilot CLI's hook file
   (`~/.copilot/hooks/codemie-copilot-cli-hooks.json`); Copilot Chat's hook file and its entry in
   VS Code's settings; the scope record of both Copilot clients in
   `~/.codemie/copilot-connectors.json`. A project list already there is kept;
5. registers the OS job, as on any machine, and saves the `node` and CLI entry it runs as
   `localJob`.

When step 4 could set up no client, the install undoes steps 2–4, registers the job as on a machine
that is not local and says so in its summary (`Local mode: not turned on — no supported client could
be set up (Claude Code, Copilot CLI, Copilot Chat); the JSON report is delivered`): the machine
delivers the JSON report alone, and a later install turns the mode on once a supported client is
there. On a machine that is local already such an install fails instead and leaves the mode, the
job and the settings as they were.

A step that fails undoes the steps before it, last first. A client whose settings already send
its telemetry elsewhere is skipped, and the summary says why: for Claude Code that is an OTLP
endpoint of your own, the general one or one of the per-signal ones
(`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `…_METRICS_ENDPOINT`, `…_TRACES_ENDPOINT`). So is a client whose files cannot be
written (`its files could not be written (<code>)`), and Claude Code when its settings file cannot
be read or does not parse.

**What then runs by itself:**

- each hook event of a client runs `codemie hook` as its own process: it decides whether the
  session is gathered, starts the local proxy when none runs, and posts the event to it;
- Claude Code's own exporter posts its logs, metrics and traces to the local proxy;
- the local proxy writes each session to `~/.codemie/analytics/spool/` and, every 15 minutes,
  moves the sessions that are done into `~/.codemie/analytics/sessions/`: 15 minutes after a
  session ends, or 60 minutes after its last event when no end came (Copilot Chat sends none); a
  Copilot CLI session whose `sessionEnd` never came gets its end and final totals from its
  transcript before the sweep;
- the daily job, `codemie analytics sync run --scheduled`, delivers the `.otlp.jsonl.gz` of the
  window, cut into files no larger than 70 MB when one would be larger, and the JSON report after
  them.

**The other commands on a local machine:**

| Command | What it does there |
| --- | --- |
| `codemie analytics sync status` | adds the line `Mode: local — delivers the OTLP files of <the analytics folder> beside the JSON report`, the folder named by its real path (`~/.codemie/analytics/sessions` unless `CODEMIE_HOME` moves it) |
| `codemie analytics sync run` | delivers the OTLP files of the window and the JSON report, as the job does |
| `codemie analytics sync uninstall` | removes the local mode as well (see [Uninstall](#uninstall)) |
| `codemie proxy doctor` | no sign-in, upstream or delivery section; a `Local analytics` group with the folder, the job and the last delivery per target |
| `codemie proxy start` / `restart` | start or restart the local proxy; `--profile` is refused |
| `codemie proxy stop` | stops it; the next hook event starts it again |
| `codemie proxy connect` / `disconnect` | refused, naming `codemie analytics sync uninstall` |
| `codemie proxy analytics exclude` / `include` / `enable` / `disable` | the developer's filters, as on any machine |
| `codemie proxy analytics status` | the filters, and the folder and job lines in place of the delivery health |

### The local proxy: start, restart, stop

`install` starts it. The OS keeps no service for it: after a reboot, or when it has died, the
next hook event of Claude Code, Copilot CLI or Copilot Chat starts it before it posts its event,
waiting up to 12 seconds for another process that is starting it. `codemie proxy start` starts it
by hand, on `--port` when it is given, or, when one already runs, leaves it on its port and names
it with its URL; `codemie proxy restart` stops it and starts it
again on its port. A watcher inside the proxy checks its own `/health` every 30 seconds and
restarts it, up to 3 times.

After a CLI update, the proxy of the earlier version is replaced by the next hook event, or by
`codemie proxy restart`. It listens on port 4001, or on a free port when 4001 is taken; the hook
then points Claude Code at the new port, which Claude Code takes from its next session.
`codemie proxy stop` stops it until the next hook event.

Two CLI versions on one machine: the Copilot hooks run the build that ran `install`, Claude
Code's hooks run the `codemie` first on `PATH`. See [Limitations](#limitations) for a hook of a
CLI before the local mode.

### What the file holds

This is about the OTLP files; the JSON report beside them holds what it holds on any machine.
What a CodeMie backend gets from these clients, nothing cut further: the developer's email, the
transcript and file paths, the branch and the remote of the repository, Bash commands and tool
parameters (whole in Claude Code's telemetry), and the first 200 characters of a prompt. Secrets
are masked when an event is written, as on any machine. The file holds none of the values a
backend gets as request headers: the organization, the subscription class, the policy version,
the project's source, the contract and the consent.

Every `resource` of every line carries the attribute `user.email` = the sync email the file's name is made from,
with its case, so a reader takes the developer from the file itself; it is set when the run builds the file, and a
resource-level `user.email` of Claude Code's telemetry gives way to it. With no CodeMie login a record's `user_email`
is empty; a hook event also names the developer in `developer_name` — the git `user.email` or `user.name`, else the
CLI config's email or the OS user. A session's telemetry
travels whole with its hook events, so the part of a session resumed outside the policy is in the
file: OTLP carries no working directory. A session that fires a hook while your filters leave it out — analytics
switched off, an excluded project, a project outside the tracked list — is not gathered from
then on, a return to a tracked folder and `proxy analytics enable` / `include` included; what
was moved before stays. A Claude Code settings file that cannot be read or does not parse, a project list in it
that is not a list of absolute paths, or a hook that names no folder while that list is not empty is not a filter:
that hook is not gathered, no mark is left, and the session goes on once the file reads again. A
file is no larger than 70 MB: a larger run is cut into several (see [Export size limit](#export-size-limit)).

### Limitations

- **The clients.** The OTLP files hold Claude Code, Copilot CLI and Copilot Chat. Codex, Gemini
  and Pi are not in them; they reach the lead in the JSON report, delivered beside them.
- **The default `never`.** In the local mode it gathers nothing; the team lead chooses `always`
  in `bootstrap`, or `windows` to gather on Windows alone.
- **A changed `--include-external`.** The answer applies when a session is gathered: a session
  stored under an earlier answer stays in the folder and is delivered while it is in a run's window.
- **Nothing before the install.** Only events from the install on are gathered. A session already
  running is gathered from its next event, its transcript read from the start.
- **The delays.** A session reaches the folder 15 minutes after it ends, or 60 minutes after its
  last event; a run delivers it the next day.
- **Lost telemetry.** Claude Code's telemetry sent while the proxy is down is lost: nothing
  restarts the proxy until the next hook event.
- **Copilot blocks.** Copilot CLI and Copilot Chat block an enforced event the local proxy did not
  accept, as on any machine; that happens when the hook could not start the proxy. Copilot Chat
  also blocks while `~/.codemie/copilot-connectors.json` cannot be read: the message names the file
  and `codemie analytics sync install`.
- **Collection turned back on.** A session that fired an event while your filters left it out is
  not gathered again after `proxy analytics enable` or `include`; sessions started from then on
  are, and the command says so.
- **The size.** A delivered file is no larger than 70 MB, and a run can deliver several, for the
  webhook and for git; a session with a single line whose gzip alone is above 70 MB is left out whole, its lines
  that would fit included, and named in the run's log line, while the other sessions are delivered; once its newest
  write is outside the window no run names it. A push takes 120 seconds at most.
- **The content and the filters.** See [What the file holds](#what-the-file-holds).
- **One mode per machine.** The local mode is for a machine with no CodeMie backend, where no
  client is started through CodeMie. `proxy connect` is refused until `sync uninstall`, and the
  commands of the local mode start no other proxy. A hook that finds another CodeMie proxy running
  replaces it with the local proxy: one left running would take the hook events to a backend.
  Starting a client through `codemie` (`codemie claude`) with a project's own profile is outside
  the mode: it starts that profile's proxy in place of the local one.
- **The hints.** Where another machine's `proxy doctor` or clients' list names `proxy connect` or
  `proxy disconnect`, a local machine's names `codemie analytics sync install`, the one command that
  writes the clients' settings there and never refuses in the mode. It is named for a routed VS Code
  extension or a project list as well, which the mode has no command of its own for.
- **Settings that do not load.** A `~/.codemie/analytics-sync.json` that cannot be read or is not valid
  is taken as no local mode: Claude Code's hooks gather nothing, while a hook of Copilot CLI or
  Copilot Chat is still stored by the running local proxy and its session moved into the folder,
  under your own folder filters and without the lead's `--include-external` — until the file is
  mended or `sync install` runs again. `sync status` and `sync uninstall` stop on the file.
  Mend or remove it and run `sync install` again; with a job installed under a name of its own
  (`--task-name`) that install asks for `--force`.
- **The job** runs the Node and the CLI it was installed with.
- **Nothing stored is removed by itself**, `sync uninstall` included: the folder grows by every
  session and stays until you delete it.
- **Never cleaned by itself, cleared by `sync uninstall`:** the exclusion marks, and a session whose
  move into the folder was interrupted in a way the proxy cannot continue — it stays where it is,
  undelivered, since repeating the move would write its lines into the folder file a second time.
- **`sync uninstall` drops the sessions in their grace.** It removes the local spool with the
  sessions not yet moved into the folder: what of them has not been moved is never delivered.
- **Two CLI versions on one machine.** A Copilot CLI or Copilot Chat hook of a CLI before the
  local mode (where the CLI the hooks name was replaced by an earlier version) posts to the live
  local proxy, which stores its events with no `--include-external` applied; each such hook writes
  `~/.codemie/proxy-connection.json` with an empty profile, which `uninstall` leaves. Claude
  Code's hooks of such a CLI gather nothing.

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

The names above are the defaults; see [Name the scheduled job](#name-the-scheduled-job) for
custom names.

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
The replacement covers the same week or more, so no session drops out. In the local mode a second
run whose files are cut differently leaves the earlier files beside the new ones; a reader keeps
one copy of a line by its `codemie.line_id`. A local-mode run that fails at a later file leaves the files the
target already accepted; the marker stays, and the next run sends the window again under its own date and count — the
reader keeps one copy of a line by its id.

**A session can still arrive incomplete.** A session open at 03:00 is sent as it is then.
Later runs re-send it with its later activity, but an analysis tool that keeps the first copy
it reads keeps the incomplete one.

**A JSON report too large to send can't be split.** After a long outage the window since the last
send can exceed the 70 MB limit, and every run fails the same way until the marker moves.
There is no flag to send it in parts, in the local mode too; the local mode's OTLP files are cut.

**Local mode: see [Limitations](#limitations).**

**No manual backfill.** The standalone collector's `--last`/`--from`/`--to` backfill isn't
part of `sync`. On a machine not in the local mode, export a one-off longer period with the
deprecated `codemie analytics --export json` and share the file directly. On a machine in the
local mode, the same export gives a one-off JSON report; the OTLP files' period is the
`--lookback-days` (1–30) of the install line alone.

## Reference: settings and files

`sync` reads no `ANALYTICS_*` environment variables; the settings file and CLI flags are the
only configuration. Every path below is under the CodeMie home, `~/.codemie` by default.

| Path | Written by | Holds |
| --- | --- | --- |
| `analytics-sync.json` | `sync install` | webhook URL, git target, run time, lookback (when fixed), policy, `taskName` (custom scheduler task name only), and in the local mode `local: true` and `localJob` (the `node` and CLI `entry` the job was registered with) (mode 600, written to a temporary file and renamed over it) |
| `analytics/sessions/` | `sync install` (created empty) and the local proxy, in the local mode | every finished session: `<sessionId>.hooks.jsonl` and `<sessionId>.otel_{logs,metrics,traces}.jsonl`, only appended to, never cleaned |
| `analytics/spool/` | the local proxy (local mode) | sessions not yet moved into the folder |
| `analytics/excluded/` | the hooks (local mode) | one empty file per session that fired a hook in a folder your filters leave out |
| `analytics-last-sent` | each successful webhook delivery | the time of the last confirmed send |
| `analytics-last-sent-git` | each successful git delivery | the same, for the git target |
| `analytics-sync-repo/` | each git delivery | a shallow working copy of the team repository |
| `logs/analytics-sync.log` | each run | one line per target per run |
| `logs/analytics-sync.launchd.log` | macOS only | launchd's own stdout/stderr |
| `analytics-sync-bootstrap.json` | `sync bootstrap` (team leads only) | saved wizard answers: chosen targets, the webhook URL and the git repository, branch and path (mode 600) |

`--include-external` decides which sessions are gathered. For the JSON report: `never` the
sessions CodeMie launched (`codemie claude`, `codemie copilot`), `always` every session, `windows`
every session on Windows and the launched ones elsewhere. In the local mode: `never` gathers
nothing, `always` every session, `windows` every session on Windows and nothing elsewhere.

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
