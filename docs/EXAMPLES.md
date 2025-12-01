# Examples

## Common Workflows

```bash
# Code review workflow
codemie-code "Review this PR for security issues and performance"

# Bug fixing
codemie-claude "Fix the authentication bug in src/auth.ts"

# Test generation
codemie-codex "Generate comprehensive tests for the API endpoints"

# Documentation
codemie-code "Document the functions in utils/helpers.js"

# Refactoring
codemie-claude "Refactor this component to use React hooks"
```

## Configuration Examples

```bash
# View current configuration with sources
codemie config show

# Test connection
codemie config test

# Initialize project-specific overrides
codemie config init

# Temporary model override
codemie-claude --model claude-4-5-sonnet "Explain this algorithm"
```

## Multi-Provider Workflow Examples

```bash
# Scenario: Developer with work and personal accounts

# Setup work profile with enterprise LiteLLM
codemie setup
# → Name: "work"
# → Provider: LiteLLM
# → URL: https://litellm.company.com
# → Model: claude-4-5-sonnet

# Setup personal profile with OpenAI
codemie setup
# → Name: "personal"
# → Provider: OpenAI
# → Model: gpt-4.1

# List profiles to verify
codemie profile list
# ● work (litellm) - claude-4-5-sonnet
# ○ personal (openai) - gpt-4.1

# Use work profile during work hours
codemie-code "review company codebase"

# Switch to personal for side projects
codemie profile switch personal
codemie-code "help with my open source project"

# Or use specific profile without switching
codemie-claude --profile work "analyze security"
codemie-codex --profile personal "generate tests"

# Update work profile when credentials rotate
codemie setup
# → Choose: Update existing profile
# → Select: work
# → Update credentials...
```

## Advanced Usage

```bash
# Pass custom arguments to agents (unknown options pass through)
codemie-codex --temperature 0.1 --max-tokens 2000 "Generate clean code"
codemie-claude --context large "Review this code"

# Non-interactive mode with -p (useful for CI/CD)
codemie-claude -p "$(cat prompt.txt)" --max-turns 50
codemie-codex -p "Generate tests for src/utils" --output json

# Health checks
codemie doctor                   # Full system check
codemie-code health             # Built-in agent check
codemie-claude health           # Claude agent check
codemie-gemini health           # Gemini agent check
codemie-deepagents health       # Deep Agents CLI check
```

## Analytics Usage Examples

```bash
# Enable analytics and view status
codemie analytics enable
codemie analytics status

# View comprehensive statistics
codemie analytics show

# Filter by date range
codemie analytics show --from 2025-11-01 --to 2025-11-30

# Filter by specific agent
codemie analytics show --agent claude
codemie analytics show --agent gemini

# Filter by project
codemie analytics show --project /path/to/my-project

# Export to JSON for analysis
codemie analytics show --format json --output analytics-report.json

# View specific project with date range
codemie analytics show \
  --project /workspace/my-app \
  --from 2025-11-01 \
  --to 2025-11-30 \
  --agent claude
```

## CI/CD Integration Example

```bash
# GitHub Actions / GitLab CI workflow example
codemie-claude \
  --base-url "${CODEMIE_BASE_URL}" \
  --api-key "${CODEMIE_API_KEY}" \
  --model "${CODEMIE_MODEL:-claude-4-5-sonnet}" \
  --provider "litellm" \
  -p "$(cat /tmp/review-prompt.txt)" \
  --max-turns "${CODEMIE_MAX_TURNS:-50}" \
  --dangerously-skip-permissions \
  --allowedTools "Bash(*),Read(*),Curl(*)"

# Using profile for CI/CD
codemie-claude \
  --profile ci-litellm \
  -p "Review this PR for security issues" \
  --max-turns 30
```

## Workflow Installation Examples

```bash
# Install PR review workflow
codemie workflow install pr-review

# Interactive installation with customization
codemie workflow install --interactive

# List installed workflows
codemie workflow list --installed

# Uninstall a workflow
codemie workflow uninstall pr-review
```
