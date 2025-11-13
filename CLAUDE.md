# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Critical First Step: ALWAYS Read Documentation

**MANDATORY**: Before writing ANY code, you MUST:
1. Read the `README.md` file - this is your PRIMARY source of truth
2. Review this CLAUDE.md for architectural patterns and conventions
3. Study reference implementations mentioned in this guide

## Common Commands

```bash
# Installation & Setup
npm install                 # Install dependencies
npm link                    # Link globally for local testing

# Building
npm run build              # Compile TypeScript and copy assets (to dist/)
npm run dev                # Watch mode for development

# Testing
npm test                   # Run all tests (Node.js native test runner)
npm run test:watch         # Run tests in watch mode

# Run individual test files
node --test tests/agent-direct.test.mjs
node --test tests/streaming.test.mjs

# Code Quality
npm run lint               # Check code style with ESLint
npm run lint:fix           # Fix linting issues automatically

# Development Workflow
npm run build && npm link  # Build and link for testing
codemie doctor             # Verify installation and configuration

# Release & Publishing
git tag -a v0.0.1 -m "Release version 0.0.1"  # Create release tag
git push origin v0.0.1                         # Push tag to trigger publish
```

## Core Principles

**ALWAYS follow these fundamental principles:**

### KISS (Keep It Simple, Stupid)
- Write simple, straightforward code that's easy to understand
- Avoid over-engineering and unnecessary complexity
- Remove redundant code, scripts, and configuration
- If something can be done in fewer lines/steps, do it
- Question every piece of complexity - is it truly needed?

### DRY (Don't Repeat Yourself)
- Never duplicate code, logic, or configuration
- Extract common patterns into reusable functions/utilities
- Reuse existing utilities from `src/utils/` before creating new ones
- If you find yourself copying code, refactor it into a shared function
- One source of truth for each piece of knowledge

**Remember:** Simple, clean code is better than clever, complex code.

## Specialized Agents

This project uses specialized subagents for complex, multi-step workflows. These agents have dedicated system prompts stored in `.claude/agents/` that can be updated independently.

### Release Manager Agent

**Location:** `.claude/agents/release-manager.md`

**Purpose:** Automate the complete release process from change analysis to npm publication.

**Trigger Phrases:**
- "Release version X.X.X"
- "Create a new release"
- "Release a patch/minor/major version"
- "Use release manager to..."
- "Prepare a release"

**What it does:**
1. Runs pre-flight checks (clean working directory, correct branch)
2. Analyzes git history since last release tag
3. Categorizes commits using conventional commits
4. Generates structured release notes (Keep a Changelog format)
5. Updates package.json and package-lock.json version
6. Creates git commit for version bump
7. Creates and pushes annotated git tag
8. Creates GitHub release with generated notes
9. Triggers npm publish workflow via GitHub Actions
10. Reports completion status and provides verification links

**Example Usage:**
```
You: "Release version 0.0.2"

Claude:
1. Checks git status and current branch
2. Analyzes 12 commits since v0.0.1
3. Generates release notes with categorized changes
4. Shows preview and asks for confirmation
5. Updates package.json to 0.0.2
6. Creates commit "chore: bump version to 0.0.2"
7. Creates tag v0.0.2 and pushes
8. Creates GitHub Release
9. Reports: "✅ Released v0.0.2, npm publish workflow triggered"
```

**Customization:**
Edit `.claude/agents/release-manager.md` to modify:
- Release notes format
- Commit categorization rules
- Version bump strategies
- Error handling behavior
- Pre-flight check requirements

### Creating Additional Agents

To create your own specialized agent:

1. **Create the agent file**: `.claude/agents/{role}-{function}.md`
   - Example: `code-reviewer.md`, `test-generator.md`, `security-auditor.md`

2. **Define the system prompt**: Include role, capabilities, workflow, error handling, and examples

3. **Document trigger phrases**: Add them to this CLAUDE.md section

4. **Update agents README**: Add documentation to `.claude/agents/README.md`

**Naming convention:** `{role}-{function}.md`
- ✅ `release-manager.md`, `code-reviewer.md`, `test-generator.md`
- ❌ `release.md`, `agent1.md`, `helper.md`

**See:** `.claude/agents/README.md` for detailed agent creation guide and best practices.

## Critical Policies

### Testing & Documentation Policy

