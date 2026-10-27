# Technical Research

**Task**: analytics framework-label factory stlc skill
**Generated**: 2026-10-27
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-16435 (Bug): [CLI Analytics][Sessions] Sessions started via STLC Factory skills are labeled "Pure chat" instead of a factory.

A session started by launching a factory must show the factory name in the Framework column of the Sessions table instead of "Pure chat". Works for SDLC Factory ("CodeMie AI Factory") and Superpowers, NOT for the QA factory (STLC Factory, gitbud.epam.com/epm-cdme/codemie-public-skills, branch feat/stlc-factory, ai-packages/stlc-factory). Four sessions started by /stlc-factory:exploratory, /stlc-feature, /stlc-factory:stlc-foundation, /stlc-factory:suite-health all show "Pure chat" in the table and the details header. /sdlc-factory:code-review and :feature-verification show "CodeMie AI Factory"; /superpowers:brainstorming shows "Superpowers". Details of suite-health show Skills = 1 while the header says "Pure chat". Client: Claude Code Desktop, ingestion via `codemie proxy connect --claude-code-otlp` (claude-code-otlp OtlpAgentAdapter, docs/ARCHITECTURE-OTLP-PLUGIN.md). First prompts are `/stlc-feature <url>` (no namespace prefix) and `/stlc-factory:<skill>`.

Expected: STLC Factory session labeled "STLC Factory" in Sessions table and details header; only non-factory sessions remain "Pure chat".

AC: 1) the four commands as first prompt yield the STLC Factory label. 2) Details header shows same. 3) SDLC Factory / Superpowers / Pure chat unchanged. 4) Other session data unchanged.

Research hint: find where the label is derived (src/), across OTLP hook path and local analytics path; note if resolved outside repo (codemie-preview).

---

## 2. Codebase Findings

### Existing Implementations
- `src/cli/commands/analytics/report/session-source-detector.ts` - the only label derivation found in this repo. Ordered first-match-wins `SESSION_SOURCE_DETECTORS` array of `{name,label,matches(names)}`. Names are lowercased skill + agent + command invocation names. Entries: `sdlc-factory` -> "CodeMie AI Factory" (prefix `sdlc-factory:` OR exact `sdlc-light|sdlc-task|sdlc-autonomous`), `superpowers` ("Superpowers", prefix `superpowers:`), openspec, speckit, bmad (substring). Fallback `PURE_CHAT_LABEL = 'Pure chat'`. No `stlc` entry exists. Helpers: hasPrefix, hasExact, hasSubstring.
- Precedent for unnamespaced commands: `SDLC_FACTORY_COMMANDS` exact-name list, comment "distinct from the namespaced prefix". `/stlc-feature` has the same shape.
- `src/cli/commands/analytics/report/payload-builder.ts:188` - sets `sessionSource: detectSessionSource({skillInvocations, agentInvocations, commandInvocations})`; `types.ts:38` declares `sessionSource: string`.
- `src/cli/commands/analytics/report/client/app.js` lines ~502, ~1068 - HTML report UI renders `s.sessionSource || 'Pure chat'` ("Frameworks - Compare" view groups by it). Label is data-driven, no hardcoded factory list.
- `src/agents/plugins/claude-code-otlp/event-fields/command-fields.ts` - `resolveCommandFields(prompt)` extracts leading slash command (`/x:y args` -> `x:y`; `/stlc-feature <url>` -> `stlc-feature`) as `command_name` on UserPromptSubmit. Docs say `agent.skill.dispatch` is the authoritative event for skill-backed commands.
- `src/agents/plugins/claude/session/claude-named-invocations.ts` - extracts named skill/agent/command invocations for the local Claude session path.

### Architecture and Layers Affected
CLI analytics report layer (`src/cli/commands/analytics/report/`): detector -> payload-builder -> client UI. OTLP adapter (`claude-code-otlp`) only emits command_name/skill fields; grep for framework/sessionSource/"Pure chat" in `src/agents/plugins/claude-code-otlp`, `src/providers`, and OTLP docs found no label derivation there.

