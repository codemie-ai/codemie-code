# Local analytics mode — Spec

**Story**: `story.md` (its criteria, non-goals and decisions bind). **Repository**: codemie-code. One release.

## Why

A team with no CodeMie backend delivers, through `codemie analytics sync`, a JSON report built from session logs. The
proxy's data — Claude Code's hook events and telemetry, Copilot CLI's and Copilot Chat's hook events — is the format the
receiving side takes, and exists only behind a CodeMie login. The lead's existing `sync` setup should gather and deliver
that data on a machine that has no login at all.

## Today

- `sync run` builds `codemie-analytics-<email>-<UTC date>.report.json` from session logs and delivers it daily
  (`src/cli/commands/analytics/sync/report-builder.ts:36-72`, `sync/run-sync.ts:125-212`); a webhook file above 70,000,000
  bytes fails the run (`sync/targets/webhook-target.ts:21,47`).
- `--include-external` defaults to `never` (`sync/config-store.ts:29`); a session CodeMie did not launch is left out of the
  report (`sources/sessions-source.ts:21`). With no profile no CodeMie launcher starts a client
  (`src/agents/core/AgentCLI.ts:343-348`).
- `proxy connect` needs an SSO profile and a stored login (`src/cli/commands/proxy/connect-orchestrator.ts:226-323`); with no
  login Claude Code's hook writes no event (`src/agents/core/evidence/stamp.ts:122-125`). The proxy's intake checks its
  gateway key alone (`src/providers/plugins/sso/proxy/plugins/otlp.plugin.ts:233-400`).
- A spool session is deleted at the first sweep (every 15 minutes) after all of it was sent or dropped and 15 minutes
  passed from its end mark, or 60 from its last write (`plugins/otlp-spool/sweep.ts:85-103`, `spool-config.ts:72,102,127`).
- A line of the spool's hooks file is the CLI's own envelope (`plugins/otlp.plugin.ts:39-46,301`); a telemetry line is one
  native OTLP JSON export request (`:359-400`).
- Copilot CLI blocks a prompt or a tool call, and Copilot Chat also a session start, whose event the local spool did not
  accept (`src/agents/core/OtlpAgentAdapter.ts:148-150`, `copilot-cli-otlp.plugin.ts:76`, `copilot-chat-otlp.plugin.ts:28`).

## Behavior

- **Turning it on.** The lead's command is unchanged. On a machine whose CLI config holds no profile, `sync install` marks
  the local mode in `~/.codemie/analytics-sync.json`, starts a proxy with no upstream, writes the hooks and telemetry settings of the clients found on the machine
  among Claude Code, Copilot CLI and Copilot Chat, and registers the daily job. A client that cannot be set up —
  one that already sends telemetry elsewhere, one whose files cannot be written, Claude Code when its settings file cannot be
  read or does not parse — is skipped and listed; with no client written the install undoes what it created for the mode, registers the job
  without it and says so in its summary — the machine delivers the JSON report alone; on a machine already local such an
  install fails and what this run created is undone. The check for a profile and for a proxy with an upstream comes first on every
  install: a machine already local that has one by then ends `Install failed: …` and nothing changes. On any other machine with a profile, or
  with a CodeMie proxy running, the install works as today and says in one line why the local mode is off.
- **Collecting.** The local proxy keeps a spool of its own (`~/.codemie/analytics/spool/`), reads no credentials and sends
  nothing; the hooks run with no sign-in check, no evidence
  record and no session gate. A session is collected when `--include-external` allows it; a developer's folder filters and
  `proxy analytics exclude` apply on top. With `never` the local mode collects nothing. A session that
  fires a hook in a folder the filters leave out is not collected from that hook on — a return to a tracked folder
  included — and what of it is still in the spool is dropped. A Claude Code settings file that cannot be read or does not parse, a project filter in it that is not a list of absolute paths, or a hook that names no folder while that filter is not empty is not a filter: that hook is not collected, no mark is left, and the session goes on once the file reads again. Copilot's block
  stays: it comes only when the hook could not bring the proxy up.
- **Keeping.** At the first sweep after a session's grace — 15 minutes from its end, 60 from its last write; Copilot Chat
  sends no end, so always 60 — the proxy moves it into `~/.codemie/analytics/sessions/`: one `.jsonl` file per session and
  stream, every line carrying `codemie.line_id`. A session with no hook event is not kept; telemetry that arrives after a
  move joins its session. An event already in the session's file by its `event_id` is not written again. A repeated move
  gives the same files. The folder is never cleaned.
