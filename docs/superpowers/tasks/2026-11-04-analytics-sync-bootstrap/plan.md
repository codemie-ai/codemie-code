# `codemie analytics sync bootstrap` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `codemie analytics sync bootstrap`, a lead-side 8-step resumable Power Automate setup wizard with a non-interactive `--webhook` mode. It prints one cross-shell `codemie analytics sync install …` command.

**Architecture:** New modules live under `src/cli/commands/analytics/sync/bootstrap/`: links, timezones, flow-package (the only `fflate` importer), state-store, steps (the only source of "of N") and the runner. The runner follows the runner/deps convention (`sync/install.ts:1-20,232`). It returns an exit code, never throws and never calls `process.exit`. Shared pieces are reused: `buildInstallCommand`, the `config-store.ts` validators, `sendWebhook`, `redactSecrets`/`webhookHost` and `openUrlInBrowser`.

**Tech Stack:** TypeScript ESM, commander, inquirer ^9 (dynamic import), `fflate` (new), Vitest.

**Spec:** `docs/superpowers/tasks/2026-11-04-analytics-sync-bootstrap/spec.md`. The approved arch review is folded in: AR-1 (reuse needs a complete, confirmed state), AR-2 (which input form the trigger-URL rule checks), and the plan note on a shared printable-value predicate.

Commit per task using the repository's existing convention.

## Global Constraints

- Help description, exact: `Lead: connect a Teams channel and SharePoint folder, then print the install command for your team (installs nothing on this machine)`.
- Step heading, exact: `Step N of 8 · <title>`. Titles: `Teams channel`, `SharePoint folder`, `Time zone`, `Import the flow`, `Trigger URL`, `External sessions`, `Lookback`, `Developers`. Print each heading once per step, not on a retry.
- Lead state: `getCodemiePath('analytics-sync-bootstrap.json')`, mode `0o600` plus `chmod`. Never read the collector's `analytics-setup.json`.
- Flow package: `codemie-analytics-flow.zip` in cwd. Overwrite an existing file and print a notice. It never holds a webhook.
- Only the install command goes to stdout. Everything else goes to stderr.
- Every other display of the webhook goes through `redactSecrets` or `webhookHost` (`sync/redact.ts:20`, `sync/format.ts:24`).
- `install`'s own behavior does not change.
- Port collector content from `/home/oleksiiyurchenko/codemie-dev/codemie-onboarding/codemie-analytics-collector/`. Analysis §8 records the rules and messages.

## Review Focus

- A trigger URL pasted with a trailing typographic quote, or as `<https://…>`. Guided mode should strip the brackets, then reject the quote with a message naming typographic quotes. It must not accept a corrupted signature (Task 2, Task 8).
- A run interrupted after the URL is saved but before the send ends. Reuse must not be offered. Resume at step 5 (Task 5).
- A hand-edited state file (`lookbackDays: 45`, unknown policy, invalid JSON). It must never reach the printed command (Task 5).
- A webhook with `%name%` or `!`. Reject it, naming `--webhook`, before any send (Task 1, Task 6).
- The browser opener throwing. Print the URL and continue (Task 7).

---

### Task 1: Printable-value rule and double quoting in `buildInstallCommand`

**Files:** Modify `src/cli/commands/analytics/sync/install-command.ts:1-39` (header, `quote`, `flag`). Test `sync/__tests__/install-command.test.ts`: update the pinned strings at `:11,17`.

**Interfaces:** Produces `export function assertPrintableValue(flag: string, value: string): void`. It throws `SyncConfigError` naming `flag`.

- [ ] Test-first: yes — `buildInstallCommand({webhook:'https://h/p?a=1&sig=x%2F', includeExternal:'windows'})` returns `codemie analytics sync install --webhook "https://h/p?a=1&sig=x%2F" --include-external "windows"`. A webhook or git value containing `"`, `$`, a backtick, `!`, `\x07`, `’`, or `%zz`/a trailing `%` throws `SyncConfigError` whose message names the flag.
- [ ] Implement `assertPrintableValue` with the spec's four clauses. `flag()` calls it on every value, then wraps the value in double quotes. Rewrite the header: double quotes, the printable rule, and no "1:1" claim (`--format` is not emitted).

### Task 2: Shared validators and `validateTriggerUrl`

**Files:** Modify `src/cli/commands/analytics/sync/config-store.ts:41,222,236`: export `validateWebhookUrl`, `validateIncludeExternal` and `validateLookbackDays` unchanged, then add the new function. Test `sync/__tests__/config-store.test.ts`.

**Interfaces:** Consumes `assertPrintableValue` (Task 1). Produces `export function validateTriggerUrl(input: string, mode: 'option' | 'guided'): string`. It returns the normalised `href`.

