# Technical Research

**Task**: analytics sync bootstrap power-automate wizard
**Generated**: 2026-11-04
**Research path**: filesystem

---

## 1. Original Context

Analytics sync bootstrap: lead-side Power Automate setup wizard

## Story
**As a** team lead rolling CodeMie out to developers, **I want** the CLI to walk me through connecting our Teams channel and SharePoint folder and then give me one install command for my developers, **so that** I can set up our team's analytics reporting without downloading or cloning the standalone collector.

## Background
Setting up a team's reporting needs a Power Automate flow that files each developer's daily report into SharePoint and posts in Teams. Today only the standalone collector's wizard builds that flow package and the matching developer command, and the collector is distributed through a repository external clients cannot reach. Moving the wizard into the CLI's `bootstrap` command gives leads the same guided setup with the tool they already have.

## Acceptance Criteria
### Command surface
- Given the CLI is installed, when a user runs `codemie analytics sync --help`, then `bootstrap` is listed with a description that says who runs it and what it changes: "Lead: connect a Teams channel and SharePoint folder, then print the install command for your team (installs nothing on this machine)".
- Given `codemie analytics` has its own `--include-external` switch, when a lead runs `codemie analytics sync bootstrap --webhook <url> --include-external always`, then the policy applies to bootstrap and the printed install command, and no "unexpected argument" error occurs.
### Bootstrap (lead)
- Given a lead in a terminal, when they run `codemie analytics sync bootstrap`, then a guided setup walks them through numbered steps in this order: Teams channel, SharePoint folder, time zone, importing the flow, trigger URL with a test send, external sessions, lookback, and the developer command. Each step shows its position ("Step 2 of 8").
- Given the Teams channel step, when the lead pastes the channel link (from "Get link to channel"), then the CLI reads the team and channel from it and asks the lead to confirm the channel by its name. A link that is not a Teams channel link is rejected with a message saying what to copy instead, and the question is asked again.
- Given the SharePoint folder step, when the lead pastes the folder's browser address, then the CLI derives the site and the folder path and asks for confirmation. Typing "manual", or declining the derived values, asks for the site address and folder path separately. A non-SharePoint address or an empty folder path is rejected and asked again.
- Given the time zone step, when the lead enters a Windows time zone name (default UTC), then it is used for the timestamps the flow posts in Teams. An unknown name is rejected and asked again.
- Given the channel, folder and time zone, when the import step runs, then the CLI writes a Power Automate flow package into the current folder, ready for "Import Package (Legacy)" and pre-filled with the channel, folder and time zone. The package contains no webhook URL. The CLI prints step-by-step import instructions, offers to open Power Automate in the browser, and waits until the lead confirms the flow is on and its trigger URL is copied.
- Given the trigger URL step, when the lead pastes the flow's trigger URL, then the CLI validates it as a Power Automate https trigger URL and offers to test-send a small file. On success it tells the lead where the file and the Teams reply should appear. On failure it shows the reason (for HTTP 4xx, a hint to check that the flow is on, that its trigger allows "Anyone", and that the whole URL was copied) and offers to retry, enter a different URL, or skip the test.
- Given the external sessions and lookback steps, when the lead answers, then they pick the include-external policy (windows, the recommended default, always, or never), each option explained, and either the CLI's default lookback (7 days today, which follows CLI updates) or a fixed 1-30 days.
- Given all answers, when the final step runs, then the CLI prints one `codemie analytics sync install …` command carrying the webhook, the include-external policy and, if fixed, the lookback. The command does not fix a run time.
- Given a lead who already has a flow, when bootstrap starts and they say the flow is already imported, then the channel, folder, time zone and import steps are skipped and the wizard continues at the trigger URL.
- Given a lead who ran bootstrap before, when they run it again, then it shows the saved settings (webhook masked) and offers to reuse them and go straight to the developer command. An interrupted run resumes with the earlier answers as defaults. The saved answers are readable only by the current user.
- Given a lead who passes `--webhook <url>` (with optional `--lookback-days <1-30>` and `--include-external windows|always|never`), when bootstrap runs, then no questions are asked: it test-sends to the webhook and, once accepted, prints the install command. This path also works without a terminal.
- Given the printed command, when a developer pastes it into a macOS or Linux shell, Windows PowerShell or cmd, then it runs unchanged; the webhook URL's query string survives quoting on every shell.
- Given the printed command, when the lead reads the output, then it also states the minimum CodeMie CLI version that supports the command and how a developer updates to it.
- Given bootstrap runs without a terminal and without `--webhook`, when it starts, then it fails at once, explaining that it either needs a terminal for its questions or `--webhook` to skip them.
- Given the `--webhook` path and a test send that is rejected or unreachable (HTTP 4xx/5xx, DNS or network error), when bootstrap runs, then no command is printed, the error explains the likely cause, and the exit code is non-zero.
- Given a webhook that is not https or not a valid URL, or a lookback outside 1-30, or an unknown include-external policy passed as an option, when bootstrap runs, then it fails before sending anything, with a message naming the bad option.
- Given any bootstrap output, error or saved file other than the printed install command, when it is shown or written, then the webhook signature does not appear in it.
### Documentation
- Given the CLI command reference, when this ships, then it documents `bootstrap`, both of its modes (guided and `--webhook`), and the lead-to-developer flow.

