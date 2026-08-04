# Technical Research

**Task**: bin package.json installer cli alias
**Generated**: 2026-07-27T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

Remove code from package.json bin mapping (prevents accidental collisions). Document migration ('use codemie / codemie-code; optional alias if you insist'). Optionally add an explicit installer opt-in to create a code alias, but only if product wants to support that legacy habit. Jira ticket: EPMCDME-13589.

---

## 2. Codebase Findings

### Existing Implementations

- `package.json:10` — `"code": "./bin/codemie.js"` — the single npm bin declaration that creates the `code` shell command; both `"codemie"` (line 9) and `"code"` (line 10) point to the identical entry script; this one line is the complete deletion target
- `package.json:9` — `"codemie": "./bin/codemie.js"` — the primary bin entry that remains after removal
- `package.json:11` — `"codemie-code": "./bin/agent-executor.js"` — the agent-runner shortcut; entirely separate from the `code` alias and unaffected
- `bin/codemie.js` — primary CLI entry point shared by both `codemie` and `code`; runs migration checks, update check, then delegates to `dist/cli/index.js`; no reference to the `code` alias name at runtime
- `bin/agent-executor.js` — entry for `codemie-code` (agent runner via AgentCLI + AgentRegistry)
- `scripts/postinstall.mjs` — runs on `npm install`; two responsibilities only: (1) restores execute bits on the `node-pty` spawn-helper binary on macOS, (2) appends `export PATH="<npmBin>:$PATH"` to `.zshrc` / `.bashrc` / `.bash_profile` if the npm bin dir is not already in PATH; does not create shell aliases and does not reference `code` anywhere
- `src/utils/cli-bin.ts` — `restoreCliBinLink()` atomically repairs the global `codemie` symlink when an agent package overwrites it (called from `install.ts` and `update.ts`); hardcoded to the `codemie` symlink path only; has no awareness of the `code` alias and requires no changes
- `src/utils/install.ts:185` — calls `restoreCliBinLink()` after agent plugin install
- `src/utils/update.ts:309,389` — calls `restoreCliBinLink()` after agent update
- `install/macos/install.sh`, `install/windows/install.cmd`, `install/windows/install.ps1` — desktop app (CodeMie Connect) installers; completely unrelated to the npm bin alias

### Architecture and Layers Affected

- **Package manifest layer**: `package.json` `bin` block — one-line deletion is the sole required change for the core removal
- **Post-install hook layer** (`scripts/postinstall.mjs`) — currently untouched by the alias; if the optional installer opt-in is added, this file would need new alias-creation logic (novel pattern for this script)
- **Documentation layer** — no existing CHANGELOG, no existing migration guide; a new migration note must be created from scratch
- **CLI entry layer** (`bin/`) — no changes needed; `bin/codemie.js` continues to serve the `codemie` bin entry

### Integration Points

- The `code` bin alias has no unique runtime behavior — it shares 100% of its code path with `codemie` via `bin/codemie.js → dist/cli/index.js`
- npm bin mechanism: on `npm install -g @codemieai/code`, npm creates symlinks in the global bin dir for each key in the `bin` block; removing `"code"` from the block means new installs will not create the symlink, but existing symlinks on already-installed machines persist until `npm uninstall` + reinstall or manual `npm unlink`
- `restoreCliBinLink()` is invoked by agent plugin install/update flows to protect the `codemie` symlink; it does not protect or reference the `code` symlink and needs no changes
- No internal module imports the `code` alias name; it is purely an npm-level declaration

### Patterns and Conventions

- All bin entries in `package.json` follow the pattern: `"<name>": "./bin/<entry>.js"` where each `<entry>.js` is a thin loader that resolves the `dist/` equivalent
- `postinstall.mjs` uses `execSync('npm config get prefix')` to resolve the npm bin dir; any opt-in alias creation would need to follow the same approach to locate where to write a shell alias
- `restoreCliBinLink()` uses an atomic rename trick (`fs.renameSync(tmp, target)`) for symlink safety — a pattern to follow if symlink management is added to postinstall
- No shell-alias injection exists anywhere in the codebase today; adding one to `postinstall.mjs` is a new pattern

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/usage/project-config.md` — covers ConfigLoader and profile resolution; no reference to bin entries or the `code` alias; not relevant to this task
- `.ai-run/guides/integration/exposed-api.md` — documents programmatic API surface; no reference to CLI binary names or the `code` alias; not relevant
- No guide covers bin-alias management or migration documentation conventions

### Architectural Decisions

- No ADRs or recorded decisions found for the `code` bin alias introduction or its removal
- `restoreCliBinLink()` in `src/utils/cli-bin.ts` reflects a prior decision to protect the `codemie` symlink against agent plugin overwrites — that decision is scoped to `codemie` and does not extend to `code`

### Derived Conventions

- All user-visible documentation (README.md, docs/COMMANDS.md, docs/AGENTS.md, docs/EXAMPLES.md, docs/CONFIGURATION.md, docs/SKILLS.md) consistently uses `codemie` and `codemie-code` in examples; the `code` alias has never been surfaced to users in docs
- Migration notes should be placed in a new file (e.g., `docs/migration/`) or in a release notes document — no established location exists
- The project has no CHANGELOG file; a migration note should target release notes or the PR description as the minimum

---

## 4. Testing Landscape

### Existing Coverage

- `src/utils/__tests__/cli-bin.test.ts` — unit tests for `restoreCliBinLink()`; covers the `codemie` symlink guard only; no test touches the `code` alias
- `tests/integration/cli-commands/skills.test.ts` — e2e integration test for `codemie skills`; hard-codes `CLI_BIN = path.join(REPO_ROOT, 'bin', 'codemie.js')` (not `code`); tests command behavior, not bin-alias presence

### Testing Framework and Patterns

- Vitest (multi-project config: `unit`, `cli`, `agent` projects)
- Integration tests invoke CLI via `execa` or `child_process.spawn` against the `bin/` entry scripts directly
- No fixture or factory pattern specific to bin-alias testing

### Coverage Gaps

- No test asserts that the `code` bin command exists or is absent — the removal cannot be regression-tested without a new smoke-check
- No test covers `scripts/postinstall.mjs` behavior (PATH injection or alias creation)
- If the optional installer opt-in is added, its logic in `postinstall.mjs` would be entirely untested

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_CREATE_CODE_ALIAS` — does not exist today; would be a new env var to implement if the optional installer opt-in is added
- `CODEMIE_INTEGRATION_ALIAS` — existing env var in `src/utils/config.ts`; governs SDK integration alias, unrelated to the bin alias
- `CODEMIE_SKILLS_BIN_OVERRIDE` — test-only override for skills CLI binary path; unrelated

