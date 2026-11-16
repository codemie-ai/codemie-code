# Spec: `codemie analytics sync bootstrap` (EPMCDME-16487)

## Intent

A team lead runs one CLI command to connect a Teams channel and a SharePoint folder to a Power Automate flow. The command then prints one `codemie analytics sync install …` line for the lead's developers. This duplicates the standalone collector's `setup.js` wizard for external clients, who cannot reach the collector. The collector itself is left as is. Bootstrap installs nothing on the lead's machine.

## Behavior

**Command surface.** Register `bootstrap` in `createSyncCommand()` (`src/cli/commands/analytics/index.ts:74-87`) beside install/status/run/uninstall. Import its runner lazily, like the others (`:89-90`). The help description is exactly: "Lead: connect a Teams channel and SharePoint folder, then print the install command for your team (installs nothing on this machine)". It has three options: `--webhook <url>`, `--lookback-days <n>` and `--include-external <policy>`. These options belong to `bootstrap` through the existing `enablePositionalOptions` scoping (D14, `index.ts:36,79`). The runner follows the runner/deps convention (`install.ts:1-20,232`). It returns an exit code, never throws and never calls `process.exit`.

**Guided mode** (TTY, no `--webhook`). There are eight numbered steps, each headed "Step N of 8 · <title>". The heading is printed once per step, not on a retry. The steps are:
1. Teams channel: parse a "Get link to channel" link.
2. SharePoint folder: parse the browser address, or enter site and path manually.
3. Time zone: a Windows ID, default `UTC`.
4. Import the flow: write the package, print instructions, offer to open the browser, wait for confirmation.
5. Trigger URL: check it with the trigger-URL rule (below), then offer a test send with Try again / Enter a different URL / Skip.
6. External sessions: windows (recommended), always or never.
7. Lookback: the CLI default (follows updates) or a fixed 1-30.
8. Developers: print the command.

The parsing rules, messages, import instructions, time-zone list and resume logic follow the collector as recorded in technical-analysis.md §8 (`links.js`, `timezones.js`, `wizard.js`, `wizard-support.js`).

**Start logic.** If a saved state with a webhook exists, show a summary with the webhook masked and offer reuse. Reuse re-checks the saved webhook with the trigger-URL rule. If it passes, the wizard jumps to step 8. If it fails, the saved webhook is discarded and the wizard goes to step 5. Without reuse, ask "already imported the flow?" A yes jumps to step 5. State is saved after every step, so an interrupted run resumes with the earlier answers as defaults. A state file that cannot be read, is not JSON or has the wrong shape is treated as absent: print one notice naming its path and start fresh.

**Trigger-URL rule.** One `validateTriggerUrl` sits beside the other sync validators. Step 5, `--webhook` and reuse all call it. It parses the input with `new URL`. It then requires https and a `sig` query param, and rejects any whitespace or line break in the input. Every check after that runs on the normalised `href`, which is also the value that is saved and printed. The `href` must also pass the builder's printable-value rule. Errors name `--webhook` only in non-interactive mode. In guided mode they say what to copy and ask again.

**Printable-value rule.** `buildInstallCommand` (`sync/install-command.ts:46`) owns it, and it applies to every value, git values included. A value fails it if it contains any of these:
- `"`, `$`, a backtick or `!`
- a control character
- a non-ASCII character, which covers typographic quotes such as U+2018-U+201F
- a `%` that does not start a `%XX` hex escape

A failing value raises a `SyncConfigError` naming the flag. Every value that passes is wrapped in double quotes. The builder's "safe to pass to a shell as-is" header then holds for all of its inputs.

**Flow package.** Write `codemie-analytics-flow.zip` into the current folder. Its source is a byte-identical copy of the collector's 5-file `flow/template/`. Only `Flow_config.inputs` is set, to `{siteUrl, folderPath, teamId, channelId, timeZone}`, on the parsed JSON. The package never holds a webhook URL. An existing file is overwritten, and the output says so.

**Non-interactive mode** (`--webhook`). Ask no questions. Validate every option first. Test-send a `setup-check-<stamp>.json` through `sendWebhook` (`sync/targets/webhook-target.ts:39-83`). On a 2xx response print the install command and exit 0. On any failure print no command and exit non-zero. This mode neither reads nor writes the lead state file. It works without a TTY. Without a TTY and without `--webhook`, fail at once and name both remedies.

**Install command.** Print webhook, `--include-external <policy>` (always present) and `--lookback-days` only when a fixed value was chosen. Never print `--at`. The command comes from `buildInstallCommand`, switched to double quotes. After the command, the output adds one line with no version number. It tells developers who get "unknown command" to update CodeMie CLI with `codemie self-update`.

## Interfaces

