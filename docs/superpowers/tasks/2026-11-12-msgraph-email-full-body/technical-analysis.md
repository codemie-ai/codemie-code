# Technical Research

**Task**: msgraph skill email read stripHtml
**Generated**: 2026-11-12
**Research path**: filesystem

---

## 1. Original Context

Ticket EPMCDME-16964. The msgraph skill truncates HTML email bodies at 2000 characters silently. Location: src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js ~line 617 in the args.read branch: `console.log(body.contentType === 'text' ? body.content : stripHtml(body.content || '').slice(0, 2000));`. Text branch already prints the whole body. Expected: full body returned (no limit) so both branches behave the same. SKILL.md does not mention the 2000 limit. The script has no tests and exports nothing; main() runs on load and calls Graph with fetch. Testing options: run as child process with fetch stubbed via a small --import preload and a fake token, or extract body formatting into a small testable function — choose whichever is less code. Please research: where the script reads its token (so a test can fake it), how other repo tests (tests/ dir, vitest config) exercise skill scripts or spawn node child processes, whether other places in msgraph.js truncate body/preview text (e.g. other .slice calls on message content), and whether a copy of msgraph.js exists elsewhere in the repo that needs syncing. Do not modify any source files.

---

## 2. Codebase Findings

### Existing Implementations
- `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` (about 1900+ lines, CommonJS, `require('node:...')`, no exports). Line 617, in `cmdEmails` `args.read` branch (lines 608-619): prints Subject/From/Date/Read, a 60-char rule, then `body.contentType === 'text' ? body.content : stripHtml(body.content || '').slice(0, 2000)`. Only the HTML branch is capped. Graph returns lowercase `text`/`html`, matching the comparison.
- `stripHtml(s)` at line 414: regex tag removal plus entity decode (nbsp, amp, lt, gt), collapses blank lines, trims. Handles null input.
- The `--json` path for the same command does not exist in `--read` (it prints text only); the `onenote --read` json path at line 1614 is a different command.
- `main()` at line 1906 reads `process.argv.slice(2)`, runs on load (`main().catch(...)` at the end of the file), and exits 1 on errors. No `require.main` guard and no `module.exports`.

### Token source (for faking in a test)
- `CACHE_FILE = path.join(os.homedir(), '.ms_graph_token_cache.json')` (line 50). `loadCache()` (line 201) does `JSON.parse(fs.readFileSync(CACHE_FILE))`.
- `getValidToken()` -> `getAccessToken(false)` (line 360): returns `cache.access_token` if `now < cache.expires_at - 60` (epoch seconds), otherwise refreshes or does an interactive PKCE login.
- A test can fake it by running the child with `HOME` (and `USERPROFILE` on Windows) pointed at a temp dir that holds `.ms_graph_token_cache.json` = `{"access_token":"fake","expires_at":<now+3600>,"username":"x"}`. No env var override exists in the script; `process.env` is not read for config at all.

### HTTP layer (differs from the ticket statement)
- The script does NOT use global `fetch` for Graph calls. `graphGet` (line 112) calls `httpsRequest` (line 70), which uses `node:https` `https.request` with hostname hardcoded from `GRAPH_BASE = 'https://graph.microsoft.com/v1.0'` (line 51, constant, not env-overridable). A `fetch` stub preload would therefore have no effect on `emails --read`.
- The only `fetch` identifier is a local helper `function fetch(url, auth)` inside `graphDownload` (line 160), used for file downloads.
- Consequence: a child-process test needs a preload that patches `https.request` (or `httpsRequest` cannot be reached because it is module-private), not `fetch`. Also `graphGet` retries on 429 only.

### Other truncation points in msgraph.js (same class of issue)
- Line 617: the target, 2000 chars (email read).
- Lines 983, 1092: `stripHtml(m.body?.content || '').slice(0, 200)` (Teams chat/channel message previews).
- Lines 1076, 1098: `stripHtml(r.body?.content || '').slice(0, 200)` and `.slice(0, 160)` (Teams replies).
- Lines 639-640: email list columns `from` 28 chars, subject 40 chars; 665-667 subject 45, sender 20, id 36; 739 event title 45 (tabular listings, not bodies).
- Line 577, 1129-ish and `HTTP Error` handler: error body `.slice(0, 200)` (diagnostics).
- Only line 617 is in the email-read body path. Teams ones are list-style previews and outside the ticket scope.

### Copies elsewhere in the repo
- Only one source file: `find -name "msgraph*"` outside node_modules/.git/dist returns only the skill directory (`scripts/msgraph.js`, `README.md`, `SKILL.md`).
- `dist/agents/plugins/claude/plugin/skills/msgraph/` exists but `dist` is gitignored (`git check-ignore dist` confirms); it is produced by the `copy-plugin` npm script (`scripts/copy-plugins.js`). Nothing to sync by hand beyond a rebuild.
- `src/cli/commands/skills/setup/sync-plugin.ts` mentions msgraph in a header comment only (copies the plugin to `.codemie/claude-plugin/`); `__tests__/sync-plugin.test.ts` references it. Docs that mention msgraph under `docs/superpowers/tasks/2026-06-18-msgraph-skill-sync-incorporate-global-adjustments/` are earlier task artefacts; that task concerned syncing a global adjusted copy into this one.

### Architecture and Layers Affected
- Single layer: a standalone, dependency-free Claude plugin skill script (deployed outside the compiled package and run with `node`). No CLI/Registry/Plugin TypeScript layers are involved.