- **Staying up.** A hook that finds no proxy starts the local one before it writes; an older one is replaced.
- **Delivering.** The daily job gzips the lines of the sessions written to inside the run's window into
  `codemie-analytics-<email>-<UTC date>.otlp.jsonl.gz` and sends it to the lead's targets beside the JSON report, which is built as on any other machine. A
  file is no larger than 70,000,000 bytes gzipped, for the webhook and for git: when the run's lines do not fit, they are
  cut at a line into `codemie-analytics-<email>-<UTC date>.part-<k>-of-<n>.otlp.jsonl.gz` (`part-01-of-03`), each a gzip
  stream of whole lines by itself, in no order a reader needs — a line is told from a repeated one by its
  `codemie.line_id`. The webhook gets one request per file, git the files in one commit and one push; a target's marker
  moves when it accepted every file of the run, and a failure at any file leaves it for the next run. A second run on the
  same UTC day whose files are cut differently leaves the earlier files beside the new ones. The log holds one line per
  target: `ok sent <name> <bytes>` for one file, `ok sent <n> files <total bytes>` for several.
- **Other commands.** `proxy doctor`, `proxy status`, `proxy clients` and `codemie doctor` show the local mode's state and
  name `sync install` in their hints; `sync status` names the mode. `proxy start` and `proxy restart` start and restart the local
  proxy and refuse a `--profile`; `proxy connect` and `disconnect` refuse and name `sync uninstall`; `proxy stop` works and the
  next event starts the proxy again. `sync uninstall` removes
  the hooks, stops the proxy, removes the local spool with the sessions not yet moved, then the job and the settings, and
  the exclusion marks last, and leaves the folder; it removes the same on a machine with no profile and no proxy with an
  upstream whose settings no longer say `local`, when a trace of the mode is there — its proxy's state, the local spool or
  the exclusion marks; when a step
  of it fails the settings of the local mode stay and the uninstall can be run again — the hooks it had already removed
  stay removed until then. It removes CodeMie's own entries of a client wherever they are in place, those of a client set
  up before the install included — the install rewrote them to the local proxy; a client that holds none of CodeMie's
  entries is not touched, and nothing that CodeMie did not write is removed.
  `codemie analytics --export json` prints a deprecation notice on stderr.

## Commands, and what runs under each

No command and no flag is new. What changes is what three of them do on a machine in the local mode.

### The team lead — once

| Command | What it does |
|---|---|
| `codemie analytics sync bootstrap` | A guided setup, unchanged. Asks where developers' machines deliver: a Teams webhook, a git repository, or both. For the webhook: takes the Teams channel and the SharePoint folder, writes `codemie-analytics-flow.zip` for Power Automate, takes the flow's trigger URL and test-sends a small `setup-check-<stamp>.json` to it. For git: takes the repository, an optional branch and path, and test-pushes a placeholder file from a temporary working copy. Then asks `--include-external` (`never` by default, `always`, `windows`), the lookback (7 days by default, 1–30) and an optional name of the daily job, and prints one `sync install` line. It installs nothing on the lead's machine and starts no proxy. |
| the printed line, shared with the team | `codemie analytics sync install --webhook-b64 <…> [--git-repo <url> --git-branch <b> --git-path <p>] [--at HH:MM] [--lookback-days N] --include-external <policy> [--task-name "<name>"]`. The webhook in it is a secret: anyone holding the line can post into the folder. |

With `--include-external never` the local mode gathers nothing; a team on the local mode needs `always`, or `windows` to
gather on Windows alone.

### A developer — once