**IMPORTANT - Do NOT write tests, documentation, or summaries unless explicitly requested:**
- Do NOT write tests unless user explicitly says: "Write tests", "Create unit tests", etc.
- Do NOT run tests unless user explicitly says: "Run the tests", "Execute test suite", etc.
- Do NOT generate documentation unless user explicitly says: "Write documentation", "Create docs", etc.
- Do NOT write summaries unless user explicitly says: "Summarize", "Write a summary", etc.
- Do NOT run compilation checks unless explicitly requested
- Do NOT proactively create README files or documentation files

### Node Modules Policy

**IMPORTANT:**
- NEVER modify files inside `node_modules/`
- All source code lives in `src/`
- All tests live in `tests/`
- Build output goes to `dist/`

### Utilities Policy

**Before implementing new utility functions:**
1. Check if similar functionality exists in `src/utils/` directory
2. Always reuse existing utilities (logger, exec, errors, tips, etc.)
3. If implementing new shared utilities, get user approval first

### Git Workflow Policy

**CRITICAL - Read the complete Git Workflow Policy:**

📖 **See:** `.codemie/guides/git-workflow.md` for comprehensive git workflow guidelines

**Key Requirements:**
- ❌ **NEVER commit directly to `main` branch**
- ✅ **ALWAYS create a feature branch** for any changes
- ✅ **ALL changes go through Pull Request review**
- ✅ Use conventional commit format: `type: description`
- ✅ Follow branch naming: `feature/`, `fix/`, `docs/`, `refactor/`, `chore/`

**Quick Reference:**
```bash
# Standard workflow
git checkout main && git pull origin main
git checkout -b feature/your-feature-name
# Make changes...
git add .
git commit -m "feat: add something" -m "Co-authored-by: CodeMie AI <codemie.ai@gmail.com>"
git push -u origin feature/your-feature-name
# Create PR via GitHub UI or: gh pr create
```

**Important:** Always add CodeMie AI co-author to commits for proper attribution

For detailed information on:
- Branch naming conventions
- Commit message guidelines
- PR creation and review process
- Merge conflict resolution
- Emergency hotfixes
- Git commands reference

👉 **Read:** `.codemie/guides/git-workflow.md`

### Release & Publishing Policy

**IMPORTANT - How to publish to npm registry:**

The project uses GitHub Actions to automatically publish to npm when a release is created. The workflow is defined in `.github/workflows/publish.yml`.

**Step-by-step release process:**

1. **Ensure you're on the main branch** (after merging your feature branch):
   ```bash
   git checkout main
   git pull origin main
   ```

2. **Create an annotated git tag** with the version number:
   ```bash
   # Match the version in package.json (e.g., 0.0.1)
   git tag -a v0.0.1 -m "Release version 0.0.1"
   ```

3. **Push the tag to GitHub**:
   ```bash
   git push origin v0.0.1
   ```

4. **Create a GitHub Release** (two options):

   **Option A - GitHub UI (recommended):**
   - Go to GitHub repository → Releases → "Draft a new release"
   - Select the tag you just pushed (`v0.0.1`)
   - Add release title (e.g., `v0.0.1` or `Release 0.0.1`)
   - Add release notes describing changes
   - Click "Publish release"

   **Option B - Manual workflow trigger:**
   - Go to Actions → "Publish to NPM" workflow
   - Click "Run workflow"
   - Select the `main` branch
   - Click "Run workflow"

5. **The workflow will automatically**:
   - Checkout code
   - Install dependencies
   - Run CI checks (`npm run ci` - includes lint, build, and tests)
   - Publish to npm with `npm publish --access public`
   - Authenticate using the `NPM_TOKEN` secret

**Prerequisites:**
- `NPM_TOKEN` must be configured in GitHub repository secrets
- Version in `package.json` must match the tag version (without the `v` prefix)
- All CI checks must pass (linting, build, tests)

**Version bumping:**
```bash
# Update version in package.json
npm version patch    # 0.0.1 → 0.0.2
npm version minor    # 0.0.1 → 0.1.0
npm version major    # 0.0.1 → 1.0.0

# This creates a commit and tag automatically
# Then push both:
git push origin main --tags
```

**Verifying the publish:**
```bash
# Check on npm registry
npm view @codemieai/code

# Install and test locally
npm install -g @codemieai/code@latest
codemie doctor
```

## Reference Implementations

Study these excellent examples before implementing new code:
- **AI Assistant** (`src/code/`) - Complete ReAct agent implementation with streaming
- **Tool System** (`src/code/tools/`) - Filesystem, Git, Command, and MCP tools
- **UI Layer** (`src/ui/terminal-ui.ts`) - Interactive terminal with cancellation support
- **Agent System** (`src/agents/`) - Agent registry and adapters pattern

