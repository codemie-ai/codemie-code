# Project-Level Configuration Guide

**Purpose**: Configure CodeMie settings per repository with fallback to global defaults

---

## Overview

CodeMie Code supports two levels of configuration:

1. **Global Configuration** (`~/.codemie/codemie-cli.config.json`)
   - Applies across all repositories
   - Default location for user settings

2. **Project Configuration** (`.codemie/codemie-cli.config.json`)
   - Repository-specific overrides
   - Falls back to global config for missing fields
   - Perfect for teams working across multiple CodeMie projects

### When to Use Each

| Use Case | Configuration Level |
|----------|---------------------|
| Personal default settings | Global |
| Team-wide standards | Global (committed to version control via setup scripts) |
| Project-specific overrides (CodeMie project, integration) | Local |
| Different providers per repository | Local |
| Repository-specific settings | Local |

---

## Getting Started

### 1. Interactive Setup

During `codemie setup`, you'll be asked where to store the configuration:

```bash
$ codemie setup

? Where would you like to store this configuration?
  ❯ Global (~/.codemie/) - Available across all repositories
    Local (.codemie/) - Only for this repository
```

**Global Setup**:
- Stores in `~/.codemie/codemie-cli.config.json`
- Available in all repositories
- Default choice for most users

**Local Setup**:
- Stores in `.codemie/codemie-cli.config.json` (repository root)
- Only applies in this repository
- Missing fields inherit from global config
- Useful for per-project customization

### 2. Typical Workflows

#### Workflow A: Global Config + Per-Repository Overrides

1. **Set up global defaults** (once):
   ```bash
   codemie setup
   # Select "Global"
   # Configure provider, auth, default project, etc.
   ```

2. **Override in specific repositories** (as needed):
   ```bash
   cd ~/code/frontend-app
   codemie setup
   # Select "Local"
   # Override codeMieProject: "frontend-app"
   # Override codeMieIntegration: "frontend-team"
   # Other fields inherit from global
   ```

#### Workflow B: Local-Only (No Global Config)

```bash
cd ~/code/my-repo
codemie setup
# Select "Local"
# Configure all settings for this repository
```

**Note**: If no global config exists, you must provide all required fields in local config.

---

## Configuration Priority

Settings are loaded in this priority order (highest to lowest):

```
CLI args > Environment variables > Project config > Global config > Defaults
```

### Examples

**Example 1: Project Override**
- Global config: `codeMieProject: "default-project"`
- Project config: `codeMieProject: "frontend-app"`
- **Result**: Uses `"frontend-app"` (project wins)

**Example 2: Partial Override**
- Global config: `provider: "bedrock"`, `model: "claude-3-5-sonnet"`, `codeMieProject: "global-project"`
- Project config: `codeMieProject: "frontend-app"`
- **Result**: Uses `bedrock` provider, `claude-3-5-sonnet` model, `frontend-app` project

**Example 3: Environment Variable**
- Global config: `model: "claude-3-5-sonnet"`
- Project config: `model: "claude-opus-4"`
- Environment: `CODEMIE_MODEL="gpt-4"`
- **Result**: Uses `gpt-4` (environment wins)

**Example 4: CLI Argument**
- All configs: `model: "claude-3-5-sonnet"`
- Command: `codemie-code chat --model=claude-opus-4 "Hello"`
- **Result**: Uses `claude-opus-4` (CLI args win)

---

### Example: 2-Level Lookup in Action

**Scenario**: You have both global and local configs:

**Global Config** (`~/.codemie/`):
- Profile `default`: bedrock, claude-3-5-sonnet
- Profile `work`: sso, company settings
- Profile `personal`: openai, gpt-4

**Local Config** (`.codemie/` in frontend-app):
- Profile `default`: codeMieProject="frontend-app" (overrides only this field)

**When you run `codemie profile`**:
```
● default (bedrock) [Local]     ← Local override of global "default"
○ work (sso) [Global]           ← Available from global
○ personal (openai) [Global]    ← Available from global
```

