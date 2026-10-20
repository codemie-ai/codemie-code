# CodeMie Bootstrap Installers

This directory contains source files for the CodeMie installers:

- **CodeMie Connect** — a signed `.dmg` desktop app for macOS (Apple Silicon) that sets up Node.js and the CodeMie CLI on first launch, so there is nothing to install first.
- **Script installers** — plain shell/PowerShell bootstrap scripts that install via npm. Prefer these for CI, headless machines, or when CodeMie Connect is unavailable.

## Distribution Models

Two distribution models are supported:

1. **Hosted scripts** — run directly from GitHub raw URLs or mirror to Artifactory:
   - Windows PowerShell: `install/windows/install.ps1`
   - Windows CMD: `install/windows/install.cmd`
   - macOS/Linux/WSL: `install/macos/install.sh`

2. **CodeMie Connect** — a self-contained desktop app:
   - macOS: the `.dmg` from the [latest codemie-connect release](https://github.com/codemie-ai/codemie-connect/releases/latest)
   - `install/manifest.json` tells installed apps which version is the latest and where to download it.

The scripts can be run directly from GitHub raw URLs or mirrored to Artifactory later. They do not require CodeMie Connect.

3. **Chrome extension** — a packaged `.zip` build of the CodeMie browser side panel, for manual
   install while the Chrome Web Store listing is pending review: see
   [`install/chrome/README.md`](chrome/README.md).

Set `CODEMIE_INSTALL_URL` only when you want to override the public GitHub raw location, for example with an enterprise Artifactory mirror. If it is unset, `install/windows/install.cmd` downloads the PowerShell installer from this public repository. `CODEMIE_INSTALL_URL` points at the **directory** containing `install.ps1`, not the file itself.

Channel selection is not implemented in the bootstrap scripts yet. Install the default npm package version, or pass an explicit version with PowerShell `-Version` or shell `CODEMIE_PACKAGE_VERSION`.

## GitHub Raw URLs

Use `main` for the latest installer source.

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/windows/install.ps1 | iex
```

Windows CMD:

```cmd
curl -fsSL https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/windows/install.cmd -o install.cmd && install.cmd && del install.cmd
```

macOS, Linux, and WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/macos/install.sh | bash
```

Direct file URLs:

```text
https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/windows/install.ps1
https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/windows/install.cmd
https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/macos/install.sh
```

For reproducible installs, replace `main` with a release tag such as `v0.8.0`.

## Script Options

### Windows PowerShell (`install/windows/install.ps1`)

| Parameter | Default | Values / Purpose |
|---|---|---|
| `-Mode` | `auto` | `auto` = `npm-global` if the npm prefix is user-writable, otherwise `portable`; `npm-global` = plain `npm install -g` into the existing npm prefix; `portable` = npm prefix under `-InstallRoot` with shim `.cmd` files in `bin/`, adding `bin/` and the prefix to the user PATH |
| `-Version` | *(empty)* | Pin `@codemieai/code` to a specific version |
| `-RegistryUrl` | `https://registry.npmjs.org/` | npm registry used for resolution and install |
| `-ScopeRegistryUrl` | *(empty)* | Sets the `@codemieai:registry` npm scope to an enterprise registry |
| `-InstallRoot` | `%LOCALAPPDATA%\CodeMie` | Portable install root (`-Mode portable` only) |
| `-DryRun` | *(switch)* | Print every action without executing it |

### macOS / Linux / WSL (`install/macos/install.sh`)

| Env var | Default | Values / Purpose |
|---|---|---|
| `CODEMIE_INSTALL_MODE` | `auto` | `auto` = `npm-global` if the npm prefix is user-writable, otherwise `user-prefix`; `npm-global` = plain global install; `user-prefix` = install under `CODEMIE_NPM_PREFIX` |
| `CODEMIE_NPM_PREFIX` | `$HOME/.codemie/npm-prefix` | npm prefix used when `CODEMIE_INSTALL_MODE` resolves to `user-prefix` |
| `CODEMIE_PACKAGE_VERSION` | *(empty)* | Pin `@codemieai/code` to a specific version |
| `CODEMIE_REGISTRY_URL` | `https://registry.npmjs.org/` | npm registry used for resolution and install |
| `CODEMIE_SCOPE_REGISTRY_URL` | *(empty)* | Sets the `@codemieai:registry` npm scope to an enterprise registry |

Pin a version on macOS/Linux/WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/macos/install.sh | env CODEMIE_PACKAGE_VERSION=0.8.0 bash
```

## Windows Defaults

Windows uses `-Mode auto` by default: npm global installation when global npm is user-writable, otherwise a portable install into the current user's local profile:

```text
%LOCALAPPDATA%\CodeMie
```

The installer calls `npm.cmd` directly to avoid PowerShell resolving `npm` to `npm.ps1`.

Known limitation: `install/windows/install.cmd` forwards arguments to PowerShell through `%*`. Use the PowerShell installer directly when passing arguments that contain spaces, such as `-InstallRoot "C:\My Folder"`.

## macOS/Linux Defaults

macOS, Linux, and WSL use `CODEMIE_INSTALL_MODE=auto` by default: npm global installation when global npm is user-writable. If global npm is not writable, the script installs into a user-local npm prefix (`$HOME/.codemie/npm-prefix`).

## Upgrading from an Older Installer

Older installers set the npm `prefix` in the user `.npmrc` to `%LOCALAPPDATA%\CodeMie\npm-prefix` (Windows) or `$HOME/.codemie/npm-prefix` (macOS/Linux), which redirected every `npm install -g` into that folder and could break npm-installed tools such as Claude Code. Rerun the installer to remove the override; it lists the packages left in the old folder so you can reinstall them. `codemie doctor` reports the override and prints the manual fix:

```bash
npm config delete prefix --location user
npm i -g @anthropic-ai/claude-code@latest   # repeat for each package listed in the old folder
```

## macOS Installation

The macOS `.dmg` is CodeMie Connect, a signed and notarized macOS desktop app for **Apple Silicon (aarch64)** Macs. On first launch it downloads Node.js and the CodeMie CLI for its own use, so nothing needs to be installed first, and it keeps that CLI up to date in the background. (An Intel x86_64 build is not shipped.)

CodeMie Connect is built and released from a separate repository, [codemie-connect](https://github.com/codemie-ai/codemie-connect/releases).

### Running CodeMie Connect

Download the `.dmg` from the [latest release](https://github.com/codemie-ai/codemie-connect/releases/latest), open it, and run the app. It runs a guided setup (sign in, pick a model, install a tool), then opens to a Home screen, a Tools screen for installing or removing coding tools, and a Health screen that runs `codemie doctor`.

### Log File

App output is written to `~/Library/Logs/CodeMie/codemie_wizard.log`. The log persists across runs.

From 2.1.1 the app checks codemie-connect's latest release for updates. `install/manifest.json` stays here for 2.1.0, which reads it from this repo; it points to 2.1.1. App versions are independent of the `@codemieai/code` npm package version.

## Release Artifacts

Run this command to prepare publishable artifacts:

```bash
npm run prepare:install-artifacts
```

Generated files are written to `artifacts/install/` and are not committed.

Generated artifacts include a version header and their checksums are computed from the generated artifact content, not from the source files under `install/`.