Lead state: `getCodemiePath('analytics-sync-bootstrap.json')`, mode 0o600 plus chmod, as in `config-store.ts:376`. A saved `lookbackDays: 'default'` stands for the CLI default.

```ts
interface BootstrapState {
  version: 1;
  channelLink?: string; teamId?: string; channelId?: string; channelName?: string;
  siteUrl?: string; folderPath?: string; timeZone?: string;
  flowImported?: boolean; webhookUrl?: string;
  includeExternal?: IncludeExternalPolicy;
  lookbackDays?: number | 'default';
}
```

## Acceptance criteria

1. `codemie analytics sync --help` lists `bootstrap` with the exact description above.
2. `sync bootstrap --webhook <url> --include-external always` applies the policy to bootstrap and the printed command. No "unexpected argument" error occurs.
3. Guided mode runs the 8 steps in order, each headed "Step N of 8".
4. Teams step: a valid channel link yields team and channel, and the lead confirms by channel name. A non-channel link (including `/l/message/`) is rejected with what to copy instead and asked again.
5. SharePoint step: the browser address yields site and folder, and the lead confirms. "manual" or a declined confirm asks for site and path separately. A non-SharePoint address, a sharing link or an empty path is rejected and asked again.
6. Time-zone step: a Windows ID (default UTC) is accepted. An unknown ID is rejected and asked again.
7. Import step: the zip is written to the current folder, pre-filled, with no webhook URL. Import instructions are printed, opening Power Automate is offered, and the step waits for confirmation.
8. Trigger step: the URL must pass the same trigger-URL rule as AC 17. The test send reports where the file and Teams reply appear. A failure shows the reason, plus the "flow on / Anyone / whole URL" hint for 4xx, and offers retry, a different URL or skip.
9. Steps 6-7 offer the three policies with explanations (windows is the default), and the default lookback or a fixed 1-30.
10. Step 8 prints one install command: webhook, `--include-external`, `--lookback-days` only if fixed, and no `--at`. One update hint line follows it, naming `codemie self-update` and no version.
11. "Already imported" skips steps 1-4.
12. Re-run: the saved settings are shown with the webhook masked. Reuse re-checks the saved webhook and jumps to step 8, or goes to step 5 if the check fails. An interrupted run resumes with the saved defaults. A malformed state file is treated as absent, with a notice. The state file is mode 0o600.
13. `--webhook` mode: no prompts, test-send, then the command on success. It works without a TTY. It neither reads nor writes the lead state file.
14. The printed command runs unchanged in bash/zsh, PowerShell (through the `codemie.ps1` shim) and cmd, and the query string survives on each. `docs/COMMANDS.md` documents one caveat. Where script execution is blocked, PowerShell runs `codemie.cmd` instead, and that path can split the URL at `&`.
15. No TTY and no `--webhook`: immediate failure explaining both options.
16. `--webhook` test send rejected or unreachable (4xx/5xx, DNS, network): no command, a cause-specific error, non-zero exit.
17. Fails before any send, with a message naming the option, when:
    - the webhook is not https or not a valid URL;
    - the webhook has no `sig`;
    - the webhook contains whitespace or a line break;
    - the normalised webhook breaks the printable-value rule;
    - the lookback is outside 1-30;
    - the policy is unknown.
18. The webhook signature is never shown, logged or put in an error message; every display of it is masked. Only two places hold it: the printed install command and the 0o600 lead state file.
19. `docs/COMMANDS.md` documents `bootstrap`, both modes and the lead-to-developer flow. It also states that the printed line contains the trigger secret and must not go to shared logs.

## Non-goals

- Developer-side `install`, `run`, `status`, `uninstall`, and webhook delivery itself (sibling story).
- The collector's developer zip archive for external clients.
- Any change to the Power Automate flow template; it ships as it is.
- Changes to, or keeping in sync with, the codemie-onboarding collector.
- Reading or importing the collector's `analytics-setup.json`.
- Stating a minimum CLI version in bootstrap output (deliberate deviation from the ticket). A generic update hint without a version is printed.
- Keeping the signature out of every saved file (deliberate deviation from the ticket). The 0o600 lead state file holds it so that reuse works.
- Tightening `install`'s own `--webhook` validation (the trigger-URL rule is bootstrap-only; the printable-value rule lives in the shared builder, which `install` does not call).
- More than one team per lead machine; the lead state is a single slot.

## Decisions

