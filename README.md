# CodeMie Code

> AI coding assistant and CLI wrapper for managing multiple AI coding agents

CodeMie Code is a unified npm package that provides both a built-in AI coding assistant and a CLI wrapper for managing multiple AI coding agents (Claude Code, Codex, etc.).

## ✨ Features

- 🤖 **Built-in AI Assistant** - Ready-to-use coding assistant powered by any AI provider
- 🔧 **CLI Wrapper** - Manage and run multiple AI coding agents from one interface
- 🛠️ **Complete Toolset** - 15 tools including filesystem operations, git commands, and code execution
- 🔌 **MCP Support** - Model Context Protocol integration for extensible tool support
- 🔒 **Security First** - Path validation, symlink protection, and command sanitization
- 📝 **Diff-based Editing** - Smart file editing with indentation preservation
- 🌐 **Provider Agnostic** - Works with any AI provider (OpenAI, Anthropic, Azure, etc.)
- 🎯 **Project-aware** - Operates within allowed directories with ignore patterns
- 🚀 **Zero Configuration** - Works with environment variables only

---

## 📦 Installation

### From npm (when published)

```bash
npm install -g @codemieai/code
```

### From Source (Development)

```bash
# Clone the repository
git clone https://github.com/codemie-ai/codemie-code.git
cd codemie-code

# Install dependencies
npm install

# Build the project
npm run build

# Link globally for testing
npm link
```

### Verify Installation

```bash
# Check if commands are available
codemie --help
codemie-code --help

# Run health check
codemie doctor
```

---

## 🚀 Quick Start

### Installation → Setup → Use

CodeMie Code follows a simple three-step workflow:

```
1. Install → 2. Setup (Wizard OR Manual) → 3. Use (Built-in OR External Agents)
```

### Step 1: Install

```bash
npm install -g @codemieai/code
```

### Step 2: Setup (Choose One Method)

#### Method A: Interactive Setup Wizard (Recommended)

Best for most users - guided configuration with connection testing:

```bash
codemie setup
```

**What it does:**
- ✅ Guides you through provider selection
- ✅ Prompts for credentials (with validation)
- ✅ Tests connection before saving
- ✅ Saves to `~/.codemie/config.json`

**Supported Providers:**
- AI/Run CodeMie (Unified gateway)
- AWS Bedrock (Claude via AWS)
- Anthropic (Direct API)
- Azure OpenAI (for GPT models and Codex)
- Custom LiteLLM Proxy

#### Method B: Manual Configuration Guide

Best for automated setups or when you have credentials ready:

```bash
# Show environment variables for specific provider
codemie env              # AI/Run CodeMie (default)
codemie env bedrock      # AWS Bedrock
codemie env anthropic    # Anthropic
codemie env azure        # Azure OpenAI
```

**What you get:**
- ✅ Complete list of required environment variables
- ✅ Copy-paste ready export commands
- ✅ Shell profile configuration examples
- ✅ Verification commands

### Step 3: Verify Setup

```bash
codemie doctor
```

**What it checks:**
- ✅ Node.js version (>= 18.0.0)
- ✅ npm and git availability
- ✅ AI provider configuration
- ✅ Connection test to AI provider
- ✅ Installed external agents

### Step 4: Start Using CodeMie

#### Built-in Assistant (CodeMie Code)

Start the interactive AI assistant:

```bash
# In current directory
codemie-code

# In specific directory
codemie-code /path/to/project

# Execute one-off task
codemie-code exec "Add error handling to api.ts"
```

**Features:**
- 15+ built-in tools (filesystem, git, commands)
- MCP server support
- Interactive conversation
- Streaming responses

#### External Agents (Optional)

Install and use additional AI coding agents:

```bash
# List available agents
codemie list

# Install an agent
codemie install claude-code    # Anthropic Claude Code
codemie install codex          # OpenAI Codex (via Azure OpenAI)

# Run an installed agent
codemie run claude-code
codemie run codex
```

---

## 📋 First-Time User Experience

When you run `codemie` for the first time without configuration:

