# Technical Research

**Task**: claude plugin skills humanizer codemie-html-report plugin-version
**Generated**: 2026-11-04
**Research path**: filesystem

---

## 1. Original Context

let's copy skills humanazer and codemie-html-report from skills folder from project "/Users/yanaasadchaya/Projects/epam/airun/codemie-public-skills/.claude/worktrees/architecture-review-autonomous-4df230" where msgraph and codemie-html-report are exist - need to update codemie-html-report skill and add humanizer here in codemie-code and increase plugin version of claude there.
fully validate it

---

## 2. Codebase Findings

Paths below are relative to the target repo root (`wt-o-code`). `P` = `src/agents/plugins/claude/plugin`. `SRC` = `<source repo>/skills`.

### Existing Implementations

**Purpose A: ship the CodeMie HTML report skill in the Claude plugin**
- `P/skills/codemie-html-report/` exists (13 files): `SKILL.md`, `README.md`, `scripts/inject-css.js`, `scripts/inject-data.js`, `style-guide/css/{base,bundle,buttons,components,forms,layout,tokens,typography,utilities}.css`. Scripts are ESM (`import`), and the SKILL.md calls them via `${CLAUDE_PLUGIN_ROOT}/skills/codemie-html-report/scripts/...` (lines 293, 298, 312, 318).
- `inject-css.js:17` reads a prebuilt `style-guide/css/bundle.css`. The source has no `bundle.css`.
- The source `SRC/productivity/codemie-html-report/` is 36 files, about 1.4 MB, `metadata.version: "0.3.0"`. New: `LICENSE`, `evals/` (contact-sheet.mjs, evals.json, visual-review.md), `references/` (analytics, deck, glossary, visual, writing .md), `scripts/{build.js, inject-charts.js, inject-controls.js, slop-scan.mjs (114 KB), vendor-assets.mjs}`, `style-guide/css/{controls,deck}.css`, `style-guide/deck-gallery.src.html`, `style-guide/fonts/{fonts.css (712 KB), LICENSE-OFL.txt}`, `style-guide/js/{chart.umd.min.js (209 KB), charts.js, controls.js, deck.js}`. Changed: SKILL.md, README.md, inject-css.js, inject-data.js and 8 CSS files.
- The source scripts are CommonJS (`require(`): build.js, inject-*.js. `.mjs` files use ESM. `vendor-assets.mjs` fetches fonts and Chart.js from googleapis, jsdelivr and github at run time (lines 37-75).

**Purpose B: ship a humanizer skill**
- None found in the target. I searched for `humanizer` across `src/`, `scripts/`, `tests/` and `docs/`.
- Source: `SRC/common/humanizer/` (16 files, about 230 KB, `metadata.version: "2.0.0"`): SKILL.md, README.md, LICENSE, `evals/` (evals.json + 5 fixture files), `references/{drafting,formats,glossary,languages,text,visual}.md`, `scripts/slop-scan.mjs`.
- `references/glossary.md` and `scripts/slop-scan.mjs` are byte-identical to the copies in the html-report skill (checked with `cmp`).

**Purpose C: plugin version that makes users receive the new skills**
- `P/.claude-plugin/plugin.json:8` has `"version": "1.0.30"`. Nothing else in the repo mirrors this value. A grep for `1.0.30` found only a docs example at `docs/specs/claude-version-management/installation-and-versioning.md:897`.
- `BaseExtensionInstaller.getVersion` (`src/agents/core/extension/BaseExtensionInstaller.ts:177`) reads the manifest `version`. `shouldUpdateLocal` (line ~490) compares it with `~/.codemie/claude.extension.json` and skips the copy when they are equal (line 506).
- Manifest path: `claude.plugin-installer.ts:65` returns `.claude-plugin/plugin.json`. Critical files: `getCriticalFiles()` returns `plugin.json`, `hooks/hooks.json`, `README.md`. The install target is `~/.codemie/claude-plugin`.