- Double quotes on every value in the shared `buildInstallCommand` (git-repo commands change too, pinned test updated) over POSIX single quotes. Answers how one command survives bash, PowerShell and cmd. — user
- Rejecting webhooks containing `"`, `$`, a backtick or `!` over escaping them. Answers how to keep double quoting safe on every shell. — user
- Dropping the ticket's minimum-CLI-version AC over printing a version. Bootstrap and the sibling sync commands ship in one PR. — user
- A new state file `~/.codemie/analytics-sync-bootstrap.json` over sharing the collector's `analytics-setup.json`. Answers where lead answers live, and whether collector answers are reused (they are not). — user
- Adding the `fflate` dependency over porting the collector's zip writer. Answers how to build the flow package. — user
- `fflate` over `yazl` for the zip dependency. It has zero dependencies, is pure JS with a synchronous `zipSync` that suits 5 small files, ships its own types and is actively maintained. `yazl` is stream-based and pulls in `buffer-crc32`.
- Requiring https plus a `sig` query param in both bootstrap modes over https only. Answers what counts as a Power Automate trigger URL. — user
- Always printing `--include-external`, even for `windows`, over printing it only when non-default. Answers how the command carries the policy. — user
- Overwriting an existing `codemie-analytics-flow.zip` with a notice over refusing or prompting. Answers what happens on a re-run in the same folder. — user
- Shipping the template as JSON assets under `src/` copied to `dist/` over inlining it as a TS module. Answers how D13's template copy ships; the exact copy route is the plan's call. — user
- The builder owning the printable-value rule for every value over a denylist on bootstrap's raw `--webhook` only. Answers where the rule that makes a printed value safe lives. — user, answers AR-1
- One `validateTriggerUrl` on the normalised `href`, applied in step 5, in `--webhook` mode and on reuse, over separate checks per entry point. Answers how a trigger URL is checked wherever it enters. — user, answers AR-1
- Rejecting typographic quotes, whitespace and line breaks, and any `%` that is not a `%XX` escape, over accepting them. Answers how the rule covers PowerShell smart quotes and cmd `%name%` expansion. — user, answers AR-2
- Documenting the `codemie.cmd` / blocked-PowerShell caveat over printing an extra PowerShell-specific command form. Answers how AC 14 treats the npm `.cmd` shim. — user, answers AR-2
- Storing the full webhook in the 0o600 lead state file over storing only a masked form and dropping reuse. Answers whether reuse can print a working command. — user, answers AR-3
- `--webhook` mode neither reading nor writing the lead state over saving its answers on success. Answers whether a headless run can change a lead's saved wizard answers.
- Printing a generic `codemie self-update` hint without a version over printing nothing. Answers what a developer with an older CLI is told. — user, answers AR-5

## Constraints and left to the builder

- Every printed URL other than the install command goes through `redactSecrets`/`webhookHost` (`sync/redact.ts:20`, `sync/format.ts:24`).
- Make `validateWebhookUrl`, `validateIncludeExternal` and `validateLookbackDays` (`config-store.ts:41,222,236`) public, or wrap them. Do not change `install`'s behavior. `validateWebhookUrl` returns the raw string (`:57`), so `validateTriggerUrl` works on `new URL(raw).href`.
- The 4xx hint keys off `SyncDeliveryError.status` (`src/utils/errors.ts:94`), not message text.
- Tests change where wiring and output change: the help list in `analytics-sync-cli.test.ts:89-128` and the quoting in `install-command.test.ts:11,17`. New tests follow the deps-injection pattern.
- Plan notes from the review are left to the planner:
  - Module cut under `sync/bootstrap/`: links, timezones, flow-package (the only `fflate` importer), state-store, steps (the source of "of N"), and the runner.
  - One `toInstallCommandOptions(state)`, used by step 8 and by reuse.
  - One shared 0o600 `writePrivateJson`, used for both files that hold the webhook.
  - An interactive test-send timeout of about 30 s, with a "Sending test file…" line; save the URL before the send.
  - Print the install command alone on stdout and everything else on stderr. In `--webhook` mode, also print the check and cleanup lines.
  - Ship the template like `scripts/copy-plugins.js:64` and resolve it before step 1.
  - Build the zip with `zipSync` `level: 0` (stored entries, as the collector does).
  - If the browser opener fails, print the URL instead.
  - A round-trip test of the builder against `createSyncInstallCommand()`, only when tests are requested.

## Open risks

- cmd.exe expands `%name%` inside double quotes if an environment variable of that name exists. The printable-value rule rejects a `%` that does not start a `%XX` escape. Valid escape runs such as `%2Ftriggers%2F` can still read as a variable name in cmd, so a collision stays unlikely but possible.
- PowerShell passes a space-free argument to the `codemie.cmd` shim without its quotes. Where script execution is blocked, that path can split the URL at `&`. This is documented in COMMANDS.md, not prevented, and has not been run on Windows.
- Unverified: does every current Power Automate trigger URL form, including `*.environment.api.powerplatform.com`, carry `sig` and pass the printable-value rule?
- On Windows the 0o600 lead state file rests on the user-profile ACL; `chmod` does not set an ACL there.
