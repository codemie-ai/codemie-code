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
- Save configuration to `~/.codemie/codemie-cli.config.json`

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
codemie profile
# Output:
# ● work-litellm (litellm) - claude-sonnet-4-6
# ○ personal-openai (openai) - gpt-4.1
# ○ enterprise-sso (ai-run-sso) - claude-sonnet-4-6

# Switch active profile
codemie profile switch personal-openai

# Use active profile (default behavior)
codemie-code "analyze this code"

# Override with specific profile for one command
codemie-claude --profile work-litellm "review PR"
codemie-gemini --profile personal-openai "generate tests"

# Show profile details
codemie profile show work-litellm
```

### Profile Configuration File

Profiles are stored in `~/.codemie/codemie-cli.config.json`:

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
      "model": "claude-sonnet-4-6",
      "timeout": 300
    },
    "personal-openai": {
      "name": "personal-openai",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-***",
      "model": "gpt-4.1",
      "timeout": 300
    },
    "enterprise-sso": {
      "name": "enterprise-sso",
      "provider": "ai-run-sso",
      "model": "claude-sonnet-5",
      "agentModels": {
        "claude": { "models": ["claude-sonnet-5", "claude-haiku-4-5"], "model": "claude-sonnet-5" },
        "codex": { "models": ["gpt-5.6-terra"], "model": "gpt-5.6-terra" },
        "opencode": { "models": ["claude-sonnet-5", "gemini-3-pro"], "model": "gemini-3-pro" }
      }
    }
  }
}
```

**Legacy Configuration**: If you have an existing single-provider config, it will automatically migrate to a profile named "default" on first use.

### Models per Agent

`codemie setup` chooses models per agent (EPMCDME-15641). The profile records
them in `agentModels`, keyed by base agent name (as on `enterprise-sso` above):

- `models` - the models that agent may use (at least one).
- `model` - that agent's active model; it launches with it.
- `confirmedModels` (optional) - ids accepted despite the agent's model-name
  rule: typed names the rule rejects, and catalog routers/aliases. Launch
  reports them as unverified instead of incompatible. Always a subset of `models`.

The top-level `model` stays: it mirrors the first agent's active model, and is
what agents outside `agentModels` and profile-level displays use. A profile
without `agentModels` is a legacy single-model profile and behaves as before.

#### The setup wizard

`codemie setup` runs a full-screen wizard in the style of `codemie setup assistants`.
A breadcrumb shows the stages (`Agents › Claude Code › Codex › Review`); Esc steps
back one screen, and Ctrl+C or Cancel leaves without saving.

1. **Agents** - "Which agents will use this profile?" (at least one). The offered
   agents are `claude`, `codex`, `gemini`, `kimi`, `copilot-cli`, `opencode`, `pi`,
   `codemie-code` and `openwiki`; ACP variants share their base agent's models.
   An agent the provider cannot serve is shown but cannot be selected, with the
   reason: `not supported by <provider>` (its `supportedProviders` excludes the
   provider) or `no compatible model on <provider>` (no catalog model passes its
   rules). A note lists the agents without model rules.
2. **For each agent: Models** - lists only the models that agent supports.
   Agents with a model classifier (`classifyModel` in their plugin metadata:
   `claude`, `codex`, `gemini`, `kimi`, `copilot-cli`) hide models they cannot run;
   router/alias names with no recognizable family are tagged `unverified`.
   `opencode`, `pi`, `codemie-code` and `openwiki` have no model rules, so every
   model is listed with the note "any model works". Typing filters the list;
   a name that matches nothing can be added with `+ Use "<name>"` (a name the
   agent's rules reject is saved as unverified). With no provider catalog, the
   list starts empty and you type model names. Ollama adds a "Search Ollama
   library" row.
3. **For each agent: Active model** - one of that agent's picked models. Skipped
   when the agent has a single model.

   Agents with no in-session model menu (`activeModelOnly` in their plugin metadata:
   `gemini`, `kimi`, `copilot-cli`, `openwiki`) always run on their active model, so
   steps 2 and 3 become a single **Active model** screen. It lists the models the
   agent supports, accepts typed names and search the same way, and notes that the
   model is changed with `codemie models switch --agent <name>`. The saved set holds
   that one model.
4. **Review** - one line per agent, active model first; Save writes the profile.

On an update, the saved agents and models are preselected. The wizard is skipped
for providers that auto-pick their single model (`anthropic-subscription`,
`moonshot-subscription`); no `agentModels` is saved.

#### Switching and listing

- `codemie models switch [model-id] [--agent <name>]` changes one agent's active
  model in place, writing only that agent's `model` (plus the top-level `model`
  when it is the first agent, and Claude's `haikuModel`/`sonnetModel`/`opusModel`
  tiers when the agent is Claude). Without `--agent`, the model id picks the agent
  when only one agent has it; otherwise you choose the agent, then its model, from
  that agent's own list. An agent with one model is a no-op. On a legacy profile
  `--agent` is rejected. An `activeModelOnly` agent has no saved list to choose
  from: it is offered the provider's live catalog, narrowed to the models it can
  use, and the chosen model replaces its set. A model id the catalog does not list
  is accepted unless the agent's rules reject it; when the catalog cannot be
  fetched, pass the model id.
- `codemie models list [--agent <name>]` prints an "Agents:" block (each agent's
  models, active first), then the catalog with an `AGENTS` column listing the
  agents each model is available to, `*` marking the agents that start with it. A
  legend explains the mark. Models any agent uses come first.
  `--agent` tags only that agent's models as `(active)`/`(profile)`. A legacy
  profile keeps the `(active)` tag only.
