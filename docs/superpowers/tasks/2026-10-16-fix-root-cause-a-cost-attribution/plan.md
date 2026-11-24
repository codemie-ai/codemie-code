# Plan — Fix Root Cause A: shared Claude log credited entirely to the earliest session

Commit per task using the repository's existing convention.

## Design (read before coding)

`enrichCosts` (`src/cli/commands/analytics/cost/cost-enricher.ts:402-460`) processes sessions in
`startTime` order against one shared `seen` Set. When N CodeMie sessions share one native log file
(Claude keeps appending across `--continue`/`--resume`), parsing that file for *any* of them returns
the full, identical content — so the earliest-processed session's `gatherDedupedUsageRecords`/
`gatherUsageDeduped` call greedily claims every key in the file via `takeUnseenRecords`, including
turns that happened during a later session.

**Mechanism:** give each session's own dedup call a pre-filter — keep a candidate record only if its
`ts` is `null` (unkeyable-by-time, existing fallback) **or** strictly before that session's own
`observedEnd`. A session with no confirmed `observedEnd` keeps every candidate unchanged (today's
behavior) — it is simply not able to steal records that a *later*, properly-bounded session's filter
has excluded for itself. This requires no sibling bookkeeping and no second extraction call: `seen`
is still mutated by exactly one `takeUnseenRecords` call per session, in the existing ascending-order
loop. `observedEnd` is read from each session's own `raw.endEvent` — currently gated behind the
`INTERNAL_PARSED_FAMILY` capture path for no real reason (that's the "general case" gap in criterion
6); removing the gate is what makes this available for ordinary resumed/continued sessions.

**Verified by hand-tracing against the two protected tests** (`sub-agent records join the
cross-session dedup...`, `never reintroduces another session's accepted responses...` in
`cost-enricher.test.ts`): neither session in either test sets `endEvent`, so neither gets an
`observedEnd`, so the new filter is a no-op for both — they fall through to exactly today's
ascending-order/`seen` behavior, which is what both already assert. An earlier design that bounded a
session with *no own* `observedEnd` using "next sibling's startTime" was traced against the same two
tests and found to invert their outcome (the synthetic `startTime`s there are unrelated in scale to
the real timestamps the records carry) — that approach is **rejected**; do not reintroduce it as the
basis for the dedup filter.

`cost.observedEnd`'s own "next sibling's startTime, or now" fallback (acceptance criterion 4) is
display-only (task 4) — it is never read by the dedup filter above.

## Tasks

### 1. Populate `ParsedEntry.observedEnd` for ordinary sessions, not just captured ones

`cost-enricher.ts:113-122` (`parseOne`) only reads `raw.endEvent` into `observedEnd` when
`INTERNAL_PARSED_FAMILY` capture (`capture`) is also present. Drop the `capture &&` guard on the
`observedEnd` spread (line ~121) so any session with a real `raw.endEvent.data.endTime` gets
`observedEnd` populated regardless of capture. Leave `observedStart`'s existing capture-gated line
untouched — this task only concerns the end time.