### Configuration Files

- `package.json` `bin` block — the only configuration governing the `code` alias; removing line 10 is the complete configuration change required for the core task
- `scripts/postinstall.mjs` — would need modification only if the opt-in alias feature is added; currently has no alias logic

### Feature Flags and Deployment Concerns

- No feature flags govern the `code` bin alias today
- npm's bin linking is applied at install time — removal from `package.json` takes effect for new installs and upgrades via `npm update -g`; users who installed before the removal retain the `code` symlink until they reinstall
- A breaking-change notice in the npm publish release notes is the standard mechanism to communicate this to existing users
- `install/macos/` and `install/windows/` desktop installers are unaffected

---

## 6. Risk Indicators

- **Stale symlinks on existing installs**: removing `"code"` from `package.json` does not remove the npm-created symlink on machines where `@codemieai/code` is already globally installed; users must reinstall or run `npm unlink code` manually — this is an inherent npm limitation and should be documented in the migration note
- **No test coverage for the `code` bin entry or its absence**: there is no CI gate that would catch a regression if the entry were accidentally re-added; a minimal smoke-check (asserting `code` command is absent post-install) would close this gap but does not exist
- **No CHANGELOG or migration guide infrastructure**: the project has no `CHANGELOG` file and no `docs/migration/` directory; the migration note must be created in a new location with no established convention to follow
- **Installer opt-in is a novel pattern**: `scripts/postinstall.mjs` currently only adds npm bin dir to PATH; writing a shell alias (e.g., `alias code=codemie >> ~/.zshrc`) would be new behavior with no precedent in the codebase — cross-shell correctness (zsh vs bash vs fish), idempotency, and quoting of the alias value would all need care
- **No documentation references the `code` alias**: the removal is low-risk from a documentation standpoint — README and all docs in `docs/` use only `codemie` and `codemie-code`; no doc updates are required for the core removal
- **codegraph returned false positives on dimension 1**: the `bin package.json cli entry points` query returned chart.umd.js hits; direct file reads were used to confirm ground truth — this is a minor indexing noise, not a codebase risk

---

## 7. Summary for Complexity Assessment

The core removal is a single-line deletion from `package.json` (line 10, the `"code"` key in the `bin` block). No runtime code, no `src/` files, no `bin/` entry scripts, and no `scripts/postinstall.mjs` logic need to change for the removal itself. The `restoreCliBinLink()` utility in `src/utils/cli-bin.ts` is already scoped to the `codemie` symlink and is fully unaffected. All user-facing documentation already uses `codemie` and `codemie-code` exclusively — no README or docs/ updates are needed for the core change. The task touches only the Package Manifest layer for its mandatory portion. Estimated file change surface: one file, one line for the core removal.

The migration documentation requirement adds moderate scope: no CHANGELOG and no migration guide directory exist, so a new file and location must be established. The migration note itself is straightforward prose ("use `codemie` or `codemie-code`; if you need the `code` shorthand, add `alias code=codemie` to your shell RC"), but agreeing on the location and format introduces a small ambiguity. The stale-symlink caveat (npm does not auto-remove existing symlinks on upgrade) must be included in the migration note and is non-obvious to users.

The optional installer opt-in — creating a `code` shell alias via `postinstall.mjs` if a flag is set — is technically the highest-risk sub-task. It would introduce new shell-alias injection logic into `postinstall.mjs` (a novel pattern for this script), require cross-shell correctness (zsh, bash, fish), idempotency checks, and env-var gating (`CODEMIE_CREATE_CODE_ALIAS`). If product decides to implement it, this portion would expand the change surface to two or three files and add meaningful test coverage debt. Overall the task is low-complexity for the mandatory parts and medium-complexity if the opt-in feature is included.
