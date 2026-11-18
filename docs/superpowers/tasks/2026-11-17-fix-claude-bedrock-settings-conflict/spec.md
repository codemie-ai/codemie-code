# Spec: stop Bedrock settings from silently bypassing the CodeMie gateway

## Problem

When Claude's own settings select AWS Bedrock (`env.CLAUDE_CODE_USE_BEDROCK` in a Claude settings file, in VS Code's `claudeCode.environmentVariables`, or `inferenceProvider: "bedrock"` in Claude Desktop), Claude ignores the gateway CodeMie configures: settings `env` beats process env, so `codemie-claude`, Claude Desktop and the VS Code extension keep talking to Bedrock. Nothing warns the user, and the sessions disappear from CodeMie analytics. Only one backend can be active in one Claude configuration.

## Goal

Before `codemie install claude`, `codemie-claude` (and ACP) or a Claude `codemie proxy connect` target writes anything or starts a session, detect an active Bedrock setup, say plainly that Bedrock and the CodeMie gateway cannot both be active, and let the user either back up and switch to the gateway or cancel with nothing changed. The switch is applied only at the last moment before the flow's first Claude write, so a later failure does not leave a half-switched machine.

## Behavior

**Detection.** Bedrock is active when the effective `CLAUDE_CODE_USE_BEDROCK` is on, using the existing `flagState` rules (`routing.ts:101`). Precedence, highest first: managed sources, project `settings.local.json`, project `settings.json`, user settings, then process env. The highest layer that defines the flag decides; an unreadable layer matters only if no higher layer decides. An unknown flag spelling, or an unreadable layer that could decide, means "cannot tell": stop before changing anything (guidance names the file and the exact key to fix, never values). A malformed (unparseable) Claude Code settings file is not in effect (Claude rejects it whole): skip it with a warning that says CodeMie analytics attribution stays unknown until the file is fixed. Desktop: applied `configLibrary` file with `inferenceProvider: "bedrock"`; an unparseable applied file is "cannot tell", not "none".

**Absent versus cannot tell (managed readers).** A source that is simply not there is "no policy present", never "cannot tell". macOS plist: file missing means skip; only a read or parse failure of an existing file is "cannot tell". Windows registry, per hive (`HKLM`, `HKCU`) `SOFTWARE\Policies\ClaudeCode` value `Settings`: query the key, then the value; a non-zero exit with empty stdout is "not found" and means absent, whatever the message text or locale. Only a runner that cannot start, times out, or returns output that cannot be parsed is "cannot tell". `managed-settings.json` and `managed-settings.d/` follow the existing missing-file rule (ENOENT/ENOTDIR = absent).

**Sources checked per flow** (only sources that can affect that flow):