```
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║        Welcome to CodeMie Code! 🎉                    ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝

📋 Getting Started:

Step 1: Choose Your Setup Method

  Option A: Interactive Setup Wizard (Recommended)
  $ codemie setup
  → Guided configuration for all providers
  → Tests connection before saving

  Option B: Manual Configuration Guide
  $ codemie env [provider]  # Show all required env vars
  → Complete environment variable list
  → Copy-paste ready commands

Step 2: Example Configurations:
  [Shows AI/Run, AWS Bedrock, Anthropic examples]

Step 3: Verify Configuration
  $ codemie doctor

Step 4: Start Using CodeMie
  $ codemie-code           # Built-in assistant
  $ codemie list           # See available agents
  $ codemie install <agent>  # Install external agent
```

---

---

## 🎯 First-Time Experience

CodeMie Code provides a guided first-time experience to help you get started quickly.

### What Happens on First Run

When you run `codemie` for the first time without configuration:

```bash
$ codemie

╔═══════════════════════════════════════════════════════╗
║                                                       ║
║        Welcome to CodeMie Code! 🎉                    ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝

It looks like this is your first time using CodeMie Code.
Let's get you set up!

📋 Recommended Next Steps:

1. Run the interactive setup wizard:
   $ codemie setup
   Configure your AI provider, API key, and model preferences
   Supports: AI/Run CodeMie, AWS Bedrock, Anthropic, OpenAI, Azure

2. Or manually set environment variables:

   Option A: AI/Run CodeMie (Recommended)
   $ export CODEMIE_BASE_URL="https://ai.run/api/v1"
   $ export CODEMIE_API_KEY="your-ai-run-key"
   $ export CODEMIE_MODEL="claude-sonnet-4-5"

   Option B: AWS Bedrock (Claude via AWS)
   $ export ANTHROPIC_MODEL="us.anthropic.claude-sonnet-4-5-20250929-v1:0"
   $ export CLAUDE_CODE_USE_BEDROCK=1
   $ export AWS_REGION="us-west-2"

   Option C: Direct Anthropic API
   $ export CODEMIE_BASE_URL="https://api.anthropic.com/v1"
   $ export CODEMIE_API_KEY="your-api-key"
   $ export CODEMIE_MODEL="claude-sonnet-4"
   Add these to ~/.bashrc or ~/.zshrc for persistence

3. Verify your configuration:
   $ codemie doctor
   Check system health and test connectivity

4. Start coding with the built-in AI assistant:
   $ codemie-code              # Start interactive assistant
   $ codemie run codemie-code  # Alternative way to run

5. (Optional) Install additional AI coding agents:
   $ codemie list              # See all available agents
   $ codemie install claude-code # Install Anthropic Claude Code
   $ codemie install codex       # Install OpenAI Codex
   These agents can be run with: codemie run <agent>
```

### Setup Wizard Features

The interactive setup wizard (`codemie setup`) provides:

✅ **Provider Selection** - Choose from AI/Run CodeMie, AWS Bedrock, Anthropic, OpenAI, Azure, or custom providers
✅ **Guided Configuration** - Step-by-step credential setup
✅ **Connection Testing** - Verify your setup before saving
✅ **Persistent Storage** - Configuration saved to `~/.codemie/config.json`
✅ **Easy Reconfiguration** - Use `codemie setup --force` to reconfigure

### Available AI Coding Agents

CodeMie Code includes a **built-in AI assistant** and can manage multiple external AI agents:

#### Built-in Agent: CodeMie Code
- **Features**: Full-featured AI coding assistant with 15+ tools
- **Usage**: `codemie-code` or `codemie run codemie-code`
- **Tools**: Filesystem operations, Git commands, command execution, MCP integration
- **No Installation Required**: Available immediately after setup

#### Optional External Agents

Install additional AI coding agents to expand your toolkit:

| Agent | Description | Installation |
|-------|-------------|--------------|
| **Claude Code** | Official Anthropic Claude Code CLI | `codemie install claude-code` |
| **Codex** | OpenAI Codex (requires Azure OpenAI) | `codemie install codex` |

**List available agents:**
```bash
codemie list
```

**Install an agent:**
```bash
codemie install claude-code
codemie install codex
```

**Run an agent:**
```bash
codemie run claude-code
codemie run codex
```

**Check installed agents:**
```bash
codemie doctor
```

