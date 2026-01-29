# Skills System

The Skills System allows you to inject custom knowledge and guidelines into CodeMie agents through markdown files with YAML frontmatter.

## Overview

**Skills** are markdown files that provide:
- Domain-specific knowledge
- Coding standards and best practices
- Project-specific conventions
- Guidelines for specific tasks or modes

Skills are discovered automatically and injected into the agent's system prompt at initialization.

## Key Concepts

### Skills vs Hooks

| Feature | Skills | Hooks |
|---------|--------|-------|
| **Purpose** | Knowledge injection | Execution control |
| **When** | Agent initialization | Lifecycle events |
| **How** | System prompt | Shell/LLM execution |
| **Scope** | Session-wide | Per-event |

**Use Skills for**: Guidelines, patterns, conventions, domain knowledge
**Use Hooks for**: Permission control, validation, transformations, notifications

## Skill File Format

Skills are defined in `SKILL.md` files with YAML frontmatter:

```markdown
---
name: my-skill
description: Brief description of what this skill provides
version: 1.0.0
author: Your Name
priority: 10
modes:
  - code
  - architect
compatibility:
  agents:
    - codemie-code
---

# Skill Content

Markdown content with guidelines, examples, and best practices.

## Section 1

Your knowledge here...
```

### Frontmatter Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | ✅ | string | Unique skill identifier |
| `description` | ✅ | string | Brief description |
| `version` | ❌ | string | Skill version (semver) |
| `author` | ❌ | string | Skill author |
| `license` | ❌ | string | License (e.g., MIT, Apache-2.0) |
| `modes` | ❌ | array | Modes where skill applies (e.g., code, architect) |
| `compatibility.agents` | ❌ | array | Compatible agent names |
| `compatibility.minVersion` | ❌ | string | Minimum CLI version required |
| `priority` | ❌ | number | Priority within same source (default: 0) |

## Discovery Locations

Skills are discovered from these locations (in priority order):

### 1. Project Skills (Highest Priority)
```
.codemie/skills/
└── my-skill/
    └── SKILL.md
```

**Priority**: 1000 + metadata priority
**When to use**: Project-specific conventions and guidelines

### 2. Mode-Specific Skills (Medium Priority)
```
~/.codemie/skills-code/
└── typescript-patterns/
    └── SKILL.md
```

**Priority**: 500 + metadata priority
**When to use**: Mode-specific knowledge (e.g., architecture vs coding)

### 3. Global Skills (Lowest Priority)
```
~/.codemie/skills/
└── general-coding/
    └── SKILL.md
```

**Priority**: 100 + metadata priority
**When to use**: General guidelines applicable across all projects

## Priority Resolution

Skills with the same name are deduplicated using priority:

1. **Source priority**: project > mode-specific > global
2. **Metadata priority**: Higher `priority` field wins within same source
3. **Final priority**: `SOURCE_BASE + metadata.priority`

Example:
- Project skill with `priority: 5` → **1005**
- Global skill with `priority: 20` → **120**
- Project skill wins (1005 > 120)

## CLI Commands

### List Skills

```bash
# List all skills
codemie skill list

# Filter by mode
codemie skill list --mode code

# Filter by agent
codemie skill list --agent codemie-code

# Custom working directory
codemie skill list --cwd /path/to/project
```

### Validate Skills

```bash
# Validate all skill files
codemie skill validate

# Exits with code 1 if any invalid skills found
```

### Reload Skills

```bash
# Clear cache and force reload
codemie skill reload
```

Skills are reloaded on next agent start.

## Configuration

Enable skills in your profile configuration (`~/.codemie/codemie-cli.config.json`):

```json
{
  "profiles": {
    "default": {
      "provider": "openai",
      "model": "gpt-4",
      "skills": {
        "enabled": true,
        "mode": "code",
        "autoReload": false
      }
    }
  }
}
```

### Configuration Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable/disable skill loading |
| `mode` | string | - | Mode for mode-specific skills |
| `autoReload` | boolean | `false` | Auto-reload on file changes (future) |

## Creating Skills

### Step 1: Create Skill Directory

```bash
# Project-specific
mkdir -p .codemie/skills/my-skill

# Global
mkdir -p ~/.codemie/skills/my-skill
```

### Step 2: Write SKILL.md

```markdown
---
name: my-skill
description: My custom skill
priority: 10
---

# My Skill

Guidelines and knowledge here...

## Example Pattern

\`\`\`typescript
// Example code
\`\`\`

## Best Practices

- Use this pattern
- Avoid that anti-pattern
```

### Step 3: Validate

```bash
codemie skill validate
```

### Step 4: Test

```bash
# Start agent with debug logging
CODEMIE_DEBUG=true codemie-code
```

Check logs for:
```
[DEBUG] Loaded 1 skills:
  - my-skill (project, priority: 1010)
```

## Best Practices

### Skill Content

**Do:**
- ✅ Be specific and actionable
- ✅ Include code examples
- ✅ Explain *why*, not just *what*
- ✅ Use clear section headings
- ✅ Keep focused on one domain/topic