| Flow | Sources |
|---|---|
| `codemie-claude`, `codemie-claude-acp`, `install claude` | user, project-local and project Claude settings; managed; shell env |
| `proxy connect --claude-desktop` | user Claude settings (Desktop's Code tab reads them), managed, Desktop applied config, Desktop managed settings |
| `proxy connect --vscode-claude-code` | user Claude settings, managed, VS Code `claudeCode.environmentVariables` (stable and Insiders) |
| `proxy connect --claude-code-otlp` only | warn only; never prompts or edits |

Connect flows do not read project layers: they are machine-wide and the current directory says nothing about where the client runs. Managed sources: `managed-settings.json` plus every file in `managed-settings.d/` (name order), macOS managed plists (`plutil`), Windows registry as above. Desktop managed settings: the existing Linux file only. A managed source that turns Bedrock on is not editable: explain it is set by IT, exit 1, change nothing, no prompt.

**Prompt (detect and ask).** One shared prompt lists the files and key names found (printed paths and key names go through `sanitizeDisplayText`), states the incompatibility, marks the shared project `settings.json` as shared (often git-tracked), lists Bedrock model keys that will also go from layers that do not carry the flag, notes that running Claude sessions watch these files and may need a restart, and, for `install claude`, that nothing routes to the gateway until the next `codemie-claude` run. Two choices only: "back up and switch" or "cancel". Asked every time Bedrock is detected. Ctrl-C counts as cancel: a prompt-scoped SIGINT listener (pattern of `launch-project-prompt.ts:59-100`) removed in `finally`, exit 1 with guidance. The gate takes `canPrompt` from its caller, computed from `canPromptForProject` plus ACP and `--silent`. ACP, `--task`, non-TTY, `CODEMIE_NO_PROMPTS=1` and `proxy connect --silent` never prompt: they stop with guidance and change nothing. This holds for `install claude` too: a scripted install with Bedrock active exits 1 and changes nothing.

**Cancel.** No file touched; exit code 1; guidance says what was found, where, and how to resolve it or rerun. In `proxy connect` a cancel aborts the whole command. Any "cannot tell" or managed stop likewise.

**Switch (apply).** Runs after consent, immediately before the flow's first Claude write, and re-resolves first: it reads each file once, backs up exactly those bytes and derives the stripped content from the same bytes. If a file changed (mtime or size) before its rename, the switch stops and restores what it already wrote.
1. Backup folder `~/.codemie/backups/bedrock-switch-<timestamp>/` via `getCodemiePath()`, created with a non-recursive `mkdir` (on `EEXIST` retry with a random suffix; never reused), mode 0700, copies 0600 regardless of source mode. `manifest.json` is written first with a version field and, per copy, the original path and a file kind (paths only, no setting values). Copies are verified before step 2; a backup failure stops with nothing changed.
2. Strip the keys below, preserving all other content (JSONC-preserving edits for VS Code), written atomically; the real path behind a symlinked settings file is resolved and the temp file written beside it so the link survives. If a later write fails, files already written are restored from the backup, best effort, and the error names the backup folder.
3. Desktop: the gate only detects, prompts and backs up. Removal of every `inferenceBedrock*` key goes into the existing connect writer's key-removal step (`desktop.ts:846-861`, not disconnect), so the file is rewritten once and ends with `inferenceProvider: "gateway"`; there is no state with provider `bedrock` and no Bedrock parameters.

Every switch prints the backup folder, one sentence on how to undo (copy the files back per the manifest), that the backup may hold credentials and may be deleted once the user has confirmed, and that a managed policy, if any, still wins. A later failure in the same flow prints the folder again. Then the flow continues normally.

**Keys removed.** Provider-specific keys come from one descriptor (see Design).
- From each editable layer that sets `CLAUDE_CODE_USE_BEDROCK`: `env`: that flag, `ANTHROPIC_BEDROCK_BASE_URL`, `CLAUDE_CODE_SKIP_BEDROCK_AUTH`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_PROFILE`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`; top-level `awsAuthRefresh`, `awsCredentialExport`.
- From every editable layer the flow reads, flag or not: Bedrock model settings, meaning model keys whose value is a Bedrock ID (`us.`/`eu.`/`apac.`/`global.anthropic.…`, `anthropic.claude-…`, `arn:aws:bedrock:…`): top-level `model`, `env.ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, and matching entries of `availableModels`. A Bedrock ID is useless outside Bedrock and would override the gateway model. Non-Bedrock values stay.

**Shell env.** `codemie-claude` removes an inherited `CLAUDE_CODE_USE_BEDROCK` from Claude's child environment (never from the user's shell) silently, claude and claude-acp only, and not when the profile provider is `bedrock`. Other flows only warn.

**Skips.** No check when the active profile's provider is `bedrock` (it sets its own env for the process only; `bedrock.template.ts:94-110`), nor for `install claude` when no profile exists.

## Placement

Two calls per entry point: detect-and-ask early (so a cancel never starts a sign-in), apply late (so nothing is changed until the flow can proceed). Claude agents only; not in `claude.plugin.ts beforeRun`.

- `AgentCLI.handleRun`: detect-and-ask after the config-completeness check (`AgentCLI.ts:319`), before auth validation (`:321`); apply just before `exportProviderEnvVars` (`:398`), after auth, launch identity and `validateCompatibility`.
- `install.ts`: detect-and-ask right after the agent is resolved (~`:104`), loading the active profile; apply immediately before the first install or additional-installation step the run will perform, after the reinstall confirmation.
- `connect-orchestrator.ts`: detect-and-ask after `resolveSsoProxyConfig`, before the daemon starts (this is also after `reportDaemonProfileIdentity` and `verifySsoCredentials`, `:908`, `:931`; that check starts no sign-in, so a cancel there is harmless); apply just before `syncRegisteredSkills`/`syncPluginSkills` (`:953`), the first Claude write for every target.

## Design

A new module family under `src/agents/plugins/claude/cloud-provider-conflict/`, named for the concept, not for Bedrock: a provider descriptor (flag name, removable keys, model-ID predicate, Desktop key prefix, display name) with only Bedrock filled in, consumed by the resolver, switcher and prompt; a resolver (per-layer result: path, scope, editable, readable, in effect, key names; merged verdict `none | conflict-editable | conflict-managed | unknown`); a switcher (backup, manifest, strip); a prompt; and the two gate functions above. Paths, platform, env, cwd, command runners (with a 2-3 s timeout each; a timeout is "cannot tell") and the prompt are injectable; layer reads and managed readers run in parallel and elapsed time is logged at debug.

Existing code touched, all additively:
- `claude-settings-env.ts`: export a per-layer step returning `{path, state: absent | malformed | unreadable | ok, parsed}`, and the new managed readers (`managed-settings.d/`, plist, registry) behind injectable runners. `readClaudeSettingsEnv` becomes a fold over the step with today's mapping (malformed gives `complete:false`) and today's four-layer set, so its OTLP caller, its tests and the two relative-path mocks are untouched. `managedSettingsPaths` keeps its exact values.
- `routing.ts`: export `flagState` and `CLOUD_FLAGS` (flag names reused by the descriptor).
- `desktop.ts`: the key-removal addition above.

`detectSettingsConflict` (base URL and model warning) stays as the interim warning and is folded into the per-layer result when the next provider conflict lands. The OTLP connector's `.codemie-backup` files and the new backups coexist on purpose; `proxy disconnect` does not restore the new ones.

## Acceptance criteria

1. Each in-scope flow detects an active Bedrock setup in any source checked for it before any write by the flow itself or session start (CodeMie's start-up migrations, which run before every `codemie` subcommand, are not gated).
2. The message states that Bedrock and the CodeMie gateway/subscription setup cannot both be active in one Claude configuration.
3. Cancel (or non-interactive/ACP/`--silent` stop, including a scripted `install claude`) leaves every Claude Code, Desktop and VS Code file byte-identical, apart from start-up migrations, and exits 1 with guidance.
4. Switch creates a new backup folder with verified copies and a manifest before the first modification, and prints the folder.
5. After a switch no listed Bedrock key remains in any editable layer that held the flag, no Bedrock-ID model key remains in any editable layer the flow reads, and detection returns `none`.
6. After a switch the flow proceeds normally. For `codemie-claude`, `routedViaCodemie`/`resolveEndpoint` over the resulting files confirms the gateway route and the resulting model keys hold no Bedrock ID.
7. An unreadable decisive layer, an unknown flag spelling, a failed managed-source read, or managed Bedrock stops the command before any change, with diagnostics that never print setting values. A managed source that is simply absent (missing plist, registry key or value not found, missing file) never stops a launch.
8. Unrelated keys and non-Bedrock model values survive the switch: JSON values are kept, JSONC comments and formatting are preserved.
9. After a Desktop switch the applied config has `inferenceProvider: "gateway"` and no `inferenceBedrock*` key; after a VS Code switch `claudeCode.environmentVariables` has no Bedrock entry; attribution to the gateway then holds when every Claude settings layer parses. End-to-end analytics attribution is a QA item, not asserted here.
10. Automated tests (real tmp dirs, injected platform/env/prompt/runners, never real user files) cover: detection per source; cancel and Ctrl-C without change; non-interactive, ACP and managed stops; backup, manifest, modes (POSIX) and symlinked settings; the switch with preservation of unrelated settings; the split-layer case (flag in one layer, Bedrock model ID in another); routing after the switch; the shell-env strip; the "absent" outcome per platform (no plist, registry key or value not found on a clean machine, no managed files) proceeding without a stop, and the failure outcome (runner cannot start, timeout, unparseable output, unreadable plist) stopping; a malformed file skipped with a warning; and a changed-file abort with restore.

## Decisions

- Back up and switch, or cancel; no per-session `--settings` override — user
- Ask every time Bedrock is detected — user
- Check every source that can cause the problem, on Windows, macOS and Linux — user
- Remove everything the original criterion lists, including `AWS_PROFILE` and `AWS_REGION` — user
- Edit the shared project `settings.json`, with a prompt that says it is shared and a backup outside the repo — user
- ACP never prompts; it stops with guidance — user
- Non-interactive runs (`--task`, no TTY, `CODEMIE_NO_PROMPTS`) stop with guidance and change nothing — user
- Automated tests are required — user
- Documentation and CLI help out of scope, confirmed by the requester even though the source requirements' last criterion asks for docs — user
- `install claude` gates like the other flows (prompt to back up and switch or cancel; scripted or non-interactive installs stop with guidance, exit 1, change nothing), over only warning because a plain install writes no Claude settings — user, answers AR-4
- A Windows registry "not found" means no policy present, and only a genuine read or exec failure means "cannot tell", over treating any non-zero exit as "cannot tell"; a test covers it — user, answers AR-3
- `install claude` with no profile skips the check, over prompting without a gateway to switch to (default)
- `proxy connect --claude-code-otlp` only warns, over prompting, since it only adds telemetry (default, confirm)
- One backup folder per switch, `~/.codemie/backups/bedrock-switch-<timestamp>/` with a versioned `manifest.json`, never overwritten (default, confirm)
- Cancel exits with code 1 and guidance, over exit 0 (default, confirm)
- Bedrock only; Vertex and Foundry deferred to a follow-up with no owner assigned yet (default, confirm)
- Skip the check when the active profile provider is `bedrock` (default, confirm)
- The prompt warns that running Claude sessions may pick up the change and may need a restart (default, confirm)
- A managed Bedrock source is explained and exits 1 without a prompt (default, confirm)
- Static AWS credentials are removed with the rest, over keeping them (default, confirm; they may serve non-Bedrock tools, the backup is the recovery)
- Detect-and-ask early and apply late, re-resolved, over one early call that detects, asks and switches, so a failing sign-in, daemon start or writer never follows a committed switch (my call, answers AR-1)
- Desktop `inferenceBedrock*` removal folded into the existing connect writer, over a second writer in the switcher (my call, answers AR-1)
- Expose a per-layer step in `claude-settings-env.ts` and fold `readClaudeSettingsEnv` over it, over a second resolver reading the same layers (my call, answers AR-2)
- A malformed settings file is skipped with a warning by the gate while the OTLP evidence still reads it as unknown, over changing that mapping (my call, answers AR-2)
- Project-local and project layers apply only to `codemie-claude`, ACP and `install claude`; connect flows check user, managed, Desktop and VS Code only, over checking the current directory everywhere (my call, answers AR-5, confirm)
- Bedrock-ID model keys are stripped from every editable layer the flow reads; AWS and credential keys only from layers that set the flag, so AWS settings meant for other tools survive (my call, answers AR-6)
- One provider descriptor and a concept-named module family, over Bedrock literals in each part (my call, answers AR-8)
- "Bedrock model settings" means model keys whose value is a Bedrock ID, over every model key (my call)
- Existing `detectSettingsConflict` stays in place as the interim warning (my call)
- Sources are scoped per flow (table above), over checking all sources everywhere (my call)
- `proxy connect --silent` does not consent to rewriting Claude files; it stops (my call)
- A failed write mid-switch triggers best-effort restore from the backup, over leaving a partial switch (my call)
- A cancel in `proxy connect` aborts the whole command, over dropping only the Claude targets (my call)

## Non-goals

- Documentation, CLI help and a restore-from-backup command (recovery is manual from the manifest)
- Vertex and Foundry detection
- Gating CodeMie's start-up migrations (`bin/codemie.js:51`)
- Fixing `resolveHook` skipping the Claude `beforeRun` for Bedrock profiles (separate bug; unverified here and not relied on)
- Detecting Anthropic server-managed settings, `--settings`/`--setting-sources` arguments passed to `codemie-claude`, or adding a runtime "not routed via CodeMie" backstop
- Changing `readClaudeSettingsEnv` semantics, `detectSettingsConflict`, or the OTLP connector's `.codemie-backup` files
- A per-session `--settings` override
- Coordinating concurrent launches

## Assumptions and risks

- Claude Code precedence, Desktop's Code tab reading user settings in gateway mode, the VS Code extension behavior, and the Windows registry value format come from the brief's tests and binary reading; not verified in this repo.
- `reg query` and `plutil` exit behavior for a missing key or file comes from documented behavior, not a run here. A registry access error with empty stdout reads as absent; `HKLM`/`HKCU` Policies are readable by standard users.
- Residual bypasses, stated in connect guidance: a Bedrock project elsewhere is not seen by connect flows (only user, managed, Desktop and VS Code layers are checked); Desktop managed policy on macOS and Windows is not detected; `--settings` is not read.
- Concurrent launches are not coordinated (the second normally sees none after the first); a kill mid-switch is recoverable only from the manifest.
- Managed-source readers cannot be exercised locally; they run through injected runners.
- The first Claude write is skills sync (`BaseAgentAdapter.ts:~672`); that ordering is taken from the brief, not re-traced. Whether a plugin importing from `cli/commands/proxy/connectors/*` creates an import cycle needs a dependency-cycle check.
- QA, not verifiable here: Windows end to end including rename over a settings file a live session holds open, Desktop gateway mode, post-switch traffic and analytics attribution, handleRun latency to the gate on macOS and Windows (cold and warm), and whether Claude applies project `env` before folder trust.

## Plan notes

- Per-runner timeout 2-3 s, parallel reads, managed readers skipped for a `bedrock` profile, elapsed time at debug; measure to tune.
- Ctrl-C at the prompt: SIGINT listener plus ref'd keep-alive, removed in `finally`; SIGINT case in the injected-prompt tests.
- Symlinked settings: realpath the target; symlink test.
- Backup modes 0700/0600 and the credential notice; test modes on POSIX.
- Printed paths and key names go through `sanitizeDisplayText`; "cannot tell" guidance names the file and exact key.
- One "can we prompt" rule: `canPrompt` computed by each caller from `canPromptForProject`, plus ACP and `--silent`.
- The Desktop applied-file backup is taken before `writeDesktopConfig` runs (it falls back to `{}` on a parse failure at `desktop.ts:753` and uses a plain `writeFile` at `:861`); an unparseable applied file is "cannot tell".
- Connect ordering note above (gate is after `verifySsoCredentials`, which starts no sign-in).
- No ticket ID, link or customer name in branches, commits, code comments, docs or task artifacts committed to the repo; remove the ticket link from the task analysis file before any `git add docs/`.
