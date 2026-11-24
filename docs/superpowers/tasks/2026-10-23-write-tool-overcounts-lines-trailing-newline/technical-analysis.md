# Technical Research

**Task**: claude-file-operation line-count analytics write-tool otlp session-signals (EPMCDME-16306)
**Generated**: 2026-10-24
**Research path**: filesystem (codegraph MCP not available in this environment)

---

## 1. Original Context

EPMCDME-16306 [CLI Analytics][Production] Write tool overcounts added lines by 1 when a file ends with a newline.

Description: CLI Analytics incorrectly reports the number of added lines when Claude Code creates a file using the Write tool. When the file ends with a newline (\n), the collector counts one extra line. The incorrect value is then displayed in Production Analytics.

Root Cause (confirmed by reporter):
- Source file: src/agents/plugins/claude/session/claude-file-operation.ts
- Function: extractClaudeFileOperation()
- Installed JS: claude-file-operation.js:42
- Current implementation: fileOp.linesAdded = content.split('\\n').length;
- When content ends with \n, split creates an extra empty element, e.g. "a\nb\n".split('\n') gives ["a", "b", ""] → 3 instead of 2.
- The OTLP transcript collector already handles trailing newlines correctly via countContentLines() in claude-code-otlp/transcript/session-signals.ts.
- The Edit operation is unaffected because it uses structuredPatch.

Acceptance criteria:
1. Write correctly counts lines with and without trailing newlines.
2. Empty files, single-line files, blank lines, and CRLF line endings are handled correctly.
3. Edit line counting remains unchanged.
4. Live collection, native session re-parsing, and OTLP collection produce consistent line counts.
5. Session details and aggregated metrics (Overview, Efficiency, Repositories) display the correct values.
6. Automated regression tests cover the affected scenarios.

Recommended Fix: Reuse the existing countContentLines() logic from the OTLP collector, ideally through a shared helper, to ensure consistent counting across collection paths.

---

## 2. Codebase Findings

### Existing Implementations

**Buggy implementation** — `src/agents/plugins/claude/session/claude-file-operation.ts`

Interface (lines 12-20):
```ts
export interface ClaudeFileOperation {
  type: string;
  path?: string;
  format?: string;
  language?: string;
  pattern?: string;
  linesAdded?: number;
  linesRemoved?: number;
}
```

`extractClaudeFileOperation()` line-counting logic (lines 71-91):
```ts
71	  if (toolName === 'Write') {
72	    const content = res.content || res.file?.content || inp.content;
73	    if (content) {
74	      fileOp.linesAdded = content.split('\n').length;
75	    }
76	  } else if (toolName === 'Edit' && Array.isArray(res.structuredPatch)) {
77	    let added = 0;
78	    let removed = 0;
79	    for (const patch of res.structuredPatch) {
80	      if (Array.isArray(patch.lines)) {
81	        for (const line of patch.lines) {
82	          if (typeof line === 'string') {
83	            if (line.startsWith('+')) added++;
84	            else if (line.startsWith('-')) removed++;
85	          }
86	        }
87	      }
88	    }
89	    if (added > 0) fileOp.linesAdded = added;
90	    if (removed > 0) fileOp.linesRemoved = removed;
91	  }
```

- **Write** (line 74): `content.split('\n').length` — confirmed buggy; overcounts by 1 whenever `content` ends with `\n` (including `\r\n`-terminated content, since `\r\n` still ends in `\n`).
- **Edit** (lines 76-90): diff-hunk based (`structuredPatch`), counts `+`/`-` prefixed lines — not newline-split based, confirmed unaffected by this bug, must remain unchanged.
- **MultiEdit**: `TOOL_TYPE_MAP` (lines 23-29) maps only `Read`, `Write`, `Edit`, `Grep`, `Glob` — `MultiEdit` is not in the map at all, so `extractClaudeFileOperation('MultiEdit', ...)` returns `undefined`. There is currently no line-counting code path for MultiEdit to fix (acceptance criteria mentions MultiEdit by name in feature_area context but there is no existing implementation to change — flagged as a scope question, not a code change).

Consumers of `extractClaudeFileOperation`:
- `src/agents/plugins/claude/claude.session.ts:21,359`
- `src/agents/plugins/claude/session/processors/claude.metrics-processor.ts:18,333`

Type usage: `ClaudeFileOperation` is exported and imported as a type in `claude.session.ts:21`; consumed (not re-declared) via the extractor function in `claude.metrics-processor.ts`.

**Correct implementation (reference)** — `src/agents/plugins/claude-code-otlp/transcript/session-signals.ts`