## Out of Scope
- The developer-side `install`, `run`, `status` and `uninstall`, and webhook delivery itself (sibling story scheduler).
- The collector's developer zip archive for external clients; developers always install through the CLI command.
- Changes to the Power Automate flow itself; bootstrap ships the collector's current flow template as it is.
- Changes to the codemie-onboarding collector or keeping it in sync with the CLI.

## Context and Decisions
- Today a lead connects a team with the standalone collector's client setup wizard (`setup.js`): asks Teams channel, SharePoint folder, time zone, writes a Power Automate flow package to import, takes trigger URL, test-sends, asks include-external policy and lookback, prints developer command. Answers saved and reused.
- D3: install command fixes webhook (required), lookback days and include-external policy. Run time defaults to 03:00 local; developer overrides with `--at`.
- D5: whole client setup wizard inside `bootstrap`; only developer zip archive stays out.
- D6: command group `codemie analytics sync bootstrap|install|status|run|uninstall`; this story delivers `bootstrap`.
- D11: name is `bootstrap`; help must say who runs each subcommand.
- D12: with `--webhook` it skips the wizard, test-sends and prints the command.
- D13: a copy of the collector's current Power Automate template ships inside the CLI, not kept in sync afterwards.
- D14: an option typed after a `sync` subcommand belongs to that subcommand, even where `analytics` has an option with the same name.

---

## 2. Codebase Findings

### Existing Implementations

**Purpose A: register `bootstrap` in the `sync` group, options scoped to it (D6, D14).**
- `createSyncCommand()` — `src/cli/commands/analytics/index.ts:74-87`. Adds `install|status|run|uninstall`; calls `.enablePositionalOptions()` (`:79`), mirroring `analytics` (`:36`). `analytics` declares a boolean `--include-external` (`:40`); `install` redeclares `--include-external <policy>` (`:104`). Each subcommand dynamic-imports its runner (`await import('./sync/install.js')`) and sets `process.exitCode`. Descriptions start with the role ("Developer: …", `:93,115,142`).
- Regression test of the scoping: `src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts:240-275` (`sync install --include-external windows` reaches `runInstall`, `loadAnalytics` not called).

**Purpose B: validate `--webhook`, `--lookback-days`, `--include-external`.**
- `validateInstallOptions()` — `src/cli/commands/analytics/sync/config-store.ts:262` (exported). Throws `SyncConfigError` naming the flag. Private helpers: `validateWebhookUrl` (`:41`, https only, redacted message; no `sig` check), `validateIncludeExternal` (`:222`, default `windows`), `validateLookbackDays` (`:236`, integer 1-30, absent stays `undefined`). It also requires webhook **or** git and validates `--at`/`--format`. Consumer: `install.ts:prepareSettings`.
- Collector equivalent `validateTriggerUrl` (external, §8) also rejects a URL without `sig=`. Nothing in this repo checks `sig`.

**Purpose C: test-send a small file to the webhook.**
- `sendWebhook(url, report: SyncReport, fetchImpl?)` / `WebhookTarget` — `src/cli/commands/analytics/sync/targets/webhook-target.ts:39-83`. Body `{type:'message', attachments:[{contentType:'application/json', name, contentBytes(base64)}]}` (same shape as the collector). `redirect:'error'`, 5 min timeout. Non-2xx → `SyncDeliveryError(message, status)` (`src/utils/errors.ts:94`); fetch rejection (DNS/network) → `SyncDeliveryError(errorMessage(err))`, redacted. Consumer: `run-sync.ts:251`. `SyncReport = {fileName, bytes: Buffer}` (`sync/types.ts:5`).