---

## 📚 Configuration

### Supported AI Providers

CodeMie Code supports multiple AI providers with flexible configuration options:

#### 1. AI/Run CodeMie (Recommended)
Unified AI gateway with access to multiple models.

```bash
export CODEMIE_BASE_URL="https://ai.run/api/v1"
export CODEMIE_API_KEY="your-ai-run-key"
export CODEMIE_MODEL="claude-sonnet-4-5"
```

**Benefits:**
- Single API key for multiple models
- Unified billing and usage tracking
- Simplified model switching

#### 2. AWS Bedrock (Claude via AWS)
Use Claude models through AWS Bedrock with your AWS credentials.

**Prerequisites:**
- ✅ **AWS Account** with Bedrock access enabled
- ✅ **AWS Credentials** (Access Key ID & Secret Access Key)
- ✅ **IAM Permissions** for Bedrock (`bedrock:InvokeModel`)
- ✅ **AWS CLI** installed (optional but recommended)

**Step 1: Obtain AWS Credentials**

Your AWS credentials consist of:
- **AWS Access Key ID** (e.g., `AKIAIOSFODNN7EXAMPLE`)
- **AWS Secret Access Key** (e.g., `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`)

To create credentials:
1. Go to AWS Console → IAM → Users
2. Select your user → Security credentials
3. Create access key → Choose "Command Line Interface (CLI)"
4. Save both Access Key ID and Secret Access Key

**Step 2: Configure AWS Credentials**

Choose one of three methods:

**Method 1: AWS CLI (Recommended)**
```bash
# Install AWS CLI (if not already installed)
# macOS: brew install awscli
# Linux: apt-get install awscli or yum install awscli
# Windows: Download from aws.amazon.com/cli

# Configure credentials
aws configure
# AWS Access Key ID [None]: AKIAIOSFODNN7EXAMPLE
# AWS Secret Access Key [None]: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
# Default region name [None]: us-west-2
# Default output format [None]: json

# Verify configuration
aws sts get-caller-identity
```

**Method 2: Environment Variables**
```bash
export AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"
export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
export AWS_REGION="us-west-2"

# Add to ~/.bashrc or ~/.zshrc for persistence
echo 'export AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"' >> ~/.bashrc
echo 'export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"' >> ~/.bashrc
echo 'export AWS_REGION="us-west-2"' >> ~/.bashrc
source ~/.bashrc
```

**Method 3: AWS Credentials File**
```bash
# Create/edit ~/.aws/credentials
mkdir -p ~/.aws

cat > ~/.aws/credentials << EOF
[default]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
EOF

# Create/edit ~/.aws/config
cat > ~/.aws/config << EOF
[default]
region = us-west-2
output = json
EOF
```

**Step 3: Enable Bedrock Model Access**

1. Go to AWS Console → Amazon Bedrock
2. Navigate to "Model access" in the left sidebar
3. Click "Manage model access"
4. Enable access to Claude models:
   - ☑️ Claude 3.5 Sonnet
   - ☑️ Claude Opus
   - ☑️ Claude Sonnet
5. Click "Save changes"

**Step 4: Configure CodeMie for Bedrock**

```bash
# Set Bedrock environment variables
export ANTHROPIC_MODEL="us.anthropic.claude-sonnet-4-5-20250929-v1:0"
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION="us-west-2"
export AWS_PROFILE="default"  # Optional, if using named profiles

# Add to shell profile for persistence
echo 'export ANTHROPIC_MODEL="us.anthropic.claude-sonnet-4-5-20250929-v1:0"' >> ~/.bashrc
echo 'export CLAUDE_CODE_USE_BEDROCK=1' >> ~/.bashrc
echo 'export AWS_REGION="us-west-2"' >> ~/.bashrc
source ~/.bashrc
```

**Available Bedrock Models:**

| Model Identifier | Description | Region |
|-----------------|-------------|---------|
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Claude Sonnet 4.5 (Latest) | US regions |
| `us.anthropic.claude-opus-4-0-20250514-v1:0` | Claude Opus 4 | US regions |
| `anthropic.claude-3-5-sonnet-20241022-v2:0` | Claude 3.5 Sonnet | All regions |

