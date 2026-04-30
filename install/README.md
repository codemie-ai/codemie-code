# CodeMie Bootstrap Installers

This directory contains source files for the lightweight CodeMie bootstrap installers.

The first supported distribution model is hosted scripts:

- Windows PowerShell: `install/windows/install.ps1`
- Windows CMD: `install/windows/install.cmd`
- macOS/Linux/WSL: `install/macos/install.sh`

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

## Release Artifacts

Run this command to prepare publishable artifacts:

```bash
npm run prepare:install-artifacts
```

Generated files are written to `artifacts/install/` and are not committed.

Generated artifacts include a version header and their checksums are computed from the generated artifact content, not from the source files under `install/`.