**Purpose D: build the developer `install` command line.**
- `buildInstallCommand()` — `src/cli/commands/analytics/sync/install-command.ts:46`. Header says it is not wired yet and that `bootstrap` (EPMCDME-16487) reuses it (`:3`). Rules: emits every flag given, including `--include-external windows` (the default). Each value is wrapped in POSIX single quotes (`'` → `'\''`). Needs webhook or gitRepo. Only consumer: `__tests__/install-command.test.ts`.

**Purpose E: keep the webhook signature out of output and files.**
- `redactSecrets()` / `errorMessage()` — `sync/redact.ts:20,32` (`sig=…` → `sig=REDACTED`, URL userinfo masked). `webhookHost()` — `sync/format.ts:24` (prints host only). Used by install, status, run-sync, webhook-target.

**Purpose F: save answers readable only by the current user.**
- `writeSyncSettings()` — `config-store.ts:376`: writes mode `0o600`, then `chmod` (`SETTINGS_FILE_MODE`, `:24`). The path is `getCodemiePath('analytics-sync.json')` (`:34`). This is the developer's settings file, which `uninstall` deletes. Nothing in this repo stores wizard answers. A grep for `analytics-setup` in `src` finds nothing.

**Purpose G: open Power Automate in the browser.**
- `openUrlInBrowser(url)` — `src/utils/browser.ts:8` (`open` package, `wait:false`). Used by `sso.auth.ts` and `mcp-oauth-provider.ts`.

**Purpose H: terminal prompts and TTY detection.**
- `inquirer` ^9 is dynamic-imported in `install.ts:createRealInstallDeps().promptEmail`. There are 16 `list`/`confirm`/`password` prompt uses across `src/cli/commands`. The TTY check is `deps.isTTY = Boolean(process.stdin.isTTY)` (`install.ts:256`). No "Step N of M" heading helper exists in `src` (grep found none).

**Purpose I: Teams link, SharePoint URL, Windows time-zone parsing; flow template; zip writing.**
- None found in this repo. Searched `src` for `Standard Time`, `power.automate`, `powerautomate`, `sharepoint`, `setup.js`, `Flow_config`. The only mention is prose in `docs/ANALYTICS-REPORT.md:504` ("Existing downstream Power Automate flows … keep working"). No zip library is a dependency (`package.json:119-151`: no adm-zip, archiver, jszip, yazl or fflate). The external collector has all of these (§8).

**Purpose J: state the minimum CLI version and how to update.**
- `package.json` version `0.16.2`. `CHANGELOG.md` has no `analytics sync` entry (it is only under `[Unreleased]`/not listed). The version is read at runtime via `package.json` relative to `getDirname(import.meta.url)` (`src/agents/core/AgentCLI.ts:57`) and in `src/cli/commands/version.ts`. The CLI updates itself with `codemie self-update` (`src/cli/commands/self-update.ts:13`). `codemie update` updates agents, not the CLI (`update.ts:240`).

Other touched code: `docs/COMMANDS.md:747-796` (the "Scheduled delivery (`analytics sync`)" section documents install/status/run/uninstall only). `docs/ANALYTICS-REPORT.md` (scheduled delivery detail). `install.ts:52,99,270` refers to the collector clone `~/.codemie/codemie-onboarding`.

### Decisions Already in the Code
- **Dependency injection per runner**: each runner (`runInstall(opts, deps)`) takes a `*Deps` interface plus a `createReal*Deps()` factory. It never throws and never calls `process.exit`; it prints redacted failures and returns an exit code (`install.ts:1-20,232`). This is the convention.
- **Lazy subcommand import** so that loading `analytics` does not pull in sync modules (`index.ts:89-90`). This is the convention.
- **Lookback default not persisted**: `lookbackDays` is stored only when given explicitly, so the default of 7 follows CLI updates (`types.ts:27-30`, `config-store.ts:255`). The collector applies the same rule (§8, `lookback.js`).
- **POSIX-only quoting** in `buildInstallCommand` (`install-command.ts:28-31`). The alternative is double quotes, which the collector uses (`gitbudHandoffCommands`). No reason is recorded for the choice beyond "safe to pass to a shell".
- **Error classes**: `SyncConfigError` (extends `ConfigurationError`) and `SyncDeliveryError` (has a `status` field) in `src/utils/errors.ts:50,94`.
- **Non-TS assets ship** via `package.json:files` (`dist`, `src/workflows/templates/**/*.yml`, `src/utils/tips.json`) or via `scripts/copy-plugins.js`, which copies asset dirs from `src/` to `dist/`. Example: Pi extension `.js` files are copied byte-identical.