**Step 5: Verify Setup**

```bash
# Check AWS credentials
aws sts get-caller-identity

# Check CodeMie configuration
codemie doctor

# Start using Bedrock
codemie-code
```

**Using AWS Profiles**

If you have multiple AWS accounts or profiles:

```bash
# List available profiles
aws configure list-profiles

# Use a specific profile
export AWS_PROFILE="production"

# Or specify in CodeMie config
export AWS_PROFILE="production"
codemie-code
```

**Troubleshooting Bedrock**

**Issue: "AccessDeniedException"**
- Ensure your IAM user/role has `bedrock:InvokeModel` permission
- Verify model access is enabled in Bedrock console

**Issue: "Region not supported"**
- Bedrock is available in specific regions only
- Use: `us-west-2`, `us-east-1`, `eu-west-1`, `ap-northeast-1`

**Issue: "Credentials not found"**
- Check: `aws configure list`
- Verify environment variables are set
- Ensure ~/.aws/credentials exists and is readable

#### 3. Anthropic (Direct API)
Direct access to Anthropic's Claude API.

```bash
export CODEMIE_BASE_URL="https://api.anthropic.com/v1"
export CODEMIE_API_KEY="your-anthropic-api-key"
export CODEMIE_MODEL="claude-sonnet-4"
```

#### 4. Azure OpenAI (for GPT models and Codex)
Use OpenAI models through Azure.

```bash
export CODEMIE_BASE_URL="https://your-resource.openai.azure.com"
export CODEMIE_API_KEY="your-azure-api-key"
export CODEMIE_MODEL="gpt-4"
```

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `CODEMIE_BASE_URL` | AI provider base URL | `https://ai.run/api/v1` |
| `CODEMIE_API_KEY` | Authentication API key | `your-api-key` |
| `CODEMIE_MODEL` | Model to use | `claude-sonnet-4-5` |

### AWS Bedrock Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `AWS_ACCESS_KEY_ID` | **Yes*** | AWS access key ID | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY` | **Yes*** | AWS secret access key | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| `AWS_REGION` | **Yes** | AWS region for Bedrock | `us-west-2` |
| `ANTHROPIC_MODEL` | **Yes** | Bedrock model identifier | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| `CLAUDE_CODE_USE_BEDROCK` | **Yes** | Enable Bedrock mode | `1` |
| `AWS_PROFILE` | No | AWS CLI profile name | `default` |

**\*Note:** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are required UNLESS you have configured credentials via AWS CLI (`aws configure`) or AWS credentials file (`~/.aws/credentials`).

### Optional Configuration

#### Runtime Configuration

```bash
# Enable debug logging
export CODEMIE_DEBUG="true"

# Timeout for AI requests (seconds)
export CODEMIE_TIMEOUT="300"

# Load specific MCP servers
export CODEMIE_MCP_SERVERS="time,context7"
```

#### MCP Configuration

Configure MCP (Model Context Protocol) servers in `~/.codemie/config.json`:

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "time": {
      "command": "uvx",
      "args": ["mcp-server-time"]
    }
  }
}
```

Or use environment variable to specify which servers to load:

```bash
# Load specific MCP servers
export CODEMIE_MCP_SERVERS="context7,time"
codemie-code

# Or with CLI flag
codemie-code --mcp-servers context7,time
```

When no `--mcp-servers` flag is provided, all servers configured in `~/.codemie/config.json` are loaded automatically.

### Configuration Methods

#### Method 1: Shell Environment (Recommended)

```bash
# Add to ~/.bashrc or ~/.zshrc
export CODEMIE_BASE_URL="https://your-ai-proxy.com"
export CODEMIE_AUTH_TOKEN="your-token"
export CODEMIE_MODEL="claude-4-5-sonnet"

# Reload shell
source ~/.bashrc  # or ~/.zshrc
```

#### Method 2: Project .env File

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

#### Method 3: Inline

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

---

## 🎯 Usage

### CodeMie Code Assistant

The built-in AI assistant with filesystem, git, and command execution tools.

```bash
# Interactive mode (default)
codemie-code
codemie-code /path/to/project

# Execute one-off task
codemie-code exec "Add error handling to api.ts"

