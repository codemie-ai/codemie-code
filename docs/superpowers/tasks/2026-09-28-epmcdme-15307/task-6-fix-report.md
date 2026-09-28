DONE

Fix round 1 for Task 6 (install/macos/install.sh + install/README.md).

Commits:
- b6cd1b2 (fix(ci): print prefix revert and use fixed legacy path in installer migration) — install/macos/install.sh
- d23c129 (docs(ci): clarify legacy prefix detection uses a fixed path) — install/README.md

Changes:
1. install.sh now prints `Revert: npm config set prefix "$LEGACY_PREFIX" --location user` right after running `npm config delete prefix --location user` (echo text only, never executed as a command) — satisfies AC5.
2. Introduced `LEGACY_PREFIX="$HOME/.codemie/npm-prefix"` as a fixed constant, separate from the overridable `USER_PREFIX="${CODEMIE_NPM_PREFIX:-$HOME/.codemie/npm-prefix}"`. Legacy detection, the stranded-package `npm ls` listing, the revert text, and the `rm -rf` cleanup guidance all now use `LEGACY_PREFIX`. install/README.md's migration section was reworded to state detection always compares against the fixed path, not against an overridden `CODEMIE_NPM_PREFIX`.

Verification:
- `sh -n install/macos/install.sh` -> EXIT=0
- `grep -n "npm config set prefix" install/macos/install.sh` -> exactly one match, an `echo` line printing the revert command; no executed `npm config set prefix` call exists in the file.
- `git show --stat HEAD` for both fix commits confirmed each touches exactly its one intended path; `git status --short` before and after each commit confirmed no other files (including docs/superpowers/ or .codemie/codemie-cli.config.json) were staged or committed.
