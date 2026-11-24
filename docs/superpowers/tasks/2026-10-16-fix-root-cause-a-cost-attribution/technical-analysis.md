# Technical Research

**Task**: analytics cost-enricher session-attribution dedup
**Generated**: 2026-10-16T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Fix Root Cause A from docs/superpowers/investigations/2026-10-13-EPMCDME-15316-findings.md ('Root cause A — Shared Claude log credited entirely to the earliest session (12 of 17 zeros)'). When Claude Code resumes/continues a conversation, it keeps appending to the SAME JSONL log file, but each `codemie-claude` launch creates a NEW CodeMie session. `enrichCosts` in src/cli/commands/analytics/cost/cost-enricher.ts sorts sessions by startTime and dedups usage records by (message.id, requestId) using a single global `seen` Set — so the EARLIEST session claims every record in the shared file, including turns that actually happened during later sessions. Net effect: later sessions sharing that file report $0 cost/tokens even though real work happened in them. The findings doc's recommended fix (fix 1, preferred): time-window attribution — assign each deduped record to the session whose [startTime, endTime] window contains record.timestamp; only records outside every window (true replays / untimed rows) fall back to the earliest-owner behavior. Keep the global dedup set so nothing is double-counted. Open sessions (endTime: null) need an upper bound — use the next sharing session's startTime, or 'now' if it's the last one.

