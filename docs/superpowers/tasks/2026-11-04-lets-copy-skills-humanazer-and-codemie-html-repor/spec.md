# Spec: sync codemie-html-report and humanizer into the Claude plugin

`P` = `src/agents/plugins/claude/plugin`. `SRC` = `/Users/yanaasadchaya/Projects/epam/airun/codemie-public-skills/.claude/worktrees/architecture-review-autonomous-4df230/skills`.

## Goal

Users of the CodeMie Claude plugin get the current `codemie-html-report` skill (v0.3.0, build.js pipeline) and a new humanizer skill (v2.0.0). The plugin version goes up so installed copies refresh (`BaseExtensionInstaller.shouldUpdateLocal` skips the copy on an equal version; analysis section 2, Purpose C).

## Scope

1. **Replace `P/skills/codemie-html-report/`** with `SRC/productivity/codemie-html-report/`, minus `evals/` and `LICENSE`. Delete `style-guide/css/bundle.css`, but only after a grep confirms no new script in the skill and nothing else under `P` reads it. Add `P/skills/codemie-html-report/package.json` containing `{"type":"commonjs"}`. The source scripts use `require`/`__dirname`, and without this file the root `"type": "module"` (package.json:5) makes them fail under `src/` and `dist/`. The `.mjs` files stay ESM by their extension.
2. **Add `P/skills/codemie-humanizer/`** from `SRC/common/humanizer/`, minus `evals/` and `LICENSE`, with frontmatter `name: codemie-humanizer`. The `codemie-` prefix keeps the proxy sync (`sync-plugin.ts:44-57`, which writes unconditionally) from overwriting a user's own `~/.claude/skills/humanizer/`. Update html-report's mentions of "the humanizer skill" (SKILL.md:29, README.md:92-99) to `codemie-humanizer`.
3. **Path rewrite.** In both SKILL.md files, rewrite `<skill-dir>/...` and bare `references/...` / `scripts/...` paths to `${CLAUDE_PLUGIN_ROOT}/skills/<name>/...`. This is the convention in the other plugin skills (codemie-sdk:80-83, codemie-analytics:348), and it is the only token `sync-plugin.ts:50-57` rewrites. That rewrite runs on SKILL.md only, so reference docs do not get the token. Wherever a reference doc names a script or file by `<skill-dir>`, reword it to a skill-relative form, for example "`scripts/build.js` in this skill's folder (the folder SKILL.md gives)". Follow-up, outside this change: make `sync-plugin.ts` copy or symlink whole skill folders with ownership tracking (as `SkillSync` does), so later upstream syncs can be plain copies.
4. **Licence lines.** Follow the other plugin skills: no `LICENSE` file, no licence field in the frontmatter, no EPAM licence or copyright header in scripts (for example `inject-data.js:2-7`), and no "see LICENSE" references. The repository's Apache-2.0 licence covers the skills. Third-party notices for vendored assets stay: `style-guide/fonts/LICENSE-OFL.txt` and the Chart.js banner in `chart.umd.min.js`.
5. **Content otherwise byte-identical** to the source. Scripts stay CommonJS / `.mjs` as shipped, and `vendor-assets.mjs` ships. `scripts/slop-scan.mjs` and `references/glossary.md` ship in both skills as byte-identical copies, because html-report's build.js runs its own copy.
6. **Analytics hand-off.** In `P/skills/codemie-analytics/SKILL.md` (about lines 320-360), the html-report steps pass the data folder and the output path, then say "build it per codemie-html-report's `references/analytics.md`". They do not restate the placeholder name or the script order. Add one line saying that the layout references give structure and data only. CSS, fonts and Chart.js come from the html-report build, which overrides any instruction in those references to inline CSS or load a CDN. Leave the rest of that file alone. Follow-up, outside this change: move `leaderboard-dashboard-report.md`, `people-spending-dashboard-report.md` and the people-spending template onto the build.
7. **Version bump.** Change `P/.claude-plugin/plugin.json:8` from `1.0.30` to `1.0.31`.
8. **Gitleaks.** Add an allowlist entry only if pre-commit gitleaks flags the vendored assets. The entry is path-anchored to exactly `P/skills/codemie-html-report/style-guide/fonts/fonts.css` and `P/skills/codemie-html-report/style-guide/js/chart.umd.min.js`. Add it only after reviewing every hit and confirming it is base64 font data or minified library code. If any hit is not clearly a false positive, stop and report. Never use `--no-verify`.

## Acceptance criteria

