DONE

Commit: 7366f95 (fix(ci): stop macOS/Linux installer from rewriting user npm prefix)
Changed paths: install/macos/install.sh

Verification:
- `sh -n install/macos/install.sh` -> EXIT=0 (log: docs/superpowers/tasks/2026-09-28-epmcdme-15307/test.local.log)
- `grep -n "npm config set prefix" install/macos/install.sh` -> no matches (grep exit 1)

Summary:
- Added migration before auto resolution: detects the legacy override only when `npm config get prefix --location user` exactly equals `$USER_PREFIX` (default `$HOME/.codemie/npm-prefix`), lists stranded packages (`npm ls -g --prefix <old> --depth=0`), runs and reports `npm config delete prefix --location user`.
- Removed `npm config set prefix ... --location user` from user-prefix mode; kept the `$USER_PREFIX/bin` PATH hint.
- `npm install -g` now passes `--prefix "$USER_PREFIX"` in user-prefix mode.
- After a detected migration, prints reinstall guidance (`npm i -g @anthropic-ai/claude-code@latest`) and optional `rm -rf "$USER_PREFIX"` at the end of the run.
- After `CODEMIE_SCOPE_REGISTRY_URL` is written, prints its revert command (`npm config delete @codemieai:registry --location user`).

Concerns:
- The brief's migration list didn't ask for a "Revert: npm config set prefix ..." print (unlike the Windows script); I initially added one by analogy but removed it because it would fail the mandated grep gate (which bans the literal string "npm config set prefix" anywhere in the file). AC5 in spec.md ("every setting the installer changes or deletes is printed together with its revert command") is technically not fully satisfied for the prefix deletion on macOS/Linux — only the scope-registry write gets a revert line. This is a direct conflict between AC5 and the grep gate as given; I followed the explicit grep gate since it was given to me as a hard verification requirement.
- `sh` resolves to bash in this Git Bash environment, not dash; `sh -n` here doesn't catch bash-only syntax. I avoided introducing new bashisms (no arrays) for portability, but pre-existing code (e.g. `local` inside `node_major()`) was already there before my change and is unaffected.
- Did not execute the installer itself, per instructions.

## Fix round 1

Commits:
- b6cd1b2 (fix(ci): print prefix revert and use fixed legacy path in installer migration) — install/macos/install.sh
- d23c129 (docs(ci): clarify legacy prefix detection uses a fixed path) — install/README.md

Fixes applied, addressing feedback that AC5 wins over the over-broad grep gate:
1. After `npm config delete prefix --location user` runs, install.sh now prints `Revert: npm config set prefix "$LEGACY_PREFIX" --location user` (echo only, never executed).
2. Legacy detection, the stranded-package listing, the revert text, and the `rm -rf` guidance now all use a new fixed variable `LEGACY_PREFIX="$HOME/.codemie/npm-prefix"`, not the overridable `$USER_PREFIX` (which follows `CODEMIE_NPM_PREFIX` when set). install/README.md's migration step 1 was reworded to state detection always uses the fixed path, not `CODEMIE_NPM_PREFIX`.

Verification:
- `sh -n install/macos/install.sh` -> EXIT=0
- `grep -n "npm config set prefix" install/macos/install.sh` -> one match, on an `echo` line only (`echo "Revert: npm config set prefix \"$LEGACY_PREFIX\" --location user"`), never executed as a command.

`git show --stat HEAD` confirmed each fix commit touches exactly its one intended path.