# Execute with custom directory
codemie-code exec "Run tests" -d /path/to/project

# Test connection
codemie-code test

# With MCP servers
codemie-code --mcp-servers time,context7

# With specific model
CODEMIE_MODEL="claude-opus" codemie-code
```

#### Interactive Commands

Once inside the assistant:

- **exit** - Exit the assistant
- **clear** - Clear conversation history
- Any coding question or task

#### Example Prompts

```
You: Show me the project structure
You: Read the package.json file
You: List all TypeScript files
You: Show git status and recent commits
You: Create a new file called utils.ts with helper functions
You: Search for files containing "authentication"
You: Edit README.md to add a new section
You: Run npm test and show me the results
```

### MCP Server Management

Extend capabilities with Model Context Protocol servers.

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

#### Popular MCP Servers

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

### CLI Wrapper (codemie)

Manage multiple AI coding agents from one interface.

#### List Available Agents

```bash
codemie list                    # List all agents
codemie list --installed        # List only installed agents
```

#### Install Agents

```bash
codemie install claude-code     # Install Anthropic Claude Code
codemie install codex           # Install OpenAI Codex
```

#### Run Agents

```bash
# Run built-in CodeMie Code
codemie run codemie-code

# Run other agents
codemie run claude-code
codemie run codex

# With custom model
codemie run codemie-code --model claude-opus
```

#### Uninstall Agents

```bash
codemie uninstall claude-code
codemie uninstall codex
```

#### Health Check

```bash
codemie doctor
```

Checks:
- ✅ Node.js version (>= 24.0.0)
- ✅ npm installation
- ✅ git availability
- ✅ Environment variables configuration
- ✅ Installed agents

#### Version Information

```bash
codemie version
codemie-code --version
```

---

## 🛠️ Available Tools

CodeMie Code assistant comes with 15 built-in tools, plus extensible MCP tools:

### Filesystem Tools (10 tools)

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

### Git Tools (4 tools)

| Tool | Description |
|------|-------------|
| `git_status` | Get repository status |
| `git_diff` | Show git diff for changes |
| `git_log` | Show commit history |
| `git_command` | Execute any git command |

### Command Execution (1 tool)

| Tool | Description |
|------|-------------|
| `execute_command` | Execute shell commands (with security checks) |

### MCP Tools (Extensible)

MCP (Model Context Protocol) enables dynamic tool loading from external servers:

| Server | Tools | Description |
|--------|-------|-------------|
| `context7` | `resolve-library-id`, `get-library-docs` | Access up-to-date library documentation |
| `time` | `get-current-time` | Query times in any timezone |
| Custom | Varies | Add your own MCP servers |

Configure MCP servers in `~/.codemie/config.json` to extend available tools.

### Tool Features

- **Path Validation**: All operations restricted to allowed directories
- **Symlink Protection**: Prevents escaping allowed directories
- **Ignore Patterns**: Automatically excludes node_modules, .git, etc.
- **Indentation Preservation**: Smart editing maintains code formatting
- **Unified Diffs**: Shows clear before/after changes
- **Command Sanitization**: Blocks dangerous commands (rm -rf /, sudo, etc.)

---

## 🔒 Security Features

CodeMie Code implements multiple security layers:

### Filesystem Security

✅ **Path Validation**
- All paths validated against allowed directories
- No directory traversal attacks (../)
- Absolute path resolution

✅ **Symlink Protection**
- Symlinks resolved and validated
- Target paths must be within allowed directories

✅ **Ignore Patterns**
- Automatically excludes sensitive directories
- Default: `node_modules`, `.git`, `__pycache__`, `.venv`, `dist`, `build`

### Command Security

The `execute_command` tool blocks dangerous patterns:

```typescript
🚫 rm -rf /              // Recursive delete on root
🚫 mkfs                  // Filesystem formatting
🚫 dd if=                // Disk operations
🚫 wget ... | sh         // Download and execute
🚫 curl ... | sh         // Download and execute
🚫 sudo                  // Privilege escalation
🚫 chmod 777             // Unsafe permissions
🚫 > /etc/               // Writing to system config
🚫 > /dev/               // Writing to devices
🚫 :(){ :|:& };:         // Fork bomb
```

### Security Best Practices

1. **Set Allowed Directories**: Only the working directory is accessible
2. **Review Changes**: Always review diffs before applying
3. **Use Version Control**: Work in git repositories
4. **Test in Isolation**: Test in separate environments first

---

## 🎨 Usage Examples

### Example 1: Code Review

```bash
codemie-code

