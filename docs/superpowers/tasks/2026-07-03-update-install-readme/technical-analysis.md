# Technical Analysis — update-install-readme

## Task
Update `install/README.md` so it accurately reflects the actual contents of the `install/` folder. The README is out of date.

## Scope
Docs-only change. Single file: `install/README.md`. No code, no scripts, no behavior change.

## Codebase Findings

### Folder contents (ground truth)
`install/` contains exactly six entries:

| Path | Type | Documented in README? |
|---|---|---|
| `README.md` | doc | (self) |
| `macos/install.sh` | shell bootstrap script | ✅ partially |
| `macos/CodeMie Connect_2.0.1_aarch64_signed.dmg` | macOS GUI installer (signed, Apple Silicon) | ❌ **missing entirely** |
| `windows/install.ps1` | PowerShell bootstrap script | ✅ partially |
| `windows/install.cmd` | CMD wrapper | ✅ |
| `windows/CodeMie Connect_2.0.1_x64-setup.exe` | Windows GUI wizard | ✅ detailed |

### Drift item 1 — macOS `.dmg` installer undocumented (major)
`install/macos/CodeMie Connect_2.0.1_aarch64_signed.dmg` (2.6 MB, signed, aarch64/Apple Silicon) has **zero coverage** in `install/README.md`. The top-level `README.md:71` documents it as a GUI installer option, but `install/README.md`'s only "Installation Wizard" section covers Windows exclusively.
- The macOS wizard is a SwiftUI app built in a **separate repository** (`codemie-claude-installer-mac`; per `docs/superpowers/plans/2026-06-03-codemie-claude-installer-mac.md`). Its step list / log path are not verifiable from this repo.
- Verifiable facts: filename, signed, aarch64 (Apple Silicon) only, GUI/no-terminal, download/browse URLs.

### Drift item 2 — PowerShell `install.ps1` parameters underdocumented
The README mentions only `-Version` and `-InstallRoot`. Actual parameters (`install.ps1:2-9`):

| Param | Values / default | Purpose |
|---|---|---|
| `-Mode` | `portable` (default) \| `npm-global` | portable = npm prefix under InstallRoot + shim `.cmd`s in `bin/`; npm-global = plain `npm install -g` |
| `-Version` | string, default `''` | pin package version |
| `-RegistryUrl` | default `https://registry.npmjs.org/` | npm registry |
| `-ScopeRegistryUrl` | default `''` | sets `@codemieai:registry` |
| `-InstallRoot` | default `%LOCALAPPDATA%\CodeMie` | portable install root |
| `-DryRun` | switch | print actions, execute nothing |

### Drift item 3 — Shell `install.sh` env vars underdocumented
README mentions only `CODEMIE_PACKAGE_VERSION` (and `CODEMIE_INSTALL_URL` for the CMD wrapper). Actual env vars (`install.sh:6-10`):

| Env var | Values / default | Purpose |
|---|---|---|
| `CODEMIE_REGISTRY_URL` | default `https://registry.npmjs.org/` | npm registry |
| `CODEMIE_SCOPE_REGISTRY_URL` | default `''` | sets `@codemieai:registry` |
| `CODEMIE_INSTALL_MODE` | `auto` (default) \| `npm-global` \| `user-prefix` | auto picks npm-global if prefix writable, else user-prefix |
| `CODEMIE_NPM_PREFIX` | default `$HOME/.codemie/npm-prefix` | user-prefix target |
| `CODEMIE_PACKAGE_VERSION` | default `''` | pin package version |

### Drift item 4 — stale version example
README pins the example release tag to `v0.0.57` (lines 51, 86 equivalent). `package.json` version is now `0.8.0`. Example tag should be refreshed to `v0.8.0`. (The top-level `README.md` carries the same stale `v0.0.57` examples, but that file is out of scope here.)

### Drift item 5 — install-mode asymmetry unexplained
Windows default = `portable` mode (npm prefix + 7 shim `.cmd` files under `bin/`, PATH update). macOS/Linux default = `auto` (npm-global if writable, else user-prefix with `$HOME/.codemie/npm-prefix`). README describes both behaviors but never names the modes or maps them to the script params/env vars, so the two columns read as inconsistent rather than symmetric.

### Drift item 6 — CMD wrapper behavior
`install/windows/install.cmd` (verified): defaults `CODEMIE_INSTALL_URL` to `https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/windows`, `curl`s `install.ps1` to `%TEMP%`, executes it, deletes it. README's CMD section is accurate but light on the `CODEMIE_INSTALL_URL` override semantics (it overrides the **directory**, not the file).

### Accurate content to preserve
- GitHub raw URL section (lines 21–51) — correct, just needs tag refresh.
- Windows Defaults section (`%LOCALAPPDATA%\CodeMie`, `npm.cmd` direct call, `%*` forwarding limitation) — accurate.
- macOS/Linux Defaults paragraph — accurate.
- Windows Installation Wizard section (steps table, unattended mode, default paths, log file) — authoritative; preserve as-is.
- Release Artifacts section — accurate (`npm run prepare:install-artifacts` → `artifacts/install/`, checksums from generated content).

## Risk Indicators
- **Binary `.dmg`/`.exe` in repo** — README must not claim behaviors verifiable only from the (separate-repo) wizard sources. Keep macOS wizard section factual.
- **Version-pinned filenames** (`CodeMie Connect_2.0.1_*`) drift from npm package version (`0.8.0`) — different versioning schemes; README should state the wizard version as part of the filename, not imply it equals the npm version.
- **`artifacts/install/manifest.json`** still shows `packageVersion: 0.0.57` — generated artifact, out of scope for this README fix; do not "fix" it.

## Orchestrator Digest
Single-file docs update with clear, codebase-grounded drift list. No ambiguity in *what* to fix; the only judgment call is how much detail to give the macOS wizard given its sources live in another repo — recommendation is a factual minimal section (existence, platform, signed, download/browse link) mirroring the top-level README's treatment, not a fabricated step table. No code, no tests, no scripts touched.

**Open questions:** none blocking — proceeding with the minimal-but-factual macOS wizard section and a consolidated script-options reference table.
