# Sync codemie-html-report + codemie-humanizer into the Claude plugin: implementation plan

> **For agentic workers:** Implement task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship html-report v0.3.0 and a new `codemie-humanizer` skill (v2.0.0) in the Claude plugin, and bump the plugin to 1.0.31 so installed copies refresh.

**Architecture:** Content-only change under `P` = `src/agents/plugins/claude/plugin`. `copy-plugins.js`, `sync-plugin.ts` and `BaseExtensionInstaller` pick it up unchanged. `SRC` = `/Users/yanaasadchaya/Projects/epam/airun/codemie-public-skills/.claude/worktrees/architecture-review-autonomous-4df230/skills`.

**Tech stack:** Markdown skills, Node scripts (CommonJS `.js`, ESM `.mjs`).

Commit after each task, following the repository's existing convention. Keep scratch files (sample pages, check scripts) in the session scratchpad and never commit them.

---

### Task 1: Replace codemie-html-report with the source copy

**Files:** Replace `P/skills/codemie-html-report/**`. Create `P/skills/codemie-html-report/package.json`. Delete `P/skills/codemie-html-report/style-guide/css/bundle.css`.

Test-first: yes. Running the new `scripts/build.js` from `P` on a sample `page.src.html` fails with `require is not defined in ES module scope` until `package.json` is added.

- [ ] Delete the current skill folder. Copy `SRC/productivity/codemie-html-report/` into it, leaving out `evals/` and `LICENSE`.
- [ ] Grep `P` for `bundle.css`. If no remaining reader exists outside the old `inject-css.js`, delete the file. If a reader exists, stop and report it.
- [ ] In the scratchpad, write a minimal `page.src.html` that contains `/* __CODEMIE_CSS__ */` and a JSON data file. Run `node P/skills/codemie-html-report/scripts/build.js <page> --out <out>`. It should FAIL with `require is not defined`.
- [ ] Add `package.json` containing exactly `{"type":"commonjs"}` and a trailing newline.
- [ ] Re-run `inject-data.js` on the page, then `build.js`, then `slop-scan.mjs` on the output. Expected: all three exit 0, and the output contains the inlined CSS.
- [ ] When you commit, check pre-commit gitleaks. If it flags anything, review every hit. Add a path-anchored allowlist entry to `.gitleaks.toml` only when every hit is base64 font data in `style-guide/fonts/fonts.css` or minified code in `style-guide/js/chart.umd.min.js`, and only for those two exact paths. If any hit is not clearly a false positive, stop and report it. Never use `--no-verify`.

### Task 2: Add codemie-humanizer

**Files:** Create `P/skills/codemie-humanizer/**`.

Test-first: no. This is a copy and rename.

- [ ] Copy `SRC/common/humanizer/` to `P/skills/codemie-humanizer/`, leaving out `evals/` and `LICENSE`. Change the frontmatter to `name: codemie-humanizer`. Make sure `P/skills/humanizer/` does not exist.

### Task 3: Strip the EPAM licence lines from both skills

**Files:** Every file under both skills that carries EPAM licence or copyright text. Source grep hits: scripts (`build.js`, `inject-*.js`, `slop-scan.mjs`, `vendor-assets.mjs`), `style-guide/css/*.css`, `style-guide/js/{charts,controls,deck}.js`, both SKILL.md and README.md files, and `references/{analytics,deck}.md`.

Test-first: yes. Before the edit, `grep -rniE "all rights reserved|see LICENSE|^license:" P/skills/codemie-html-report P/skills/codemie-humanizer` reports hits. After the edit it reports none, apart from third-party notices.

- [ ] Remove the EPAM header comment blocks (for example `inject-data.js:2-7`), any `license:` frontmatter field and any "see LICENSE" sentences. Keep `style-guide/fonts/LICENSE-OFL.txt`, the OFL reference in `fonts.css`, and the Chart.js banner in `chart.umd.min.js`.
- [ ] Apply exactly the same edit to both `scripts/slop-scan.mjs` copies. Then `cmp` both `slop-scan.mjs` copies and both `references/glossary.md` copies (AC11). Expected: identical.