## Communication Style

When responding:
1. Confirm your understanding of the request
2. Reference which patterns you're following from existing code
3. Outline your implementation approach
4. Present complete, working code
5. Explain key design decisions
6. Highlight any assumptions requiring user input

## Self-Verification Before Delivery

- [ ] README.md and CLAUDE.md have been read and understood
- [ ] Reference implementations reviewed for similar patterns
- [ ] Code follows TypeScript best practices and project conventions
- [ ] No tests written (unless explicitly requested)
- [ ] No tests executed (unless explicitly requested)
- [ ] Code is production-ready and follows DRY/KISS principles

## Escalation Scenarios

Seek user guidance when:
- Documentation is missing, unclear, or contradictory
- New dependencies are required
- Breaking changes are necessary
- Multiple valid approaches exist
- Reference implementations don't cover the use case
- Security or architectural concerns arise

## Project Overview

**CodeMie Code** is a unified npm package that provides:
- A built-in AI coding assistant powered by LiteLLM (via LangChain)
- A CLI wrapper for managing multiple AI coding agents (Claude Code, Codex)

The project uses TypeScript with a ReAct agent pattern via LangGraph for autonomous tool execution.

## Quick Architecture Overview

### Core Components

- **AI Assistant** (`src/code/`): Main assistant class, agent, configuration, prompts
- **Tool System** (`src/code/tools/`): Filesystem, Git, Command execution, MCP integration
- **CLI Wrapper** (`src/cli/commands/`): Commands for managing external agents
- **Agent System** (`src/agents/`): Registry and adapters for different AI agents
- **UI Layer** (`src/ui/`): Interactive terminal with streaming and cancellation
- **Environment** (`src/env/`, `src/utils/`): Config management and utilities

### Entry Points
- `bin/codemie-code.js` - Starts the AI assistant
- `bin/codemie.js` - CLI wrapper for agent management

### Key Design Patterns

#### ReAct Agent Pattern
Uses LangGraph's `createReactAgent`:
1. **Reasoning** - LLM thinks about what to do
2. **Acting** - Calls tools based on reasoning
3. **Observing** - Receives tool results
4. Loops until task is complete

#### Streaming Architecture
Agent supports streaming via `chatStream()`:
- `thinking_start/end` - Agent is reasoning
- `tool_call_start` - Tool invocation begins
- `tool_call_result` - Tool returns result
- `content_chunk` - Partial response content
- `complete/cancelled/error` - Terminal states

#### Security Model
All filesystem/command operations validate:
- Paths must be within `allowedDirectories`
- Symlinks are resolved and validated
- Dangerous command patterns are blocked
- Ignore patterns exclude sensitive dirs

## Project Structure

```
codemie-code/
├── bin/
│   ├── codemie-code.js          # AI assistant entry point
│   └── codemie.js               # CLI wrapper entry point
│
├── src/
│   ├── code/                    # CodeMie Code Assistant
│   │   ├── index.ts             # Main assistant class
│   │   ├── agent.ts             # LangChain ReAct agent
│   │   ├── agent-events.ts      # Event system for streaming
│   │   ├── config.ts            # Configuration loader
│   │   ├── prompts.ts           # System prompts
│   │   └── tools/               # Tool implementations
│   │       ├── filesystem.ts    # 8 filesystem tools
│   │       ├── git.ts           # 4 git tools
│   │       ├── command.ts       # Command execution
│   │       ├── mcp.ts           # MCP integration
│   │       └── diff-utils.ts    # Diff utilities
│   │
│   ├── cli/                     # CLI Wrapper
│   │   └── commands/            # CLI commands
│   │       ├── list.ts
│   │       ├── install.ts
│   │       ├── run.ts
│   │       ├── doctor.ts
│   │       ├── uninstall.ts
│   │       └── version.ts
│   │
│   ├── agents/                  # Agent System
│   │   ├── registry.ts          # Agent registry
│   │   └── adapters/            # Agent adapters
│   │       ├── codemie-code.ts
│   │       ├── claude-code.ts
│   │       └── codex.ts
│   │
│   ├── env/                     # Environment Management
│   │   └── manager.ts
│   │
│   ├── ui/                      # UI Layer
│   │   └── terminal-ui.ts       # Interactive terminal
│   │
│   └── utils/                   # Utilities
│       ├── env-mapper.ts        # Environment variable mapping
│       ├── exec.ts              # Process execution
│       ├── logger.ts            # Logging
│       ├── errors.ts            # Error classes
│       └── tips.ts              # Loading tips
│
├── tests/                       # Test files
│   ├── test-*.js                # Manual integration tests
│   └── integration/             # Additional test scenarios
│
├── dist/                        # Build output (TypeScript compilation)
├── mcp/                         # MCP server configurations
│   └── servers.json
├── package.json                 # Dependencies and scripts
├── tsconfig.json                # TypeScript configuration
├── eslint.config.mjs            # ESLint configuration
└── README.md                    # Package documentation
```

