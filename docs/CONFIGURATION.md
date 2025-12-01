# Configuration

## Setup Wizard (Recommended)

Run the interactive setup wizard:

```bash
codemie setup
```

The wizard will:
- Guide you through provider selection
- Test your credentials via health endpoints
- Fetch available models in real-time
- Save configuration to `~/.codemie/config.json`

**Multi-Provider Support**: If you already have profiles configured, the wizard will offer to:
- Add a new profile (prompts for unique name)
- Update an existing profile (select from list)
- Cancel without changes

This ensures you can configure multiple providers (work, personal, enterprise SSO) without losing existing configurations.

## Multi-Provider Profiles

CodeMie CLI supports multiple provider profiles, allowing you to:
- Configure different providers for different contexts (work, personal, etc.)
- Switch between profiles with a single command
- Keep all configurations without overwriting

### Creating Multiple Profiles

```bash
# First profile - work account with LiteLLM
codemie setup
# → Choose: Add a new profile
# → Name: "work-litellm"
# → Provider: LiteLLM
# → Configure credentials...

# Second profile - personal OpenAI account
codemie setup
# → Choose: Add a new profile
# → Name: "personal-openai"
# → Provider: OpenAI
# → Configure credentials...

# Third profile - enterprise SSO
codemie setup
# → Choose: Add a new profile
# → Name: "enterprise-sso"
# → Provider: CodeMie SSO
# → Authenticate via SSO...
```

### Using Profiles

```bash
# List all profiles (shows active profile with ●)
codemie profile list
# Output:
# ● work-litellm (litellm) - claude-4-5-sonnet
# ○ personal-openai (openai) - gpt-4.1
# ○ enterprise-sso (ai-run-sso) - claude-4-5-sonnet

# Switch active profile
codemie profile switch personal-openai

# Use active profile (default behavior)
codemie-code "analyze this code"

# Override with specific profile for one command
codemie-claude --profile work-litellm "review PR"
codemie-codex --profile personal-openai "generate tests"

# Show profile details
codemie profile show work-litellm
```

### Profile Configuration File

Profiles are stored in `~/.codemie/config.json`:

```json
{
  "version": 2,
  "activeProfile": "work-litellm",
  "profiles": {
    "work-litellm": {
      "name": "work-litellm",
      "provider": "litellm",
      "baseUrl": "https://litellm.company.com",
      "apiKey": "sk-***",
      "model": "claude-4-5-sonnet",
      "timeout": 300
    },
    "personal-openai": {
      "name": "personal-openai",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-***",
      "model": "gpt-4.1",
      "timeout": 300
    }
  }
}
```

**Legacy Configuration**: If you have an existing single-provider config, it will automatically migrate to a profile named "default" on first use.

## Supported Providers

- **ai-run-sso** - AI/Run CodeMie SSO (unified enterprise gateway)
- **gemini** - Google Gemini API (direct access)
- **openai** - OpenAI API
- **azure** - Azure OpenAI
- **bedrock** - AWS Bedrock
- **litellm** - LiteLLM Proxy

## Manual Configuration

### Environment Variables (Highest Priority)

Environment variables override config file values and are useful for CI/CD, Docker containers, and temporary overrides.

#### Core Configuration

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `CODEMIE_PROVIDER` | AI provider (ai-run-sso, litellm, openai, azure, bedrock) | - | `litellm` |
| `CODEMIE_BASE_URL` | Base URL for API endpoint | - | `https://api.openai.com/v1` |
| `CODEMIE_API_KEY` | API key for authentication | - | `sk-...` |
| `CODEMIE_MODEL` | Model to use | - | `claude-sonnet-4-5-20250929` |
| `CODEMIE_TIMEOUT` | Request timeout in milliseconds | `300000` | `600000` |
| `CODEMIE_DEBUG` | Enable debug logging | `false` | `true` |

#### AI/Run SSO Configuration

