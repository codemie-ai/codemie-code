# codemie-code supportedVersion Implementation Plan

> **For agentic workers:** use superpowers:executing-plans or superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Make `codemie install codemie-code --supported` work (EPMCDME-16980) by declaring `supportedVersion` on the codemie-code plugin.

**Architecture:** Module-level constant in the plugin, referenced from metadata, guarded by a Vitest drift test against the package.json dependency. Commit per task using the repository's existing convention (Conventional Commits, ticket EPMCDME-16980 in the body, no Co-Authored-By or AI trailer). Stage files explicitly by path; never stage `.codemie/codemie-cli.config.json`.

**Constraints:** No `minimumSupportedVersion` (Pi precedent). Minimal diff, no refactor (PR #627 touches this file). Never run the full suite or the real `codemie install`. Run only the new file: `T=<scratchpad>/home; mkdir -p $T; HOME=$T USERPROFILE=$T CODEMIE_HOME=$T npx vitest run <file>` (scratchpad `/private/tmp/claude-501/-Users-mert-efe-codemie-installers-codemie-code/01772921-cd09-4030-880e-98b7a604467c/scratchpad`).

### Task 1: Pin supportedVersion with drift guard

**Files:**
- Create: `src/agents/plugins/__tests__/codemie-code.plugin.version-support.test.ts`
- Modify: `src/agents/plugins/codemie-code.plugin.ts` (constant near line 38; one line in `CodeMieCodePluginMetadata`, line ~190)

**Test-first:** yes — `CodeMieCodePluginMetadata.supportedVersion` equals the `@codemieai/codemie-opencode` dependency in package.json (fails: undefined).

- [ ] **Step 1: Write the test.** Copy the mocks (provider registry, `utils/processes.js` with importActual + `installGlobal`/`exec`/`commandExists`, logger) and dynamic-import style from `src/agents/plugins/pi/__tests__/pi.plugin.version-support.test.ts`, adjusting relative paths (`../../../providers/...`, `../../../utils/...`). Read package.json via `readFileSync` from the repo root (resolve from `import.meta.url`). Tests:
  - `supportedVersion` equals `pkg.dependencies['@codemieai/codemie-opencode']`
  - `minimumSupportedVersion` is undefined
  - `new CodeMieCodePlugin().installVersion('supported')` calls `installGlobal('@codemieai/codemie-opencode', { version: <pkg dependency> })`
- [ ] **Step 2: Run the new file; verify the tests fail** (supportedVersion undefined; installVersion rejects "No supported version defined in metadata").
- [ ] **Step 3: Implement.** Add `const CODEMIE_CODE_SUPPORTED_VERSION = '0.0.47';` (with a one-line comment: must match package.json dependency) and `supportedVersion: CODEMIE_CODE_SUPPORTED_VERSION,` in `CodeMieCodePluginMetadata`.
- [ ] **Step 4: Run the new file; verify it passes.**
- [ ] **Step 5: Mutation check.** Remove the `supportedVersion` line once, run the file, confirm the new tests fail (and only this file runs), then restore the line and re-run to confirm pass.
- [ ] **Step 6: Commit** the two files by path: `fix(agents): add supportedVersion to codemie-code plugin metadata`.

negative-constraints: honored — no `minimumSupportedVersion` (Task 1 test asserts undefined); no PR #627 refactor (one constant + one line); no full-suite or real install runs (constraints header); no Co-Authored-By / config staging (header, Step 6).