- [ ] Test-first: yes — each case throws `SyncConfigError`: `http://…`; no `sig`; an inner space, `\n`, a control char; a non-ASCII char such as a trailing `”` (message names typographic quotes); `!` in the URL. In `'option'` mode the message contains `--webhook`. In `'guided'` mode it does not, and it says what to copy instead. A valid URL returns `new URL(input).href`. `install`'s existing tests stay green.
- [ ] Implement in this order:
  1. Run the checks on `input` as given: whitespace, line break, control char, non-ASCII.
  2. Parse it with `new URL`.
  3. Require https and a `sig` param.
  4. Call `assertPrintableValue('--webhook', href)`.
  5. Return `href`.

  It does no paste cleaning (see Task 3, AR-2).

### Task 3: Teams/SharePoint link parsing and Windows time zones

**Files:** Create `sync/bootstrap/links.ts`, a port of collector `src/links.js`. Create `sync/bootstrap/timezones.ts`, a port of collector `src/timezones.js`. Test `sync/bootstrap/__tests__/links.test.ts` and `timezones.test.ts`.

**Interfaces:** Produces:

```ts
export class BootstrapInputError extends Error {}
export function cleanPaste(raw: string): string; // trim; strip surrounding quotes (ASCII and typographic) and <>
export function parseChannelLink(raw: string): { teamId: string; channelId: string; channelName: string };
export function parseFolderUrl(raw: string): { siteUrl: string; folderPath: string };
export function validateSiteUrl(raw: string): string;
export function validateFolderPath(raw: string): string;
export const DEFAULT_TIME_ZONE = 'UTC';
export const WINDOWS_TIME_ZONES: readonly string[]; // the 139 IDs, verbatim
export function resolveTimeZone(raw: string): string; // throws BootstrapInputError when unknown
```

- [ ] Test-first: yes — port the collector's `links`/`timezones` cases to Vitest. Cover: a valid `/l/channel/19:…@thread.tacv2/<name>?groupId=<guid>` link; a `/l/message/` link, a non-Teams host, and a bad channelId, each rejected with a what-to-copy message; a folder from `id=`, `RootFolder=` and `/:f:/r/`; `/:f:/s/` sharing links, `.aspx` folders, non-`*.sharepoint.com` hosts and empty paths rejected; `cleanPaste('<https://x>')` and `cleanPaste('“https://x”')` both returning `https://x`; `resolveTimeZone('Pacific Standard Time')` passing; `'Mars'` throwing.
- [ ] Port the logic and messages verbatim, typed. Where the collector names its own `InputError`, use `BootstrapInputError`.

### Task 4: Flow template asset and zip package

**Files:**
- Add the `fflate` dependency in `package.json`.
- Copy the 5 files from the collector's `flow/template/` byte-identical to `src/cli/commands/analytics/sync/bootstrap/flow-template/`, keeping the same tree.
- Add a `dirConfigs` entry in `scripts/copy-plugins.js` (the pattern at `:50-57`) that copies the template dir to `dist/…/sync/bootstrap/flow-template`.
- Create `sync/bootstrap/flow-package.ts`, a port of collector `src/flow-template.js`.
- Test `sync/bootstrap/__tests__/flow-package.test.ts`.

**Interfaces:** Produces:

```ts
export const FLOW_PACKAGE_FILENAME = 'codemie-analytics-flow.zip';
export interface FlowConfigInputs { siteUrl: string; folderPath: string; teamId: string; channelId: string; timeZone: string }
export function resolveFlowTemplateDir(): string; // getDirname(import.meta.url)/flow-template; throws ConfigurationError if missing
export async function buildFlowPackage(inputs: FlowConfigInputs, templateDir?: string): Promise<Uint8Array>;
export async function writeFlowPackage(dir: string, inputs: FlowConfigInputs): Promise<{ path: string; overwritten: boolean }>;
```

- [ ] Test-first: yes — unzip the result with `fflate.unzipSync`. It holds the 5 template paths. In `definition.json`, `properties.definition.actions.Flow_config.inputs` equals the given inputs. The other 4 files are byte-identical to the template. No entry contains `sig=` or `https://` plus the trigger. A second `writeFlowPackage` into the same tmp dir reports `overwritten: true`.
- [ ] Implement. Set `Flow_config.inputs` on the parsed JSON, not by string substitution. Use `zipSync(files, { level: 0 })`.

### Task 5: Lead state store, private writer and state-to-command mapping

**Files:**
- Create `sync/private-file.ts`.
- Refactor `writeSyncSettings` (`config-store.ts:376`) to use it, with no behavior change.
- Create `sync/bootstrap/state-store.ts`.
- Test `sync/bootstrap/__tests__/state-store.test.ts`.

**Interfaces:** Produces:

```ts
// private-file.ts
export async function writePrivateJson(path: string, data: unknown): Promise<void>; // mode 0o600 + chmod
// state-store.ts
export interface BootstrapState {
  version: 1;
  channelLink?: string; teamId?: string; channelId?: string; channelName?: string;
  siteUrl?: string; folderPath?: string; timeZone?: string;
  flowImported?: boolean; webhookUrl?: string;
  webhookTest?: 'passed' | 'skipped';           // AR-1: set only on a 2xx or explicit Skip
  includeExternal?: IncludeExternalPolicy;
  lookbackDays?: number | 'default';
}
export function getBootstrapStatePath(): string;
export async function loadBootstrapState(path?: string): Promise<{ state: BootstrapState | null; notice?: string }>;
export async function saveBootstrapState(state: BootstrapState, path?: string): Promise<void>;
export type ReuseCheck = { ok: true; options: InstallCommandOptions } | { ok: false; resumeAt: number };
export function checkReuse(state: BootstrapState): ReuseCheck;
export function toInstallCommandOptions(state: BootstrapState): InstallCommandOptions;
export function firstUnansweredStep(state: BootstrapState): number; // 1-based
export function summarizeState(state: BootstrapState): string[];    // webhook masked, test result shown
```

- [ ] Test-first: yes — the following cases:
  - An unreadable, non-JSON or wrong-shape file returns `{state:null}` and a notice naming the path.
  - The saved file is mode `0o600`.
  - `checkReuse` returns `ok` only when `webhookUrl`, `webhookTest`, `includeExternal` and `lookbackDays` are all present and pass `validateTriggerUrl(…,'guided')`, `validateIncludeExternal` and `validateLookbackDays` (`'default'` passes).
  - `lookbackDays: 45` or an unknown policy gives `resumeAt` that field's step (7 or 6).
  - A missing `webhookTest`, or a failing webhook, gives `resumeAt: 5`.
  - Otherwise `resumeAt` is `firstUnansweredStep`.
  - `toInstallCommandOptions` always sets `includeExternal`, sets `lookbackDays` only when it is a number, and never sets `at`.
  - `summarizeState` output never contains the `sig` value.
- [ ] Implement the functions above.

### Task 6: Runner, `--webhook` mode and CLI registration

**Files:**
- Create `sync/bootstrap/run-bootstrap.ts`.
- Modify `sync/targets/webhook-target.ts:36-83`: add an optional `timeoutMs` to `WebhookTarget` and `sendWebhook`. It defaults to `WEBHOOK_TIMEOUT_MS`.
- Modify `src/cli/commands/analytics/index.ts:74-87`: add `createSyncBootstrapCommand()` with options `--webhook <url>`, `--lookback-days <n>` and `--include-external <policy>`. Add a lazy `import('./sync/bootstrap/run-bootstrap.js')` and set `process.exitCode`.
- Test `sync/bootstrap/__tests__/run-bootstrap.test.ts`. Update `analytics/__tests__/analytics-sync-cli.test.ts:89-128` (help list).

**Interfaces:** Consumes Tasks 1, 2 and 5. Produces:

```ts
export interface BootstrapOptions { webhook?: string; lookbackDays?: string; includeExternal?: string }
export interface BootstrapDeps {
  isTTY: boolean; cwd: string; now: () => Date;
  out: (line: string) => void; err: (line: string) => void;
  send: (url: string, report: SyncReport, timeoutMs?: number) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  prompt: BootstrapPrompter; // defined in Task 7
  statePath: string;
}
export async function runBootstrap(opts: BootstrapOptions, deps: BootstrapDeps): Promise<number>;
export function createRealBootstrapDeps(): BootstrapDeps;
export function setupCheckReport(now: Date): SyncReport; // setup-check-<stamp>.json {setupCheck:true, sentAt, note}
export const UPDATE_HINT: string; // names `codemie self-update`, no version
```

- [ ] Test-first: yes — the following cases:
  - Help lists `bootstrap` with the exact description.
  - `sync bootstrap --webhook <url> --include-external always` reaches `runBootstrap` with `includeExternal:'always'`, and `loadAnalytics` is not called.
  - In `--webhook` mode, `out` receives exactly the command with `--include-external "always"`. `err` holds the check line, the cleanup line and `UPDATE_HINT`, with no `sig` value. The exit code is 0. `statePath` is never read or written.
  - A send that throws `SyncDeliveryError(…, 403)` or a network error gives no `out` call, a cause-specific `err` (the 4xx hint keys off `.status`), and a non-zero exit.
  - A bad webhook, lookback 0 or 31, or policy `sometimes` fails before `send`, with the option named.
  - `isTTY:false` without `--webhook` fails at once, naming both remedies.
- [ ] Implement `--webhook` mode and the no-TTY failure. Hand guided mode to `runGuided` (Task 7).