- `codemie profile status` shows an "Agent models" row per agent.

#### At launch

- Each agent launches with its own active model; its in-session model menu
  (Claude `/model`, Codex's catalog, OpenCode/codemie-code's dynamic config,
  Pi's `models.json`) is limited to its own `models`, even a single one. A
  legacy single-model profile, or an agent outside `agentModels`, shows the full
  provider catalog.
- `--model` or `CODEMIE_MODEL` overrides the agent's active model for that run.
- Only the persisted active model is checked. If it is incompatible with the
  launching agent, a profile with `agentModels` is blocked (exit 1), naming the
  agent's compatible models and `codemie models switch --agent <name>`, or
  `codemie setup` when none exists. A legacy profile only prints a warning and
  continues. An agent outside `agentModels` launches with the top-level model,
  under the same check.

## Supported Providers

- **ai-run-sso** - AI/Run CodeMie SSO (unified enterprise gateway)
- **openai** - OpenAI API
- **azure** - Azure OpenAI
- **bedrock** - AWS Bedrock
- **litellm** - LiteLLM Proxy (universal gateway to 100+ providers)
- **ollama** - Ollama (local models)

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
| `CODEMIE_INSECURE` | Disable TLS certificate verification for local/on-prem development only | `false` | `1` |
| `CODEMIE_NO_SYSTEM_PROXY` | Disable Windows system proxy/PAC discovery (explicit proxy variables still apply) | `false` | `1` |
| `HTTP_PROXY` / `HTTPS_PROXY` | Explicit outbound proxy; lowercase spellings are also supported | - | `http://proxy.example:8080` |
| `NO_PROXY` | Comma-separated proxy bypass list; lowercase `no_proxy` is merged | loopback | `.internal.example,10.0.0.0/8` |

#### Windows system proxy and PAC

On Windows, CodeMie uses Internet Settings for Node HTTP clients, global
`fetch()`, the local SSO proxy, SDK clients, and spawned agent tools. Routing is
resolved per request in this order:

1. Implicit loopback bypasses, `NO_PROXY`/`no_proxy`, and npm `noproxy`.
2. Explicit user `HTTP_PROXY`/`HTTPS_PROXY` values (uppercase or lowercase).
3. Windows `ProxyOverride` entries.
4. The configured PAC (`AutoConfigURL`), including ordered proxy failover and
   `DIRECT` fallback.
5. The static Windows `ProxyServer`, only when PAC retrieval or evaluation is
   unavailable.

The CLI reads per-user settings from HKCU by default. If the machine policy
`ProxySettingsPerUser=0` is set, it reads the corresponding HKLM Internet
Settings instead. Trailing IPv4 wildcards such as `10.*` and `192.168.*`,
`<local>`, domains, CIDR ranges, and loopback are supported. WPAD auto-detection
and binary per-connection settings are not currently supported.

In-process traffic evaluates PAC and bypass rules for every target. Tools and
SDKs that only understand proxy environment variables receive a best-effort
export: HTTP and HTTPS are resolved independently for their target, both case
variants are populated only when missing, and representable Windows bypasses
are merged into `NO_PROXY`/`no_proxy`. A single exported value cannot represent
host-dependent PAC decisions, so this export is target-specific.

TLS certificates are verified by default on direct and proxied connections.
Node.js uses its bundled CA list rather than the Windows certificate store, so
for enterprise TLS inspection point `NODE_EXTRA_CA_CERTS` at the corporate root
certificate (PEM). `CODEMIE_INSECURE=1` (or Node's own
`NODE_TLS_REJECT_UNAUTHORIZED=0`) disables verification; it is an explicit
escape hatch for controlled self-signed development environments and should not
be used as the permanent corporate configuration.

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

#### CLI Behavior

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `CODEMIE_AUTO_UPDATE` | Automatic CLI self-update behavior | `true` | `false` to prompt before updating |
| `CODEMIE_UPDATE_CHECK_INTERVAL` | Time between update checks (milliseconds) | `86400000` (24h) | `3600000` for 1 hour |

**Auto-Update Behavior:**
- `true` (default) - Silently auto-update CLI in background on startup
- `false` - Show update notification and prompt for confirmation
- **Rate Limited**: Only checks once per interval (default: 24 hours)
  - First invocation: Checks npm registry (5s max timeout)
  - Subsequent invocations within interval: Instant (no network call)
- **Concurrent Safe**: File-based locking prevents multiple simultaneous updates
- Non-blocking: Update check failures won't prevent CLI from starting
- Cache location: `~/.codemie/.last-update-check`
- See `codemie self-update --help` for manual update options

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

Location: `~/.codemie/codemie-cli.config.json`

```json
{
  "provider": "litellm",
  "model": "claude-sonnet-4-6",
  "baseUrl": "https://litellm.codemie.example.com",
  "apiKey": "your-api-key",
  "timeout": 300
}
```

## Model Compatibility

AI/Run CodeMie CLI automatically validates model compatibility:

- **Claude**: Both Claude and GPT models
- **Gemini CLI**: Gemini models only (gemini-2.5-flash, gemini-2.5-pro, gemini-1.5-pro, etc.)
- **CodeMie Native**: All supported models

When incompatible models are detected, AI/Run CodeMie CLI will:
1. Fetch available models from your provider's API
2. Filter to compatible models
3. Offer to switch automatically
