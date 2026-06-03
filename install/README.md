# CodeMie Bootstrap Installers

This directory contains source files for the lightweight CodeMie bootstrap installers.

Two distribution models are supported:

1. **Hosted scripts** — run directly from GitHub raw URLs or mirror to Artifactory:
   - Windows PowerShell: `install/windows/install.ps1`
   - Windows CMD: `install/windows/install.cmd`
   - macOS/Linux/WSL: `install/macos/install.sh`

2. **Windows Installation Wizard** — a self-contained GUI installer:
   - `install/windows/CodemieWizard.exe`

The scripts can be run directly from GitHub raw URLs or mirrored to Artifactory later. They do not require a Windows-built `.exe`.

Set `CODEMIE_INSTALL_URL` only when you want to override the public GitHub raw location, for example with an enterprise Artifactory mirror. If it is unset, `install/windows/install.cmd` downloads the PowerShell installer from this public repository.

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

For reproducible installs, replace `main` with a release tag such as `v0.0.57`.

## Windows Defaults

Windows installs into the current user's local profile by default:

```text
%LOCALAPPDATA%\CodeMie
```

The installer calls `npm.cmd` directly to avoid PowerShell resolving `npm` to `npm.ps1`.

Known limitation: `install/windows/install.cmd` forwards arguments to PowerShell through `%*`. Use the PowerShell installer directly when passing arguments that contain spaces, such as `-InstallRoot "C:\My Folder"`.

## macOS/Linux Defaults

macOS, Linux, and WSL prefer npm global installation when global npm is user-writable. If global npm is not writable, the script configures a user-local npm prefix.

## Windows Installation Wizard

`install/windows/CodemieWizard.exe` is a self-contained Windows desktop GUI application that installs and configures the CodeMie Claude Code CLI end-to-end. It requires no terminal knowledge and bundles all dependencies.

### Running the Wizard

Double-click `CodemieWizard.exe`. No command-line arguments are supported — the wizard is a pure GUI application.

The wizard walks through the following steps in order:

| Step | What it does |
|------|-------------|
| PowerShell execution policy | Sets `RemoteSigned` scope for the current user |
| Git for Windows | Detects an existing install or silently downloads and installs v2.47.0-64-bit |
| Node.js + npm | Detects an existing install or silently downloads and installs Node.js LTS v20.18.0 |
| CodeMie CLI | Installs `@codemieai/code` globally via `npm install -g` |
| CodeMie setup | Opens a visible terminal window and runs `codemie setup` interactively |
| Claude engine | Opens a visible terminal window and runs `codemie install claude --supported` |
| Validation | Runs `codemie doctor` to confirm everything is working |

Each step that requires a download shows a progress animation and an inline **Approve** / **Ignore** button before proceeding.

### Unattended Mode

Check the **Unattended mode** checkbox in the left sidebar before clicking Install. All approval gates auto-approve, so the wizard runs without prompts. The two interactive terminal steps (`codemie setup` and `codemie install claude`) still open a visible console window because they require user input.

### Default Paths

Tools are installed to their standard system locations:

```text
Git:    C:\Program Files\Git\cmd\git.exe
Node:   C:\Program Files\nodejs\node.exe
```

npm global binaries are added to the current user's `PATH`:

```text
%USERPROFILE%\AppData\Local\CodeMie\npm-prefix
%USERPROFILE%\AppData\Roaming\npm
```

### Log File

All wizard output is written to:

```text
%TEMP%\codemie_wizard.log
```

The log persists across runs. Each line is prefixed with an ISO-8601 timestamp and a tag: `[OUT]` stdout, `[ERR]` stderr, `[INF]` info, `[OK]` success, `[CMD]` command.

## Release Artifacts

Run this command to prepare publishable artifacts:

```bash
npm run prepare:install-artifacts
```

Generated files are written to `artifacts/install/` and are not committed.

Generated artifacts include a version header and their checksums are computed from the generated artifact content, not from the source files under `install/`.