- AC1: `P/skills/codemie-humanizer/` exists, its frontmatter has `name: codemie-humanizer`, it has no `evals/` or `LICENSE`, and `P/skills/humanizer/` does not exist.
- AC2: `P/skills/codemie-html-report/` matches the source file list minus `evals/` and `LICENSE`, plus `package.json`, and `bundle.css` is gone.
- AC3: A normalised diff against the source shows only these differences: path rewrites, reference-doc rewording, removed licence lines, the humanizer rename and the html-report mentions of it, and the added html-report `package.json`.
- AC4: Neither skill folder contains `<skill-dir>`, and no reference doc contains `${CLAUDE_PLUGIN_ROOT}`. Every `${CLAUDE_PLUGIN_ROOT}/skills/...` path in the two SKILL.md files resolves to a file in `P`.
- AC5: No EPAM "All rights reserved" text, licence frontmatter field or skill `LICENSE` file remains in either skill. `LICENSE-OFL.txt` and the Chart.js banner remain.
- AC6: The codemie-analytics hand-off defers to html-report's `references/analytics.md`. It writes no placeholder name and no script order, and it carries the override line over the layout references. No `/*__CSS__*/` remains.
- AC7: `plugin.json` version is `1.0.31`.
- AC8: `npm run build`, typecheck and lint pass, and so do the existing installer and sync tests (`plugin-installer.test.ts`, `sync-plugin.test.ts`, `sso-claude-plugin.test.ts`).
- AC9: These scripts run successfully on a sample `page.src.html`, both from `dist/` and from the installed copy under `~/.codemie/claude-plugin`: `inject-data.js`, then `build.js` (output contains the inlined CSS), then `slop-scan.mjs`. The only `package.json` under `P` is `P/skills/codemie-html-report/package.json`. The run records how long build.js takes on a deck with charts.
- AC10: Pre-commit gitleaks passes. If an allowlist entry was needed, it covers only the two paths named in Scope item 8.
- AC11: `cmp` confirms that the `slop-scan.mjs` and `glossary.md` copies are identical across the two skills.

## Non-goals

- msgraph: the target copy is newer than the source.
- New Vitest tests or a runner for the skill evals.
- TypeScript changes to `copy-plugins.js`, `sync-plugin.ts` or the installers. The whole-folder sync is a named follow-up.
- Editing codemie-analytics beyond the html-report hand-off and its override line. Moving the layout references onto the build is a named follow-up.
- `src/cli/commands/analytics/report/` and its `codemie-bundle.css`.
- Running `vendor-assets.mjs` or refreshing the vendored assets.
- A CHANGELOG entry.

## Decisions

- Rewrite skill paths to `${CLAUDE_PLUGIN_ROOT}/skills/<name>/...` over a verbatim copy (how should SKILL.md paths be written?) — stand-in
- Skill-relative wording in reference docs over the `${CLAUDE_PLUGIN_ROOT}` token there, with the whole-folder sync as a follow-up (how do reference docs name files when nothing substitutes the token?)
- Update the codemie-analytics hand-off over leaving analytics alone (does analytics follow the new html-report contract?) — stand-in
- Analytics hand-off defers to html-report's references/analytics.md and adds an override line, over restating the build contract (where do the build rules live?)
- Strip the skill LICENSE files and EPAM licence lines to match the other plugin skills, over shipping them as in source (what licensing do the copied skills carry?) — user
- Keep third-party notices (OFL fonts licence, Chart.js banner) over removing them with the EPAM lines (does the licence answer cover vendored third-party notices?)
- Leave out `evals/` and ship `vendor-assets.mjs` over shipping or dropping both (which source files ship to npm?) — stand-in
- Delete `bundle.css` after a reader check over keeping it (what happens to the stale prebuilt bundle?) — stand-in
- Validate with the existing gates plus hands-on script runs and diffs, over adding a new Vitest test (what does "fully validate" mean?) — stand-in
- Add a path-anchored gitleaks allowlist after reviewing each hit, over stopping on any hit (how are scanner false positives on vendored assets handled?) — stand-in
- Add a `{"type":"commonjs"}` package.json in codemie-html-report over rewriting the scripts to ESM (how do CommonJS scripts run under the root `"type": "module"`?)
- Ship humanizer as `codemie-humanizer` over keeping the name `humanizer` with an ownership guard in sync-plugin.ts (how do we avoid overwriting a user's own humanizer skill?)
- Keep two identical copies of slop-scan.mjs and glossary.md, checked with `cmp` during validation, over a single shared copy (how is the duplicated shared code handled?)
- Patch bump to 1.0.31 over a minor bump (what version step?)
- No CHANGELOG entry over adding one under Unreleased (is a changelog edit in scope?)