### Task 7: Guided wizard, start logic and steps 1-4

**Files:** Create `sync/bootstrap/steps.ts` and `sync/bootstrap/guided.ts`. Port collector `src/wizard.js` (sequence and start logic) and `src/wizard-support.js` (`importInstructions`, `POWER_AUTOMATE_URL`). Test `sync/bootstrap/__tests__/guided.test.ts`, using a scripted fake `BootstrapPrompter`.

**Interfaces:** Consumes Tasks 3, 4 and 5. Produces:

```ts
export const STEPS = ['Teams channel','SharePoint folder','Time zone','Import the flow','Trigger URL','External sessions','Lookback','Developers'] as const;
export function stepHeading(index: number): string; // `Step ${index+1} of ${STEPS.length} · ${STEPS[index]}`
export interface BootstrapPrompter {
  input(message: string, def?: string): Promise<string>;
  confirm(message: string, def: boolean): Promise<boolean>;
  select<T extends string>(message: string, choices: { value: T; name: string }[], def?: T): Promise<T>;
}
export async function runGuided(deps: BootstrapDeps): Promise<number>;
```

- [ ] Test-first: yes — the following cases:
  - Headings print in order, once each, even after a rejected answer.
  - A `/l/message/` paste is asked again.
  - Typing `manual` or declining the folder confirm asks for the site and path separately.
  - An unknown time zone is asked again.
  - Step 4 writes the zip into `cwd`, prints the 6 import instructions, offers to open the browser and waits for confirmation. An `openUrl` that throws prints `https://make.powerautomate.com/`.
  - With a reusable state, the masked summary is shown and accepting jumps to step 8.
  - A non-reusable state resumes at `checkReuse().resumeAt` with saved defaults.
  - "Already imported? yes" jumps to step 5.
  - State is saved after each step.
  - A missing template dir fails before step 1.
- [ ] Implement start logic and steps 1-4. Call `resolveFlowTemplateDir()` before step 1.

### Task 8: Guided steps 5-8: trigger URL and test send, policy, lookback, command

**Files:** Modify `sync/bootstrap/guided.ts`. Test `sync/bootstrap/__tests__/guided.test.ts`.

**Interfaces:** Consumes `cleanPaste`, `validateTriggerUrl(…,'guided')`, `setupCheckReport`, `toInstallCommandOptions`, `buildInstallCommand` and `UPDATE_HINT`.

- [ ] Test-first: yes — the following cases:
  - Step 5 runs `cleanPaste` and then `validateTriggerUrl`. A `<…>` paste is accepted. A trailing `”` is rejected with the typographic-quote message.
  - The URL is saved with `webhookTest` cleared before `send(url, report, 30_000)`. `Sending test file…` prints first.
  - Success prints the collector's "Within a minute <file>…" text and saves `webhookTest:'passed'`.
  - A 4xx prints the "flow is turned on / Anyone / whole URL" hint and offers Try again / Enter a different URL / Skip the test. Skip saves `webhookTest:'skipped'`.
  - Step 6 offers windows (default, "Windows only (recommended)"), always and never, with explanations.
  - Step 7 offers the default (stored as `'default'`) or a fixed 1-30.
  - Step 8 sends exactly one `out` line from `toInstallCommandOptions`, then `UPDATE_HINT` on `err`.
- [ ] Implement steps 5-8.

### Task 9: Document `bootstrap`

**Files:** Modify `docs/COMMANDS.md:747-796`. Also update `docs/ANALYTICS-REPORT.md` (the scheduled-delivery section): one line pointing to `bootstrap`.

- [ ] Test-first: no — docs only. Document:
  - `bootstrap`, with guided mode and `--webhook` mode.
  - The lead-to-developer flow.
  - That the printed line contains the trigger secret and must not go to shared logs.
  - The `codemie.cmd` caveat: where PowerShell script execution is blocked, `codemie.cmd` can split the URL at `&`.
  - The `codemie self-update` hint.

## Negative-constraint pass

- Installs nothing on the lead machine: no task calls the scheduler or `writeSyncSettings` (Tasks 6-8).
- The package never holds a webhook: Task 4 test.
- `--webhook` mode never reads or writes state: Task 6 test.
- No minimum version printed: `UPDATE_HINT` has no version (Task 6).
- `install` validation not tightened: Task 2 only exports its validators, and `validateTriggerUrl` is bootstrap-only.
- The collector's `analytics-setup.json` is never read: Task 5 uses its own path.
- The flow template is not changed: Task 4 copies it byte-identical and tests that.
- Never print `--at`: Task 5 test.
- No signature outside the command and the state file: Tasks 5, 6 and 8 tests.
- One team only: Task 5 has a single state slot.
- The developer zip archive is not ported. No collector change. No developer-side changes beyond the shared builder and the optional send timeout.