| Variable | Description | Example |
|----------|-------------|---------|
| `CODEMIE_URL` | AI/Run platform URL | `https://ai.run` |
| `CODEMIE_AUTH_METHOD` | Authentication method (manual, sso) | `sso` |
| `CODEMIE_INTEGRATION_ID` | Integration ID for API access | `int_...` |
| `CODEMIE_INTEGRATION_ALIAS` | Integration alias | `my-integration` |

#### AWS Bedrock Configuration

| Variable | Description | Example |
|----------|-------------|---------|
| `AWS_REGION` | AWS region for Bedrock | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS access key | `AKIA...` |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | `...` |
| `AWS_PROFILE` | AWS profile name | `default` |
| `CLAUDE_CODE_USE_BEDROCK` | Enable Bedrock for Claude Code | `1` |

#### Azure OpenAI Configuration

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `AZURE_OPENAI_API_VERSION` | Azure API version | `2024-02-01` | `2024-02-01` |
| `OPENAI_ORG_ID` | OpenAI organization ID | - | `org-...` |

#### Analytics Configuration

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `CODEMIE_ANALYTICS_ENABLED` | Enable analytics collection | `false` | `true` or `1` |
| `CODEMIE_ANALYTICS_TARGET` | Storage target (local, remote, both) | `local` | `local` |
| `CODEMIE_ANALYTICS_PATH` | Custom local storage path | `~/.codemie/analytics` | `/custom/path` |
| `CODEMIE_ANALYTICS_ENDPOINT` | Remote analytics endpoint URL | - | `https://analytics.example.com` |

#### Security & File Access

| Variable | Description | Example |
|----------|-------------|---------|
| `CODEMIE_ALLOWED_DIRS` | Comma-separated list of allowed directories | `/home/user/projects,/workspace` |
| `CODEMIE_IGNORE_PATTERNS` | Comma-separated patterns to ignore | `*.log,node_modules/**` |

#### Usage Examples

**Quick OpenAI setup:**
```bash
export CODEMIE_PROVIDER=openai
export CODEMIE_BASE_URL=https://api.openai.com/v1
export CODEMIE_API_KEY=sk-...
export CODEMIE_MODEL=gpt-4

codemie-code "Review my code"
```

**Using LiteLLM with custom endpoint:**
```bash
export CODEMIE_PROVIDER=litellm
export CODEMIE_BASE_URL=http://localhost:4000
export CODEMIE_MODEL=claude-sonnet-4-5-20250929

codemie-claude "Refactor this function"
```

**Enable analytics:**
```bash
export CODEMIE_ANALYTICS_ENABLED=true
export CODEMIE_ANALYTICS_TARGET=local

codemie analytics status
```

**AWS Bedrock configuration:**
```bash
export CODEMIE_PROVIDER=bedrock
export AWS_REGION=us-east-1
export AWS_PROFILE=default
export CLAUDE_CODE_USE_BEDROCK=1

codemie-claude "Generate tests"
```

**Temporary debug mode:**
```bash
CODEMIE_DEBUG=true codemie-code "Debug this issue"
```

#### Legacy Provider-Specific Variables

These are supported for backward compatibility:

```bash
# OpenAI-specific
export OPENAI_API_KEY="your-openai-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"

# Gemini-specific
export GEMINI_API_KEY="your-gemini-key"
export GEMINI_MODEL="gemini-2.5-flash"
```

### Configuration File

Location: `~/.codemie/config.json`

```json
{
  "provider": "litellm",
  "model": "claude-sonnet-4-5",
  "baseUrl": "https://litellm.codemie.example.com",
  "apiKey": "your-api-key",
  "timeout": 300
}
```

## Model Compatibility

AI/Run CodeMie CLI automatically validates model compatibility:

- **Codex**: OpenAI models only (gpt-4, gpt-4.1, gpt-5, etc.)
- **Claude**: Both Claude and GPT models
- **Gemini CLI**: Gemini models only (gemini-2.5-flash, gemini-2.5-pro, gemini-1.5-pro, etc.)
- **CodeMie Native**: All supported models

When incompatible models are detected, AI/Run CodeMie CLI will:
1. Fetch available models from your provider's API
2. Filter to compatible models
3. Offer to switch automatically
