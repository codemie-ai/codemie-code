# Design: ticket IDs per session in the analytics report

Date: 2026-10-26 (rev. 2, after review)
Status: implemented (see Implementation notes)
Related: PR #675 (`--redact`)

## Goal

Let a consumer of `codemie analytics --export json` (for example the EPAM analytics collector)
attribute each session to work items (Jira, Rally, ...) **without receiving prompt text**, and,
when asked, without anything derived from prompts at all.

Today the report has no ticket data. The only way to infer a ticket is `title`, the full first user
prompt. PR #675 adds `--redact` to blank it. This design adds a dedicated, ID-only signal.

Principle: **extend, don't modify.** Ticket logic lives in its own module. Existing types
(`SessionCost`, `SessionAnalytics`) and the enricher's pricing loop do not change, apart from
one small, generic observation hook.

## Current state (main @ 764488f, v0.16.0)

| What | Where | Notes |
|---|---|---|
| Ticket regex and parsers | `src/agents/core/ticket-parser.ts` | `TICKET_RE` (`gi` flags, so case-insensitive), `extractTicketMentions`, `extractTicketMarker`. Pure, tested. |
| Story tiers | `src/agents/core/story-resolver.ts` | explicit env/config -> branch -> marker -> mention. Used only by the OTLP hook pipeline. |
| Report session record | `report/types.ts` `ReportSessionRecord` | No ticket field. |
| Native log parsing | `cost/cost-enricher.ts` `parseOne` -> `ParsedEntry` (`parsed: ParsedSession`, `agentName`, `startTime`, ...) | Every session's native log is parsed once, then walked in `startTime` order. |
| Cross-session ownership | `cost/usage-readers.ts` `takeUnseenRecords` (run-wide `seen` set, earliest session wins) and `withinWindow(windowEnd)` (drops records after the session's end) | Applied to usage records only. `windowEnd` is computed per entry inside the `enrichCosts` loop. |
| Subagent transcripts | `parsed.subagents`, indexed by `claude-ownership.ts` / `claude-trace.ts` | Carry their own tool calls. |
| Per-agent readers | `usage-readers.ts` `readUsageByModel` | `switch (agentName)` over Claude-shaped, Codex, Gemini, Kimi, Pi, Copilot. |
| Prompts in analytics | `MetricDelta.userPrompts` | Tracked sessions: every prompt. Native sessions: `openingPrompt` only (`native-loader.ts:392`). |
| Branches in analytics | `MetricDelta.gitBranch` | Tracked: per delta. Native: one modal branch (`native-loader.ts:595`). |
| `analytics otel` | `sources/otel-source.ts` | Returns its own cost and **bypasses the enricher**. OTLP events carry `story_id` / `story_source`, but `otel-loader.ts` ignores them. |
| Unknown CLI options | commander, no `allowUnknownOption` | An older CLI exits with an unknown-option error on any new flag. |

## Output

One additive, optional field per session:

```ts
// report/types.ts
export interface SessionTicket {
  id: string; // upper-cased, e.g. "CAKE-807"
  /** Occurrences per source; a source is absent when it did not see this id. */
  sources: { tool?: number; branch?: number; prompt?: number };
}

export interface ReportSessionRecord {
  // ...existing fields unchanged...
  /** Ticket ids attributed to this session; absent when none were found or extraction is off. */
  tickets?: SessionTicket[];
}
```

- Absent when empty, so no existing record changes shape (same convention as `costSeries`,
  `dispatches`).
- IDs and counts only. Never prompt text, tool input text or paths.
- **No ranking and no combined count.** Reading a ticket is not working on it: a `jira_search`
  returning 15 issues would otherwise outrank the branch the work happened on. Per-source counts
  let the consumer decide. Ordering is only for stable output: by id.
- Capped at 20 per session (matches `MAX_TICKET_MENTIONS`).
- Passes through `--redact` unchanged.

## Sources

| Source | Input | Extraction |
|---|---|---|
| `tool` | Tool calls (main transcript **and subagent transcripts**) whose name matches the tool patterns | `TICKET_RE` over **key-like input fields only**: `issueIdOrKey`, `issueKey`, `issue_key`, `key`, `parent`, `jql` |
| `branch` | Branches the session touched | `extractTicketMentions` on each distinct branch |
| `prompt` | User prompts | `extractTicketMarker` + `extractTicketMentions`, then **corroboration** (below) |

**Subagent rule:** a matching tool call made by a subagent counts for the parent session, because
the session is the unit of work in the report.

**Not covered:** IDs that exist only in a tool *result* (for example the key returned by
`createJiraIssue`). The first version reads inputs only; the next call that uses the new key
(`getJiraIssue`, `addComment`, a branch) is what attributes it. Reading results is a possible
follow-up.

### False positives: corroboration instead of a denylist

`TICKET_RE` is case-insensitive, so free text matches `gpt-4`, `claude-3`, `utf-8`, `node-18`,
`covid-19`, `SHA-256`, `CVE-2024-1234`. A denylist cannot keep up. Instead:

- `tool` and `branch` IDs are kept as found. Both inputs are narrow by construction.
- A `prompt` ID is kept only if its **project prefix** (the part before `-`) also appears in a
  `tool` or `branch` ID anywhere in the same report. "CAKE-812 in a prompt" survives because
  `CAKE-807` was seen from a tool call; `UTF-8` does not.
- Prompt matching is **case-sensitive** (upper-case prefix), applied on top of the parsers' output.

A prompt-only ticket in a report with no tool or branch evidence for its project is dropped. That
is the intended trade-off: fewer, trustworthy IDs.

### Uneven prompt and branch coverage

For native sessions the delta path only has the opening prompt and one modal branch. The tool
pass already holds the full parsed native log, so for native Claude and Codex sessions it also
reads **every user prompt and every per-message `gitBranch`** from `parsed.messages`. Tracked and
native sessions then get the same coverage. Tracked sessions keep using their deltas; when both
exist for a session, IDs are de-duplicated by occurrence, not double counted.

## Where the code goes

### 1. One generic seam in the enricher (the only change to existing logic)

```ts
// cost/cost-enricher.ts
/** Read-only view of one session's parsed log, in the same order and window as cost ownership. */
export interface ParsedSessionView {
  sessionId: string;
  agentName: string;
  parsed: ParsedSession | null;
  startTime: number;
  windowEnd: number | undefined;
}
export type ParsedSessionObserver = (view: ParsedSessionView) => void;

export async function enrichCosts(sessions, deps = realDeps, observers: ParsedSessionObserver[] = [])
```

Inside the existing `for (const entry of ordered)` loop, after `windowEnd` is computed, each
observer is called with the view. No pricing logic changes, `SessionCost` is unchanged, and an
empty `observers` list (the default) behaves exactly as today. Tickets are the first observer;
later per-session signals (PR links, commit SHAs) can use the same hook.

A full extractor registry (`fromParsed` / `fromDeltas` / `merge`) was considered and deferred:
with one user it is framework ahead of need. The observer can grow into it.

### 2. New module `src/cli/commands/analytics/tickets/`

| File | Responsibility |
|---|---|
| `tool-calls.ts` | Per-agent tool-call readers, `switch (agentName)` like `readUsageByModel`: Claude-shaped (`tool_use` blocks, plus `parsed.subagents`), Codex (`function_call`, JSON-parsed `arguments`). Returns `{ id, name, input, timestamp }[]`. Adding Gemini or Pi later is one new case. |
| `tool-tickets.ts` | Pure: match names against patterns (case-insensitive globs), scan key-like fields (nested objects and arrays, strings only, 64 KB per value cap). |
| `native-signals.ts` | Pure: all user prompts and per-message branches from a parsed native log. |
| `collector.ts` | The observer. Keeps a **run-wide `seen` set of tool-call ids**, applied in the enricher's start-time order, and drops calls after `windowEnd`. Mirrors `takeUnseenRecords` + `withinWindow`, so a resumed session's replayed turns go to the session that made them, not to both. Accumulates per-session maps. |
| `merge.ts` | Pure: combine per-source maps, apply prefix corroboration and case-sensitivity for prompts, cap, order by id, return `undefined` when empty. |
| `options.ts` | Resolve sources and tool patterns from flags and config. |

### 3. Wiring

| File | Change |
|---|---|
| `analytics/index.ts` | Register `--ticket-sources` and `--ticket-tools` on the default command only (see `otel` below). Validate before loading sessions, like `--export`. Create the collector, pass it to `enrichCosts`, hand its result to the builder. |
| `report/payload-builder.ts` | `PayloadContext` gains optional `tickets?: Map<string, SessionTicket[]>`; when present, copy `tickets` onto each record. No other change. |
| `analytics/types.ts` | `ticketSources`, `ticketTools` on `AnalyticsOptions`. |
| `docs/ANALYTICS-REPORT.md` | Field, sources, flags, coverage limits, privacy note. |

Not touched: `SessionCost`, `SessionAnalytics`, the aggregator, pricing, the OTLP pipeline,
conversation sync, metrics sync, the HTML dashboard.

## CLI surface

Two flags, both optional. Omitted means defaults, so existing invocations are unaffected.

```
--ticket-sources <list>   tool,branch,prompt in any combination, or "none"
--ticket-tools <globs>    comma list of tool-name globs, case-insensitive
```

Defaults:

| Setting | Default |
|---|---|
| Sources | `tool,branch,prompt`; **`tool,branch` when `--redact` is set** |
| Tool patterns | config key `analytics.ticketTools` in the CodeMie config if set, else `mcp__*jira*` |
| Fields | fixed key-like list (above); no flag in the first version |

- `--redact` implies no prompt scanning, because people read "redact" as "nothing derived from my
  prompts". Prompt-derived IDs can include customer account numbers. `--redact
  --ticket-sources tool,branch,prompt` opts back in explicitly.
- `mcp__*jira*`, matched case-insensitively, covers `mcp__claude_ai_Atlassian__getJiraIssue`,
  `mcp__atlassian__jira_get_issue` and similar.
- Team-specific tool naming is configuration, so its home is the config key. `--ticket-tools` stays
  as a flag so the collector can pass it per run without editing the user's CodeMie config.

Examples:

```bash
# collector: nothing derived from prompts
codemie analytics --last 7d --export json --redact

# a team using a Rally MCP
codemie analytics --export json --ticket-tools "mcp__*rally*"
```

## `analytics otel`

`OtelSource` bypasses the enricher, so the `tool` pass cannot run there. In this PR:

- the ticket flags are registered on the default command only, not on `otel`, so they cannot be
  passed and silently do nothing;
- the gap is documented in `ANALYTICS-REPORT.md`.

Follow-up: OTLP events already carry `story_id` / `story_source` (including the explicit tier,
`SDLC_ANALYTICS_STORY_ID` / `.claude/analytics.local.json`), the strongest signal available. An
`otel-loader.ts` change can map them to a `story` source.

## Privacy

- No prompt text or tool input text leaves; only IDs and counts.
- With `--redact`, nothing derived from prompts either.
- IDs still reveal Jira project keys and which items a developer touched. The receiving side
  (SharePoint folder, analysis tool) needs matching access control. `ANALYTICS-REPORT.md` states this.

## Tests

- `tickets/__tests__/tool-calls.test.ts`: Claude main and subagent `tool_use`, Codex
  `function_call` with JSON arguments, unknown agent -> `[]`.
- `tickets/__tests__/tool-tickets.test.ts`: case-insensitive globs, key-like fields only,
  free-text fields ignored, nested values, size cap.
- `tickets/__tests__/collector.test.ts`: a resumed session replaying an earlier session's Jira
  call is attributed once, to the earlier session; calls after `windowEnd` dropped; subagent calls
  counted for the parent.
- `tickets/__tests__/merge.test.ts`: prefix corroboration (`CAKE-812` kept, `UTF-8` dropped),
  case-sensitive prompts, per-source counts, cap, empty -> `undefined`.
- `report/__tests__/payload-builder.test.ts`: `tickets` present and absent; records unchanged
  without a tickets map.
- `cost/__tests__`: `enrichCosts` with no observers is unchanged (existing tests), observers
  called once per session in start order with `windowEnd`.
- `__tests__/analytics-cli-metadata.test.ts`: flags on the default command, not on `otel`;
  invalid source rejected; `--redact` default drops `prompt`.

## Rollout

1. PR #675 (`--redact`) merges first. This PR rebases on it, because the `--redact` default for
   sources depends on it.
2. CLI release containing both. Note the version.
3. Collector change (EPAM `codemie-onboarding`), merged **only after** that release is published:
   - **Capability probe:** read `codemie --version` and compare with the release, or check
     `codemie analytics --help` for `--redact`.
   - **Policy for old CLIs:** skip the run and log `skip — codemie <x> lacks --redact; upgrade to
     <y>`. Never fall back to an unredacted export.
   - Pass `--redact`, plus `--ticket-tools` from an optional admin `ticketTools` setting in
     `destination.json` (same lookup order as `includeExternal`).
4. Who picks up the collector change, and when:
   - **Quickstart installs** (managed clone in `~/.codemie/codemie-onboarding`) self-update from
     `main` on every scheduled run (`src/update.js`), so they switch the next day **regardless of
     their CLI version**. That is why the probe and the release-first order are required.
   - **Zip installs** (client packages) change only when the admin re-packs and redistributes.
5. Data continuity: a skipped run does not move the last-sent marker, so after the developer
   upgrades the CLI, the next run's window reaches back to the last confirmed send. Data is delayed,
   not lost.

## Implementation notes

Decisions taken while implementing, where the design left room:

- Prompt ids use the shared `TICKET_RE` without its `i` flag (upper-case prefix required). The
  `story:` / `ticket #` marker parser is not used: a marker id that is upper case is already caught
  as a mention, and a lower-case one would bypass the case rule.
- Counts: `tool` = matching calls, `branch` = distinct branch names, `prompt` = distinct prompt texts.
  Branches and prompts from deltas and from the native log are merged by text, so the same prompt seen
  in both is counted once.
- Native rows (prompt and `gitBranch` together) are deduped run-wide and bounded by `windowEnd`,
  like tool calls, because resumed logs replay them: Claude by row `uuid`, Codex by original
  timestamp plus text (Codex rows have no id). The deltas native-loader synthesizes for native
  sessions (`<id>-native*`) are skipped, since the native pass reads the same log.
- With `prompt` requested, tool and branch evidence is still gathered for corroboration and simply
  not emitted, so `--ticket-sources prompt` works on its own.
- "Earliest" follows the enricher's sort: start time, ties in input order. A deterministic
  tie-breaker belongs to the cost sort itself and is left to a separate change, because it alters
  cost attribution too.
- `analytics otel` rejects the ticket flags (commander binds parent options after `otel`, so they
  would otherwise be accepted and ignored). Flags are validated with or without `--export`.
- Ids sort numerically (`BIG-2` before `BIG-10`).
- The automatic end-of-session report (`report/session-report.ts`) does not include tickets.
- Prompts use the repo's notion of a genuine user turn (`countTurns` in claude-code-otlp): rows
  with `isMeta`, `isSidechain` or `isCompactSummary` are skipped, and slash-command plumbing,
  local command output and system reminders are stripped (`<command-args>` is kept).
- Key fields also include `inwardIssue` / `outwardIssue` (Atlassian `createIssueLink`, the most
  frequent Atlassian call in real logs); a key field may hold an array of strings, and JSON
  encoded in a string (`additional_fields`) is walked. The default tool patterns add
  `mcp__*atlassian*__*issue*`, because `createIssueLink` has no "jira" in its name.
- Codex tool names are matched as logged and, for `server__tool` names, also as `mcp__server__tool`;
  no real Codex MCP log was available to confirm which form Codex writes.
- Branches: bot dependency branches (`dependabot/`, `renovate/`) are skipped and a match followed
  by `.` (a version, `lodash-4.17.21`) is ignored, since those were the main source of branch noise
  and, through corroboration, of prompt noise.
- `jql` is matched case-sensitively, except the value of an issue-key clause (`key`/`issue`/
  `issuekey`/`parent` with `=`, `!=`, `in`, `not in`), which accepts any case like Jira does; other
  key fields stay case-insensitive. Known limitation: a lower-case key elsewhere in a query is lost.
- Prompts are normalised the same way on both paths (wrappers stripped, whitespace collapsed), so a
  prompt seen in CodeMie's records and in the native log is counted once.
- Not addressed: a session-level metadata branch (Codex `session_meta`) is not bounded by the
  session's window, so sessions sharing one log file can each get it.
- Known limitation: corroboration is report-wide and branch matching is case-insensitive, so a
  noisy branch (`chore/react-17-upgrade`) can confirm prompt noise and results depend on the
  report's range and filters.
- Over the cap, the ids with the most evidence are kept; output is then ordered by id.
- Corroboration uses the whole report (open question 2: whole report).
- `analytics.ticketTools` is a top-level key of the CodeMie config (open question 4: global).
- Tool results are not read (open question 1) and the dashboard is unchanged (open question 3).

## Open questions (resolved for this PR)

1. Should tool *results* be read in a follow-up, to attribute keys created by `createJiraIssue`?
2. Should prefix corroboration use the whole report (proposal) or only the same session? Whole
   report catches a prompt-only ticket from a project seen elsewhere; same-session is stricter.
3. Should the dashboard show tickets per session?
4. Should `analytics.ticketTools` live in the profile or the global config section?
