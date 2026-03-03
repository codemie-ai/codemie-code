# Plugin System

The Plugin System allows you to extend CodeMie Code with reusable packages of skills, commands, agents, hooks, and MCP servers. Plugins follow the Anthropic `.claude-plugin/plugin.json` format and are discovered automatically from multiple locations.

## Table of Contents

- [Overview](#overview)
- [Key Concepts](#key-concepts)
- [Plugin Manifest Format](#plugin-manifest-format)
- [Discovery Locations](#discovery-locations)
- [Plugin Components](#plugin-components)
- [CLI Commands](#cli-commands)
- [Configuration](#configuration)
- [Creating a Plugin](#creating-a-plugin)
- [Best Practices](#best-practices)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Resources](#resources)

## Overview

Plugins allow you to:

- **Bundle components** — Package skills, commands, agents, hooks, and MCP servers into a single distributable unit
- **Namespace everything** — All components are prefixed with `plugin-name:` to avoid conflicts
- **Distribute and share** — Copy plugin directories, share via git repos, or install from local paths
- **Manage via CLI** — Install, uninstall, enable, and disable plugins with `codemie plugin` commands
- **Discover automatically** — Plugins are found from project, user, and CLI-specified locations

## Key Concepts

### Plugins vs Skills vs Hooks

| Feature | Plugins | Skills | Hooks |
|---------|---------|--------|-------|
| **Purpose** | Bundle & distribute components | Knowledge injection | Execution control |
| **Contains** | Skills, commands, agents, hooks, MCP | Markdown guidelines | Shell/LLM scripts |
| **Scope** | Multi-component packages | Single knowledge unit | Single event handler |
| **Namespace** | `plugin-name:component-name` | Flat name | Per-event matchers |
| **Distribution** | Directory with manifest | Single SKILL.md | Config JSON |

### Namespacing

All plugin components are automatically namespaced with the plugin name to prevent conflicts:

```
plugin-name:skill-name
plugin-name:command-name
plugin-name:agent-name
plugin-name:mcp-server-name
```

For example, a plugin named `security-tools` with a skill named `code-review` becomes `security-tools:code-review`.

### The `${CLAUDE_PLUGIN_ROOT}` Variable

Plugin manifests and configuration files support the `${CLAUDE_PLUGIN_ROOT}` placeholder, which is replaced with the absolute path to the plugin's root directory at load time. This allows plugins to reference their own files without hardcoding paths:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/check-command.sh"
          }
        ]
      }
    ]
  }
}
```

## Plugin Manifest Format

Each plugin is defined by a manifest file located at `.claude-plugin/plugin.json` or `plugin.json` in the plugin root directory. The `.claude-plugin/plugin.json` path is checked first.

### Example Manifest

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "A useful plugin for CodeMie Code",
  "author": {
    "name": "Your Name",
    "email": "you@example.com",
    "url": "https://github.com/yourname"
  },
  "homepage": "https://github.com/yourname/my-plugin",
  "repository": "https://github.com/yourname/my-plugin",
  "license": "MIT",
  "keywords": ["codemie", "security", "tooling"],
  "skills": "skills",
  "commands": "commands",
  "agents": "agents",
  "hooks": "hooks/hooks.json",
  "mcpServers": ".mcp.json"
}
```

### Field Reference

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | Yes | `string` | Plugin name (kebab-case, validated against `^[a-z0-9]+(-[a-z0-9]+)*$`) |
| `version` | No | `string` | Semantic version (e.g., `1.0.0`) |
| `description` | No | `string` | Human-readable description |
| `author` | No | `object` | Author info: `{ name, email?, url? }` |
| `homepage` | No | `string` | Plugin homepage URL |
| `repository` | No | `string` | Source repository URL |
| `license` | No | `string` | License identifier (e.g., `MIT`, `Apache-2.0`) |
| `keywords` | No | `string[]` | Search keywords |
| `skills` | No | `string \| string[]` | Skills directory path override(s), relative to plugin root |
| `commands` | No | `string \| string[]` | Commands directory path override(s), relative to plugin root |
| `agents` | No | `string \| string[]` | Agents directory path override(s), relative to plugin root |
| `hooks` | No | `string \| string[] \| object` | Hooks config path(s), or inline hooks configuration |
| `mcpServers` | No | `string \| string[] \| object` | MCP servers config path(s), or inline MCP configuration |
| `lspServers` | No | `string \| string[] \| object` | LSP servers config path(s), or inline LSP configuration |
| `outputStyles` | No | `string \| string[]` | Output style path overrides |

### Name Validation

Plugin names must be **kebab-case**: lowercase alphanumeric characters with hyphens.

- `my-plugin` — valid
- `security-tools` — valid
- `a1` — valid
- `MyPlugin` — invalid (uppercase)
- `my_plugin` — invalid (underscores)
- `my plugin` — invalid (spaces)

### Path Fields

All path fields (`skills`, `commands`, `agents`, `hooks`, `mcpServers`, `outputStyles`) must use **relative paths**. Absolute paths will cause a validation error.

```json
{
  "skills": "src/skills",
  "commands": ["commands", "extra-commands"]
}
```

### No Manifest Fallback

If no manifest file is found, the plugin name is derived from the directory name by converting it to kebab-case (lowercase, replacing spaces/underscores with hyphens). All other fields default to their standard values.

## Discovery Locations

Plugins are discovered from multiple sources in priority order. When the same plugin name exists in multiple locations, the highest-priority source wins.

### 1. CLI Flag Directories (Priority: 400)

```
--plugin-dir /path/to/my-plugin
```

**Source**: `local`
**When to use**: Testing plugins during development or one-off usage.

### 2. Project Plugins (Priority: 300)

```
your-project/
└── .codemie/
    └── plugins/
        ├── security-tools/
        │   ├── .claude-plugin/
        │   │   └── plugin.json
        │   └── skills/
        │       └── ...
        └── team-conventions/
            ├── plugin.json
            └── ...
```

**Source**: `project`
**When to use**: Team-shared plugins committed to the repository.

### 3. User Cache (Priority: 200)

```
~/.codemie/
└── plugins/
    └── cache/
        ├── my-tools/
        │   ├── .claude-plugin/
        │   │   └── plugin.json
        │   └── ...
        └── code-quality/
            └── ...
```

**Source**: `user`
**When to use**: Personal plugins installed via `codemie plugin install`.

### 4. Config Directories (Priority: 100)

Directories listed in the `plugins.dirs` setting (see [Configuration](#configuration)).

**Source**: `local`
**When to use**: Managed plugin directories from configuration.

### Deduplication

When the same plugin name is found in multiple sources, the highest-priority source wins. Lower-priority duplicates are silently skipped. For example, a project plugin always takes precedence over a user-cached plugin with the same name.

## Plugin Components

Plugins can contain any combination of the following component types:

### Summary

| Component | Default Directory | File Pattern | Depth | Name Source |
|-----------|-------------------|--------------|-------|-------------|
| Skills | `skills/` | `**/SKILL.md` | 3 levels | Frontmatter `name` or parent directory name |
| Commands | `commands/` | `*.md` | 1 level | Frontmatter `name` or filename (without `.md`) |
| Agents | `agents/` | `*.md` | 1 level | Frontmatter `name` or filename (without `.md`) |
| Hooks | `hooks/hooks.json` | JSON config | — | Event-based matchers |
| MCP Servers | `.mcp.json` | JSON config | — | Server name from config keys |

### Skills

Skills are markdown files with YAML frontmatter discovered from the `skills/` directory (or custom path from manifest).

```
my-plugin/
└── skills/
    ├── code-review/
    │   └── SKILL.md
    └── testing-patterns/
        └── SKILL.md
```

- File pattern: `**/SKILL.md` (searched up to 3 levels deep)
- Namespaced as: `my-plugin:code-review`, `my-plugin:testing-patterns`
- See [Skills System](./SKILLS.md) for the SKILL.md format

### Commands

Commands are markdown files discovered from the `commands/` directory.

```
my-plugin/
└── commands/
    ├── lint.md
    └── deploy.md
```

- File pattern: `*.md` (1 level deep only)
- Namespaced as: `my-plugin:lint`, `my-plugin:deploy`

### Agents

Agents are markdown files discovered from the `agents/` directory.

```
my-plugin/
└── agents/
    ├── reviewer.md
    └── planner.md
```

- File pattern: `*.md` (1 level deep only)
- Namespaced as: `my-plugin:reviewer`, `my-plugin:planner`

### Hooks

Hooks can be specified as a file path or inline in the manifest.

**File-based** (default: `hooks/hooks.json`):

```
my-plugin/
└── hooks/
    └── hooks.json
```

**Inline in manifest**:

```json
{
  "name": "my-plugin",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/validate.sh"
          }
        ]
      }
    ]
  }
}
```

Plugin hooks are merged with profile hooks — plugin hooks are appended after profile hooks (lower priority). See [Hooks System](./HOOKS.md) for the hooks configuration format.

### MCP Servers

MCP server configurations can be specified as a file path or inline in the manifest.

**File-based** (default: `.mcp.json`):

```
my-plugin/
└── .mcp.json
```

**Example `.mcp.json`**:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${CLAUDE_PLUGIN_ROOT}"]
    }
  }
}
```

MCP server names are automatically namespaced: `filesystem` becomes `my-plugin:filesystem`.

**Inline in manifest**:

```json
{
  "name": "my-plugin",
  "mcpServers": {
    "mcpServers": {
      "my-server": {
        "command": "node",
        "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"]
      }
    }
  }
}
```

## CLI Commands

### `codemie plugin list`

List all discovered plugins and their status.

```bash
codemie plugin list [--cwd <path>]
```

**Options:**
- `--cwd <path>` — Working directory for project plugin discovery (default: current directory)

**Output columns:** Name, Version, Description, Source, Status, Components

### `codemie plugin install`

Install a plugin from a local path into the user cache.

```bash
codemie plugin install <path>
```

Copies the plugin directory to `~/.codemie/plugins/cache/<plugin-name>/`. If the same version is already cached, the copy is skipped.

### `codemie plugin uninstall`

Remove a plugin from the user cache.

```bash
codemie plugin uninstall <name>
```

### `codemie plugin enable`

Enable a previously disabled plugin (removes it from the disabled list).

```bash
codemie plugin enable <name>
```

### `codemie plugin disable`

Disable a plugin without removing it.

```bash
codemie plugin disable <name>
```

## Configuration

Plugin settings can be managed through two mechanisms:

### Plugin Settings File

`~/.codemie/plugins.json`:

```json
{
  "enabled": ["plugin-a", "plugin-b"],
  "disabled": ["plugin-c"],
  "dirs": ["/path/to/extra/plugins"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | `string[]` | Explicitly enabled plugin names. If present, only these plugins are enabled. |
| `disabled` | `string[]` | Explicitly disabled plugin names. Takes precedence over `enabled`. |
| `dirs` | `string[]` | Additional plugin directories to scan (Priority: 100). |

### Profile-Level Configuration

In `~/.codemie/codemie-cli.config.json`, plugins can also be configured per profile:

```json
{
  "profiles": {
    "default": {
      "provider": "openai",
      "plugins": {
        "enabled": ["security-tools"],
        "disabled": ["experimental-plugin"],
        "dirs": ["/custom/plugins"]
      }
    }
  }
}
```

### Enable/Disable Logic

1. If a plugin name is in the `disabled` list, it is **always disabled** (highest precedence)
2. If an `enabled` list exists, only plugins in that list are enabled
3. If no `enabled` list exists, all plugins are **enabled by default**

## Creating a Plugin

### Step 1: Create Directory Structure

```bash
mkdir -p my-plugin/.claude-plugin
mkdir -p my-plugin/skills/my-skill
mkdir -p my-plugin/commands
mkdir -p my-plugin/hooks
```

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── my-skill/
│       └── SKILL.md
├── commands/
│   └── review.md
└── hooks/
    └── hooks.json
```

### Step 2: Write plugin.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin for CodeMie Code",
  "author": {
    "name": "Your Name"
  },
  "license": "MIT"
}
```

### Step 3: Add Components

**Add a skill** (`skills/my-skill/SKILL.md`):

```markdown
---
name: my-skill
description: Custom guidelines for my team
---

# My Skill

Guidelines and knowledge here...
```

**Add a command** (`commands/review.md`):

```markdown
---
name: review
description: Run a code review checklist
---

# Code Review

Review the current changes against these criteria:
- Security: No hardcoded secrets
- Performance: No N+1 queries
- Style: Follows project conventions
```

**Add hooks** (`hooks/hooks.json`):

```json
{
  "PostToolUse": [
    {
      "matcher": "Write|Edit",
      "hooks": [
        {
          "type": "command",
          "command": "${CLAUDE_PLUGIN_ROOT}/scripts/lint-check.sh"
        }
      ]
    }
  ]
}
```

### Step 4: Test Locally

**Option A — CLI flag:**
```bash
codemie-code --plugin-dir ./my-plugin
```

**Option B — Install to cache:**
```bash
codemie plugin install ./my-plugin
codemie plugin list
```

**Option C — Project directory:**
```bash
cp -r my-plugin .codemie/plugins/my-plugin
```

### Step 5: Validate with Debug Logging

```bash
CODEMIE_DEBUG=true codemie-code
```

Check logs for plugin discovery:
```
[DEBUG] [plugin] Resolved 1 plugins (1 enabled)
[DEBUG] [plugin] Loaded "my-plugin": 1 skills, 1 commands, 0 agents
```

## Best Practices

### Structure

**Do:**
- Use `.claude-plugin/plugin.json` for the manifest (preferred over `plugin.json`)
- Keep the directory structure flat and predictable
- Include a `version` field for cache management
- Add a `description` for discoverability

**Don't:**
- Use absolute paths in the manifest
- Nest plugins inside other plugins
- Include `node_modules/` or `.git/` in distributed plugins
- Use uppercase or underscores in the plugin name

### Naming

**Do:**
- Use descriptive kebab-case names: `security-tools`, `team-conventions`
- Prefix with your organization name for uniqueness: `acme-security-hooks`
- Name skills and commands descriptively: `code-review`, `deploy-checklist`

**Don't:**
- Use generic names like `plugin` or `tools`
- Use names that conflict with built-in components

### Distribution

**Do:**
- Include a README.md in the plugin root
- Document what the plugin provides and how to use it
- Use `${CLAUDE_PLUGIN_ROOT}` for all internal path references
- Specify a license

**Don't:**
- Include sensitive information (credentials, API keys)
- Depend on absolute file paths or specific system configurations
- Include large binary files

## Examples

### Example 1: Simple Skill Plugin

A plugin that provides TypeScript coding standards.

```
typescript-standards/
├── .claude-plugin/
│   └── plugin.json
└── skills/
    └── typescript/
        └── SKILL.md
```

**`.claude-plugin/plugin.json`**:
```json
{
  "name": "typescript-standards",
  "version": "1.0.0",
  "description": "TypeScript coding standards and best practices"
}
```

**`skills/typescript/SKILL.md`**:
```markdown
---
name: typescript
description: TypeScript coding standards
---

# TypeScript Standards

## Import Conventions
- Always use .js extensions in imports
- Prefer named imports over default exports

## Type Safety
- Explicit return types on exported functions
- Avoid `any` — use `unknown` when type is uncertain
- Prefer `interface` over `type` for object shapes
```

### Example 2: Security Hooks Plugin

A plugin that validates tool usage with shell scripts, using `${CLAUDE_PLUGIN_ROOT}` for portable paths.

```
security-hooks/
├── .claude-plugin/
│   └── plugin.json
├── hooks/
│   └── hooks.json
└── scripts/
    └── validate-bash.sh
```

**`.claude-plugin/plugin.json`**:
```json
{
  "name": "security-hooks",
  "version": "1.0.0",
  "description": "Security validation hooks for safe agent execution"
}
```

**`hooks/hooks.json`**:
```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "${CLAUDE_PLUGIN_ROOT}/scripts/validate-bash.sh",
          "timeout": 5000
        }
      ]
    }
  ]
}
```

**`scripts/validate-bash.sh`**:
```bash
#!/bin/bash
COMMAND=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.tool_input.command')

# Block dangerous patterns
if [[ "$COMMAND" =~ "rm -rf /" ]] || [[ "$COMMAND" =~ "dd if=" ]]; then
  echo '{"decision": "block", "reason": "Dangerous command blocked by security-hooks plugin"}'
  exit 0
fi

echo '{"decision": "allow"}'
```

### Example 3: Full-Featured Plugin

A comprehensive plugin with skills, commands, hooks, and an MCP server.

```
full-featured/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── code-review/
│   │   └── SKILL.md
│   └── testing-patterns/
│       └── SKILL.md
├── commands/
│   ├── review.md
│   └── deploy-checklist.md
├── agents/
│   └── reviewer.md
├── hooks/
│   └── hooks.json
├── .mcp.json
└── scripts/
    └── post-write-lint.sh
```

**`.claude-plugin/plugin.json`**:
```json
{
  "name": "full-featured",
  "version": "2.0.0",
  "description": "Full-featured plugin with all component types",
  "author": {
    "name": "Team Name",
    "url": "https://github.com/team"
  },
  "license": "MIT",
  "keywords": ["code-review", "testing", "linting"]
}
```

**`.mcp.json`**:
```json
{
  "mcpServers": {
    "linter": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/linter-server.js"],
      "env": {
        "CONFIG_PATH": "${CLAUDE_PLUGIN_ROOT}/config/lint.json"
      }
    }
  }
}
```

After loading, the MCP server is accessible as `full-featured:linter`.

## Troubleshooting

### Plugin Not Discovered

1. **Check location**: Verify the plugin is in a discovery location:
   ```bash
   ls .codemie/plugins/          # Project plugins
   ls ~/.codemie/plugins/cache/  # User cache
   ```

2. **Check manifest**: Ensure a valid manifest exists:
   ```bash
   cat .codemie/plugins/my-plugin/.claude-plugin/plugin.json
   # or
   cat .codemie/plugins/my-plugin/plugin.json
   ```

3. **Check plugin name**: Name must be kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`)

4. **Enable debug logging**:
   ```bash
   CODEMIE_DEBUG=true codemie-code
   ```
   Look for: `[plugin] Resolved N plugins`

### Plugin Disabled

1. **Check settings**:
   ```bash
   cat ~/.codemie/plugins.json
   ```

2. **Look for the plugin in the disabled list**

3. **Enable it**:
   ```bash
   codemie plugin enable my-plugin
   ```

### Components Not Loading

1. **Check directory structure**: Ensure files are in the correct directories (`skills/`, `commands/`, `agents/`)

2. **Check file patterns**:
   - Skills: Must be named `SKILL.md` (case-insensitive)
   - Commands and agents: Must be `*.md` files

3. **Check depth limits**:
   - Skills: Up to 3 levels deep
   - Commands and agents: 1 level deep only

4. **Verify frontmatter**: Skills and commands with frontmatter must have valid YAML:
   ```markdown
   ---
   name: my-component
   description: A description
   ---
   ```

### Manifest Parse Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Invalid JSON in plugin manifest` | Malformed JSON | Validate with `jq . plugin.json` |
| `Plugin manifest must have a "name" field` | Missing name | Add `"name": "my-plugin"` |
| `Plugin name must be kebab-case` | Invalid name format | Use lowercase with hyphens only |
| `must use relative paths` | Absolute path in manifest | Remove leading `/` or `\` |

## FAQ

**Q: Can I have multiple plugins with the same name?**
A: Yes, but only the highest-priority one will be loaded. The priority order is: CLI flag (400) > project (300) > user cache (200) > config dirs (100).

**Q: Do I need a plugin.json manifest?**
A: No. If no manifest is found, the plugin name is derived from the directory name. However, a manifest is recommended for version tracking and component path customization.

**Q: Can plugin hooks override profile hooks?**
A: Plugin hooks are merged with profile hooks, with plugin hooks appended after profile hooks (lower priority). The standard hook priority system (`block` > `deny` > `allow`) still applies.

**Q: How do I update an installed plugin?**
A: Run `codemie plugin install <path>` again. If the version has changed, the cached copy will be replaced. For the same version, the install is skipped.

**Q: Can I use plugins with any agent?**
A: Yes. Plugins are loaded at the CLI level and their components are injected into whichever agent is running. Skills can optionally filter by agent using the `compatibility.agents` frontmatter field.

**Q: How do I share a plugin with my team?**
A: Commit the plugin to `.codemie/plugins/<plugin-name>/` in your repository. It will be automatically discovered as a project-level plugin for everyone on the team.

## Resources

- **Source code**: `src/plugins/`
- **Core types**: `src/plugins/core/types.ts`
- **Manifest parser**: `src/plugins/core/manifest-parser.ts`
- **Plugin resolver**: `src/plugins/core/plugin-resolver.ts`
- **CLI commands**: `src/cli/commands/plugin.ts`
- **Component loaders**: `src/plugins/loaders/`
- **Related docs**: [Skills System](./SKILLS.md) | [Hooks System](./HOOKS.md) | [Commands](./COMMANDS.md)

---

**Tip**: Start by placing plugins in `.codemie/plugins/` for project-level sharing, then use `codemie plugin install` for personal plugins you want available across all projects.