**When you switch to "work"**:
```bash
codemie profile switch work
✓ Switched to profile "work" in local config
```

**What happens**:
- Active profile in local config is set to "work"
- When loading config, it uses the "work" profile from global
- You're now using the global "work" profile!

**When you use the "default" profile**:
```bash
codemie profile switch default
```
- Active profile in local config is set to "default"
- When loading config:
  1. Loads global "default" profile (base)
  2. Overlays local "default" profile on top
  3. Result: bedrock + claude-3-5-sonnet + codeMieProject="frontend-app"

**Key Insight**: Local config doesn't isolate you from global profiles - it gives you access to both!

---

## Common Use Cases

### Use Case 1: Different Projects Per Repository

**Scenario**: You work on multiple CodeMie projects and want each repository to use its project-specific settings.

**Solution**:

1. **Global config** (`~/.codemie/`):
   ```json
   {
     "version": 2,
     "activeProfile": "default",
     "profiles": {
       "default": {
         "provider": "bedrock",
         "authMethod": "sso",
         "codeMieUrl": "https://codemie.example.com",
         "model": "claude-3-5-sonnet"
       }
     }
   }
   ```

2. **Frontend repository** (`.codemie/`):
   ```json
   {
     "version": 2,
     "activeProfile": "default",
     "profiles": {
       "default": {
         "codeMieProject": "frontend-app",
         "codeMieIntegration": {
           "id": "frontend-integration-456",
           "alias": "frontend-team"
         }
       }
     }
   }
   ```

3. **Backend repository** (`.codemie/`):
   ```json
   {
     "version": 2,
     "activeProfile": "default",
     "profiles": {
       "default": {
         "codeMieProject": "backend-service",
         "codeMieIntegration": {
           "id": "backend-integration-789",
           "alias": "backend-team"
         }
       }
     }
   }
   ```

**Result**:
- Frontend repo uses `frontend-app` project + `frontend-team` integration
- Backend repo uses `backend-service` project + `backend-team` integration
- Both inherit `bedrock` provider, `sso` auth, model from global

### Use Case 2: Different Providers Per Repository

**Scenario**: Test repository uses local Ollama, production uses AWS Bedrock.

**Solution**:

1. **Global config** (production default):
   ```json
   {
     "version": 2,
     "activeProfile": "default",
     "profiles": {
       "default": {
         "provider": "bedrock",
         "model": "claude-3-5-sonnet"
       }
     }
   }
   ```

2. **Test repository** (`.codemie/`):
   ```json
   {
     "version": 2,
     "activeProfile": "default",
     "profiles": {
       "default": {
         "provider": "ollama",
         "baseUrl": "http://localhost:11434",
         "model": "llama3.2"
       }
     }
   }
   ```

**Result**:
- Test repo uses Ollama locally
- Other repos use Bedrock (production)

### Use Case 3: Team Onboarding

**Scenario**: Share local config in version control for consistent team setup.

**Solution**:

1. **Create `.codemie/codemie-cli.config.json`** (committed):
   ```json
   {
     "version": 2,
     "activeProfile": "default",
     "profiles": {
       "default": {
         "codeMieProject": "team-project",
         "codeMieIntegration": {
           "id": "team-integration-123",
           "alias": "team-name"
         }
       }
     }
   }
   ```

2. **Add to `.gitignore` (optional)**:
   ```gitignore
   # Exclude sensitive overrides
   .codemie/codemie-cli.config.local.json
   ```

3. **Team members run**:
   ```bash
   git clone repo
   cd repo
   codemie setup  # Configure provider credentials globally
   # Local config overrides codeMieProject automatically
   ```

**Result**: Team members automatically use the correct project/integration.

---

## Configuration Management

### View Current Configuration

```bash
# Show active profile (checks local config first, then global)
codemie profile status

# Show config with source attribution
codemie profile status --show-sources

# List all profiles (from local config if it exists, otherwise global)
codemie profile
```

**Note**: All profile commands automatically detect and use local configuration when you're in a directory with `.codemie/codemie-cli.config.json`. You don't need to specify any flags.

