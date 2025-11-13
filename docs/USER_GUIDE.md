# CodeMie Code User Guide

CodeMie Code provides both a built-in AI coding assistant (`codemie-code`) and a CLI wrapper (`codemie`) for managing multiple AI coding agents.

## Installation

```bash
npm install -g @codemieai/code
```

**Verify installation:**
```bash
codemie-code --help
codemie --help
```

## Setup

### 1. Configure Your AI Provider

Set these environment variables to connect to your AI provider:

```bash
export CODEMIE_BASE_URL="https://your-ai-proxy.com"
export CODEMIE_AUTH_TOKEN="your-auth-token"
export CODEMIE_MODEL="claude-4-5-sonnet"  # or gpt-4, claude-opus, etc.
```

**Add to your shell profile** for persistence:

```bash
# Add to ~/.bashrc or ~/.zshrc
echo 'export CODEMIE_BASE_URL="https://your-ai-proxy.com"' >> ~/.bashrc
echo 'export CODEMIE_AUTH_TOKEN="your-auth-token"' >> ~/.bashrc
echo 'export CODEMIE_MODEL="claude-4-5-sonnet"' >> ~/.bashrc

# Reload shell
source ~/.bashrc
```

### 2. Verify Installation

Check system health and dependencies:

```bash
codemie doctor
```

This checks:
- ✅ Node.js version (>= 24.0.0)
- ✅ npm installation
- ✅ git availability
- ✅ Environment variables configuration
- ✅ Installed agents

### 3. Test Connection

Verify your AI provider connection:

```bash
codemie-code test
```

**Expected output:**
```
✓ Configuration loaded
✓ Testing connection...
✓ Connection successful
✓ Model: claude-4-5-sonnet
```