## Technology Stack

- **Language**: TypeScript (ES2022, NodeNext modules)
- **Runtime**: Node.js >= 24.0.0 (LTS Krypton)
- **Package Manager**: npm
- **LLM Framework**: LangChain 1.x (`@langchain/core`, `@langchain/langgraph`, `@langchain/openai`)
- **LLM Provider**: LiteLLM (OpenAI-compatible proxy)
- **CLI Framework**: Commander.js
- **Schema Validation**: Zod
- **Diff Generation**: diff package
- **UI**: Chalk, Inquirer, Ora
- **Testing**: Jest with ts-jest
- **Linting**: ESLint with TypeScript support

## Configuration & Environment

### Environment Variable Priority
The config loader (`src/utils/env-mapper.ts`) checks in order:
1. `ANTHROPIC_*` - For Claude models
2. `OPENAI_*` - For GPT models
3. `AI_*` - Generic provider-agnostic
4. `LITELLM_*` - Legacy format (still supported)

### Required Environment Variables

```bash
# Provider-specific (choose one set)

# For Anthropic Claude models
ANTHROPIC_BASE_URL=https://litellm-proxy.example.com
ANTHROPIC_AUTH_TOKEN=your-token
ANTHROPIC_MODEL=claude-4-5-sonnet

# OR for OpenAI models
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your-token
OPENAI_MODEL=gpt-4

# OR generic provider-agnostic
AI_BASE_URL=https://litellm-proxy.example.com
AI_AUTH_TOKEN=your-token
AI_MODEL=claude-4-5-sonnet
```

### Optional Environment Variables

```bash
CODEMIE_DEBUG=true                           # Enable debug logging
CODEMIE_MODEL=claude-opus                    # Override model
CODEMIE_MCP_SERVERS=filesystem,cli-mcp-server # Load specific MCP servers
AI_TIMEOUT=300                               # Request timeout in seconds
```

### MCP Configuration
MCP servers are defined in:
1. `mcp/servers.json` - Default server configurations
2. `~/.codemie/config.json` - User-specific MCP config

MCP integration is handled by `src/code/tools/mcp.ts` which dynamically loads tools from configured servers.

## Development Guidelines

### File Naming Conventions

- **Modules**: kebab-case (e.g., `terminal-ui.ts`, `agent-events.ts`)
- **Classes**: PascalCase (e.g., `CodeMieCode`, `CodeMieAgent`)
- **Functions**: camelCase (e.g., `loadConfig`, `getTools`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `SYSTEM_PROMPT`)
- **Tests**: `test-*.js` or `*.test.ts`

### Code Style

- **Formatter**: TypeScript default (2 spaces)
- **Line Length**: No strict limit, but keep reasonable
- **Quotes**: Single quotes preferred
- **Semicolons**: Required
- **Imports**: Organized (standard library, third-party, local)
- **Type Hints**: Use TypeScript types throughout
- **Async/Await**: Preferred over promises/callbacks

### Import Organization

```typescript
// Third-party imports
import { ChatOpenAI } from '@langchain/openai';
import { StructuredTool } from '@langchain/core/tools';
import chalk from 'chalk';

// Local imports
import { CodeMieConfig } from './config';
import { logger } from '../utils/logger';
import { FilesystemTools } from './tools/filesystem';
```

## Tool Development

### Adding New Filesystem Tools

Extend `FilesystemTools` class in `src/code/tools/filesystem.ts`:
1. Create tool using `new StructuredTool()` with Zod schema
2. Add validation via `validatePath()` or `validateInAllowedDirectory()`
3. Push to tools array in constructor
4. Handle errors with try-catch, return error messages

Example:
```typescript
const myNewTool = new StructuredTool({
  name: "my_new_tool",
  description: "Description of what this tool does",
  schema: z.object({
    path: z.string().describe("File path"),
    content: z.string().describe("File content")
  }),
  func: async ({ path, content }) => {
    try {
      const fullPath = this.validatePath(path);
      // Tool implementation
      return "Success message";
    } catch (error: any) {
      return `Error: ${error.message}`;
    }
  }
});
```