**Don't:**
- ❌ Write generic advice ("write clean code")
- ❌ Duplicate existing documentation
- ❌ Make skills too long (>10KB)
- ❌ Include sensitive information

### Organization

**Project Skills** (`.codemie/skills/`):
- Project-specific conventions
- API patterns for this codebase
- Deployment procedures
- Team workflows

**Mode Skills** (`~/.codemie/skills-{mode}/`):
- Architecture mode: Design patterns, system design
- Code mode: Implementation patterns, testing strategies

**Global Skills** (`~/.codemie/skills/`):
- Language best practices
- Security guidelines
- General coding standards

### Priority Guidelines

Use priority to control precedence within same source:

- `priority: 0` - Default priority
- `priority: 10` - High priority (overrides defaults)
- `priority: -10` - Low priority (fallback)

Example: Project has two TypeScript skills
```yaml
# typescript-basics/SKILL.md
priority: 0  # Default

# typescript-advanced/SKILL.md
priority: 10  # Overrides basics if name conflicts
```

## Examples

### Example 1: TypeScript Standards

```markdown
---
name: typescript-standards
description: TypeScript coding standards
modes:
  - code
---

# TypeScript Standards

## Import Conventions
- Always use .js extensions
- Named imports over default

## Type Safety
- Explicit return types
- Avoid `any`
```

### Example 2: Security Guidelines

```markdown
---
name: security-guidelines
description: Security best practices
priority: 20
compatibility:
  agents:
    - codemie-code
---

# Security Guidelines

## Input Validation
- Sanitize all user input
- Validate file paths

## Logging
- Never log credentials
- Use sanitizeLogArgs()
```

## Troubleshooting

### Skills Not Loading

**Check configuration:**
```bash
cat ~/.codemie/codemie-cli.config.json | grep -A 5 skills
```

Ensure `enabled: true`

**Check discovery:**
```bash
codemie skill list --mode code
```

**Check logs:**
```bash
CODEMIE_DEBUG=true codemie-code
```

Look for:
- `Skills disabled in configuration` → Enable in config
- `Failed to load skills: ...` → Check error message
- `Loaded 0 skills` → Check file locations

### Skill Not Applied

1. **Verify skill is loaded:**
   ```bash
   codemie skill list | grep my-skill
   ```

2. **Check compatibility:**
   - Is agent name correct? (`codemie-code`)
   - Is mode specified and matching?

3. **Check priority:**
   - Is another skill overriding it?
   - Use higher priority value

4. **Reload cache:**
   ```bash
   codemie skill reload
   ```

### Validation Errors

```bash
codemie skill validate
```

Common errors:
- **Missing frontmatter**: File must start with `---`
- **Invalid YAML**: Check syntax
- **Missing required fields**: `name` and `description` required
- **Invalid structure**: Frontmatter must be object (not array)

## Advanced Usage

### Multiple Skills Per Directory

```
.codemie/skills/
├── typescript/
│   └── SKILL.md
├── python/
│   └── SKILL.md
└── security/
    └── SKILL.md
```

All discovered and loaded together.

### Mode-Specific Workflow

1. **Code mode** (`~/.codemie/skills-code/`):
   - Implementation patterns
   - Testing strategies
   - Debugging techniques

2. **Architect mode** (`~/.codemie/skills-architect/`):
   - System design patterns
   - Scalability considerations
   - Technology selection

3. **Both modes** (`~/.codemie/skills/`):
   - Security guidelines
   - General best practices

### Conditional Loading

Skills with `modes` field only load in matching modes:

```yaml
modes:
  - code
  - testing
```

Only loads when `config.skills.mode` is `code` or `testing`.

## Future Enhancements

Planned features:
- ✨ Auto-reload on file changes (`autoReload: true`)
- ✨ Skill versioning and updates
- ✨ Skill marketplace/sharing
- ✨ Skill templates
- ✨ Skill dependencies
- ✨ Skill-specific tools

## FAQ

**Q: How many skills can I load?**
A: No hard limit, but keep total content under ~50KB to avoid prompt size issues.

**Q: Can skills execute code?**
A: No. Skills are read-only markdown for context enhancement only.

**Q: Do skills slow down the agent?**
A: Minimal impact. Skills are loaded once at initialization (cached).

**Q: Can I share skills?**
A: Yes! Skills are plain markdown files. Share via git repos or file sharing.

**Q: What's the difference from CLAUDE.md?**
A: CLAUDE.md is a single project guide. Skills are modular, reusable knowledge units with discovery and priority.

## Resources

- **Example skills**: `.codemie/skills/examples/`
- **Source code**: `src/skills/`
- **CLI commands**: `src/cli/commands/skill.ts`
- **Type definitions**: `src/skills/core/types.ts`

---

**Tip**: Start with project skills in `.codemie/skills/` for quick iteration, then move to global `~/.codemie/skills/` when mature.
