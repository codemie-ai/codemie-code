# EPMCDME-15937 Normalized repository in OTLP analytics - Implementation Plan

**Goal:** The OTLP event `cwd` (and `raw.cwd`) is always `extractRepository(ctx.cwd)`, never an absolute path.

**Conventions:** Commit per task using the repository's existing convention (only if the user asks; AGENTS.md). ES modules, `.js` import suffix, explicit return types. Out of scope and must stay untouched: `src/utils/paths.ts`, `src/utils/processes.ts`, `resolveRepoFields` and `repo_remote` behavior, `OVERRIDABLE_FIELD_KEYS`, `otlp-spool/`, `otel-analytics-override.ts`, `forwarder.ts`, `package.json`, `.codemie/codemie-cli.config.json`, `install.cmd`, the backend repo. No home-directory special-casing (accepted limitation).

**Design decisions**
- The only source change is `OtlpAgentAdapter.buildEvent` (`src/agents/core/OtlpAgentAdapter.ts:169`): `cwd: ctx.cwd` becomes `cwd: extractRepository(ctx.cwd)`, adding `import { extractRepository } from '@/utils/paths.js';` next to the other `@/utils` imports (L2-5). `raw` already mirrors the event (L174), so `raw.cwd` follows. The absolute `ctx.cwd` is still used for git and identity lookups, never emitted.
- `OtlpAgentAdapter.test.ts` mocks only `@/utils/processes.js` (L6), not `@/utils/paths.js`, so the real `extractRepository` runs in tests.
- Existing assertions to update: `OtlpAgentAdapter.test.ts:251` (`cwd: '/repo'`) and `:263` (`toBe('/repo')`) would now receive `repo` (single segment). In the Claude plugin test, `cwd: '/repo'` at L106/177/289/330 are hook-input or derivation-pass fixtures, not the stamped event `cwd`; verify and leave them if so. Inputs `cwd: '/x'` (L51, 411, 436) are never asserted on the event.

## Task 1: Stamp `cwd` as the repository identifier in `buildEvent`

**Files:** modify `src/agents/core/OtlpAgentAdapter.ts` (L169 and the import); tests in `src/agents/core/__tests__/OtlpAgentAdapter.test.ts`.

One-line change as described above.

- Test-first: yes — in `OtlpAgentAdapter.test.ts` using the existing `FakeAdapter` (L40) and its input helper (L79): event `cwd` and `raw.cwd` equal `qa-projects/pr609-preview-agents` for `/Users/lika/Projects/qa-projects/pr609-preview-agents` and for Windows-style `C:\Projects\qa-projects\pr609-preview-agents`; a Claude Desktop sandbox path gives `Cowork`; `/` gives `unknown`; none of them is absolute; with `detectGitRemoteRepo` returning `undefined`, `repo_remote` is still `''`, with `org/repo` it is unchanged and `cwd` is still the short value; an event-supplied non-empty `repo_remote` still overrides while `cwd` stays short. Fails today (absolute `cwd`).

## Task 2: Align existing assertions and docs

**Files:** `OtlpAgentAdapter.test.ts` (L248-263, the "stamps ... the hook cwd" and derived-events cases), `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts` (any assertion on a forwarded event's `cwd`), `docs/ARCHITECTURE-OTLP-PLUGIN.md` (the common-fields lines mentioning `cwd`, ~L73-81).

Update the expectations at L251 and L263 to `'repo'` and rename the cases to say the event carries the repository identifier. In the Claude plugin test, change only assertions on forwarded events; hook-input fixtures stay. In the architecture doc add one sentence: the event `cwd` is now a repository identifier (`extractRepository(cwd)`: `parent/current`, `Cowork`, `unknown`), not a working directory, and the absolute path never leaves the hook process; `repo_remote` is unchanged.

- Test-first: no — adjusts existing expectations and docs; behavior is covered by Task 1.

## Negative-constraint pass

- `repo_remote`, `resolveRepoFields`, the override mechanism: untouched by both tasks.
- `extractRepository`, `resolveRepositoryName`, `detectGitRemoteRepo`: unchanged; no home-directory handling.
- No backend change, no new event field, no spool/proxy change; local working-tree files excluded.
- No whole-suite gates, manual verification, or commits planned.
- negative-constraints: honored as listed above.