### Adding New Git Tools

Extend `GitTools` class in `src/code/tools/git.ts` following the same pattern.

### Diff-Based Editing

The `edit_file` tool uses `diff` package to generate unified diffs:
- Preserves indentation (tabs vs spaces)
- Shows clear before/after changes
- Validates file exists before editing

## Agent Adapters

To add a new agent adapter (e.g., for Cursor or Copilot):

1. Create `src/agents/adapters/my-agent.ts` implementing `AgentAdapter` interface
2. Register in `src/agents/registry.ts`
3. Implement required methods:
   - `install()` - Install the agent
   - `uninstall()` - Uninstall the agent
   - `isInstalled()` - Check if installed
   - `run(args)` - Run the agent
   - `getVersion()` - Get version info

Example:
```typescript
export class MyAgentAdapter implements AgentAdapter {
  name = 'my-agent';
  displayName = 'My Agent';
  description = 'Description of my agent';

  async install(): Promise<void> { /* ... */ }
  async uninstall(): Promise<void> { /* ... */ }
  async isInstalled(): Promise<boolean> { /* ... */ }
  async run(args: string[]): Promise<void> { /* ... */ }
  async getVersion(): Promise<string | null> { /* ... */ }
}
```

## Error Handling

### Standard Error Pattern

```typescript
try {
  // Operation
  const result = await performOperation();
  return result;
} catch (error: any) {
  // Log error for debugging
  logger.error('Operation failed:', error);

  // Return user-friendly error message
  throw new Error(`Operation failed: ${error.message}`);
}
```

### Custom Error Classes

Located in `src/utils/errors.ts`:
- `ConfigurationError` - Configuration issues
- Use standard `Error` for most cases

## Testing Approach

### Test Framework & Structure

- Uses **Node.js native test runner** (`node:test`)
- All test files are located in `tests/` directory
- Test files use `.mjs` extension (ES modules)
- Tests are built using `describe()`, `it()`, `before()`, and `after()` from `node:test`

### Test Categories

1. **Agent Tests** - Test LLM agent functionality (requires base URL configuration)
   - `agent-direct.test.mjs` - Direct agent tool calling
   - `agent-output.test.mjs` - Agent output format
   - `streaming.test.mjs` - Streaming functionality
   - `conversation-flow.test.mjs` - Multiple question handling

2. **Integration Tests** - Test `codemie-code` (AI assistant) (requires base URL configuration)
   - `codemie-code.test.mjs` - CodeMieCode tool calling
   - `tool-count.test.mjs` - Tool loading verification
   - `interactive-simulation.test.mjs` - Interactive conversation simulation
   - `ui-state.test.mjs` - UI state management
   - `live-output.test.mjs` - Live output format

3. **MCP Tests** - Test MCP server integration with AI assistant (requires base URL configuration)
   - `mcp-context7.test.mjs` - Context7 MCP server
   - `mcp-time-server.test.mjs` - Time MCP server
   - `mcp-e2e.test.mjs` - End-to-end MCP integration
   - `context7-only.test.mjs` - Context7 server only

4. **UI/Format Tests** - Test formatting and UI logic (does NOT require base URL)
   - `ui-format.test.mjs` - UI formatting
   - `text-wrapping.test.mjs` - Text wrapping logic

5. **CLI Wrapper Tests** - Test `codemie` CLI commands (does NOT require base URL)
   - Currently no tests exist for CLI commands (`codemie doctor`, `codemie list`, etc.)
   - These commands don't interact with LLM, so they don't need base URL configuration

### Test Helpers

The `tests/test-helpers.mjs` file provides utilities for managing test preconditions:

**Key Functions:**

```javascript
// Check if base URL is configured
isBaseUrlConfigured()

// Skip test if base URL is not configured (with warning)
skipIfNoBaseUrl(testContext, customMessage?)

// Get list of missing environment variables
getMissingEnvVars()

// Check if all required environment variables are configured
isFullyConfigured()

// Print configuration status for debugging
printConfigStatus()
```

**Usage Example:**

```javascript
import { describe, it, before } from 'node:test';
import { skipIfNoBaseUrl } from './test-helpers.mjs';

describe('My Test Suite', () => {
  before(() => {
    if (skipIfNoBaseUrl()) return;
    // ... setup code
  });

  it('should do something', () => {
    if (skipIfNoBaseUrl()) return;
    // ... test code
  });
});
```

