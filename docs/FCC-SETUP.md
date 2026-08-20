# FCC (Free Claude Code) Setup Guide

**For Halyk Bank Corporate Users**

This guide explains how to set up and use FCC (Free Claude Code), Halyk Bank's internal Claude Code deployment that routes requests through the corporate LiteLLM gateway with SSO authentication.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Quick Start](#2-quick-start)
3. [Manual Installation](#3-manual-installation)
4. [Configuration](#4-configuration)
5. [Usage](#5-usage)
6. [Troubleshooting](#6-troubleshooting)
7. [Edge Cases](#7-edge-cases)

---

## 1. Prerequisites

Before installing FCC, ensure you have:

### Required Access

- **GitLab Access**: Membership in `spm-api` group on GitLab (`gitlab.halykbank.nb`)
- **API Key**: FCC LiteLLM API key (request from **Дамир Бахтияров** or **Алышер Сағидолдаев**)
- **Local Admin Rights**: Required for PowerShell commands and software installation

### System Requirements

| Component | Minimum Version | How to Check |
|-----------|-----------------|--------------|
| Windows | 10/11 | `winver` |
| PowerShell | 5.1+ | `$PSVersionTable.PSVersion` |
| Node.js | 18+ | `node -v` |
| Python | 3.10+ (via uv) | `uv python list` |

### Network Requirements

If you're behind the corporate proxy, you'll need proxy access:

- **Proxy URL**: `http://172.26.66.21:8080`
- **Access Request**: Submit ticket via Ivanti → "Пользовательский доступ к интернет ресурсам"
- **Example Ticket**: #2415385 (reference ticket)

---

## 2. Quick Start

The fastest way to install FCC is using the automated PowerShell script:

### Step 1: Copy Installation Script

Copy the script from:
```
W:\IT_\ДАБП\ДАБП\Alisher\install-fcc.ps1
```

Save it to your Desktop or a convenient location.

### Step 2: Run Installation Script

Open PowerShell **as Administrator** and run:

```powershell
cd C:\Users\<YourUsername>\Desktop
.\install-fcc.ps1
```

### Step 3: Set Environment Variables

After installation, set these environment variables:

```powershell
$env:ANTHROPIC_AUTH_TOKEN = "freecc"
$env:FCC_LITELLM_KEY = "<Your API Key>"
$env:PATH += ";C:\Users\<YourUsername>\.local\bin"
```

For permanent setup, add these to your system environment variables.

### Step 4: Verify Installation

```powershell
fcc-claude --version
claude --version
```

### Step 5: Run FCC Claude

Navigate to your project directory and run:

```powershell
cd C:\path\to\your\project
fcc-claude
```

---

## 3. Manual Installation

If you prefer to install components manually, follow these steps:

### 3.1 Install uv (Python Package Manager)

**Via winget (recommended):**

```powershell
winget install --id astral-sh.uv --source winget
```

**Restart PowerShell after installation.**

**Manual install (if winget fails):**

1. Download from: https://github.com/astral-sh/uv/releases
2. Extract to `C:\Users\<YourUsername>\.local\bin`
3. Add to PATH: `$env:PATH += ";C:\Users\<YourUsername>\.local\bin"`

### 3.2 Install Python (via uv)

```powershell
uv python install 3.14.6
```

### 3.3 Check/Install Node.js

```powershell
node -v  # Must be v18 or higher
```

If Node.js is missing or outdated:

```powershell
winget install --id OpenJS.NodeJS --source winget
```

### 3.4 Install Claude Code CLI

```powershell
npm install -g @anthropic-ai/claude-code
```

**If behind corporate proxy:**

```powershell
npm config set proxy http://172.26.66.21:8080
npm config set https-proxy http://172.26.66.21:8080
npm install -g @anthropic-ai/claude-code
```

### 3.5 Install FCC

```powershell
uv tool install --force --reinstall git+https://gitlab.halykbank.nb/spm-api/genai/localclaude.git
```

### 3.6 Create Configuration

Create `~/.fcc/.env` file:

```env
# Free Claude Code Configuration
FCC_SERVER_URL=https://fcc-server-spmng.apps.spm3-dev-rz.halykbank.nb
ANTHROPIC_AUTH_TOKEN=freecc
```

---

## 4. Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ANTHROPIC_AUTH_TOKEN` | Auth token for Claude Code | `freecc` | ✅ |
| `FCC_LITELLM_KEY` | FCC LiteLLM API key | - | ✅ |
| `FCC_SERVER_URL` | FCC server URL | `https://fcc-server-spmng.apps.spm3-dev-rz.halykbank.nb` | ❌ |
| `HTTP_PROXY` | Corporate proxy URL | `http://172.26.66.21:8080` | ❌ |
| `HTTPS_PROXY` | Corporate proxy URL | `http://172.26.66.21:8080` | ❌ |

### Permanent Environment Variables (Windows)

To set environment variables permanently:

1. Open **System Properties** → **Advanced** → **Environment Variables**
2. Add **User variables**:
   - `ANTHROPIC_AUTH_TOKEN` = `freecc`
   - `FCC_LITELLM_KEY` = `<your key>`
   - Add `C:\Users\<YourUsername>\.local\bin` to `PATH`

### Using CodeMie CLI

If you have CodeMie CLI installed, you can create a profile:

```bash
codemie profile create halyk-fcc
# Follow prompts to enter:
# - Provider: fcc
# - FCC LiteLLM Key: <your key>
# - Server URL: (accept default)
```

---

## 5. Usage

### Basic Commands

```powershell
# Start interactive Claude session
fcc-claude

# Run one-shot command
fcc-claude "Review this code"

# Start Codex (if installed)
fcc-codex

# Run local proxy server
fcc-server
```

### Using with CodeMie CLI

After setting up the FCC provider in CodeMie:

```bash
# Use FCC provider with Claude
codemie-claude --provider fcc "Refactor this module"

# Create a new profile
codemie profile create halyk-work

# List available models
codemie models list --provider fcc
```

---

## 6. Troubleshooting

### Common Issues

#### 1. Proxy Authorization Error

**Error:**
```
Caused by: client error (Connect)
Caused by: tunnel error: proxy authorization required
```

**Solution:**

Submit Ivanti request:
- **Service**: Пользовательский доступ к интернет ресурсам
- **PC Name**: Your computer name
- **IP Address**: Your IP
- **Phone**: Your contact number
- **Reference**: Ticket #2415385

#### 2. Python Installation Fails

**Error:**
```
uv python install 3.14.6
# Fails with connection error
```

**Solution:**

Set proxy variables explicitly:

```powershell
$env:HTTP_PROXY = "http://172.26.66.21:8080"
$env:HTTPS_PROXY = "http://172.26.66.21:8080"
$env:UV_PYTHON_INSTALL_MIRROR = "https://github.com/indygreg/python-build-standalone/releases/download"
uv python install 3.14.6
```

#### 3. Node.js Version Too Old

**Error:**
```
Node.js v16.x is too old. Requires 18+.
```

**Solution:**

```powershell
winget install --id OpenJS.NodeJS.LTS
```

#### 4. npm 404 Error

**Error:**
```
npm ERR! 404 Not Found - @anthropic-ai/claude-code
```

**Solution:**

Check your npm registry configuration:

```powershell
npm config get registry
# Should be https://registry.npmjs.org/
```

If using corporate Artifactory, ensure `@anthropic-ai` scope is exposed.

#### 5. Claude Code Not Found After Install

**Error:**
```
'claude' is not recognized as a command
```

**Solution:**

1. Restart PowerShell
2. Check npm global bin path: `npm config get prefix`
3. Add to PATH: `$env:PATH += ";<npm-global-prefix>"`

#### 6. FCC Tool Not Found

**Error:**
```
'fcc-claude' is not recognized
```

**Solution:**

Add uv tool bin to PATH:

```powershell
$env:PATH += ";C:\Users\<YourUsername>\.local\bin"
```

For permanent fix, add to system PATH via Environment Variables.

---

## 7. Edge Cases

### 7.1 Hidden Files Issue (npm)

If npm commands fail silently or can't find modules:

1. Open `C:\Users\<YourUsername>\`
2. Click **View** → **Show** → **Hidden items**
3. Navigate to `AppData` (may also be hidden)
4. Check for `.npmrc` file
5. Remove any proxy or registry entries that may conflict

### 7.2 .npmrc Proxy Issues

If `.npmrc` has old proxy settings:

1. Open `C:\Users\<YourUsername>\.npmrc`
2. Remove lines like:
   ```
   proxy=http://old-proxy:8080
   https-proxy=http://old-proxy:8080
   registry=http://internal-nexus/
   ```
3. Save and retry installation

### 7.3 GitLab Access Denied

**Error:**
```
fatal: Authentication failed for 'https://gitlab.halykbank.nb/...'
```

**Solution:**

Request access to `spm-api` group on GitLab. Contact:
- **Дамир Бахтияров**
- **Алышер Сағидолдаев**

### 7.4 Microsoft Desktop App Installer Missing

Required for winget commands:

```powershell
Get-AppxPackage -AllUsers -Name "Microsoft.DesktopAppInstaller" | Foreach {
  Add-AppxPackage -DisableDevelopmentMode -Register "$($_.InstallLocation)\AppXManifest.xml"
}
```

---

## Support

If you encounter issues not covered in this guide:

1. Check the [install-fcc.ps1](../install/windows/install-fcc.ps1) script for latest installation logic
2. Contact **Дамир Бахтияров** or **Алышер Сағидолдаев**
3. Reference ticket #2415385 for network access issues

---

## Quick Reference

```powershell
# Full installation sequence (run as Administrator)
Get-AppxPackage -AllUsers -Name "Microsoft.DesktopAppInstaller" | Foreach {Add-AppxPackage -DisableDevelopmentMode -Register "$($_.InstallLocation)\AppXManifest.xml"}
winget install --id astral-sh.uv --source winget
# Restart PowerShell
uv python install 3.14.6
node -v  # Check version (must be 18+)
winget install --id OpenJS.NodeJS --source winget  # If needed
npm install -g @anthropic-ai/claude-code
uv tool install --force --reinstall git+https://gitlab.halykbank.nb/spm-api/genai/localclaude.git

# Set environment variables
$env:ANTHROPIC_AUTH_TOKEN = "freecc"
$env:FCC_LITELLM_KEY = "<API Key>"
$env:PATH += ";C:\Users\$env:USERNAME\.local\bin"

# Run
fcc-claude
```