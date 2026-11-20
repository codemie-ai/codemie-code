# Technical Research

**Task**: msgraph fmtDt timezone calendar
**Generated**: 2026-11-20
**Research path**: filesystem

---

## 1. Original Context

Fix EPMCDME-16957 (bug). In src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js, fmtDt() (~line 391) always renders times via new Date(iso).toISOString().slice(0,16) - always UTC, no timezone label. Calendar callers (free/busy ~715, upcoming list ~742, meeting insights ~1239, meeting/transcript view ~1272) pass e.start.dateTime from /me/calendarView, which Graph returns zone-less (e.g. 2026-11-20T09:00:00.0000000, timeZone "UTC"), so new Date() parses it as machine-local time and the output is shifted wrongly on non-UTC machines. fmtDtTz() (~399) already appends Z for zone-less UTC values but is only used for Planner/To Do due dates (~1816). Expected: local time with an offset label (e.g. "2026-11-20 12:00 (UTC+3)") or explicitly labeled UTC. Watch padEnd column widths (~640, 667, 742), DST / half-hour offsets, --json output unchanged, and any docs in SKILL.md/README.md under the msgraph skill dir that describe output. Check whether any tests or other code in the repo depend on the old 'YYYY-MM-DD HH:MM' shape.

---

## 2. Codebase Findings

### Existing Implementations
Skill dir: `src/agents/plugins/claude/plugin/skills/msgraph/` (SKILL.md, README.md, scripts/msgraph.js ~1900 lines, plain Node CommonJS-style script, no TS).
- `msgraph.js:391` `fmtDt(iso)`: `new Date(iso).toISOString().slice(0,16).replace('T',' ')`; catch falls back to raw slice. Output is always UTC `YYYY-MM-DD HH:MM`, 16 chars, no label.
- `msgraph.js:399` `fmtDtTz(dtz)`: takes `{dateTime,timeZone}`; appends `Z` if no zone designator and timeZone is UTC, then calls fmtDt. Only caller: line 1816 (To Do/Planner due).
- fmtDt has ~35 call sites, most with real ISO `Z` strings (mail, chats, drive, notebooks, transcripts `createdDateTime`). Zone-less ones are the calendar `start.dateTime`/`end.dateTime` callers:
  - 715 free/busy (start and end, no padEnd) in `--availability` branch
  - 742 upcoming list, `.padEnd(20)` (header `'Date & Time'.padEnd(20)` at 735)
  - 1239 meeting insights header; 1272 `Start  :` in meeting/transcript view; 1309 `fmtDt(e.start?.dateTime).padEnd(20)` in transcripts day listing
  - Calendar fetches via `/me/calendarView` at 703, 723, 1216, 1255. No `Prefer: outlook.timezone` header is sent anywhere (grep found none), so Graph returns UTC.
- Other padEnd uses of fmtDt output: 640 `.padEnd(16)`, 667 `.padEnd(16)`, 920 `.padEnd(18)`, 1582 and 1608 `.padEnd(18)`. These are real-Z mail/chat/notebook values; a label added to shared fmtDt would overflow 16/18 widths (e.g. "2026-11-20 12:00 (UTC+3)" is 24 chars) and misalign columns, and also header widths 636/660.
- Availability branch (699-705): default `start`/`end` are `toISOString().slice(0,19)` (UTC, no Z) and echoed via `.slice(0,16)` in the "You're free between" message; a separate UTC-vs-local concern, not named by the ticket.
- `--json` paths print raw Graph objects (e.g. 737 area), independent of fmtDt.

### Architecture and Layers Affected
Single-file CLI script (skill asset shipped with the Claude plugin). Only the formatter layer and call sites in the calendar/transcripts command handlers. No TS/src layers involved.

### Integration Points
Microsoft Graph `/me/calendarView` (zone-less `dateTimeTimeZone`, timeZone "UTC"). Script is copied/executed by a child process in tests (see Section 4). No other repo code imports fmtDt.