A prior automated attempt at this fix was already tried and discarded because it broke 2 existing unit tests in src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts (both in the nested/subagent dispatch-cost-attribution area: 'sub-agent records join the cross-session dedup (replayed response counted once)' and 'never reintroduces another session's accepted responses into agent allocations') by replacing the single global per-call `seen` Set threading through gatherDedupedUsageRecords/gatherUsageDeduped with a two-phase approach that deduped per-session first and then cross-attributed — that broke dedup interactions with the dispatch/subagent allocation logic. Please research deeply: how `enrichCosts`, `gatherDedupedUsageRecords`, `gatherUsageDeduped`, the `seen` Set threading, and the dispatch/subagent allocation code (dispatch-allocation.ts, dispatch-extractor.ts or similar) actually interact, so a correct fix preserves single-pass global dedup semantics while still attributing by time window. Also research how session start/end times are represented (ParsedEntry.observedEnd, startTime fields, open-session handling) and existing test patterns in cost-enricher.test.ts for this area.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/analytics/cost/cost-enricher.ts` — `enrichCosts()` (line ~402): phase 1 parses every session's native log concurrently into `ParsedEntry[]` (`parseOne`); phase 2+3 sorts entries by `startTime` ascending (`ordered`, line 412) and runs a **single sequential loop** over them with one shared `seen = new Set<string>()`. Per entry it calls `gatherDedupedUsageRecords(entry.agentName, entry.parsed, seen)` exactly once (line 433) — the per-turn, time-ordered path for claude/claude-acp/claude-desktop/codex/pi — falling back to `gatherUsageDeduped(entry.agentName, entry.parsed, seen)` (line 446) only when the per-turn reader returns no records (SDK rollup, gemini, no-reader agents). Both consume keys from the same `seen` set.
- `ParsedEntry` (cost-enricher.ts line 93) carries `startTime: raw.startEvent?.data?.startTime ?? 0`. It also carries `observedStart`/`observedEnd`, but these are populated **only when `capture` (the `INTERNAL_PARSED_FAMILY` native-discovery snapshot) is present** (lines 118-121) — i.e. only for the native-discovery capture path exercised by the "transports actual captured bounds" test. For an ordinary CodeMie-tracked session (the resumed/`codemie-claude --continue` case this ticket is about), `raw.endEvent` is never read into `ParsedEntry` at all today.
- `src/cli/commands/analytics/data-loader.ts` — `loadSession()` (line ~206) builds `RawSessionData.endEvent` **only when** `sessionMetadata.status === 'completed' && sessionMetadata.endTime` (line 241); an in-progress/open session has `endEvent === undefined`. `startEvent.data.startTime` is always present. This is the concrete shape behind the task's "endTime: null" framing — it is actually "endEvent absent", not a literal null field.
- `src/cli/commands/analytics/cost/usage-readers.ts`:
  - `UsageRecord` (line 79): `{ key: string | null; ts: number | null; model; usage; ownerAgentId? }` — `ts` is the record's own epoch-ms timestamp (`record.timestamp` from the task description), already extracted per-reader (Claude: `Date.parse(raw.timestamp)`, line 200; Codex/Pi similarly).
  - `takeUnseenRecords(records, seen)` (line 143) is the actual dedup mechanics: walks records in extraction order, and for each keyed record either skips it (`seen.has(key)`) or claims it (`seen.add(key)`) — order of iteration, not record timestamp, decides the winner. Because the outer `enrichCosts` loop visits sessions by `startTime` ascending and calls this once per session, the earliest-started session always wins ties.
  - `gatherDedupedUsageRecords` (line 906) and `gatherUsageDeduped` (line 859) are explicitly documented "MUST be called at most once per session against a shared `seen` set (it consumes keys)" (line 904 doc comment).
  - `extractClaudeUsageRecords` (line 167) walks the session's own main transcript **and every `parsed.subagents` entry** in one pass, tagging each record with `ownerAgentId` resolved via `buildClaudeOwnership(parsed)` (claude-ownership.ts) — a session-LOCAL transcript-ownership graph (main transcript vs. its own subagent dispatches), unrelated to which CodeMie *session* eventually owns the record.
- `src/cli/commands/analytics/cost/claude-ownership.ts` — `buildClaudeOwnership(parsed)` builds `responseOwners`/`responseCandidates`/`toolOwners` maps strictly from the one `ParsedSession` family passed in (main + its subagents); it has no notion of other CodeMie sessions.
- `src/cli/commands/analytics/cost/claude-dispatch-allocation.ts` — `enrichClaudeDispatchCosts(dispatches, parsed, records, cost)` consumes exactly the `records` array `gatherDedupedUsageRecords` returned for *this* session (already post-dedup). `recordsByOwner(records)` groups by `ownerAgentId`; `buildClaudeTraceIndex(parsed)` (claude-trace.ts) builds the subagent ancestry tree from the same `parsed` family. Allocation to agent/skill dispatches (`allocateFamily`, `subtreeOwners`, `priceAllocation`) is purely a function of `(records, parsed)` for one session — it never touches `seen` or looks at any other session's data.
- `src/cli/commands/analytics/cost/dispatch-allocation.ts` — `enrichSkillDispatchCost(dispatch, sessionRecords)` already does an **intra-session time-window match**: `sessionRecords.filter(r => r.ts != null && r.ts >= dispatch.start && r.ts <= dispatch.start + dispatch.durationMs)` (line 19). This is the existing, working precedent for "use `record.ts` against a `[start, end]` window" — but scoped to one session's own skill-dispatch window, not cross-session.
- `src/cli/commands/analytics/cost/cost-enricher.ts` dispatch wiring (lines 516-530): `extractDispatchResult(entry.parsed, entry.agentName)` (dispatch-extractor.ts) builds the dispatch list; Claude-family sessions go through `enrichClaudeDispatchCosts`, everything else through the local `enrichDispatchCosts` (same file, line 330) which also allocates from `sessionRecords` by owner/toolUseId, not by cross-session time window.

### Architecture and Layers Affected

- **CLI analytics layer** (`src/cli/commands/analytics/`): `data-loader.ts` (raw session/metrics loading) → `cost/cost-enricher.ts` (orchestration, the `seen`-threaded loop) → `cost/usage-readers.ts` (per-agent extraction + dedup primitives) → `cost/dispatch-allocation.ts` / `claude-dispatch-allocation.ts` (intra-session subagent/skill cost attribution) → `cost/cost-calculator.ts` + `@/utils/pricing.ts` (pricing).
- No router/CLI-command, DB/ORM, or external-service layer is touched by this fix — it is entirely inside the report-time enrichment pipeline, operating on already-parsed, in-memory `ParsedSession`/`RawSessionData` objects.

### Integration Points

- `AgentRegistry` / `SessionAdapter.parseSessionFile` (via `resolveSessionAdapter`, cost-enricher.ts line 47) supplies the native-log parse; this fix does not change parsing, only post-parse attribution.
- `~/.codemie/sessions/{id}.json` correlation files are the source of `agentSessionFile`/`startEvent`/`endEvent` for CodeMie-tracked sessions (via `data-loader.ts`); native-discovered sessions carry `agentSessionFile` directly plus, in some paths, an `INTERNAL_PARSED_FAMILY` capture with its own `observedStart`/`observedEnd`.

### Patterns and Conventions

- Dedup-by-mutating-shared-`Set<string>` is the established cross-session pattern (`seen`), explicitly documented as single-pass-only.
- Record-level time windowing (`r.ts >= start && r.ts <= end`) already exists at the intra-session skill-dispatch level (`dispatch-allocation.ts`) as the closest in-repo precedent for the requested inter-session windowing.
- `ownerAgentId` is a session-LOCAL identity (resolved against one session's own `ClaudeOwnership`/`ClaudeTraceIndex`); it is not meaningful across sessions. Any redesign that moves a `UsageRecord` from the session that extracted it to a different session (to re-attribute by time window) must account for the fact that `ownerAgentId`, `responseOwners`, and the trace index built in `claude-dispatch-allocation.ts` are all keyed against the *extracting* session's own `parsed` family, not the session it might be reassigned to.

---

## 3. Documentation Findings

### Guides and Architecture Docs

No `.ai-run/guides/` entry specific to analytics cost enrichment was found; the Task Classifier's `test`/`development-practices` guides are generic and do not cover this module. `docs/superpowers/investigations/2026-10-13-EPMCDME-15316-findings.md` (the task's named source) is the authoritative design input — see Section 8.

### Architectural Decisions

- Inline doc comments in `cost-enricher.ts` (lines 409-414, 427-432) and `usage-readers.ts` (lines 138-155, 899-905) record the deliberate design intent behind the current single-pass, earliest-wins dedup — "Intent was to avoid double-counting replayed turns; side effect is per-session zeros" (mirrored verbatim in the investigation doc).
- `claude-dispatch-allocation.ts` line 328-329 (dispatch-allocation.ts) documents the "ALLOCATION, don't add to `seen`" invariant for subagent/skill cost attribution — a constraint any Root-Cause-A fix must not disturb.

### Derived Conventions

- Every reader that supports cross-session dedup (Claude, Codex, Pi) returns `UsageRecord[]` with a nullable `key` and nullable `ts`; "unkeyable ⇒ always counted" and (per the task's framing) "untimed ⇒ fallback to earliest-owner" are both already load-bearing assumptions in existing tests (see Section 4).

---

## 4. Testing Landscape

### Existing Coverage

All in `src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts` (vitest):
- `'dedupes the same API response across resumed sessions (counts once, earliest owns it)'` (line 217): two sessions, `startTime: 1000` / `2000`, shared record carries **no `timestamp` field at all** (`ts` resolves to `null`). Asserts A owns the full shared record, B only its unique one. Any fix must keep this passing — it is the explicit "untimed record falls back to earliest-owner" case.
- `'sub-agent records join the cross-session dedup (replayed response counted once)'` (line 395) — **one of the two tests broken by the prior attempt**. Sessions `A`/`B` have `startTime: 1000`/`2000`; the shared record carries a real-looking `timestamp: '2026-06-08T10:00:00Z'` (parses to ≈1.75×10¹² ms) living inside A's *subagent* transcript and B's *main* transcript. The tiny `startTime` values bear no relation to the real `ts`, so any window built from `[1000, 2000)` etc. cannot contain the real timestamp — this case must also degrade to earliest-owner.
- `'never reintroduces another session's accepted responses into agent allocations'` (line 704, note the test title uses a Unicode right single quote `’`) — **the second test broken by the prior attempt**. Three sessions `first`/`second`/`third` with `startTime: 0/1/2`; a shared record with a real epoch timestamp lives in `first`'s main transcript and is replayed into `second`'s and `third`'s *subagent* transcripts. Exercises `enrichClaudeDispatchCosts`/`recordsByOwner`/`subtreeOwners` jointly with cross-session dedup — the exact dispatch-allocation + dedup interaction named in the task.
- `'attributes cost to a skill dispatch from the session's own usage records in its time window'` (line 537) is the existing precedent test for intra-session `r.ts` windowing against `dispatch.start`/`durationMs`.
- `'transports actual captured bounds...'` (line 27) is the only test that currently populates `ParsedEntry.observedStart`/`observedEnd` (via the `INTERNAL_PARSED_FAMILY` capture path, with explicit `endEvent.data.endTime`).

### Testing Framework and Patterns

- Vitest, dependency-injected `EnricherDeps` (no fs/registry), `as never` casts to shape minimal fake `RawSessionData`/`ParsedSession` objects. Sessions sharing one native log are simulated by giving each `RawSessionData` entry its own `sessionId` plus a `parseNative` dependency that returns different `messages`/`subagents` payloads per `sessionId` — not by literally sharing one file path.
- A recurring test idiom in this suite: `startTime` values are small synthetic integers (0, 1, 1000, 2000) while record timestamps use real 2026 ISO strings — this means in the CURRENT suite, any time-window computed from `startTime`/`endTime` as currently represented will never contain the real record timestamps, so these tests already exercise (and depend on) the "window attribution falls outside every window ⇒ earliest-owner" branch rather than the "inside a window" branch.

### Coverage Gaps

- No existing test constructs session `startTime`/`endTime` and record `ts` on a **consistent, overlapping real-epoch scale** — i.e. there is no test today that exercises the "record's timestamp actually falls inside session B's window" branch the task's fix is meant to add. A correct fix will need new tests of that shape (not found in the current suite).
- No existing test exercises an **open session (`endEvent` absent) sharing a log with a later session** — the "upper bound = next sharing session's startTime, or now" rule has no test precedent in this file.
- No test currently threads `raw.endEvent`/`observedEnd` into `ParsedEntry` for a *non-captured-family* (ordinary CodeMie-tracked) session — only the native-discovery capture path exercises `observedEnd`.

---

## 5. Configuration and Environment

### Environment Variables

None specific to this module; cost enrichment reads only in-memory `RawSessionData`/`ParsedSession` objects and `~/.codemie/sessions/*.json` correlation files via `getCodemiePath()` (`@/utils/paths.ts`). No env var gates this behavior.

### Configuration Files

None specific to session-attribution/dedup; pricing itself is table-driven (`@/utils/pricing.ts`, not read during this research pass since it is out of scope for Root Cause A).

### Feature Flags and Deployment Concerns

None found. This is pure report-time (CLI `codemie analytics`) logic with no runtime toggle, server component, or deployment manifest involvement.

---

## 6. Risk Indicators

- **Architectural coupling risk (the one that broke the prior attempt):** `ownerAgentId`, `ClaudeOwnership.responseOwners`, and `ClaudeTraceIndex` (used by `claude-dispatch-allocation.ts`) are all built from one session's own `parsed` family. Speculative: any fix that reassigns an already-extracted `UsageRecord` from the session that produced it to a different, later-processed session (to honor its time window) must re-derive or re-tag `ownerAgentId`/trace relationships for that record's new owning session, or dispatch/subagent allocation for the receiving session will silently fail to find the record's owner (falling into the existing "ambiguous"/"unavailable" `attributionStatus` branches) or, worse, attribute it to the wrong subagent lineage.
- **Single-pass invariant:** `gatherDedupedUsageRecords`/`gatherUsageDeduped` are explicitly documented as callable at most once per session against the shared `seen` set. Speculative: a design that needs to "look ahead" at other sessions' windows before deciding ownership (e.g. to find the next sharing session's `startTime` as an open session's upper bound) will need that lookahead to happen without a second extraction call per session, to avoid re-consuming or double-mutating `seen`.
- **Incomplete end-time plumbing today:** `ParsedEntry.startTime`/`observedEnd` as currently wired do not reliably carry `raw.endEvent.data.endTime` for ordinary (non-captured-family) sessions — `observedEnd` is gated on the `INTERNAL_PARSED_FAMILY` capture being present. A time-window fix needs a session's end time available independent of that gate.
- **No real-epoch-window test precedent:** every existing cross-session dedup test uses synthetic, non-overlapping `startTime` scales (0/1/2, 1000/2000) that happen to never intersect the real record timestamps used in the same tests — meaning the current suite cannot by itself validate the "inside a window" branch of a windowed fix; new tests are needed to cover that branch without accidentally relying on the same synthetic-scale coincidence that keeps old tests passing.
- **Open-session upper bound is unmodeled:** `RawSessionData.endEvent` is `undefined` (not a literal `endTime: null`) for any session still in progress; nothing in `cost-enricher.ts` currently computes "the next session sharing this file" as a concept at all.

---

## 7. Summary for Complexity Assessment

This change is confined to one architectural layer — the CLI analytics report-time cost-enrichment pipeline (`src/cli/commands/analytics/cost/`) — with no router, persistence, or external-service surface. The core touch point is `enrichCosts`'s single sequential loop in `cost-enricher.ts`, its shared `seen: Set<string>` threaded through `gatherDedupedUsageRecords`/`gatherUsageDeduped` (`usage-readers.ts`), and the `ParsedEntry` shape that currently under-populates session end times for non-captured-family sessions. The realistic file-change surface is small (2-4 files: `cost-enricher.ts`, `usage-readers.ts`, possibly `types.ts` for a new end-time field, plus the test file) but the logic is subtle: dedup ownership, time-window attribution, and intra-session subagent/skill cost allocation (`dispatch-allocation.ts`, `claude-dispatch-allocation.ts`) are currently cleanly separated by the invariant that one session's `gatherDedupedUsageRecords` call returns records it fully owns, with `ownerAgentId`/trace-index relationships scoped to that same session's own parsed family.

The technical novelty is moderate-to-high: the fix must change *which* session a dedup-surviving record belongs to (based on `record.ts` vs. a `[startTime, endTime]` window) without changing *how many times* it is counted (the global `seen` set must still gate exactly once per key) and without breaking the downstream assumption that the records handed to subagent/skill allocation for a session are drawn from that same session's own transcript family. The two previously-broken tests ('sub-agent records join the cross-session dedup' and 'never reintroduces another session's accepted responses into agent allocations') are the sharpest signal of where a naive two-phase (dedup-then-reattribute) redesign collides with the ownerAgentId/trace-index coupling described above.

Test coverage for the exact scenario this task targets (sessions whose `startTime`/`endTime` genuinely overlap the real timestamps of the records they should win) does not exist yet; all current cross-session dedup tests use a synthetic time scale that happens to make every window computation fall through to the pre-existing earliest-owner fallback, which is also the main latent risk: it is easy to write a "fix" that passes the existing suite by never actually exercising the new in-window attribution branch at all.

---

## 8. External References

- `docs/superpowers/investigations/2026-10-13-EPMCDME-15316-findings.md` (resolved, read in full). Facts used directly in this analysis and relevant to the fix: Root Cause A section (lines 310-373) states the mechanism ("Claude Code keeps appending to the same JSONL... enrichCosts sorts sessions by startTime and dedups records by (message.id, requestId) in a single seen set — so the earliest session takes every record in the file"), the evidence table of real sessions showing in-window-but-$0 responses, the three possible fixes (time-window attribution preferred; narrow per-file-split alternative; open-session upper-bound rule referencing ticket EPMCDME-15536), and the reproduction steps including the `check-a.js` Node script that detects the bug pattern on an exported `codemie analytics --export json` report by comparing each session's `[startTime, startTime+durationMs]` window against the shared log's unique, already-deduped API responses. The doc also documents an unrelated Root Cause B (bare Bedrock model id pricing) and Issue 1 (expired-SSO-session HTML leakage) which are explicitly out of scope for this task.
