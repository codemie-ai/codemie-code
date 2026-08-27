# FCC (LiteLLM Gateway) Setup Guide

## For Custom LLM Deployments

This guide explains how to set up and use FCC (Free Claude Code), a custom Claude Code deployment that routes requests through a LiteLLM gateway with custom authentication.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Quick Start](#2-quick-start)
3. [Manual Installation](#3-manual-installation)
4. [Configuration](#4-configuration)
5. [Usage](#5-usage)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Prerequisites

Before installing FCC, ensure you have:

### Required Access

- **LiteLLM Gateway URL**: The URL of your LiteLLM proxy server
- **API Key**: Your LiteLLM API key (obtain from your infrastructure team)
- **Auth Token**: Authentication token if required by your deployment

### System Requirements

| Component | Minimum Version | How to Check |
|-----------|-----------------|--------------|
| Windows | 10/11 | `winver` |
| PowerShell | 5.1+ | `$PSVersionTable.PSVersion` |
| Node.js | 18+ | `node -v` |
| Python | 3.10+ (via uv) | `uv python list` |

### Network Requirements

If you're behind a corporate proxy, you'll need to configure proxy access:

```powershell
$env:HTTP_PROXY = "http://your-proxy:port"
$env:HTTPS_PROXY = "http://your-proxy:port"
```

---

## 2. Quick Start

The fastest way to install FCC is using the CodeMie CLI:

### Step 1: Install FCC Provider

```bash
codemie install fcc
```

### Step 2: Run Setup Wizard

```bash
codemie setup --provider fcc
```

Follow the prompts to enter:
- LiteLLM API key
- Gateway server URL
- Authentication token

### Step 3: Verify Installation

```bash
codemie-claude --provider fcc "Hello, are you working?"
```

---

## 3. Manual Installation

If you prefer to install components manually, follow these steps:

### 3.1 Install uv (Python Package Manager)

Via winget (recommended):

```powershell
winget install --id astral-sh.uv --source winget
```

Restart PowerShell after installation.

Manual install (if winget fails):
- Download from: https://github.com/astral-sh/uv/releases
- Extract to `C:\Users\<YourUsername>\.local\bin`
- Add to PATH: `$env:PATH += ";C:\Users\<YourUsername>\.local\bin"`

### 3.2 Install Python (via uv)

```powershell
uv python install 3.11
```

### 3.3 Check/Install Node.js

```powershell
node -v  # Must be v18 or higher
```

If Node.js is missing or outdated:

```powershell
winget install --id OpenJS.NodeJS.LTS --source winget
```

### 3.4 Install Claude Code CLI

```powershell
npm install -g @anthropic-ai/claude-code
```

If behind corporate proxy:

```powershell
npm config set proxy http://your-proxy:port
npm config set https-proxy http://your-proxy:port
npm install -g @anthropic-ai/claude-code
```

### 3.5 Create Configuration

Create `~/.fcc/.env` file:

```env
# FCC (LiteLLM Gateway) Configuration
FCC_SERVER_URL=https://your-litellm-gateway.example.com
ANTHROPIC_AUTH_TOKEN=your-auth-token
FCC_LITELLM_KEY=your-litellm-api-key
```

---

## 4. Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ANTHROPIC_AUTH_TOKEN` | Auth token for Claude Code | - | ✅ |
| `FCC_LITELLM_KEY` | FCC LiteLLM API key | - | ✅ |
| `FCC_SERVER_URL` | FCC server URL | - | ✅ |
| `HTTP_PROXY` | Corporate proxy URL | - | ❌ |
| `HTTPS_PROXY` | Corporate proxy URL | - | ❌ |

### Permanent Environment Variables (Windows)

To set environment variables permanently:

1. Open **System Properties** → **Advanced** → **Environment Variables**
2. Add User variables:
   - `ANTHROPIC_AUTH_TOKEN = your-token`
   - `FCC_LITELLM_KEY = your-key`
   - `FCC_SERVER_URL = your-gateway-url`
3. Add `C:\Users\<YourUsername>\.local\bin` to PATH

### Using CodeMie CLI

If you have CodeMie CLI installed, you can create a profile:

```bash
codemie profile create fcc
# Follow prompts to enter:
# - Provider: fcc
# - LiteLLM Key: your-key
# - Server URL: your-gateway-url
# - Auth Token: your-token
```

---

## 5. Usage

### Basic Commands

```bash
# Start interactive Claude session
codemie-claude --provider fcc

# Run one-shot command
codemie-claude --provider fcc "Review this code"

# List available models
codemie models list --provider fcc
```

### Using with CodeMie CLI

After setting up the FCC provider:

```bash
# Use FCC provider with Claude
codemie-claude --provider fcc "Refactor this module"

# Create a new profile
codemie profile create my-fcc-profile

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
Submit a request to your IT team for proxy access to your LiteLLM gateway URL.

#### 2. Python Installation Fails

**Error:**
```
uv python install 3.11
# Fails with connection error
```

**Solution:**
Set proxy variables explicitly:

```powershell
$env:HTTP_PROXY = "http://your-proxy:port"
$env:HTTPS_PROXY = "http://your-proxy:port"
uv python install 3.11
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
'codemie-claude' is not recognized
```

**Solution:**
Ensure CodeMie CLI is installed globally:

```powershell
npm install -g @codemieai/code
```

### Hidden Files Issue (npm)

If npm commands fail silently or can't find modules:

1. Open `C:\Users\<YourUsername>\`
2. Click **View** → **Show** → **Hidden items**
3. Navigate to `AppData` (may also be hidden)
4. Check for `.npmrc` file
5. Remove any proxy or registry entries that may conflict

### .npmrc Proxy Issues

If `.npmrc` has old proxy settings:

1. Open `C:\Users\<YourUsername>\.npmrc`
2. Remove lines like:
   ```
   proxy=http://old-proxy:8080
   https-proxy=http://old-proxy:8080
   registry=http://internal-nexus/
   ```
3. Save and retry installation

### Gateway Access Denied

**Error:**
```
fatal: Authentication failed for 'https://your-gateway/...'
```

**Solution:**
Contact your infrastructure team to request access to the LiteLLM gateway.

---

## Support

If you encounter issues not covered in this guide:

1. Check the CodeMie CLI documentation
2. Contact your infrastructure team for gateway access
3. Run `codemie doctor` for diagnostics

---

## Quick Reference

```powershell
# Full installation sequence (run as Administrator)
winget install --id astral-sh.uv --source winget
# Restart PowerShell
uv python install 3.11
node -v  # Check version (must be 18+)
winget install --id OpenJS.NodeJS.LTS --source winget  # If needed
npm install -g @anthropic-ai/claude-code
npm install -g @codemieai/code

# Set environment variables
$env:FCC_SERVER_URL = "https://your-gateway.example.com"
$env:FCC_LITELLM_KEY = "your-api-key"
$env:ANTHROPIC_AUTH_TOKEN = "your-auth-token"
$env:PATH += ";C:\Users\$env:USERNAME\.local\bin"

# Run
codemie-claude --provider fcc
```