✅ If test passes → You're ready to start coding!
❌ If test fails → See [Troubleshooting](#troubleshooting)

## Quick Start

### Start Interactive Mode

```bash
# Start in current directory
codemie-code

# Start in specific directory
codemie-code /path/to/project
```

### Try Your First Tasks

```
You: Show me the project structure
You: List all TypeScript files
You: Read package.json and suggest improvements
You: Show git status and recent commits
You: Create a new file called utils.ts with helper functions
```

### Interactive Commands

Once inside the assistant:

- Type `exit` - Exit the assistant
- Type `clear` - Clear conversation history
- Ask any coding question or give tasks

## CodeMie Code Assistant

The built-in AI assistant with filesystem, git, and command execution tools.

### Usage

```bash
# Interactive mode (default)
codemie-code
codemie-code /path/to/project

# Execute one-off task
codemie-code exec "Add error handling to api.ts"

# Execute with custom directory
codemie-code exec "Run tests" -d /path/to/project

# With MCP servers
codemie-code --mcp-servers time,context7
```

### Available Tools

The assistant comes with 15+ built-in tools:

#### Filesystem Tools (10 tools)

| Tool | Description |
|------|-------------|
| `read_file` | Read contents of a file |
| `read_multiple_files` | Read multiple files at once |
| `write_file` | Write/create a file with content |
| `edit_file` | Edit file with diff-based updates |
| `create_directory` | Create directories recursively |
| `list_directory` | List files and directories |
| `project_tree` | Generate visual project structure tree |
| `move_file` | Move or rename files |
| `search_files` | Search files by name or content |
| `list_allowed_directories` | Show accessible directories |

#### Git Tools (4 tools)

| Tool | Description |
|------|-------------|
| `git_status` | Get repository status |
| `git_diff` | Show git diff for changes |
| `git_log` | Show commit history |
| `git_command` | Execute any git command |

#### Command Execution (1 tool)

| Tool | Description |
|------|-------------|
| `execute_command` | Execute shell commands (with security checks) |

### Example Tasks

**Code Review:**
```
You: Review src/auth.ts and suggest improvements
You: Refactor the authentication logic to use async/await
You: Add comprehensive error handling
```

**Building Features:**
```
You: Create a REST API endpoint for user registration
You: Add email validation
You: Write unit tests for the new endpoint
You: Update the API documentation
```

**Debugging:**
```
You: Run the tests and show me any failures
You: Analyze the error in test/user.test.ts
You: Fix the failing test
You: Run tests again to verify the fix
```

**Git Operations:**
```
You: Show me the git status
You: What files have changed since last commit?
You: Show me the diff for src/api.ts
You: Show the last 10 commits
```

## MCP Server Management

Extend capabilities with Model Context Protocol (MCP) servers.

### MCP Commands

```bash
# List available servers
codemie-code mcp list

# List with detailed configuration
codemie-code mcp list -v

# Add new server
codemie-code mcp add <name> <command-or-url> [options]

# Test server configuration
codemie-code mcp test <server-name>

# Remove server
codemie-code mcp remove <server-name>

# Preview which servers will load
codemie-code mcp servers
codemie-code mcp servers --servers time,context7
```

### Popular MCP Servers

**Time Server** - Query times in any timezone:
```bash
codemie-code mcp add time uvx -a "mcp-server-time"
codemie-code --mcp-servers time

# Then ask: "What time is it in Hong Kong?"
```

**Context7** - Access up-to-date library documentation:
```bash
codemie-code mcp add context7 npx -a "-y" "@upstash/context7-mcp"
codemie-code --mcp-servers context7

# Then ask: "Show me LangChain documentation for chains"
```

### Using MCP Servers

**Start with specific servers:**
```bash
codemie-code --mcp-servers time,context7
```

**Or set environment variable:**
```bash
export CODEMIE_MCP_SERVERS="time,context7"
codemie-code
```

**Example usage:**
```
You: What time is it in Tokyo?
You: Convert 2 PM Los Angeles time to London time
You: Show me React hooks documentation
You: How do I use useState in React?
```

## CodeMie CLI Wrapper

Manage and run multiple AI coding agents from one interface.

### List Agents

```bash
# List all available agents
codemie list

# List only installed agents
codemie list --installed
```

### Install Agents

```bash
codemie install claude-code     # Anthropic Claude Code
codemie install codex           # OpenAI Codex
```

### Run Agents

```bash
# Run installed agents
codemie run claude-code
codemie run codex

# Pass arguments to agents
codemie run claude-code --help
codemie run codex --model gpt-4
```

### System Health Check

```bash
codemie doctor
```

Checks:
- Environment variables configuration
- Agent installations
- System dependencies
- AI provider connection

### Version Information

```bash
codemie version          # Show all agent versions
codemie-code --version   # Show CodeMie Code version
```

## Configuration

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `CODEMIE_BASE_URL` | AI provider base URL | `https://your-ai-proxy.com` |
| `CODEMIE_AUTH_TOKEN` | Authentication token | `your-auth-token` |
| `CODEMIE_MODEL` | Model to use | `claude-4-5-sonnet` |

### Optional Environment Variables

**Debug logging:**
```bash
export CODEMIE_DEBUG="true"
```

**Request timeout (seconds):**
```bash
export CODEMIE_TIMEOUT="300"  # Default: 300 seconds
```

**Load specific MCP servers:**
```bash
export CODEMIE_MCP_SERVERS="time,context7"
```

### Configuration Methods

**Method 1: Shell Profile (Recommended)**
```bash
# Add to ~/.bashrc or ~/.zshrc
export CODEMIE_BASE_URL="https://your-ai-proxy.com"
export CODEMIE_AUTH_TOKEN="your-token"
export CODEMIE_MODEL="claude-4-5-sonnet"

# Reload shell
source ~/.bashrc  # or ~/.zshrc
```

**Method 2: Project .env File**
```bash
# Create .env in your project
cat > .env << EOF
CODEMIE_BASE_URL=https://your-ai-proxy.com
CODEMIE_AUTH_TOKEN=your-token
CODEMIE_MODEL=claude-4-5-sonnet
EOF

# Load and run
set -a; source .env; set +a
codemie-code
```

**Method 3: Inline**
```bash
CODEMIE_BASE_URL="https://your-ai-proxy.com" \
CODEMIE_AUTH_TOKEN="your-token" \
CODEMIE_MODEL="claude-4-5-sonnet" \
codemie-code
```

### Advanced: Provider-Specific Configuration

For advanced scenarios, you can use provider-specific environment variables. These act as fallbacks if generic `CODEMIE_*` variables are not set:

**For Anthropic Claude:**
```bash
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="your-anthropic-token"
export ANTHROPIC_MODEL="claude-4-5-sonnet"
```

**For OpenAI GPT:**
```bash
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_API_KEY="your-openai-key"
export OPENAI_MODEL="gpt-4"
```

**Configuration Priority:**
1. `CODEMIE_*` (generic - checked first)
2. `ANTHROPIC_*` or `OPENAI_*` (provider-specific - fallback)

## Troubleshooting

### Connection Test Fails

```
✗ Connection test failed
```

**Check configuration:**
```bash
# Verify environment variables
echo $CODEMIE_BASE_URL
echo $CODEMIE_AUTH_TOKEN
echo $CODEMIE_MODEL

# Check URL is accessible
curl -I $CODEMIE_BASE_URL

# Run diagnostics
codemie doctor

# Try test again
codemie-code test
```

**Common issues:**

1. **Missing configuration**
   ```bash
   # Error: Base URL not configured
   # Solution: Set CODEMIE_BASE_URL
   export CODEMIE_BASE_URL="https://your-proxy.com"
   ```

2. **Invalid token**
   ```bash
   # Error: Auth token not configured
   # Solution: Set CODEMIE_AUTH_TOKEN
   export CODEMIE_AUTH_TOKEN="your-valid-token"
   ```

3. **Network issues**
   ```bash
   # Test connectivity
   curl -v $CODEMIE_BASE_URL

   # Check VPN if required
   # Verify firewall settings
   ```

### Environment Variables Not Loaded

```bash
# Verify variables are set
env | grep CODEMIE_

# If empty, reload shell profile
source ~/.bashrc  # or ~/.zshrc

# Or export again
export CODEMIE_BASE_URL="..."
export CODEMIE_AUTH_TOKEN="..."
export CODEMIE_MODEL="..."
```

### Command Not Found

```bash
# Re-install globally
npm install -g @codemieai/code

# Verify installation
which codemie
which codemie-code

# Check npm global path
npm config get prefix
```

### MCP Server Not Found

```
✗ Server 'my-server' not found
```

**Solution:**
```bash
codemie-code mcp list  # See available servers
```

### Agent Not Found

```
✗ Agent 'claude-code' not found
```

**Solution:**
```bash
codemie install claude-code
```

### Path Outside Allowed Directories

```
Error: path outside allowed directories
```

**Explanation:**
CodeMie Code only operates within the working directory for security.

**Solution:**
```bash
# Start in the correct directory
cd /path/to/your/project
codemie-code

# Or specify the directory
codemie-code /path/to/your/project
```

## Best Practices

1. **Start with simple tasks** - Get familiar with the assistant's capabilities
2. **Be specific** - Clear, detailed prompts get better results
3. **Review changes** - Always review code changes before committing
4. **Use MCP servers** - Extend capabilities when needed
5. **Check health regularly** - Run `codemie doctor` to ensure everything is configured
6. **Test your setup** - Use `codemie-code test` to verify connection before starting work
7. **Use version control** - Work in git repositories for safety
8. **Verify environment** - Check `env | grep CODEMIE_` to ensure variables are set

## Resources

- [Model Context Protocol Specification](https://github.com/modelcontextprotocol/specification)
- [Available MCP Servers](https://github.com/modelcontextprotocol/servers)
- [CodeMie Code GitHub Repository](https://github.com/codemie/codemie-code)

## Quick Reference

### Essential Commands

```bash
# Setup
export CODEMIE_BASE_URL="https://your-ai-proxy.com"
export CODEMIE_AUTH_TOKEN="your-token"
export CODEMIE_MODEL="claude-4-5-sonnet"

# Verify
codemie doctor
codemie-code test

# Start coding
codemie-code
codemie-code /path/to/project
codemie-code exec "task description"

# MCP
codemie-code mcp list
codemie-code --mcp-servers time,context7

# CLI Wrapper
codemie list
codemie install claude-code
codemie run claude-code
```

### Common Tasks

| What you want | Command |
|---------------|---------|
| Start interactive coding | `codemie-code` |
| Execute single task | `codemie-code exec "task"` |
| Test connection | `codemie-code test` |
| Check system health | `codemie doctor` |
| List MCP servers | `codemie-code mcp list` |
| Install agent | `codemie install <agent>` |
| Show versions | `codemie version` |