**Example output** (with `--show-sources`):

```
Configuration Sources:

  Using local config: /Users/you/code/frontend-app/.codemie/codemie-cli.config.json

  codeMieIntegration: { id: "frontend-456", alias: "frontend-team" } (project)
  codeMieProject: frontend-app (project)
  model: claude-3-5-sonnet (global)
  provider: bedrock (global)
  timeout: 0 (default)

Priority: cli > env > project > global > default
```

### Manage Profiles with 2-Level Lookup

All profile commands use a **2-level lookup system** that provides access to both local and global profiles:

```bash
# List ALL profiles (both local and global)
codemie profile
# Shows:
# ● default (bedrock) [Local]
# ○ work (sso) [Global]

# Switch to ANY profile (local or global)
codemie profile switch work
# You can switch to global profiles even with local config!

# Delete profiles (specify which config to delete from)
codemie profile delete old-profile
```

**How 2-Level Lookup Works**:

1. **Profile Listing**: Shows profiles from BOTH local and global configs
   - Local profiles are marked with `[Local]`
   - Global profiles are marked with `[Global]`
   - If a profile exists in both, local version is shown (overrides global)

2. **Profile Loading**: When you use a profile, the system:
   - Loads the global profile as a base
   - Overlays the local profile on top (if it exists)
   - You get the merged result with local overrides

3. **Active Profile**: Can reference either a local or global profile
   - Set via `codemie profile switch <name>`
   - Stored in local config if `.codemie/` exists, otherwise global
   - When loading, the active profile is resolved from both sources

4. **Profile Switching**: Always works, regardless of profile source
   - You can switch to global profiles even when local config exists
   - The `activeProfile` reference is stored in local config (if present)
   - The actual profile data can come from either source

### Check Config Location

```typescript
import { ConfigLoader } from '@codemieai/code/utils/config';

// Check if local config exists
const hasLocal = await ConfigLoader.hasLocalConfig();
console.log(hasLocal ? 'Using local config' : 'Using global config');

// Get active profile name (checks local first, then global)
const activeProfile = await ConfigLoader.getActiveProfileName();

// List profiles (from local if exists, otherwise global)
const profiles = await ConfigLoader.listProfiles();
```

### Initialize Project Config Programmatically

```typescript
import { ConfigLoader } from '@codemieai/code/utils/config';

// Create local config with overrides
await ConfigLoader.initProjectConfig(process.cwd(), {
  codeMieProject: 'my-project',
  codeMieIntegration: {
    id: 'integration-123',
    alias: 'my-team'
  }
});
```

---

## File Structure

### Global Config (`~/.codemie/codemie-cli.config.json`)

```json
{
  "version": 2,
  "activeProfile": "default",
  "profiles": {
    "default": {
      "provider": "bedrock",
      "authMethod": "sso",
      "codeMieUrl": "https://codemie.example.com",
      "codeMieProject": "global-default",
      "model": "claude-3-5-sonnet",
      "awsProfile": "company-dev",
      "awsRegion": "us-east-1"
    },
    "work": {
      "provider": "sso",
      "codeMieProject": "work-project"
    }
  }
}
```

### Local Config (`.codemie/codemie-cli.config.json`)

**Minimal override** (inherits most from global):
```json
{
  "version": 2,
  "activeProfile": "default",
  "profiles": {
    "default": {
      "codeMieProject": "frontend-app",
      "codeMieIntegration": {
        "id": "frontend-integration-456",
        "alias": "frontend-team"
      }
    }
  }
}
```

**Full override** (no global fallback needed):
```json
{
  "version": 2,
  "activeProfile": "default",
  "profiles": {
    "default": {
      "provider": "ollama",
      "baseUrl": "http://localhost:11434",
      "model": "llama3.2",
      "codeMieProject": "test-project"
    }
  }
}
```

---

## Troubleshooting

### Issue: Config Not Being Used

**Symptoms**:
- Local config exists but settings not applied
- Wrong project being used