You: Read src/utils/helper.ts and review the code
Assistant: [Reads file, provides detailed review with suggestions]

You: Create a test file for this module
Assistant: [Creates tests/utils/helper.test.ts with test cases]
```

### Example 2: Refactoring

```bash
You: Show me all files in src/components
Assistant: [Lists component files]

You: Read Button.tsx and refactor it to use hooks
Assistant: [Shows diff with proposed changes]

You: Apply those changes
Assistant: [Applies edits and shows confirmation]
```

### Example 3: Git Workflow

```bash
You: Show me the current git status
Assistant: [Shows modified, staged, and untracked files]

You: Show diff for src/app.ts
Assistant: [Displays git diff]

You: Show the last 5 commits
Assistant: [Shows commit history]
```

### Example 4: Project Setup

```bash
You: Create a new directory called "api"
Assistant: [Creates directory]

You: Create index.ts in api/ with a basic Express setup
Assistant: [Creates file with boilerplate code]

You: Create a README.md in api/ documenting the API
Assistant: [Creates documentation]
```

### Example 5: Search and Replace

```bash
You: Search for all files containing "TODO"
Assistant: [Lists files with TODO comments]

You: Read components/Header.tsx
Assistant: [Shows file content]

You: Replace the TODO with an implementation
Assistant: [Shows diff and applies changes]
```

---

## 🐛 Troubleshooting

### Common Issues

#### "Base URL not configured"

**Solution:**
```bash
export CODEMIE_BASE_URL="https://your-ai-proxy.com"
export CODEMIE_AUTH_TOKEN="your-token"
export CODEMIE_MODEL="claude-4-5-sonnet"
```

#### "Connection test failed"

**Possible causes:**
1. Invalid CODEMIE_AUTH_TOKEN
2. CODEMIE_BASE_URL not accessible
3. Network/VPN issues

**Solution:**
```bash
# Verify URL is accessible
curl -I $CODEMIE_BASE_URL

# Check environment variables
echo $CODEMIE_BASE_URL
echo $CODEMIE_AUTH_TOKEN
echo $CODEMIE_MODEL

# Run doctor
codemie doctor

# Try test again
codemie-code test
```

#### "Command not found: codemie"

**Solution:**
```bash
# Re-install globally
npm install -g @codemieai/code

# Or re-link the package (from source)
cd /path/to/codemie-code
npm link

# Verify
which codemie
which codemie-code
```

#### "Path outside allowed directories"

**Solution:**
CodeMie Code only operates within the working directory for security.

```bash
# Start in the correct directory
cd /path/to/your/project
codemie-code

# Or specify the directory
codemie-code /path/to/your/project
```

#### Environment Variables Not Loaded

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

### Debug Mode

Enable debug logging to diagnose issues:

```bash
export CODEMIE_DEBUG="true"
codemie-code
```

Debug mode shows:
- Tool initialization details
- AI request/response info
- File operation details
- Error stack traces

### Clean Installation

If you encounter persistent issues:

```bash
# Clean build
rm -rf dist/ node_modules/
npm install
npm run build

