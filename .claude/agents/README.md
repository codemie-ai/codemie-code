# Specialized Agents

This directory contains specialized subagent prompts for complex, multi-step workflows in the CodeMie Code project.

## What Are Subagents?

Subagents are specialized AI assistants with focused system prompts for specific tasks. Each agent has a dedicated markdown file containing:
- Role and responsibilities
- Available tools and capabilities
- Step-by-step workflow
- Error handling strategies
- Best practices and examples

## Available Agents

### 🚀 Release Manager (`release-manager.md`)

**Purpose:** Automate the complete release process from change analysis to npm publication.

**Capabilities:**
- Analyze git history and categorize changes
- Generate structured release notes (Keep a Changelog format)
- Update package version (semver)
- Create git tags and commits
- Create GitHub releases
- Trigger npm publish workflows

**Trigger Phrases:**
- "Release version 0.0.2"
- "Create a new release"
- "Release a patch/minor/major version"
- "Use release manager to..."
- "Prepare a release"

**Example:**
```
User: "Release version 0.1.0"
→ Agent analyzes changes, generates notes, creates release
```

## How to Use Subagents

### Method 1: Natural Language (Recommended)

Simply use the trigger phrases in your conversation with Claude:

```
You: "Release version 0.2.0"
Claude: [Reads release-manager.md and executes the workflow]
```

### Method 2: Explicit Invocation

Reference the agent directly:

```
You: "Use the release manager to create version 0.2.0"
Claude: [Loads and follows release-manager.md instructions]
```

### Method 3: Manual Execution

Read the agent prompt yourself and ask Claude to follow it:

```
You: "Follow the release-manager agent workflow for version 0.2.0"
Claude: [Executes according to the documented workflow]
```

## How Subagents Work

When you trigger a subagent:

1. **Claude identifies** the intent matches a subagent
2. **Reads the prompt** from `.claude/agents/{agent-name}.md`
3. **Follows the workflow** step-by-step as documented
4. **Tracks progress** using TodoWrite tool
5. **Reports results** when complete or if intervention needed

## Creating Your Own Subagent

### Step 1: Define the Agent

Create a new markdown file: `.claude/agents/{role}-{function}.md`

Example: `code-reviewer.md`, `test-generator.md`, `security-auditor.md`

### Step 2: Write the System Prompt

Use this template:

```markdown
# {Agent Name}

You are a specialized {role} agent for the CodeMie Code project. Your job is to {primary goal}.

## Your Capabilities

You have access to these tools:
- Tool 1: Purpose
- Tool 2: Purpose

## Workflow

When the user requests {action}, follow these steps:

### Step 1: {Step Name}
[Detailed instructions]

### Step 2: {Step Name}
[Detailed instructions]

## Error Handling

[How to handle failures]

## Best Practices

[Guidelines for the agent]

## Examples

[Example interactions]
```

### Step 3: Document Trigger Phrases

Add your agent to this README with:
- Purpose description
- Capabilities list
- Trigger phrases
- Example usage

### Step 4: Update CLAUDE.md

Add your agent to the "Specialized Agents" section in CLAUDE.md so Claude knows when to invoke it.

## Agent Design Best Practices

### 1. Clear Workflow
- Break complex tasks into numbered steps
- Each step should be atomic and verifiable
- Use checkboxes for validation criteria

### 2. Error Handling
- Anticipate failure points
- Provide clear error messages
- Suggest recovery actions
- Allow graceful fallbacks

### 3. User Confirmation
- Ask before destructive operations
- Show previews of changes
- Allow dry-run modes
- Support rollback if possible

### 4. Progress Tracking
- Use TodoWrite for multi-step workflows
- Report what you're doing in real-time
- Show completion status clearly

### 5. Transparency
- Log commands being executed
- Explain why each step is necessary
- Show intermediate results
- Provide links and references

### 6. Flexibility
- Support multiple input formats
- Handle edge cases gracefully
- Allow customization via config
- Provide manual fallback options

## Naming Conventions

**File naming:** `{role}-{function}.md`

Examples:
- ✅ `release-manager.md`
- ✅ `code-reviewer.md`
- ✅ `test-generator.md`
- ✅ `security-auditor.md`
- ✅ `dependency-updater.md`
- ❌ `release.md` (too generic)
- ❌ `manager.md` (unclear purpose)
- ❌ `agent1.md` (meaningless)

**Role-function pattern:**
- **Role**: What the agent is (manager, reviewer, generator, auditor)
- **Function**: What domain it works in (release, code, test, security)

## Agent Communication

### Input Formats

Agents should accept multiple input styles:

```
# Explicit
"Release version 0.2.0"

# Semantic
"Release a minor version"

# Contextual
"Create a new release"

# With options
"Release 0.2.0 as a beta"
```

### Output Format

Agents should provide structured output:

```
🎯 Task: [What the agent is doing]

📊 Status: [Current progress]

✅ Completed:
- Step 1
- Step 2

⏳ In Progress:
- Step 3

❌ Failed:
- Step 4 (reason: ...)

🔜 Pending:
- Step 5
- Step 6
```

## Future Agent Ideas

Here are some agents we might create in the future:

- **`code-reviewer.md`**: Automated code review with best practices
- **`test-generator.md`**: Generate tests for new code
- **`security-auditor.md`**: Scan for security vulnerabilities
- **`dependency-updater.md`**: Update and test dependencies
- **`migration-helper.md`**: Assist with breaking change migrations
- **`documentation-writer.md`**: Generate comprehensive docs
- **`performance-analyzer.md`**: Profile and optimize code
- **`changelog-maintainer.md`**: Keep CHANGELOG.md up to date

## Integration with CI/CD

Subagent workflows can be extracted into GitHub Actions:

```yaml
# .github/workflows/release.yml
name: Release
on:
  workflow_dispatch:
    inputs:
      version:
        required: true

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      # Follow steps from rm.md
      - name: Analyze Changes
        run: ...
      - name: Generate Notes
        run: ...
      - name: Create Release
        run: ...
```

This allows both manual (via Claude) and automated (via CI) releases following the same workflow.

## Contributing

When adding a new agent:

1. Create the agent file in `.claude/agents/`
2. Follow the template and best practices
3. Add documentation to this README
4. Update CLAUDE.md with trigger phrases
5. Test the agent with real scenarios
6. Commit with message: `feat: add {agent-name} subagent`

## Support

For questions about subagents:
- Review existing agents as examples
- Check CLAUDE.md for integration details
- Consult the main README.md for project context
- Test iteratively with dry runs

---

**Remember:** Subagents are here to make complex workflows simple, safe, and repeatable!