### Integration Points
- Microsoft Graph `GET /me/messages/{id}` via `node:https`. Token cache file in the user home.
- Documentation: `SKILL.md` line ~95 shows `emails --read MESSAGE_ID`; README line 66 and 85 list `--read ID`. Neither mentions a 2000-char limit (grep for `2000`, `truncat` finds only the unrelated drive-name note at SKILL.md line 161).

### Patterns and Conventions
- Plain CommonJS JS, aligned-column style, `console.log` for output (script, not repo logger), no `src/` imports.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/testing/testing-patterns.md` section "Testing Dependency-Free Scripts via Parameter Injection" (around line 158): for standalone scripts that must stay import-free, avoid `vi.mock()`; add optional parameters defaulting to the real dependency and pass fakes in tests. Reference implementation: `src/agents/plugins/claude/plugin/statusline.mjs` with `__tests__/statusline.test.ts`.
- Same guide, line ~72: use dynamic `import()` after spies are set up.
- AGENTS.md: tests only on explicit request; git ops only on explicit request.

### Architectural Decisions
- None recorded for msgraph truncation.

### Derived Conventions
- Skill scripts are shipped as-is; no build step beyond copying.

---

## 4. Testing Landscape

### Existing Coverage
- No test exercises `msgraph.js` itself. `src/cli/commands/skills/setup/__tests__/sync-plugin.test.ts` covers only the plugin sync.
- Child-process precedent: `tests/integration/hook-stdout.test.ts` (uses `spawn` from `node:child_process`, temp `HOME`/CODEMIE_HOME via `mkdtempSync`, local `http` server standing in for a remote, strips `NODE_ENV`/`VITEST`, 20 s run timeout, drives `bin/codemie.js`). Others using child_process: `tests/integration/analytics-auth-gate.test.ts`, `analytics-sync-git-target.test.ts`, `hook-proxy-cold-start-profile.test.ts`.
- `tests/skills/pattern-invocation.test.ts` covers the skills loader, not plugin scripts.

### Testing Framework and Patterns
- Vitest (`vitest.config.ts`) with three projects: `unit` (`src/**/*.test.ts`, `src/**/*.spec.ts`, aliases `@`->`/src`, `CODEMIE_HOME` set to a temp dir), `cli` (`tests/integration/**/*.test.ts` excluding `agent-*`), `agent` (`tests/integration/agent-*.test.ts`, real network). Globals on, 30 s timeouts.
- A test for msgraph.js would live in either `src/agents/plugins/claude/plugin/skills/msgraph/__tests__/*.test.ts` (unit) or `tests/integration/` (cli project). The statusline test sits in `src/agents/plugins/claude/plugin/__tests__/`.

### Coverage Gaps
- The whole of `msgraph.js`, including `stripHtml` and the `--read` branch.

---

## 5. Configuration and Environment

### Environment Variables
- None read by msgraph.js for config (`process.env` grep returns nothing relevant). Home directory comes from `os.homedir()`, which honours `HOME` on POSIX.

### Configuration Files
- `~/.ms_graph_token_cache.json` (token cache, written with mode 0600). `TENANT`/client constants are hardcoded near the top of the script.

### Feature Flags and Deployment Concerns
- None. `package.json` `files` ships `dist`; the skill reaches `dist` via `npm run copy-plugin`. `lint` script only covers `{src,tests}/**/*.ts` and pi extension JS, so msgraph.js is not linted.

---

## 6. Risk Indicators

- The ticket says Graph is called with `fetch`; it is actually `node:https`. A `--import` preload stubbing `fetch` would not intercept anything; stubbing needs `https.request` patching (or a different seam).
- msgraph.js has no export seam and `main()` runs on load with `process.exit`. Importing it from vitest would execute `main()`; a unit test needs either a child process or a refactor.
- Speculative: extracting a small pure helper (for example `formatBody(body)`) plus a `require.main === module` / `module.exports` guard would be a larger edit to a 1900-line script than the one-line fix, but is easy to test directly; the child-process route avoids touching structure but needs an https stub and a fake HOME.
- Speculative: removing the cap means very large HTML bodies print in full to the agent context; that is the stated intent but could be noted in SKILL.md.
- Teams previews at 200/160 chars (lines 983, 1076, 1092, 1098) have the same silent-truncation character but are not in the ticket.
- Plain `.js` file outside lint and TypeScript checks: regressions are caught only by a test.

---

## 7. Summary for Complexity Assessment

The change is a one-line edit in a single standalone CommonJS skill script (`msgraph.js` line 617: remove `.slice(0, 2000)` so the HTML branch matches the text branch). Only one source copy exists; `dist/` is a gitignored build copy. Docs (SKILL.md, README) do not mention the limit, so no doc edit is required by fact.

Testing is the main variable. The script has no tests, no exports, and runs `main()` on load. Token comes from `~/.ms_graph_token_cache.json` (fakeable via a temp `HOME` plus a cache with a future `expires_at`). Graph is reached via `node:https` rather than `fetch`, which differs from the ticket and affects the stub design. The repo has child-process test precedent (`tests/integration/hook-stdout.test.ts`) and a guide on testing dependency-free scripts through parameter injection.

Risk is low: one layer, one file, no config. Main risks are the incorrect fetch assumption and the cost of a test harness relative to the one-line fix. Similar 200-char truncations exist for Teams previews but are out of scope.

---

## 8. External References

None named by the task