Lines 69-74:
```ts
69	/** Lines in a file body; a trailing newline does not start another line. */
70	function countContentLines(content: string): number {
71	  if (content.length === 0) return 0;
72	  const lines = content.split('\n').length;
73	  return content.endsWith('\n') ? lines - 1 : lines;
74	}
```
- Not exported (module-private). Used at line 103 inside `collectEditLineStats()` (lines 83-112) for the `'create'` operation type.
- `collectEditLineStats()` also handles `structuredPatch`-based counting via `countPatchLines()` (lines 54-67) — same `+`/`-` prefix logic as the Edit branch in `claude-file-operation.ts`, independently implemented.
- `session-signals.ts` has zero import statements — it is a pure, self-contained module per its header comment ("Pure functions over already-parsed main-transcript lines... No I/O").
- Return shape `EditLineStats` (`{ linesAdded: number | null; linesRemoved: number | null }`) is structurally distinct from `ClaudeFileOperation` — not currently shared between the two plugins.

### Architecture and Layers Affected

- Both files are **Plugin-layer** modules per `.ai-run/guides/architecture/architecture.md`: `claude-file-operation.ts` belongs to the `claude` chat-agent plugin (`src/agents/plugins/claude/session/`); `session-signals.ts` belongs to the `claude-code-otlp` OtlpAgentAdapter plugin (`src/agents/plugins/claude-code-otlp/transcript/`).
- Architecture rule (architecture.md L147-153, L255): "Plugin Isolation — plugins do not depend on each other"; Plugin → Plugin direct calls are **Not Allowed**. The dependency flow is `CLI → Registry → Plugin → Core → Utils`, with "All layers → Utils" allowed.
- **Implication**: `claude-file-operation.ts` directly importing from `claude-code-otlp/transcript/session-signals.ts` (or vice versa) would violate plugin isolation. The architecturally correct fix is to lift `countContentLines()` into the **Utils layer**, not to import one plugin's internals from another.
- Layers touched by the fix: Plugin layer (`claude` session extraction) + Utils layer (new/extended shared helper). The OTLP plugin layer is touched only if its private helper is refactored to delegate to the new shared utility (recommended for true single-source-of-truth per the ticket's acceptance criterion 4, but the minimal fix only requires changing the Claude side).

### Integration Points

- `src/utils/file-operations.ts` is **already imported by `claude-file-operation.ts`** (line 10: `import { extractFormat, detectLanguage } from '../../../../utils/file-operations.js';`). It currently exports only `extractFormat()` and `detectLanguage()` (path-string utilities) — no line-counting helper yet. This is the natural existing shared home for a new `countContentLines()` export, reachable from both plugin trees at the same relative import depth.
- `session-signals.ts` has no imports at all currently, so wiring it to `src/utils/file-operations.ts` is a net-new (but architecturally correct) dependency, not a refactor of an existing one.
- No existing `src/agents/core/` or `claude/shared/` module currently bridges these two plugin trees for this concern.

### Patterns and Conventions

- Pure-function, no-I/O style for line-counting helpers (both existing implementations are side-effect-free).
- `structuredPatch`/diff-hunk counting (`+`/`-` prefix scan) is duplicated independently in both files for Edit-type operations — out of scope for this bug (acceptance criterion 3: Edit counting must remain unchanged) but worth noting as a second, separate duplication that is not part of this fix.
- Similar (currently independent, same-shaped) off-by-one bugs exist in sibling agent plugins outside the stated scope:
  - `src/agents/plugins/pi/session/pi-file-operations.ts:98` — `operation.linesAdded = normalized.split('\n').length;`
  - `src/agents/plugins/opencode/session/processors/opencode.metrics-processor.ts:500` — `fileOp.linesAdded = content.split('\n').length;`
  - `src/agents/plugins/gemini/session/processors/gemini.metrics-processor.ts:292,295` — `fileOp.linesAdded = replacement.split('\n').length;` / `fileOp.linesRemoved = content.split('\n').length;`
  - These are **not required** by the ticket (which scopes to Claude's Write path only) but are natural follow-on candidates if a shared Utils helper is introduced. Recommend flagging as out-of-scope-but-related in the plan, not silently fixing them.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — confirms the 5-layer plugin architecture and the "no Plugin → Plugin calls" rule (see Section 2 above). Directly informs where the shared helper should live (Utils, not cross-plugin import).
- `.ai-run/guides/testing/testing-patterns.md` — confirms Vitest, co-located `__tests__/*.test.ts` convention, and a dynamic-import mocking pattern for module-level spies (not needed here since both functions under test are pure, unmocked). Notes a 90%+ coverage target for critical/core logic, relevant since this is analytics-affecting logic.

### Architectural Decisions

- No ADRs found specific to line-counting. The existing `countContentLines()` docstring ("a trailing newline does not start another line") is the only recorded design rationale, embedded as a code comment rather than a formal decision record.
- No existing spec/plan/technical-analysis document exists yet in the run directory prior to this file — confirmed only `.state.json` was present (sdlc-light flow, phase "main", branch `EPMCDME-16306_write-tool-line-count-overcount`), so this is the first design artifact for the fix.

### Derived Conventions

- Line-counting helpers in this codebase are written as small, pure, synchronous functions with explicit comments documenting edge-case handling (see `countContentLines`'s docstring).
- Shared cross-plugin utilities belong in `src/utils/`, and existing plugins already import ES-module-style with explicit `.js` extensions and relative-path depth matching their folder nesting (e.g. `../../../../utils/file-operations.js` from `src/agents/plugins/claude/session/`).

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/claude/session/__tests__/claude-file-operation.test.ts` (38 lines, Vitest, only test file for this module):
  - Write: content `'a\nb\nc'` (no trailing newline) → asserts `linesAdded: 3`. **No trailing-newline case exists.**
  - Edit: `structuredPatch`-based `linesAdded`/`linesRemoved` assertion.
  - Edit: `path` resolution from `toolUseResult.filePath`.
  - Non-file tool (Bash) → `undefined`.
  - No MultiEdit test case (matches the source's lack of a MultiEdit code path).
- `src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts` (269 lines, Vitest):
  - `countContentLines` is not directly exported/tested; exercised indirectly via `collectEditLineStats`'s `'create'` branch, `describe('collectEditLineStats', ...)` block (lines 46-70), specifically lines 61-70:
    ```ts
    expect(collectEditLineStats([create('a\nb\nc')]).linesAdded).toBe(3);
    expect(collectEditLineStats([create('a\nb\nc\n')]).linesAdded).toBe(3);   // trailing-newline case
    expect(collectEditLineStats([create('')]).linesAdded).toBe(0);           // empty string case
    expect(collectEditLineStats([create('a\nb')]).linesRemoved).toBe(0);
    ```
  - These cases already cover trailing-newline and empty-string scenarios for the OTLP path — a template to mirror for the Claude-side fix.
  - No CRLF-specific test case exists in either file.
  - No explicit blank-line-in-the-middle test beyond the implicit coverage of multi-line strings.

### Testing Framework and Patterns

- Vitest confirmed project-wide (`import { describe, it, expect } from 'vitest';`).
- Pure-function tests use plain `expect`/`toBe`/`toMatchObject` with no mocking — both target functions are side-effect-free, so no dynamic-import mocking pattern is needed for this fix's tests.
- Co-located `__tests__/` directories alongside the source file are the established convention.

### Coverage Gaps

- No trailing-newline test for the Write path in `claude-file-operation.test.ts` — this is the exact scenario the ticket reports as broken, and it is currently untested (confirms the bug could ship undetected).
- No CRLF test case in either test file — acceptance criterion 2 explicitly requires CRLF handling verification; this must be added net-new to both the implementation verification and the test suite.
- No empty-file or single-line-file test for the Write path specifically (the OTLP side has an empty-string case; Claude side does not).
- No MultiEdit coverage at all (matches the absence of implementation).

---

## 5. Configuration and Environment

### Environment Variables

None identified as relevant to this fix — this is pure in-process line-counting logic with no env-var-gated behavior.

### Configuration Files

None identified as relevant — no feature flags or config files govern this code path.

### Feature Flags and Deployment Concerns

None identified. This is a pure logic fix with no deployment-surface changes; downstream consumers (Session details, Overview/Efficiency/Repositories aggregated metrics per acceptance criterion 5) consume `linesAdded`/`linesRemoved` values that are already pushed through existing analytics pipelines — no new config/deployment wiring is expected.

---

## 6. Risk Indicators

- No existing test coverage for the exact trailing-newline scenario in the Claude Write path — this is precisely the reported production bug, confirming a test gap that enabled it to ship.
- No CRLF-specific test exists in either implementation despite acceptance criterion 2 explicitly requiring CRLF correctness — must be added as new test cases, and CRLF behavior should be explicitly verified (current analysis shows `endsWith('\n')` is CRLF-safe for the trailing-newline check, but this has not been asserted by a test).
- Architectural constraint (Plugin Isolation, no Plugin → Plugin calls) means the fix cannot simply import `countContentLines` from `claude-code-otlp` into `claude-file-operation.ts` — it requires extracting the helper into `src/utils/file-operations.ts` (Utils layer) and updating both plugins to import from there, which is a slightly larger change than a one-line fix in `claude-file-operation.ts` alone, but necessary to satisfy acceptance criterion 4 (consistency across live/re-parse/OTLP paths) without violating architecture rules.
- `session-signals.ts`'s `countContentLines()` is currently module-private (no `export` keyword) — exporting it or extracting it to Utils is a required refactor, not just a call-site change, and must preserve the existing `collectEditLineStats()` behavior and its test suite (269 lines) without regression.
- `MultiEdit` has no existing code path in `claude-file-operation.ts` (`TOOL_TYPE_MAP` omits it entirely). The ticket's feature_area references "write-tool" and the acceptance criteria don't explicitly mention MultiEdit, but the task's broader framing (session re-parsing consistency) means this should be explicitly confirmed as out-of-scope with the product owner / ticket, not silently left unaddressed.
- Same-shaped off-by-one bugs exist independently in `pi-file-operations.ts:98`, `opencode.metrics-processor.ts:500`, and `gemini.metrics-processor.ts:292,295`. These are out of the ticket's stated scope (Claude-only) but represent latent identical bugs; a reviewer may ask whether the shared-helper fix should be propagated there too — flag this ambiguity for the plan/spec phase rather than deciding it here.
- No design doc existed prior to this file (only `.state.json` was present in run_dir) — this technical-analysis.md is the first research artifact for the fix; no prior architectural decision has been recorded about the "lift to Utils vs. export-and-import" approach, so the spec phase should make this choice explicit.
- Downstream display surfaces (Session details, Overview, Efficiency, Repositories per acceptance criterion 5) were not directly traced to specific component files in this research pass — confirmed only that `linesAdded`/`linesRemoved` values originate from `ClaudeFileOperation` and are consumed by `claude.session.ts` and `claude.metrics-processor.ts`; the research did not trace further downstream into analytics aggregation/display code. This should be verified during implementation if display-layer changes are suspected to be needed (likely not, since this is a pure data-correction fix, but not fully confirmed).

---

## 7. Summary for Complexity Assessment

This is a well-scoped, low-to-medium complexity bug fix confined almost entirely to the Plugin layer, with one architecturally significant twist: the correct fix logic already exists (`countContentLines()` in `src/agents/plugins/claude-code-otlp/transcript/session-signals.ts:69-74`) but is private to a sibling plugin, and the project's architecture explicitly forbids Plugin → Plugin direct imports. The clean implementation therefore touches 3-4 files rather than 1: (1) a new/extended export in `src/utils/file-operations.ts` (Utils layer, already imported by the buggy file), (2) the one-line fix in `claude-file-operation.ts:74` to call the new shared helper, (3) likely a refactor of `session-signals.ts` to delegate to the same shared helper (to satisfy the ticket's explicit "consistency across live/re-parse/OTLP" requirement) rather than keeping a duplicate private copy, and (4) new test cases in both existing `__tests__` files covering trailing-newline, empty-content, CRLF, and blank-line scenarios.

Technical novelty is low — no new patterns are introduced; the fix follows an established pure-function style already present in the codebase, and the target behavior (trailing-newline-aware line counting) is already implemented and tested on the OTLP side, serving as a ready-made reference and test template. The main judgment call for the spec/plan phase is scope: whether to (a) fix only the Claude Write path per the ticket's literal root-cause description, (b) also refactor `session-signals.ts` to consume the same shared helper for true single-source-of-truth (needed to satisfy acceptance criterion 4), and (c) whether to flag or silently ignore the identical latent bug in the Pi, OpenCode, and Gemini plugins (out of ticket scope but same bug shape).

Test coverage posture is mixed-but-favorable: both affected modules have existing Vitest suites with established patterns (pure-function assertions, no mocking needed), and the OTLP side's test file already contains the exact missing test cases (trailing-newline, empty-string) that need to be mirrored into the Claude-side test file. The primary risk factors for complexity scoring are the architectural-boundary consideration (Utils-layer extraction, not a simple one-line patch) and the scope-ambiguity around MultiEdit (no existing code path — likely a non-issue but should be explicitly confirmed) and the sibling-plugin duplicate bugs (explicitly out of scope per the ticket but worth a one-line mention in the plan to avoid surprising a reviewer).