`codemie analytics sync install …` (the lead's line). In order:

1. Checks the options and resolves the developer's email: the CLI config's, else `git config --global user.email`, else asks
   once on a terminal. Runs its checks before changing anything; for a git target, a test push to the repository with the
   developer's own credentials.
2. Decides the mode, once: the machine is local when its CLI config holds no profile and no CodeMie proxy with an upstream
   is running — checked first, also on a machine already local, which ends with a failure and no change when it has a
   profile or such a proxy by then. Otherwise the local mode stays off, one line says why, and only step 6 runs — as today.
3. Writes `~/.codemie/analytics-sync.json` (mode 0600) with the targets and `local: true`.
4. Starts the local proxy: a detached Node process of the CLI, `proxy-daemon --mode local`, on `127.0.0.1:4001` or a free
   port; its pid, port and key go to `~/.codemie/proxy-daemon.json`. It has no upstream and reads no credentials.
5. For each client found on the machine, writes what `proxy connect` writes today, with no sign-in check:
   - Claude Code — in `~/.claude/settings.json` (backed up beside it): 16 hooks that run `codemie hook --agent claude-code-otlp`,
     and the telemetry settings (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, the logs, metrics and traces exporters `otlp` over
     `http/json`, `OTEL_LOG_TOOL_DETAILS=1`, the endpoint `http://127.0.0.1:<port>/v1/analytics/otlp` with the proxy's key);
   - Copilot CLI — `~/.copilot/hooks/codemie-copilot-cli-hooks.json` (12 hooks) and its record in
     `~/.codemie/copilot-connectors.json`;
   - Copilot Chat — `~/.codemie/hooks/copilot-chat-hooks.json` (8 hooks), `chat.hookFilesLocations` in VS Code's user
     `settings.json`, and its record.
   A client that is not installed is listed as such; one whose settings already send telemetry elsewhere, one whose files
   cannot be written, and Claude Code when its settings file cannot be read or does not parse are skipped and listed; with no client set up the install undoes steps 2–5 and goes on without the local mode — step 6 registers the
   job, the settings hold no `local`, and the summary says the local mode is not turned on; on a machine already local
   it fails and undoes what it created.
6. Registers the daily job of the OS at `--at` (03:00 by default) — a launchd agent on macOS, a systemd user timer on Linux,
   a scheduled task on Windows — that runs `<node> <CLI entry> analytics sync run --scheduled`, and prints a summary.

### What then runs by itself

| When | What runs | What it does |
|---|---|---|
| every hook event of a client | `codemie hook --agent <client>` — one short Node process | Applies the developer's folder filters and `--include-external`; starts the local proxy when it is not running; posts the event to the proxy's `/v1/analytics/hooks`. No sign-in, no network beyond `127.0.0.1`. |
| while Claude Code runs | Claude Code's own exporter | Posts its logs, metrics and traces to the proxy's `/v1/analytics/otlp/v1/{logs,metrics,traces}`. |
| every 15 minutes | the proxy's sweep | Moves each session past its grace from `~/.codemie/analytics/spool/` into `~/.codemie/analytics/sessions/`. |
| daily at `--at` | `codemie analytics sync run --scheduled` | Per target: takes the window (the lookback, or since the last successful delivery when that is longer); gzips the lines of the sessions written to inside it, into files no larger than 70 MB; webhook — one POST per file with the file as a base64 attachment, which the lead's flow writes to SharePoint; git — a shallow clone in `~/.codemie/analytics-sync-repo`, the files at `<git-path>/<email>/<file>`, one commit under the developer's email, one push with the developer's own credentials. The delivery mark moves only after the target accepted every file of a run whose log line carries no `the marker stays` warning. A part of the run that cannot be built — the analytics folder cannot be read, the JSON report cannot be built, a session's file cannot be read — does not hold the rest back: the run delivers the rest with a warning in its log line and leaves the mark; with nothing left to deliver it fails with `fail export`. A session with a single line whose gzip alone is above 70 MB is left out whole and named in the log line, and the mark moves. Log: `~/.codemie/logs/analytics-sync.log`. |

### Other commands a developer may run

| Command | In the local mode |
|---|---|
| `codemie analytics sync status` | The job, the run time, the window, the targets, the last run and delivery, and a line naming the local mode. |
| `codemie analytics sync run` | The same run as the job's, now. |
| `codemie proxy doctor` | The proxy, the clients, the stored sessions, the job and its Node and CLI paths, the last delivery per target — each problem with a hint. |
| `codemie proxy analytics exclude` / `include` / `disable` / `enable` | The developer's own filters; they work with no login. |
| `codemie proxy stop` | Stops the proxy; the next client event starts it again. |
| `codemie proxy start` / `restart` | Start the local proxy (or say it is running), stop it and start it again; `--port` is honoured when `proxy start` starts the proxy, one already running stays on its port and is named with its URL; a `--profile` is refused. |
| `codemie proxy connect` / `disconnect` | Refuse, and name `codemie analytics sync uninstall`. |
| `codemie analytics sync uninstall` | Removes the clients' CodeMie hooks and telemetry settings wherever they are in place, stops the proxy, removes the local spool, the job and the settings, the exclusion marks last; leaves `~/.codemie/analytics/sessions/`. With no profile and no proxy with an upstream it does the same over settings that no longer say `local` when a trace of the mode is there. A step that fails stops it with the settings of the local mode in place; the hooks it had already removed stay removed until it is run again. |

## The local proxy: start, restart, stop

- **What it is.** One background Node process of the CLI per machine, listening on `127.0.0.1` alone. It answers the hooks
  endpoint, the three telemetry endpoints and `/health`, each but the last behind its key; every other request gets 404.
  It has no upstream, reads no credentials and sends nothing.
- **First start.** `sync install`, step 4.
- **No service of the OS.** Nothing starts the proxy at logon. After a reboot, a logout or a crash it is down until the
  next hook event of a client: the hook finds no live proxy, takes a machine-wide lock (waits 12 seconds at most), starts
  the proxy, waits up to 5 seconds for it, then posts its event. Claude Code's telemetry sent while the proxy is down is
  lost; hook events are not sent until it is up.
- **Self-check.** Inside the process a watcher asks `/health` every 30 seconds and restarts the listener in place, three
  times at most.
- **After a CLI update.** The running proxy keeps the old version until a hook of the new CLI sees it: that hook stops it
  and starts the new one. On Claude Code's prompt and post-compact hooks the old one is left for that event and replaced on
  the next.
- **The port.** 4001, or a free one when 4001 is taken at the first bind. On a new port the endpoint in Claude Code's
  settings is rewritten; a Claude Code session already running keeps the old one until it is restarted, and its telemetry is
  lost meanwhile. Hooks are not affected: they read the port on every call.
- **By hand.** `codemie proxy start` brings it up without waiting for an event; `codemie proxy restart` replaces it.
- **Stop.** `codemie proxy stop` (the next event starts it again) and `sync uninstall` (for good). A stop does not flush: a
  session in the spool is moved by the next sweep after the next start.
- **Two CLI versions on one machine.** A hook of an earlier CLI does not know the local mode. Claude Code's gathers nothing.
  A Copilot hook of an earlier CLI — it runs only where the CLI its hooks name was replaced by an earlier version — is
  served by the local proxy while it runs, and `--include-external` is not applied to it.

## Data shapes

```
~/.codemie/analytics-sync.json   + "local": true, "localJob": {"node": "<path>", "entry": "<path>"}
~/.codemie/analytics/sessions/   <sessionId>.hooks.jsonl, <sessionId>.otel_{logs,metrics,traces}.jsonl, <sessionId>.moving
~/.codemie/analytics/spool/      the local proxy's own spool
~/.codemie/analytics/excluded/   <sessionId> — an empty file: the session entered an excluded folder
OTLP resource attribute          codemie.line_id = "<file name>:<first 32 hex digits of the SHA-256 of the spool line>"
hook event line                  one OTLP LogsData: resource service.name=codemie-cli; scope codemie.hooks; one log record,
                                 eventName = the event's type, its fields as attributes
```

## Acceptance criteria

- AC1: Given a machine whose CLI config holds no profile, when the lead's printed `sync install` runs, then the sync
  settings hold `local: true`, a proxy with no upstream runs, the hooks of every client found are written, the job is
  registered, and the summary lists the clients written, skipped and not installed; when no client could be written on a machine
  that is not local yet, the install undoes its local steps, registers the job without the local mode and says so in its
  summary; on a machine already local it fails and what it created is undone. (story AC1, AC17)
- AC2: Given a machine with a profile and no local mode, when `sync install` runs, then the local mode stays off, one line
  names the profiles, and the run delivers the JSON report. (story AC12)
- AC3 (negative): Given a machine already in the local mode and a profile added since, when `sync install` runs again, then
  it ends `Install failed: …`, naming the profile and `sync uninstall`, and changes nothing. (story AC13)
- AC4: Given the local mode with `--include-external always` and a Claude Code session started directly, when the session
  has ended and its grace and the next sweep have passed, then its four files are in the folder, every line is OTLP JSON
  whose `codemie.line_id` is its file name and the first 32 hex digits of the SHA-256 of the line as the spool held it, and no request left the machine. (story AC1, AC2, AC5)
- AC5: Given the same for a Copilot CLI or a Copilot Chat session, then its hooks file is in the folder. (story AC1, AC5)
- AC6 (negative): Given `--include-external never` and a client started directly, then the folder holds no file of that
  session. (story AC3)
- AC6b (negative): Given a session that fired a hook in a folder the developer excluded, when it goes on in a tracked
  folder, then nothing more of it reaches the folder, and what of it was still in the spool is not moved. (story AC4)
- AC7: Given a move stopped part-way and repeated, then the folder files equal those of one clean move, and an `event_id`
  appears once in a session's file. (story AC5, AC7)
- AC8: Given the local proxy was killed, when the next hook fires, then the proxy is up and that event is stored. (story AC10)
- AC9: Given a run with at least one session in its window, then each target receives
  `codemie-analytics-<email>-<UTC date>.otlp.jsonl.gz` — or, when one file would be larger than 70 MB, its
  `.part-<k>-of-<n>.otlp.jsonl.gz` files, each no larger — and the `.report.json` after them; unpacked, they are the sessions' lines;
  a second run over the same window carries the same line ids. (story AC6, AC7)
- AC10 (negative): Given a run with no stored session in its window, then no OTLP file is sent; with nothing for the JSON
  report either, nothing is sent and the log says so. (story AC8)
- AC11: Given the local mode, when `proxy doctor` runs, then the sections `auth`, `upstream` and `delivery` are absent, a
  `local` section reports the folder, the job and the last delivery per target, and no hint names `proxy connect` or
  `disconnect`. (story AC11)
- AC12: Given the local mode, when `proxy start` runs with no daemon, then the local proxy is up and no backend launcher
  ran; with one alive, then none is started; when `proxy restart` runs, then the daemon is another process on the same
  port; a `--profile` given to either is refused; when `proxy connect` or `disconnect` runs, then it refuses and names
  `codemie analytics sync uninstall`. (story AC15)
- AC13: Given the local mode, when `sync uninstall` runs, then the hooks are removed, the proxy is stopped, the local spool
  is gone, the job and the settings are gone, the exclusion marks last, and the folder is as it was; when a step of it fails,
  the settings stay; with no profile and no proxy with an upstream the same holds over settings that no longer say `local`
  when a trace of the mode is there. (story AC16)
- AC14: Given `codemie analytics --export json`, then the file is written as before and one deprecation line goes to stderr;
  none from a hook or the scheduled run. (story AC14)
- AC15: Given a machine not in the local mode, then its hooks, proxy, `sync` and `doctor` write, send and print what they
  did before this change, the line of AC2 and the notice of AC14 apart. (story AC12, NG1)
- AC16: Given the docs, then `docs/ANALYTICS-SYNC.md` says what the delivered file holds and does not hold, which clients it
  covers, and what `never` means in the local mode. (story AC19)
- AC17: Given the lead's `sync bootstrap`, then its questions, its flags and the line it prints are what they were before
  this change. (story AC9)
- AC18: Given a machine where `sync install` ran before this change, when the CLI is upgraded, then its job delivers the
  JSON report alone until `sync install` runs again. (story AC13)
- AC19: Given a machine in the local mode and a hook of a CLI of an earlier version, when it fires, then nothing of a
  Claude Code hook is stored and the local proxy goes on running, and a Copilot hook's events are stored without
  `--include-external`; when that CLI's `sync install` runs, then the settings hold no `local` and
  its job delivers the JSON report alone. (story AC18)

## Non-goals

- NG1: Any change of the CodeMie backend or of what a machine not in the local mode sends to it. (story NG1)
- NG2: Codex, Gemini and Pi — the local mode gathers nothing for them, they stay in the JSON report; Claude Desktop Cowork and the
  applications sending model requests through the proxy. (story NG2)
- NG3: What reads the delivered file, and any cost computed from it. (story NG3)
- NG4: A service of the OS for the proxy, a fixed port, a new schedule or flag, a cleanup or a size cap of the folder. (story NG4)
- NG5: Cutting the content, and the protobuf telemetry streams. (story NG5)
- NG6: A size check or pruning for the git target's repository.
- NG7: A warning that `never` collects nothing, and an entry or a removal date for `--export json` in the deprecation table.

## Decisions

- D1: No profile in the CLI config over the traces of a proxy connection as the sign of a local machine: a CodeMie user who
  never connected the proxy has no trace, and the local mode's own hooks would read as one.
- One mode per machine over both at once: two spools and two proxies for a case nobody asked for.
- The lead's existing command over a new flag: it already decides the targets, the time, the window and the sessions.
- D3: The mode chosen once per process, the code below receiving that mode's implementation, over "if local" branches.
  The modes are told apart at the entry of the command. Nothing below branches on this process's mode. A check of another process's
  state is no such branch: the backend cold start does not adopt a local-mode daemon
  (`src/cli/commands/proxy/otlp-cold-start.ts`), as it reads that daemon's version.
- The CLI's own proxy receiving and not sending over a third-party OpenTelemetry Collector on every machine.
- A finished session moved into a folder over keeping the spool: the spool's lifetime is minutes, the run is daily.
- Hook events as OTLP log records over the spool's envelope: one format in the folder and in the file.
- A line id over each session sent once: the lead's window overlaps runs, and the id lets a reader keep one copy.
- A gzip stream of whole lines per file over a tar or a zip: each file is read by itself, nothing to unpack into files.
- `.jsonl` for all four files over the spool's names: the name is part of every line id and is kept for good.
- No cleanup of the folder over a retention: the sessions store under `~/.codemie` is not cleaned by itself either.
- D2: `--include-external` as the lead set it over collecting everything in the local mode.
- A session stopped at its first hook in an excluded folder over gathered whole: the filters are the developer's only
  protection in the local mode, and a `cd` would undo them.
- No project rule in the local mode over a project name from the folder or git: every event carries the remote.
- D10: No classification or consent in the local mode over a consent asked at install: the lead's command runs with no question.
- D11: A notice on stderr over a deprecation-table entry for `--export json`: no replacement and no date are set.
- D13: `proxy start` and `restart` acting on the local proxy over a refusal that names `sync uninstall`: a developer whose
  proxy is down is not told to remove the analytics.
- D12: A hook of an earlier CLI left as it works over a field in the hook's request that tells the versions apart: a wire
  contract between the hook and the proxy for a CLI replaced by an earlier version.
- D9: `sync uninstall` removing CodeMie's own entries of a client wherever they are in place over only what the install
  wrote: the install rewrites the entries of a client set up before it, and entries left behind would point at a proxy
  that no longer runs; nothing a user or another tool wrote is removed.
- D14: Files no larger than 70 MB, cut at a line, over one file per run: the delivery hook of a project sends nothing
  above its own limit, and a run that failed on the size failed the same way on every later run. A part of the
  run that cannot be built — the analytics folder cannot be read, the JSON report cannot be built, a session's file
  cannot be read — does not hold the rest back: the run delivers the rest with a warning in its log line and leaves the
  marker, and with nothing left to deliver it fails with `fail export`. A session with a single line whose gzip alone is
  above 70 MB can be built by no run: it is left out whole, named in the log line, and does not hold the marker. A
  target's marker moves only after it accepted every file of a run whose log line carries no `the marker stays` warning.
- D16: The hints of `proxy doctor` and of the clients' list name `codemie analytics sync install` where another machine is
  told `proxy connect` or `disconnect`: it is the one command that writes the clients' settings there and never refuses
  in the mode, and it is named for a routed VS Code extension or a project list too, which have no command of their own.
- D17: Sync settings that no longer load are taken as no local mode: Claude Code's hooks gather nothing, while a hook of
  Copilot CLI or Copilot Chat is still stored by the running local proxy and its session moved into the folder, under the
  developer's own folder filters and without the lead's `--include-external`; `sync status` and `sync uninstall` stop on
  the file until it is mended or `sync install` runs again (`--force` with a job name of its own).
- D18: A hook of a local machine replaces another CodeMie proxy it finds running with the local one: a machine is in one
  mode, the commands of the local mode start no other proxy there, and one left running would take the hook events to a
  backend. The mode is for a machine with no CodeMie backend, where no client is started through CodeMie: a client started
  through a CodeMie launcher with a project's own profile is outside the mode, and the launcher starts that profile's proxy.
- D19: The exclusion marks, and a session whose move into the folder was interrupted in a way the proxy cannot continue,
  are never cleaned by themselves — the session stays undelivered — and `sync uninstall` clears both: repeating such a
  move would write the session's lines into the folder file a second time.
- D20: The JSON report and the OTLP files beside it, rather than the OTLP files alone — a machine in the local mode delivers
  the report built as on any other machine: what a team received before the mode it goes on receiving, Codex, Gemini and Pi included,
  while the receiving side moves to the OTLP files; the report is deprecated, not removed.
- D21: A session's file holding that session's records alone over the export as it came: a telemetry export is divided
  by the session each record names — a log record by its `session.id`, else its `session_id`, a span and a metric data
  point by their `session.id` — each session's records going to its own file with the resource and scope around them,
  and a record that names no session, or no valid one, staying with the session the export goes to. A Claude Code
  process that changes its session id sends one request with records of both sessions, and a reader that goes by the
  file would count the end of one session to the next.

## Limitations

- **Clients.** The OTLP files hold Claude Code, Copilot CLI and Copilot Chat. Codex, Gemini and Pi are not in them; they
  reach the lead in the JSON report, which a machine in the local mode delivers beside the OTLP files.
- **The default gathers nothing.** With `--include-external never` the local mode gathers nothing. No command warns of it.
- **From the install on.** Sessions that ended before `sync install` are not gathered; the JSON report holds them, from the logs.
- **A session is delivered late.** It reaches the folder 15 minutes after its end, or 60 after its last write — always 60
  for Copilot Chat — at the next 15-minute sweep, and the file at the next daily run. A session open for days is absent
  until then.
- **Telemetry can be lost.** Between the proxy's stop and the next hook event; and for a running Claude Code session after
  the port changed. A client whose settings already send telemetry elsewhere is not set up at all. Telemetry in the
  protobuf protocol is not delivered.
- **Copilot can be blocked.** When a hook cannot start the proxy, Copilot CLI refuses the prompt or the tool call, and
  Copilot Chat also the session start, as with a CodeMie backend today. Claude Code is never blocked.
- **Size.** Measured on one machine over about a day: 62,909,648 bytes of lines, 3,489,676 gzipped. A run carries the whole
  window, cut into files of 70,000,000 bytes at most; a session larger than that is cut at a line. A session with a single
  line whose gzip alone is above it is left out whole, its lines that would fit included, and named in the run's log
  line; the other sessions are delivered and the marker moves. A session whose file cannot be read is left out of that
  run; the marker stays and the next run tries it again. The folder on the developer's disk is never cleaned.
- **The git target.** One file per developer per day, or its parts when it is cut, never pruned; a second run on the same
  day whose files are cut differently leaves the earlier files beside the new ones, and the reader keeps one copy of a
  line by its id. Every developer's working copy holds the team's files.
- **What the file holds.** Emails, file and transcript paths, the branch and the repository, shell commands and tool
  parameters, the first 200 characters of a prompt; only secrets are masked. On a machine with no CodeMie setup it holds
  no `user.email`, no project name and none of the values a backend gets as request headers (organization, subscription
  class). A hook event still carries `developer_name` — the machine's git identity, as the backend gets it; a file is
  tied to its developer by the email in its name.
- **Filters.** A session that fires a hook in an excluded folder is dropped from then on and never gathered again, a
  resume in a tracked folder included; what of it was already moved into the folder stays. A Claude Code settings file that cannot be read or does not parse, a project filter in it that is not a list of absolute paths, or a hook that names no folder while that filter is not empty is not a filter: that hook is not collected, no mark is left, and the session goes on once the file reads again. Telemetry carries no folder: of
  a session never excluded it travels whole.
- **One mode per machine.** A machine in the local mode cannot connect the CodeMie proxy until `sync uninstall`.
- **The job.** It runs when the machine is on: a run missed while asleep is caught up at the next wake; after a power-off
  it is caught up on Linux and Windows (there only while the user is logged on), and on macOS that is not verified. It runs the Node and the CLI found at install; after a Node switch or a CLI reinstall elsewhere it
  fails until `sync install` is run again, and `proxy doctor` says so.
- **Claude Code's hooks** run the `codemie` first on `PATH` at install; with a CLI of an earlier version there they gather
  nothing. Copilot's hooks name the CLI by its path: where that CLI was replaced by an earlier version they are gathered
  without `--include-external`.
- **A session first seen mid-life** is read from the start of its transcript: its earlier usage is written once.