### Task Statements Checked Against the Code
- "D6: command group `codemie analytics sync bootstrap|install|status|run|uninstall`": holds for install/status/run/uninstall (`index.ts:81-84`). `bootstrap` is absent.
- "D14: option after a `sync` subcommand belongs to that subcommand": holds. It relies on `enablePositionalOptions` at both levels (`index.ts:36,79`), and an existing test covers it for `install`.
- "webhook delivery itself (sibling story)" is out of scope: holds. `sendWebhook` exists. It keeps `webhook-target.ts` in place as the delivery path; its consumer is `run-sync.ts`.
- "printed command … runs unchanged in POSIX, PowerShell, cmd": contradicted by the current builder's output form. `cmd.exe` does not treat `'` as a quote, so `&` in the query string splits the command (`install-command.ts:28-31`). The builder is kept in place by the "reuses it" comment at `:3`. It has one consumer, its test.
- "D3: install command fixes webhook, lookback, include-external; run time defaults 03:00": holds (`config-store.ts:21`, `index.ts:102-104`). `buildInstallCommand` omits `--at` when it is not given.
- "D13: a copy of the collector's current template ships inside the CLI": no copy exists in this repo. The template exists externally (§8).
- "Context: collector `setup.js` … answers saved and reused": holds externally. State goes to `<codemie-home>/analytics-setup.json`, mode 600 (§8).
- "the collector is distributed through a repository external clients cannot reach": unverified. Nothing in this repo confirms it. The collector's `wizard-support.js` names `DEFAULT_REPO_URL` (gitbud).

### Consumers of Changed Contracts
- `createSyncCommand` / sync `--help`: `analytics-sync-cli.test.ts:89-128` asserts the listed subcommands and their descriptions ("lists install, status, run, uninstall…"). A new subcommand changes what that list returns.
- `buildInstallCommand` output format: consumed only by `__tests__/install-command.test.ts`, which pins exact single-quoted strings (`:11`, `:17`).
- `validateInstallOptions`: consumed by `install.ts` only. Its helpers are module-private.
- `sendWebhook` / `SyncDeliveryError.status`: consumed by `run-sync.ts:251` and by `webhook-target.test.ts`.
- `docs/COMMANDS.md` sync section: no code consumers.

### Architecture and Layers Affected
- CLI layer: `src/cli/commands/analytics/index.ts` (registration) and `src/cli/commands/analytics/sync/*` (runners and helpers).
- Delivery target: `sync/targets/webhook-target.ts`.
- Utilities: `src/utils/browser.ts`, `src/utils/paths.ts` (`getCodemiePath`), `src/utils/errors.ts`.
- Packaging: `package.json:files`, `scripts/copy-plugins.js` (asset shipping).
- Docs: `docs/COMMANDS.md`, `docs/ANALYTICS-REPORT.md`.

### Integration Points
- Power Automate HTTP trigger (outbound HTTPS POST via global `fetch`).
- Browser via the `open` package.
- Terminal via `inquirer`.
- Filesystem: the flow package is written to cwd; state goes under `~/.codemie`.
- No Microsoft Graph or SDK is used. Only the external collector holds the channel and SharePoint parsing.

### Patterns and Conventions
- `@/` imports with `.js` extensions; `SyncConfigError`/`SyncDeliveryError` for errors; every printed URL goes through `redactSecrets`/`webhookHost`.
- The runner/deps split described above, with a `print(line)` seam.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (`architecture`, `development`, `integration`, `security`, `testing`, `usage`, `quality-gates.md`). None covers analytics sync specifically. `docs/COMMANDS.md:747` and `docs/ANALYTICS-REPORT.md` (scheduled delivery) are the domain docs.

### Architectural Decisions
- Predecessor specs: `docs/superpowers/tasks/2026-10-29-analytics-sync-install/spec.md:68` lists the "`bootstrap` wizard" as out of scope. `docs/superpowers/tasks/2026-11-03-analytics-sync-git-target/spec.md:58-59,90` adds the builder "quoting values safely" for later `bootstrap` reuse.
- `index.ts:32-36,68-72` has inline rationale for `enablePositionalOptions` (D14).

### Derived Conventions
Role-prefixed subcommand descriptions. Settings written with 0o600 plus chmod. Defaults not persisted.

---

## 4. Testing Landscape

### Existing Coverage
`sync/__tests__/` holds 14 files: install, install-command, config-store, webhook-target, redact, status, run-sync, uninstall, identity, marker, window, report-builder, git-client, real-deps. Also `targets/__tests__/git-target.test.ts`, `scheduler/__tests__/*`, and `analytics/__tests__/analytics-sync-cli.test.ts` (wiring, which `vi.mock`s each runner module).

### Testing Framework and Patterns
Vitest. Runners are tested with fake `*Deps` objects and `print` capture. `fetchImpl` is injected for the webhook. CLI wiring is tested by parsing with `exitOverride()` and `{from:'user'}`. Tests are written only on explicit request (AGENTS.md).

### Coverage Gaps
No tests exist for link parsing, time zones, the flow-package build, zip output, wizard sequencing, or bootstrap wiring. None of that code exists in this repo. The collector has matching `node --test` suites (`links`, `timezones`, `flow-template`, `zip`, `wizard`, `wizard-support`, `prompt`).

---

## 5. Configuration and Environment

### Environment Variables
No env vars in the CLI's sync code. `loadSyncSettings` deliberately ignores `ANALYTICS_*` (`config-store.ts:330`).

### Configuration Files
`~/.codemie/analytics-sync.json` (developer settings, 0o600). The collector's lead state is `~/.codemie/analytics-setup.json` (external, §8).

### Feature Flags and Deployment Concerns
No flags. The published tarball includes only the `package.json:files` entries and whatever the build copies into `dist/`.

---

## 6. Risk Indicators

- The quoting form of `buildInstallCommand` (`install-command.ts:28`) is POSIX-only. This conflicts with the cmd/PowerShell AC. Its test pins the exact strings. A real trigger URL contains `&`, `%2F` and `sig=`. In cmd, `%name%` sequences can expand even inside double quotes when such a variable exists. See "Task Statements".
- `buildInstallCommand` always emits `--include-external` when it is given, including the default `windows`. The collector printed it only when non-default.
- Webhook validation in this repo does not require `sig=`. The collector's `validateTriggerUrl` does. The validators in `config-store.ts` are module-private.
- `SyncDeliveryError` puts the status into its `status` field and into the message (`Webhook delivery failed with status N`). The 4xx hint branch in the collector matched `HTTP 4\d\d` in its own message format.
- Speculative: shipping the flow template (5 JSON files, about 21 KB) needs a route into `dist/` or `files`. Today only `.yml` templates, `tips.json` and the `copy-plugins.js` dirs ship.
- Speculative: no zip dependency exists. The collector's `zip.js` is a dependency-free stored-entry writer (CRC table, no `zlib.crc32` because Node 20.0 lacks it).
- The collector's state file name `analytics-setup.json` sits in the same `~/.codemie`. Its keys include `distribution` and `webhookUrl`. A CLI file at the same path would read the collector's answers.
- The minimum CLI version is undetermined. `analytics sync` has no CHANGELOG release entry, and `package.json` is `0.16.2`.
- The help-list test (`analytics-sync-cli.test.ts:89`) asserts the current four subcommands.
- The time-zone list (139 Windows IDs from CLDR), the Teams and SharePoint parsers, and the import instructions exist only in the external collector. The repo has no equivalent.

---

## 7. Summary for Complexity Assessment

Bootstrap touches the CLI layer: `src/cli/commands/analytics/index.ts` (one new subcommand next to four existing ones, under the existing `enablePositionalOptions` scoping) and the `sync/` module family. It can lean on existing pieces: `sendWebhook` (Teams-message body shape, redacted `SyncDeliveryError` with status), `validateInstallOptions` helpers (private today), `buildInstallCommand` (written for bootstrap, POSIX quoting only), `redactSecrets`/`webhookHost`, the 0o600 write pattern, `openUrlInBrowser`, and `inquirer`. The docs surface is `docs/COMMANDS.md` §"Scheduled delivery".

Novel to this repo are the Teams channel link parser, SharePoint folder parser, Windows time-zone list, flow-template filling and zip packaging, the eight-step resumable wizard with saved lead state, and cross-shell quoting. None of these exists here and no zip dependency is present. All of them exist in the external collector in plain JS with tests (`wizard.js`, `links.js`, `timezones.js`, `flow-template.js`, `zip.js`, `wizard-support.js`), and its flow template has 5 files. Asset shipping for a JSON template has no current precedent beyond `copy-plugins.js` dirs and `tips.json`.

Tests cover all existing sync modules with the deps-injection pattern. Nothing covers the new concerns. Key risks: cmd/PowerShell quoting versus the existing POSIX builder and its pinned test, the undetermined minimum version, a possible state-file collision with the collector's `analytics-setup.json`, and `sig` validation being absent in the CLI.

---

## 8. External References

Task names collector `setup.js` (codemie-onboarding). The repo holds no copy. It resolved externally at `/home/oleksiiyurchenko/codemie-dev/codemie-onboarding/codemie-analytics-collector/`, which is identical to `~/.codemie/codemie-onboarding/codemie-analytics-collector/` (`diff -rq` shows no differences). The last commit touching the subdir is `98f05c5` (2026-10-09). A filled package `codemie-analytics-flow.zip` (2026-10-30) sits at the onboarding repo root. It is wizard output, not the template.

- `bin/setup.js`: no args. It exits when `!process.stdin.isTTY` ("run this from a terminal"), then calls `runWizard`.
- `src/wizard.js`: `STEPS = ['Teams channel','SharePoint folder','Time zone','Import the flow','Trigger URL','External sessions','Lookback','Developers']`. The heading is `Step ${i+1} of ${n} · ${title}`, printed from the main sequence so a retry does not reprint it. Start logic: saved `webhookUrl` → "Reuse them?" → jump to handoff. Otherwise "Have you already imported the flow and copied its trigger URL?" (default no) → jump to trigger. State is saved after every step. Saved defaults are shown as a label (`saved: "<channelName>"`, `saved URL`), never the URL. The folder step accepts "manual" or a declined confirm, then asks for site and path separately. Test-send menu: Try again / Enter a different URL / Skip the test. The 4xx hint reads: "Check that the flow is turned on, that its trigger allows "Anyone", and that the whole URL was copied." Success text: "Within a minute <file> should be in the SharePoint folder, and this month's card in the Teams channel should have a reply for it. Delete the file afterwards." The include-external labels come from `describeIncludeExternal` (windows "Windows only (recommended)", always "On all platforms", never "Never"). The lookback choice is default ("follows … updates") or fixed 1-30. A saved `lookbackDays: 'default'` stands for the default.
- `src/links.js`: `cleanPaste` strips quotes and angle brackets. `parseChannelLink`: hosts `teams.microsoft.com`|`teams.cloud.microsoft`; path `/l/channel/<id>/<name>`; `channelId` matches `^19:[^@\s/]+@thread\.(tacv2|skype)$`; `teamId` = `groupId` GUID; `/l/message/` is rejected. `parseFolderUrl`: requires https `*.sharepoint.com`; folder from `id=` or `RootFolder=` or a `/:f:/r/` path (`/:f:/s|g/` sharing links rejected); site = `/sites|teams/<name>`; a `.aspx` folder is rejected. `validateSiteUrl` and `validateFolderPath` handle manual entry. `validateTriggerUrl` requires https and a `sig` param. `InputError` messages say what to copy.
- `src/flow-template.js`: template dir `flow/template/` with `manifest.json`, `Microsoft.Flow/flows/manifest.json`, and `Microsoft.Flow/flows/3806f7f4-…/{definition.json, apisMap.json, connectionsMap.json}`. It sets `properties.definition.actions.Flow_config.inputs` = `{siteUrl, folderPath, teamId, channelId, timeZone}` on parsed JSON (no string substitution). The template defaults are `timeZone:'UTC'`, `threadKeyPrefix:'analytics-thread'`, `recentCount:10`. The trigger is `Request`/`TeamsWebhook`, `triggerAuthenticationType:'All'`. The template contains no `sig=`.
- `src/wizard-support.js`: `FLOW_PACKAGE_FILENAME='codemie-analytics-flow.zip'`, `POWER_AUTOMATE_URL='https://make.powerautomate.com/'`, state `analytics-setup.json` in codemie home, written mode 600 plus chmod. `setupCheckFile(now)` → `setup-check-<stamp>.json` `{setupCheck:true, sentAt, note}`. It is deliberately not named `codemie-analytics-…`. `importInstructions()` gives 6 steps (Import Package (Legacy), "Select during import" for SharePoint and Teams connections, flow "CodeMie analytics delivery (webhook)", turn it on, trigger "Who can trigger the flow?" = "Anyone", copy the URL). `stateSummary()` shows the webhook as `saved`/`not yet`. Developer command quoting used double quotes: `--webhook "${url}"`.
- `src/timezones.js`: `DEFAULT_TIME_ZONE='UTC'`, `WINDOWS_TIME_ZONES` (139 CLDR windowsZones IDs), `resolveTimeZone`. `src/zip.js` is a stored-entry writer with its own CRC32.

## Facts Added by Review

Researched for the names the spec relies on, after the analysis above was written. Read like the facts layer; where a line here contradicts one above, this one was read later.

- `createSyncInstallCommand()` — `src/cli/commands/analytics/index.ts:91-108`. Module-private `function` (not exported). Returns `new Command('install')` with description `'Developer: register the daily delivery job on this machine'` and eight options, in this order:
- Action: `async (options: InstallOptions) => { const { runInstall, createRealInstallDeps } = await import('./sync/install.js'); process.exitCode = await runInstall(options, createRealInstallDeps()); }`. Lazy import keeps the scheduler module out of `codemie analytics` load (doc comment `index.ts:89-90`).
- No validation in the command itself; all option values pass as raw strings (`InstallOptions`, `src/cli/commands/analytics/sync/types.ts:38-47`: every field `string | undefined`, including `lookbackDays` and `includeExternal`). Parsing and validation happen in `runInstall` (`sync/install.ts:221`), which never throws and never calls `process.exit` (`install.ts:16`).
- `buildInstallCommand` / `InstallCommandOptions` — `src/cli/commands/analytics/sync/install-command.ts:17-63`. Header states flags "map 1:1 onto the options registered by `createSyncInstallCommand`" (`install-command.ts:6-7`) and that it is "not wired into the CLI yet; a future `bootstrap` command (EPMCDME-16487) reuses it". Not 1:1 in practice: it has no `format` field (install's `--format` is never emitted), and `lookbackDays` is `number`, `includeExternal` is `IncludeExternalPolicy`, while `InstallOptions` holds both as `string`. Emission order: webhook, git-repo, git-branch, git-path, at, lookback-days, include-external. The link between the two is a comment only; no code or test ties them.
- Each sync subcommand is a thin factory over a lazily imported runner that returns an exit code (`index.ts:89-148`: install, status, run, uninstall all share this pattern).
- `createSyncCommand()` (`index.ts:74-87`) calls `.enablePositionalOptions()` so a subcommand's own options (for example `install --include-external`) are not taken by the same-named option on `analytics` (D14, `index.ts:36,70-72`). `install --include-external <policy>` takes a value; `analytics --include-external` is a boolean flag (`index.ts:39`).
- Spec plan note "A round-trip test of the builder against `createSyncInstallCommand()`" (`spec.md:131`): the function cannot be imported directly (not exported). It can be reached via `createAnalyticsCommand()`, which is how `analytics-sync-cli.test.ts:59-60,94,110` already reaches it. A round trip will also show the `--format` gap and the string/number type mismatch above.
- `install-command.ts:6` claim "1:1": contradicted for `--format`. Holds for the other seven flags.
- Spec non-goal "the printable-value rule lives in the shared builder, which `install` does not call" (`spec.md:93`): holds. `createSyncInstallCommand` and `runInstall` do not import `install-command.ts` (the only importer is its test).
- `createSyncCommand()` — `index.ts:81`, the only call site.
- Reached indirectly through `createAnalyticsCommand()`, registered in `src/cli/index.ts:95`.
- `install-command.ts:6` (comment reference only).