### Patterns and Conventions
Local helper functions in the script, no deps; `AGENTS.md` coding rules (ES modules, etc.) target TS in `src/`; script is a standalone asset. Existing precedent for the zone-less-UTC fix is fmtDtTz.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, testing, quality-gates); none specific to msgraph. Skill docs: SKILL.md and README.md. Grep for `YYYY-MM-DD HH:MM`, "UTC", "time zone" in them: only `--timezone "Europe/Berlin"` for event creation (SKILL.md:124, README.md:108) and `YYYY-MM-DD` args (SKILL.md:374-405). Neither doc describes the displayed time format or states output is UTC. Sample outputs with times were not found.

### Architectural Decisions
None found for date formatting. Prior task docs for this skill: `docs/superpowers/tasks/2026-06-18-msgraph-skill-sync-...` and `2026-11-12-msgraph-email-full-body/`.

### Derived Conventions
fmtDtTz is the established pattern for zone-less UTC handling.

---

## 4. Testing Landscape

### Existing Coverage
Only `tests/integration/msgraph-email-read.test.ts` (emails `--read` full body). Grep for `fmtDt`, `YYYY`, `HH:MM`, `toISOString` in it: no matches, so no test depends on the old time shape. Other mentions of "msgraph" in `src/` (`claude-named-invocations.ts`, metrics tests, otlp tests) are skill-name references, not output format.

### Testing Framework and Patterns
Vitest. The integration test spawns the script as a child process with a preload replacing `https.request` and a temp HOME with a fake token cache. This is a ready pattern for a calendar test (mock `/me/calendarView`, set `TZ` env on the child to check offset labels).

### Coverage Gaps
No tests for calendar commands or fmtDt/fmtDtTz. Note repo policy: tests only when explicitly requested.

---

## 5. Configuration and Environment

### Environment Variables
Process `TZ` governs local-time rendering in Node (relevant to testing). No msgraph-specific timezone env var found.

### Configuration Files
None relevant. No feature flags. Script ships as a static plugin asset; no deployment changes found.

---

## 6. Risk Indicators

- Shared fmtDt used by ~35 sites; changing its output globally alters mail/chat/drive/notebook/task columns and breaks padEnd(16)/(18)/(20) alignment at 640, 667, 920, 742, 1309, 1582, 1608 and headers at 636, 660, 735. Speculative: limit the new label to calendar callers (e.g. a new/extended helper like fmtDtTz) or adjust widths.
- Zone-less strings with 7 fractional digits (`.0000000`) parse in V8 but should be checked; zone-less non-UTC `timeZone` values (e.g. Windows names) are not handled by fmtDtTz; with no Prefer header, UTC is expected.
- Speculative: offset labels need DST-correct per-instant offset (`getTimezoneOffset` of the event date, not now), half-hour/45-min zones (UTC+5:30, +5:45), and negative offsets; `UTC+0`/`UTC` for UTC machines.
- Line 1309 (transcripts day list) also passes zone-less calendar values but was not in the ticket list; line 1239/1272 as well as 715/742 are listed. Decide consistent coverage.
- Availability default window (701-702) mixes UTC and local; out of ticket scope but related.
- Docs do not describe output format, so doc updates are optional.
- Only one existing test file for the skill; no regression net for formatting.

---

## 7. Summary for Complexity Assessment

The change is confined to one plain-JS file (`msgraph.js`): the formatter helpers at ~391-404 and about five calendar call sites (715, 742, 1239, 1272, 1309). No TypeScript layers, config, or deployment are touched. Docs (SKILL.md, README.md) do not describe the time output, so doc edits are optional.

Technical novelty is low; fmtDtTz is an in-file precedent. The main care points are keeping non-calendar callers and their padEnd column widths unchanged (fmtDt is shared by ~35 sites), correct DST/half-hour offset labeling, and leaving `--json` output untouched.

Test posture is thin: one integration test for emails `--read` using a child-process plus `https.request` preload pattern that could be reused; no test depends on the old `YYYY-MM-DD HH:MM` shape. Overall small-to-medium, low risk.

---

## 8. External References

None named by the task