### Environment Variable Requirements

Tests that interact with LLM agents require one of:
- `CODEMIE_BASE_URL`
- `ANTHROPIC_BASE_URL`
- `OPENAI_BASE_URL`

If these are not set, tests will be **skipped with a warning** instead of failing.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test file
node --test tests/agent-direct.test.mjs

# Run tests without base URL (will skip LLM tests)
unset CODEMIE_BASE_URL ANTHROPIC_BASE_URL OPENAI_BASE_URL
npm test

# Run tests with debug output
CODEMIE_DEBUG=true npm test
```

### Writing New Tests

**For tests requiring LLM interaction:**

1. Import test helpers: `import { skipIfNoBaseUrl } from './test-helpers.mjs'`
2. Add skip checks to `before()` hooks: `before(() => { if (skipIfNoBaseUrl()) return; ... })`
3. Add skip checks to each test: `it('test name', () => { if (skipIfNoBaseUrl()) return; ... })`

**For tests NOT requiring LLM interaction:**

1. No need to import or use test helpers
2. Tests will run regardless of environment configuration

### Test Best Practices

- **Always build before testing**: Run `npm run build` to ensure dist/ is up to date
- **Use descriptive test names**: Clearly state what is being tested
- **Clean up resources**: Use `after()` hooks to dispose of resources (agents, MCP tools, etc.)
- **Test isolation**: Each test should be independent and not rely on state from other tests
- **Mock external dependencies**: When possible, avoid hitting real external services
- **Handle async properly**: Use `async/await` for asynchronous operations

## Debugging

Enable debug mode to see detailed execution:

```bash
export CODEMIE_DEBUG=true
codemie-code
```

This shows:
- Tool initialization counts
- LLM request/response details
- File operation details
- Error stack traces

## Important Notes

### Module System
- Uses ES modules (`"module": "NodeNext"`)
- Import paths use `.js` extensions even for `.ts` files
- Example: `import { logger } from '../utils/logger.js'`

### TypeScript Configuration
- Strict mode enabled
- Declaration maps for debugging
- Output to `dist/` directory
- Source maps enabled

### LangChain Version
- Uses LangChain 1.x ecosystem
- `@langchain/core` for base types
- `@langchain/langgraph` for agent creation
- `@langchain/openai` for ChatOpenAI model

### Not a Git Repository
- This directory is NOT initialized as a git repository
- It's a package within a larger monorepo structure

## Build Process

The build process (`npm run build`):
1. Compiles TypeScript from `src/` to `dist/`
2. Copies `src/data/tips.json` to `dist/data/`
3. Generates declaration files (`.d.ts`)
4. Generates source maps

## Common Patterns & Utilities

### Configuration Loading
See `src/code/config.ts` and `src/utils/env-mapper.ts` for how configuration is loaded with fallbacks.

### Logging
Use the shared logger from `src/utils/logger.ts`:
```typescript
import { logger } from '../utils/logger';

logger.info('Information message');
logger.success('Success message');
logger.error('Error message');
logger.debug('Debug message');  // Only shown when CODEMIE_DEBUG=true
```

### Process Execution
Use utilities from `src/utils/exec.ts` for running commands.

### Tips System
Loading tips are displayed during initialization from `src/data/tips.json`.

## Best Practices

1. **Modular Design**: Each component should have clear separation of concerns
2. **Error Handling**: Always handle errors gracefully with user-friendly messages
3. **Security**: Validate all paths and commands before execution
4. **Reusability**: Utilize shared utilities from `src/utils/`
5. **Documentation**: Provide comprehensive JSDoc comments for all public methods
6. **TypeScript**: Use proper types throughout, avoid `any` when possible
7. **Testing**: Write tests for new functionality when requested
8. **Async/Await**: Handle async operations properly with try-catch

## Troubleshooting

### Issue: Command not found after installation
**Solution**: Re-link the package
```bash
npm link
which codemie
which codemie-code
```

### Issue: TypeScript compilation errors
**Solution**: Clean build
```bash
rm -rf dist/
npm run build
```

### Issue: Import errors
**Solution**: Check import paths use `.js` extensions and are correct

### Issue: Environment variables not loaded
**Solution**: Check variable names match the priority order and verify with:
```bash
echo $ANTHROPIC_BASE_URL
echo $AI_BASE_URL
codemie doctor
```

## Support

For questions or issues:
- Review existing implementations in `src/`
- Check test examples in `tests/`
- Consult utilities in `src/utils/`
- Read comprehensive `README.md`