### Task 4: Rewrite paths and the humanizer mentions

**Files:** `P/skills/codemie-html-report/{SKILL.md,README.md,references/*.md}`, `P/skills/codemie-humanizer/{SKILL.md,README.md,references/*.md}`.

Test-first: yes. A scratchpad check script fails before the edit. It (a) greps both folders for `<skill-dir>`, (b) greps `references/` and README for `${CLAUDE_PLUGIN_ROOT}`, and (c) resolves every `${CLAUDE_PLUGIN_ROOT}/skills/...` path in the two SKILL.md files against `P` (AC4).

- [ ] In both SKILL.md files, rewrite `<skill-dir>/…` and bare `references/…` and `scripts/…` paths to `${CLAUDE_PLUGIN_ROOT}/skills/<name>/…`. The locations are html SKILL.md:26, 60-64, 169 and humanizer SKILL.md:55-64, 95-100. Also rewrite any others the grep finds.
- [ ] In reference docs and READMEs, reword each `<skill-dir>` mention to a skill-relative form, for example "`scripts/build.js` in this skill's folder (the folder SKILL.md gives)". Never introduce `${CLAUDE_PLUGIN_ROOT}` there.
- [ ] In html-report SKILL.md:29 and README.md:92-99, change "the humanizer skill" to `codemie-humanizer`. Re-run the check script. Expected: pass.

### Task 5: Point the codemie-analytics hand-off at the new build

**Files:** Modify `P/skills/codemie-analytics/SKILL.md:320-360`.

Test-first: no. Single doc edit, checked by grep.

- [ ] Replace lines 320-360 so the hand-off passes the data folder and the output path, then says "build it per codemie-html-report's `references/analytics.md`". Drop the `/*__CSS__*/` text (line 327), the order rules on lines 341-345 and the inject-data command on line 348. Add one line saying the layout references give structure and data only: CSS, fonts and Chart.js come from the html-report build, which overrides any instruction in them to inline CSS or load a CDN. Leave the rest of the file untouched. Then grep the file. Expected: no `__CSS__`, `__CODEMIE_CSS__`, `inject-data` or `build.js`.

### Task 6: Bump the plugin version and run the scripts from the shipped copies

**Files:** Modify `P/.claude-plugin/plugin.json:8`.

Test-first: yes. Before the bump, the installed copy (the target that `claude.plugin-installer.ts:58` resolves through `resolveLocalTargetPath`) still has the old skill files, because `shouldUpdateLocal` skips a copy when the versions are equal. The AC9 run against the installed copy fails there.

- [ ] Change `"version": "1.0.30"` to `"1.0.31"`.
- [ ] Run `npm run build`. Repeat the Task 1 script sequence (inject-data, then build.js, then slop-scan) once from `dist/agents/plugins/claude/plugin/skills/codemie-html-report/` and once from the installed copy after a refresh install. Expected: all exit 0. Confirm that `find P -name package.json` lists only the html-report one.
- [ ] Time `build.js` on a deck with charts and record the time in the task notes. Kill one run mid-layout and check for a leftover headless Chrome process or a `codemie-deck-*` temp profile. Record the result (arch-review plan note).

## Negative constraints

- msgraph is not touched: no task edits `P/skills/msgraph/`.
- No new Vitest tests and no eval runner. AC11 stays a `cmp` run (Task 3), so the durable drift check from the arch-review plan note is not added.
- No edits to `copy-plugins.js`, `sync-plugin.ts` or the installers. The whole-folder sync remains a follow-up.
- In codemie-analytics, only the hand-off section and its override line change (Task 5). The layout references and the template remain a follow-up.
- `src/cli/commands/analytics/report/`, running `vendor-assets.mjs` and the CHANGELOG are untouched.
- No `P/skills/humanizer/` (Task 2). No `${CLAUDE_PLUGIN_ROOT}` in reference docs (Task 4). No other `package.json` under `P` (Task 6). Third-party notices stay (Task 3). No `--no-verify` (Task 1).