**Diagnosis**:
```bash
codemie profile status --show-sources
```

Check the `(source)` indicator for each field.

**Solutions**:
1. Verify file location: `.codemie/codemie-cli.config.json` in repository root
2. Check JSON syntax: `cat .codemie/codemie-cli.config.json | jq .`
3. Verify profile name matches: `activeProfile` in both configs should match (usually "default")

### Issue: Fields Not Overriding

**Symptoms**:
- Local config fields being ignored
- Global config values used instead

**Causes**:
1. Environment variables overriding project config
2. CLI arguments overriding project config
3. Profile name mismatch

**Solutions**:
```bash
# Check environment variables
env | grep CODEMIE_

# Verify priority
codemie profile status --show-sources

# Check profile names
cat .codemie/codemie-cli.config.json | jq '.activeProfile, .profiles | keys'
```

### Issue: Missing Fields

**Symptoms**:
- Error: "CODEMIE_* is required"
- Setup asks for all fields again

**Cause**: No global config exists, local config missing required fields

**Solution**:
```bash
# Option 1: Set up global config first
codemie setup
# Select "Global", configure all fields

# Option 2: Provide all fields in local config
codemie setup
# Select "Local", configure all required fields
```

---

## Best Practices

### 1. Minimal Overrides

**✅ DO**: Only override what's different
```json
{
  "profiles": {
    "default": {
      "codeMieProject": "frontend-app"
    }
  }
}
```

**❌ DON'T**: Duplicate global settings
```json
{
  "profiles": {
    "default": {
      "provider": "bedrock",
      "model": "claude-3-5-sonnet",
      "codeMieProject": "frontend-app",
      "awsRegion": "us-east-1"
      // Unnecessary duplication
    }
  }
}
```

### 2. Version Control

**✅ DO**: Commit project-level configs when they define team standards
```gitignore
# .gitignore
.codemie/credentials.json
.codemie/cache/
```

**Keep in version control**:
- `.codemie/codemie-cli.config.json` (project settings)

**Exclude from version control**:
- `.codemie/credentials.json` (sensitive)
- `.codemie/cache/` (temporary)

### 3. Environment Variables for CI/CD

Use environment variables to override config in CI/CD:

```bash
# CI/CD environment
export CODEMIE_PROVIDER=bedrock
export CODEMIE_MODEL=claude-3-5-sonnet
export CODEMIE_PROJECT=ci-project
```

Priority ensures environment variables override both global and local configs.

### 4. Profile Consistency

Keep `activeProfile` consistent across global and local configs (usually "default") unless you need different profiles per repository.

---

## API Reference

### ConfigLoader Methods

```typescript
// Initialize project config
static async initProjectConfig(
  workingDir: string,
  overrides?: {
    profileName?: string;
    codeMieProject?: string;
    codeMieIntegration?: CodeMieIntegrationInfo;
    [key: string]: any;
  }
): Promise<void>

// Check if local config exists
static async hasLocalConfig(workingDir?: string): Promise<boolean>

// Load with source tracking
static async loadWithSources(
  workingDir?: string,
  cliOverrides?: Partial<CodeMieConfigOptions>
): Promise<ConfigWithSources>

// Show config with sources (CLI utility)
static async showWithSources(workingDir?: string): Promise<void>
```

### Types

```typescript
interface CodeMieIntegrationInfo {
  id: string;
  alias: string;
}

interface ConfigWithSources {
  config: CodeMieConfigOptions;    // Merged configuration
  hasLocalConfig: boolean;         // Whether local .codemie/ exists
  sources: Record<string, ConfigWithSource>;  // Track source of each field
}

interface ConfigWithSource {
  value: any;
  source: 'default' | 'global' | 'project' | 'env' | 'cli';
}
```

---

## Related Documentation

- [Development Practices](.codemie/guides/development/development-practices.md) - Configuration loading patterns
- [Security Practices](.codemie/guides/security/security-practices.md) - Credential management
- [CLAUDE.md](../../CLAUDE.md) - Quick reference for project config patterns