### Integration Points
The "Sessions table" / "session details header" Framework column described in the ticket is not implemented under that name in this repo (only the `sessionSource` field in the local HTML report). Speculative: the ticket's Framework column is likely rendered by the backend/UI (codemie-preview), outside this repo, which may have its own detector; not verifiable here.

### Patterns and Conventions
Add a detector entry, not an if-chain (file header). Order matters (first match wins).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development, ...); no guide specific to session-source labeling was read. `docs/ARCHITECTURE-OTLP-PLUGIN.md` covers the OTLP adapter dispatch pattern. No "stlc" mention anywhere in src/ or docs/ (only the run's state file).

### Architectural Decisions
None found for session-source detection beyond the file header comment.

### Derived Conventions
Names lowercased; namespaced skills matched by prefix; unnamespaced commands by exact list.

---

## 4. Testing Landscape

### Existing Coverage
`src/cli/commands/analytics/report/__tests__/session-source-detector.test.ts` covers each detector, priority (sdlc over superpowers), case-insensitivity, fallback, and asserts the exact detector name list `['sdlc-factory','superpowers','openspec','speckit','bmad']` (line ~59). Also `payload-builder.test.ts`, `session-report.test.ts`, `report-views.test.ts`.

### Testing Framework and Patterns
Vitest; small `session({skill,agent,command})` helper builder.

### Coverage Gaps
No STLC cases. OTLP-sourced sessions into the report: not traced end to end here.

---

## 5. Configuration and Environment

### Environment Variables
None relevant found.
### Configuration Files
None; detectors are code constants.
### Feature Flags and Deployment Concerns
None found.

---

## 6. Risk Indicators

- Speculative: the reported Framework column (Sessions table + details header) may be computed in codemie-preview, so a fix in this repo might not change the reporter's UI. Needs owner confirmation.
- Unverified: whether OTLP-ingested sessions populate skill/command invocation names that reach `detectSessionSource`; ticket says suite-health shows Skills = 1, so skill names appear to exist, but the exact skill name form (`stlc-factory:suite-health` vs bare) is unconfirmed. The external STLC repo was not read.
- Speculative: the existing test hard-codes the detector list, so it would need updating with any new entry.
- Speculative: `/stlc-feature` has no namespace; an exact-name match (like SDLC commands) vs prefix `stlc-` is a design choice; a broad `stlc` substring risks false positives.
- Ordering/precedence against sdlc-factory when both appear is undefined for STLC.

---

## 7. Summary for Complexity Assessment

The only label derivation in this repo is `session-source-detector.ts` (single ordered detector array, consumed by `payload-builder.ts` and rendered data-driven by the HTML report client). There is no `stlc` handling anywhere, which fully explains "Pure chat" for local-report classification: neither `stlc-factory:*` nor `stlc-feature` match any detector. The change surface in this repo appears small (one detector file plus its test), following an existing precedent for unnamespaced commands.

Novelty is low; the pattern is established. Test coverage of the detector is good. The main uncertainty is scope: the ticket's Sessions table and details header (CLI Analytics) is probably served by a backend/UI outside this repo, and the OTLP adapter path contains no label logic. Invocation-name forms for STLC skills come from an external repo not examined.

---

## 8. External References

The task named https://gitbud.epam.com/epm-cdme/codemie-public-skills/-/tree/feat/stlc-factory/ai-packages/stlc-factory. It is a remote URL, not read (no access attempted from the filesystem); unresolved. Facts taken from the ticket only: command forms `/stlc-factory:<skill>` (exploratory, stlc-foundation, suite-health) and unprefixed `/stlc-feature`. Also named: docs/ARCHITECTURE-OTLP-PLUGIN.md (exists; not needed for the label, no label logic found in the OTLP path).
