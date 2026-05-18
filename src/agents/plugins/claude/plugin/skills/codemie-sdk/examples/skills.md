# Skills Examples

## List

```bash
# Default list (first 10)
codemie sdk skills list

# Paginate
codemie sdk skills list --page 2 --per-page 25

# Filter by scope
codemie sdk skills list --scope marketplace
codemie sdk skills list --scope project
codemie sdk skills list --scope project_with_marketplace

# JSON output
codemie sdk skills list --json
```

**`--scope` values:** `marketplace`, `project`, `project_with_marketplace` (default returns all accessible)

**List columns:** ID, Name, Project, Visibility

**JSON fields (list):** `id`, `name`, `project`, `visibility`, `description`, `created_by`, `categories`, `createdDate`, `updatedDate`, `is_attached`, `assistants_count`, `user_abilities`, `unique_likes_count`, `unique_dislikes_count`

## Get

```bash
codemie sdk skills get 3d5b188f-185b-48df-b4b3-e608e4efb1ad
codemie sdk skills get 3d5b188f-185b-48df-b4b3-e608e4efb1ad --json
```

**Additional fields in get:** `content` (full skill markdown), `toolkits`, `mcp_servers`

## Create

```bash
# Minimal required fields
codemie sdk skills create --data '{
  "name": "my-skill",
  "description": "Does something useful for the team.",
  "content": "# My Skill\n\nInstructions here...",
  "project": "MyProject"
}'

# Full example from file
codemie sdk skills create --json skill.json
```

**Field reference:**

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | ✅ | string | Kebab-case identifier, 3–64 chars (e.g. `"my-skill"`) |
| `description` | ✅ | string | 10–1000 chars |
| `content` | ✅ | string | Markdown skill instructions, minimum 100 chars |
| `project` | ✅ | string | Project to create the skill in |
| `visibility` | — | string | `"private"` (default), `"project"`, or `"public"` |
| `categories` | — | string[] | Max 3 category values (use `list-categories` to get valid values) |
| `toolkits` | — | array | Integration toolkits |
| `mcp_servers` | — | array | MCP server connections |

**Response:** returns the created `SkillDetail` object including its `id`.

## Update

```bash
codemie sdk skills update 3d5b188f-185b-48df-b4b3-e608e4efb1ad --data '{"description":"Updated description"}'
codemie sdk skills update 3d5b188f-185b-48df-b4b3-e608e4efb1ad --json updates.json
```

All fields are optional on update — only provided fields are changed.

## Delete

```bash
# Always verify before deleting
codemie sdk skills get <id>
codemie sdk skills delete <id>
```

## Import / Export

```bash
# Import a skill from a .md file with YAML frontmatter
codemie sdk skills import ./my-skill.md --project MyProject
codemie sdk skills import ./my-skill.md --project MyProject --visibility project

# Export a skill as markdown (pipe to file to save)
codemie sdk skills export <id>
codemie sdk skills export <id> > my-skill.md
```

The import file must include YAML frontmatter with `name` and `description`:
```markdown
---
name: my-skill
description: What this skill does
---

# Instructions
...
```

## Attach / Detach Skills to Assistants

```bash
# Attach a skill to an assistant
codemie sdk skills attach <assistant-id> <skill-id>

# Detach a skill from an assistant
codemie sdk skills detach <assistant-id> <skill-id>

# List all skills attached to an assistant
codemie sdk skills list-assistant-skills <assistant-id>
codemie sdk skills list-assistant-skills <assistant-id> --json

# Bulk attach one skill to multiple assistants
codemie sdk skills bulk-attach <skill-id> --assistant-ids <id1>,<id2>,<id3>

# List all assistants using a skill
codemie sdk skills get-assistants <skill-id>
codemie sdk skills get-assistants <skill-id> --json
```

## Publish / Unpublish

```bash
# Publish to marketplace (no categories)
codemie sdk skills publish <id>

# Publish with categories (max 3, use values from list-categories)
codemie sdk skills publish <id> --categories development,testing

# Unpublish from marketplace
codemie sdk skills unpublish <id>
```

## Categories

```bash
# List available skill categories (value + label)
codemie sdk skills list-categories
codemie sdk skills list-categories --json
```

Use the `value` field from `list-categories` output when setting `categories` on create/update or publish.

## Reactions

```bash
# Like a skill
codemie sdk skills react <id> --reaction like

# Dislike a skill
codemie sdk skills react <id> --reaction dislike

# Remove all reactions
codemie sdk skills remove-reactions <id>
```

## Users

```bash
# Get users with access to skills
codemie sdk skills get-users
codemie sdk skills get-users --json
```

## Scripting

```bash
# Find skill ID by name
codemie sdk skills list --json | jq -r '.[] | select(.name == "my-skill") | .id'

# List all public skills
codemie sdk skills list --scope marketplace --json | jq -r '.[] | "\(.id) \(.name)"'

# Get skill content
codemie sdk skills get <id> --json | jq -r '.content'

# Create then get new skill ID
codemie sdk skills create --data '{"name":"my-skill","description":"Does X","content":"# My Skill\n\nInstructions...","project":"Eng"}'
ID=$(codemie sdk skills list --json | jq -r '.[] | select(.name == "my-skill") | .id')

# Attach a skill to all assistants in a project
codemie sdk assistants list --projects MyProject --json | jq -r '.[].id' | while read id; do
  codemie sdk skills attach "$id" <skill-id>
done
```