# Re-link
npm link
```

---

## 📊 Architecture

### Package Structure

```
codemie-code/
├── bin/
│   ├── codemie-code.js      # AI assistant entry point
│   └── codemie.js           # CLI wrapper entry point
│
├── src/
│   ├── code/                # CodeMie Code Assistant
│   │   ├── index.ts         # Main assistant class
│   │   ├── agent.ts         # LangChain ReAct agent
│   │   ├── agent-events.ts  # Event system for streaming
│   │   ├── config.ts        # Configuration loader
│   │   ├── prompts.ts       # System prompts
│   │   └── tools/           # Tool implementations
│   │       ├── filesystem.ts   # 10 filesystem tools
│   │       ├── git.ts          # 4 git tools
│   │       ├── command.ts      # Command execution
│   │       ├── mcp.ts          # MCP integration
│   │       └── diff-utils.ts   # Diff utilities
│   │
│   ├── cli/                 # CLI Wrapper
│   │   └── commands/        # CLI commands
│   │       ├── list.ts
│   │       ├── install.ts
│   │       ├── run.ts
│   │       ├── doctor.ts
│   │       ├── uninstall.ts
│   │       ├── version.ts
│   │       └── mcp.ts
│   │
│   ├── agents/              # Agent System
│   │   ├── registry.ts      # Agent registry
│   │   └── adapters/        # Agent adapters
│   │       ├── codemie-code.ts
│   │       ├── claude-code.ts
│   │       └── codex.ts
│   │
│   ├── env/                 # Environment Management
│   │   └── manager.ts
│   │
│   ├── ui/                  # UI Layer
│   │   └── terminal-ui.ts   # Interactive terminal
│   │
│   └── utils/               # Utilities
│       ├── env-mapper.ts    # Environment variable mapping
│       ├── exec.ts          # Process execution
│       ├── logger.ts        # Logging
│       ├── errors.ts        # Error classes
│       └── tips.ts          # Loading tips
│
├── tests/                   # Test files
│   └── integration/         # Integration tests
│
├── dist/                    # Build output (TypeScript compilation)
├── mcp/                     # MCP server configurations
│   └── servers.json
├── package.json             # Dependencies and scripts
├── tsconfig.json            # TypeScript configuration
├── eslint.config.mjs        # ESLint configuration
└── README.md                # Package documentation
```

### Technology Stack

- **Language**: TypeScript (ES2022, NodeNext modules)
- **Runtime**: Node.js >= 24.0.0 (LTS Krypton)
- **Package Manager**: npm
- **LLM Framework**: LangChain 1.x (`@langchain/core`, `@langchain/langgraph`, `@langchain/openai`)
- **LLM Provider**: Any OpenAI-compatible API
- **CLI Framework**: Commander.js
- **Schema Validation**: Zod
- **Diff Generation**: diff package
- **UI**: Chalk, Inquirer, Ora
- **Testing**: Jest with ts-jest
- **Linting**: ESLint with TypeScript support

---

## 🔄 Roadmap

### Current Status (v1.0.0)

✅ **Implemented**:
- Built-in AI coding assistant
- CLI wrapper for multiple agents
- 10 filesystem tools with security
- 4 git operation tools
- 1 command execution tool
- MCP (Model Context Protocol) integration
- Diff-based file editing
- Agent management (install/uninstall/run)
- Health check and diagnostics
- Interactive terminal UI with cancellation support
- One-off task execution with `exec` command

### Planned Features (v1.1.0+)

- 🎨 Custom themes and output formats
- 📦 Enhanced plugin system for custom tools
- 🌐 Multi-language support
- 📊 Usage analytics and insights
- 🔌 VS Code extension integration
- 🤖 More agent adapters (Cursor, Copilot, etc.)
- 🔍 Advanced MCP server discovery and management

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

### Development Setup

```bash
# Clone repository
git clone https://github.com/codemie-ai/codemie-code.git
cd codemie-code

# Install dependencies
npm install

# Build
npm run build

# Watch mode (for development)
npm run dev

# Test locally
npm link
codemie doctor
```

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test
npm test -- path/to/test

# Manual integration tests
node tests/test-streaming.js
node tests/test-agent-direct.js
```

---

## 📄 License

MIT License - see LICENSE file for details

---

## 🙏 Acknowledgments

- Built with [LangChain](https://js.langchain.com/)
- Inspired by [Claude Code](https://claude.com/code)
- CLI framework by [Commander.js](https://github.com/tj/commander.js)
- MCP specification by [Anthropic](https://github.com/modelcontextprotocol/specification)

---

## 📞 Support

For issues, questions, or contributions:
- 🐛 Report bugs via [GitHub Issues](https://github.com/codemie-ai/codemie-code/issues)
- 💬 Ask questions in [Discussions](https://github.com/codemie-ai/codemie-code/discussions)
- 📖 Read the full [User Guide](docs/USER_GUIDE.md)

---

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

---

**Made with ❤️ by the CodeMie Team**