**Other touched code**
- `scripts/copy-plugins.js:17-26` copies the whole `P` tree to `dist/` on `npm run build`. Its filter drops only `.ts` files, so every skill file (evals, fonts, LICENSE) would ship.
- `src/cli/commands/skills/setup/sync-plugin.ts:40-60` copies only each skill's `SKILL.md` into `~/.claude/skills/<name>/` and replaces `${CLAUDE_PLUGIN_ROOT}` with the install path.
- `P/skills/msgraph/` differs from the source in both directions. The target has an extra `--expand-replies` example. The source has `metadata` frontmatter, a LICENSE and evals. `msgraph.js` differs by 260 diff lines.

### Decisions Already in the Code
- Convention: plugin SKILL.md files reference their own files as `${CLAUDE_PLUGIN_ROOT}/skills/<name>/...` (codemie-html-report, codemie-sdk:80-83, codemie-assistant-builder:20,119, codemie-analytics:348). The source skills use a `<skill-dir>` placeholder plus bare relative paths like `references/*.md` (html SKILL.md:26,60-64,169; humanizer SKILL.md:55-64,95-100).
- Convention: every plugin-content PR bumps the patch version (git log on plugin.json: 1.0.25 → 1.0.30 across #554, #561, #592, #656, #717). The earlier msgraph sync from codemie-public-skills (#422, `9379b310`) did **not** bump it.
- No existing target skill ships `LICENSE`, `evals/` or vendored binaries. The target repo is `Apache-2.0` (`package.json:110`). The source LICENSE is "EPAM AI Factory — License and Ownership Notice … All rights reserved", and the source `inject-data.js:2-7` carries a matching header.
- Both module styles already exist under `P`: `msgraph.js` uses `require` (7 calls) and `codemie-analytics/scripts/*.js` use `import`. The root `package.json:5` sets `"type": "module"`, and there is no `package.json` under `P`.
- The build expects a prebuilt CSS bundle in the target (`bundle.css`). The source builds at run time (`build.js`).

### Task Statements Checked Against the Code
- "skills folder … where msgraph and codemie-html-report exist": **holds**. They are at `SRC/productivity/{msgraph,codemie-html-report}`. Humanizer is at `SRC/common/humanizer` ("humanazer" in the task).
- "update codemie-html-report skill": **holds**. The target copy exists and is older (no `metadata.version`).
- "add humanizer here in codemie-code": **holds**. No humanizer exists in the target.
- "increase plugin version of claude": **holds**. There is a single field, `plugin.json:8`. Without the bump, `shouldUpdateLocal` leaves the installed copies as they are.
- Copying the directories as-is **keeps** the `<skill-dir>` placeholder in place. Its consumer is `sync-plugin.ts`, which rewrites only `${CLAUDE_PLUGIN_ROOT}`. A SKILL.md synced to `~/.claude/skills/<name>/` has no `scripts/` or `references/` beside it.
- "fully validate it": **unverified**. No test validates skill content (see Section 4).

### Consumers of Changed Contracts
- `P/skills/codemie-analytics/SKILL.md:320-360` invokes `codemie-html-report` and runs `${CLAUDE_PLUGIN_ROOT}/skills/codemie-html-report/scripts/inject-data.js "$REPORT_DIR/<report>.html" "$OUT"` on the finished `.html`. Its line 327 names the placeholder `/*__CSS__*/`. The source contract (`references/analytics.md`) says the placeholder is `/* __CODEMIE_CSS__ */` and that inject-data runs on `page.src.html` before `scripts/build.js`. The new inject-data.js keeps the `<page> <json-file-or-dir>...` CLI shape.
- `inject-css.js` → `bundle.css`. The source inject-css.js has a different body and the source has no bundle.css. Anything that calls `inject-css.js` directly would see the change (codemie-analytics does not; only html-report SKILL.md does).
- `sync-plugin.ts` scans every directory under `skills/`, so it picks up `humanizer` automatically.
- `plugin.json` version is read by: `BaseExtensionInstaller` (above), `tests/integration/sso-claude-plugin.test.ts:23-25` (reads the version dynamically, so any value passes) and `tests/setup/agent-build-setup.ts:154`.
- `src/cli/commands/analytics/report/report-generator.ts:45` uses its own `codemie-bundle.css` and does not depend on the skill.

### Architecture and Layers Affected
- Agent plugin asset layer: `P/skills/*`, `P/.claude-plugin/plugin.json`.
- Build/packaging: `scripts/copy-plugins.js`, with `dist/` in `package.json:files`.
- Install/runtime (read, not necessarily changed): `BaseExtensionInstaller`, `ClaudePluginInstaller`, `sync-plugin.ts`.

### Integration Points
- Claude Code loads `~/.codemie/claude-plugin` (or `--plugin-dir`). Skills are namespaced `codemie:<name>`, as seen in metric tests such as `claude-named-invocations.test.ts:29`.
- `vendor-assets.mjs` is a maintainer-time network fetch. The shipped `fonts.css` and `chart.umd.min.js` are already vendored.

### Patterns and Conventions
- One directory per skill with a `SKILL.md` frontmatter `name` equal to the directory name. Scripts are invoked with `node ${CLAUDE_PLUGIN_ROOT}/...`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` exists. No guide covers plugin skills or plugin versioning. `external-integrations.md:282-293` covers the `codemie skills` CLI, not plugin skills.
- `docs/PLUGINS.md:450` gives a generic skill layout example.
- `P/README.md` does not list skills.

### Architectural Decisions
- Precedent task docs: `docs/superpowers/tasks/2026-06-18-msgraph-skill-sync-incorporate-global-adjustments/plan.md`. It treated `dist/` as a regenerated artifact and verified the sync by normalised diff.

### Derived Conventions
- Plugin content changes come with a patch bump in the same PR.
- `CHANGELOG.md` has an `## [Unreleased]` section (Keep a Changelog format).

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/plugins/claude/__tests__/plugin-installer.test.ts`: version compare and skip logic, with mocked fs.
- `src/cli/commands/skills/setup/__tests__/sync-plugin.test.ts:48-60`: `${CLAUDE_PLUGIN_ROOT}` substitution using a msgraph fixture.
- `tests/integration/sso-claude-plugin.test.ts`: real install into a temp dir, version detection, critical files.
- `P/__tests__/statusline.test.ts`: unrelated to this task.

### Testing Framework and Patterns
- Vitest with `unit`, `cli` and `agent` projects (`package.json:scripts.test`). Mocks use dynamic imports.

### Coverage Gaps
- No test parses or validates skill SKILL.md frontmatter, the referenced file paths, or the skill scripts (inject-css, inject-data, build.js, slop-scan).
- The source `evals/` are LLM eval definitions, and no runner for them exists in the target.

---

## 5. Configuration and Environment

### Environment Variables
- `CLAUDE_PLUGIN_ROOT` is supplied by Claude Code and substituted by `sync-plugin.ts`. No other variables found.

### Configuration Files
- `P/.claude-plugin/local-install.json`: hybrid strategy. It excludes `**/*.test.js`, `.DS_Store` and `node_modules`, so evals and fonts are not excluded.
- `.gitleaks.toml:10-17`: the allowlist does not cover `P/skills/**`. The pre-commit hook runs gitleaks (Docker) on the staged diff.
- `eslint.config.mjs:94-99` ignores `**/*.js`, so skill scripts are not linted. `lint-staged` handles only `*.ts` and `package.json`.

### Feature Flags and Deployment Concerns
- No flags. The npm package ships `dist/`, which includes every skill file.

---

## 6. Risk Indicators

- The source skills use `<skill-dir>` and bare `references/...` paths, while the target convention is `${CLAUDE_PLUGIN_ROOT}/skills/<name>/...`. `sync-plugin.ts` copies only SKILL.md to `~/.claude/skills/`, so a verbatim copy keeps `<skill-dir>` in place (see Task Statements).
- `codemie-analytics/SKILL.md:327,341-360` describes the old html-report contract (`/*__CSS__*/`, inject-data on the final `.html`, no `build.js`). It diverges from the new `references/analytics.md`.
- The source LICENSE and file headers are EPAM "All rights reserved", while the repo is Apache-2.0. `npm run license-check` covers npm deps only.
- Package size: about 1.6 MB of new assets (fonts.css 712 KB of base64, Chart.js 209 KB, two copies of slop-scan.mjs at 114 KB each), shipped via `copy-plugins.js` and `dist/`.
- Gitleaks on the large base64 `fonts.css` and the minified Chart.js. The allowlist does not exclude them, so false positives are possible at pre-commit.
- `bundle.css` is in the target but not the source. `inject-css.js:17` (target) depends on it, so whether the file is removed or left stale has to be settled.
- The target msgraph is ahead of the source (`--expand-replies`). The task names msgraph only as a locator.
- Speculative: "fully validate" has no existing harness. Validation would rest on the build, the installer tests, running the scripts on a sample page, and a diff against the source.

---

## 7. Summary for Complexity Assessment

The change is in the Claude plugin asset tree (`src/agents/plugins/claude/plugin/`). It replaces and extends one skill directory (codemie-html-report: 13 → 36 files), adds a new 16-file humanizer skill, and bumps the single version field in `.claude-plugin/plugin.json` (1.0.30). No TypeScript source has to change for the skills to ship: `copy-plugins.js` copies the tree wholesale, `sync-plugin.ts` discovers skill directories automatically, and `BaseExtensionInstaller` redeploys when the version changes.

There is little technical novelty, but the content contracts do not line up. The source skills use a `<skill-dir>` placeholder instead of the repo's `${CLAUDE_PLUGIN_ROOT}` convention. The new html-report changes the build flow (a `build.js` pipeline, a renamed placeholder contract, no prebuilt `bundle.css`), and the sibling `codemie-analytics` SKILL.md still documents the old flow. Licensing differs (EPAM proprietary vs the repo's Apache-2.0), and about 1.6 MB of vendored assets go through gitleaks and npm packaging.

No test covers skill content. Installer and sync tests cover version comparison and `${CLAUDE_PLUGIN_ROOT}` substitution only, and the version test reads the value dynamically. ESLint ignores `.js`. "Fully validate" therefore rests on build, typecheck and installer tests, plus manual script execution and diffs.

---

## 8. External References

- `/Users/yanaasadchaya/Projects/epam/airun/codemie-public-skills/.claude/worktrees/architecture-review-autonomous-4df230/skills/`: **resolved**.
  - `productivity/codemie-html-report/` (frontmatter `name: codemie-html-report`, `metadata: {author: codemie-team, version: "0.3.0"}`). It says: "run one build script (Step 4) that inlines the design system, adds the theme switch and presenting controls and runs the slop scan"; "`<skill-dir>` below is this file's folder"; usage `node <skill-dir>/scripts/build.js page.src.html --out page.html [--cdn] [--no-presenter] [--position bottom] [--no-layout]`; "Copy `/* __CODEMIE_CSS__ */` exactly: the build stops without it"; and "To clean an existing page in place and keep its own design, use the humanizer skill".
  - `productivity/codemie-html-report/references/analytics.md`: "fill it with this skill's `node <skill-dir>/scripts/inject-data.js page.src.html <data-dir>` … then build it with `scripts/build.js`".
  - `common/humanizer/` (`name: humanizer`, `metadata.version: "2.0.0"`): `node <skill-dir>/scripts/slop-scan.mjs <file>`; `cat draft.md | node <skill-dir>/scripts/slop-scan.mjs --stdin [--md | --html | --css]`; references text/visual/formats/drafting/glossary/languages.
  - `productivity/msgraph/`: present. It differs from the target, with the target ahead on `--expand-replies`.

## Facts Added by Review

Researched for the names the spec relies on, after the analysis above was written. Read like the facts layer; where a line here contradicts one above, this one was read later.

- `targetPath` is `resolveLocalTargetPath(config.targetDir)` = `<process.cwd()>/.codemie` (`src/utils/paths.ts:107-110`).
- Callers of `ClaudePluginInstaller.install()`: `src/providers/core/default-agent-hooks.ts:34` (`beforeRun`, which sets `CODEMIE_<AGENT>_EXTENSION_DIR`) and `src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts:76` (sets `CODEMIE_CLAUDE_EXTENSION_DIR`). The installer is reached through `claude.plugin.ts:659` `getExtensionInstaller()`.