Test-first: yes — a session with `startEvent.data.startTime` and `endEvent.data.endTime` but **no**
`[INTERNAL_PARSED_FAMILY]` entry currently reports `index.get(id).observedEnd === undefined`; add a
case to `cost-enricher.test.ts` asserting it equals `endTime` instead. (The existing "transports
actual captured bounds..." test, which does set capture, must keep passing unchanged.)

### 2. Window-filter cross-session dedup candidates by each session's own `observedEnd`

Add a helper to `usage-readers.ts` near `takeUnseenRecords` (`usage-readers.ts:143-155`):

```ts
/** Keep only records this session's own window can plausibly own: untimed ones (existing
 * earliest-owner fallback) or ones before `windowEnd` (this session's own observed end).
 * `windowEnd` undefined ⇒ no filtering, preserving today's behavior for an unbounded session. */
function withinWindow(records: UsageRecord[], windowEnd: number | undefined): UsageRecord[] {
  if (windowEnd === undefined) return records;
  return records.filter((r) => r.ts === null || r.ts < windowEnd);
}
```

Add an optional 4th parameter `windowEnd?: number` to `gatherDedupedUsageRecords` (`usage-readers.ts:906`)
and `gatherUsageDeduped` (`usage-readers.ts:859`). Wrap each of the five `takeUnseenRecords(extract...(parsed), seen)`
call sites that do cross-session dedup — lines ~880, ~891 (`gatherUsageDeduped`'s pi/claude branches)
and ~913, ~916, ~924 (`gatherDedupedUsageRecords`'s codex/pi/claude branches) — as
`takeUnseenRecords(withinWindow(extract...(parsed), windowEnd), seen)`. Leave the session-local
readers (gemini/kimi/copilot-cli) and the authoritative SDK-rollup branch untouched — they never
touch `seen`. In `cost-enricher.ts`, pass `entry.observedEnd` as the new argument at both call sites
(`cost-enricher.ts:433` and `:446`).

Promote the existing scratch reproduction (`src/cli/commands/analytics/cost/__tests__/repro-root-cause-a.test.ts`,
currently uncommitted and explicitly marked "not part of the permanent suite") into a permanent test
in `cost-enricher.test.ts` — same two-session, one-shared-file scenario (session A has `endEvent`
bounding its one real turn; session B has no `endEvent` and two later real turns) — then delete the
scratch file. Keep its assertions (B gets its own 1,000,000 tokens / ~$3, not $0; total unchanged).

Test-first: yes — the promoted test is currently failing on `main` (that's the bug); it must pass
after this task. Also re-run (unmodified) `sub-agent records join the cross-session dedup...` and
`never reintroduces another session's accepted responses...` and confirm both still pass byte-for-byte
with no edits to the test file.

### 3. Add coverage for a middle session in a three-session shared-file chain

New test in `cost-enricher.test.ts`: three sessions share one `agentSessionFile`; session 1 has its
own `endEvent` ending before session 2 starts; session 2 also has its own `endEvent` ending before
session 3 starts (open, no `endEvent`); each of the three has one uniquely-keyed real turn inside its
own window (realistic overlapping epoch-ms, not the 0/1/2 or 1000/2000 scale used elsewhere in the
suite). Assert session 1 and session 2 each report their own turn's cost (neither $0, and session 1
does not absorb session 2's or session 3's), matching the findings doc's documented
`65a9f5ff`/`f7027292`/`dc7ecd7f`-shaped evidence. No source change in this task — it exercises task 2's
filter from a third angle (a *bounded, non-terminal* middle session, not just a two-session open tail).

Test-first: yes — write the failing test against pre-task-2 behavior first if sequencing allows, or
immediately after task 2 as regression coverage; either way it must fail without task 2's filter and
pass with it.

### 4. Report an upper-bound `observedEnd` for an open session sharing a file (display only)

In `enrichCosts`, after `ordered` is built (`cost-enricher.ts:412`), group entries by `filePath` where
more than one entry shares it, sorted by `startTime`. For an entry whose own `observedEnd` is still
`undefined` after task 1 and that belongs to such a group, set the *reported* `cost.observedEnd`
(`cost-enricher.ts:457-459`) to the next sibling's `startTime` if one exists, else to the current wall
clock time. This value is cosmetic — it must not be threaded into task 2's `windowEnd` argument; doing
so was traced to break the two protected tests (see Design).

Test-first: yes — two sessions share one `agentSessionFile`, neither has `endEvent`: assert the
earlier one's `cost.observedEnd` equals the later one's `startTime`; assert the later (last-in-group)
one's `cost.observedEnd` is a defined number `>=` its own `startTime` (avoid a flaky exact `Date.now()`
match).

## Negative constraints checked

- Out of scope (Root Cause B / `model-normalizer.ts`, SSO/proxy session-expiry code): no task touches
  either file or directory.
- "Preserve global dedup semantics exactly, single-pass `seen`": task 2 adds a pre-filter *before* the
  existing single `takeUnseenRecords` call per session; no second extraction, no new `seen` mutation
  site.
- "Must not break the dispatch/subagent allocation invariant": no task touches `dispatch-allocation.ts`,
  `claude-dispatch-allocation.ts`, or `claude-ownership.ts`. The `records` array those files consume is
  still exactly what that same session's own `gatherDedupedUsageRecords` call returns — only narrower,
  never reassigned post-hoc from another session's extraction.
