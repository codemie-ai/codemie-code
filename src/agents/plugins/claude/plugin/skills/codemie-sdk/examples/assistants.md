# Assistants Examples

## List

```bash
# Basic list
codemie sdk assistants list

# Search by name
codemie sdk assistants list --search 'Code Review'

# Filter by project
codemie sdk assistants list --projects MyProject

# Marketplace assistants
codemie sdk assistants list --scope marketplace

# JSON output with pagination
codemie sdk assistants list --page 0 --per-page 20 --json

# Full assistant details in list
codemie sdk assistants list --full-response --json
```

**JSON output fields (list):** `id`, `name`, `slug`, `type`, `description`, `shared`, `is_global`, `categories`, `created_by`

## Get

```bash
codemie sdk assistants get bc1a4b75-955c-48a5-b26d-bf702c1fee5d
codemie sdk assistants get bc1a4b75-955c-48a5-b26d-bf702c1fee5d --json
```

**Additional fields in get:** `project`, `llm_model_type`, `system_prompt`, `temperature`, `toolkits`, `skill_ids`

## Create

```bash
# Minimal (required fields only)
codemie sdk assistants create --data '{"name":"My Assistant","project":"MyProject","system_prompt":"You are a helpful assistant."}'

# Full example from file
codemie sdk assistants create --json assistant.json
```

**Field reference:**

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | ✅ | string | Display name of the assistant |
| `project` | ✅ | string | Project to create the assistant in |
| `system_prompt` | ✅ | string | Instruction text that defines the assistant's persona and behavior |
| `description` | — | string | Short description shown in list and marketplace views |
| `icon_url` | — | string | URL to an image used as the assistant's avatar |
| `shared` | — | boolean | `true` = visible to all project members; `false` = private (default) |
| `is_global` | — | boolean | `true` = available across all projects platform-wide |
| `is_react` | — | boolean | Use ReAct (reasoning + acting) agent pattern; requires a model with `react_agent: true` |
| `slug` | — | string | URL-friendly identifier for deep-linking to this assistant |
| `llm_model_type` | — | string | Model `base_name` — if omitted, the platform default is used |
| `temperature` | — | number | Sampling temperature 0.0–1.0; lower = more deterministic outputs |
| `top_p` | — | number | Nucleus sampling 0.0–1.0; use either `temperature` or `top_p`, not both |
| `conversation_starters` | — | string[] | Suggested prompts displayed to users as quick-start buttons |
| `context` | — | array | Datasources attached as knowledge — see schema below |
| `toolkits` | — | array | Integration toolkits (Git, Jira, etc.) — see schema below |
| `mcp_servers` | — | array | MCP server connections for additional tools — see schema below |
| `assistant_ids` | — | string[] | Sub-assistant IDs for orchestration (multi-agent workflows) |
| `prompt_variables` | — | array | Dynamic `{{variable}}` placeholders in the system prompt — see schema below |
| `categories` | — | string[] | Label IDs for marketplace classification (e.g. `["devops", "code-review"]`). You can manage assistants categories via codemie sdk assistant-categories command (get, create, update and so on). Only categories listed via this command can be used in this field |
| `skill_ids` | — | string[] | Built-in platform skill IDs — **not** datasource IDs |
| `skip_integration_validation` | — | boolean | Skip credential validation when attaching toolkits (useful with test credentials) |

**Get available models:**
```bash
codemie sdk llm list --json | jq -r '.[] | "\(.base_name) (\(.label))"'
```

**`context` entry schema** — attach datasources:
```json
{ "id": "<datasource-id>", "context_type": "knowledge_base", "name": "<datasource-name>" }
```
Valid `context_type`: `"knowledge_base"` (file/confluence/jira/google), `"code"` (code repository).
```bash
# Get datasource IDs
codemie sdk datasources list --projects MyProject --json | jq -r '.[] | "\(.id) \(.name)"'
```

**`toolkits` entry schema** — get the exact structure from the platform:
```bash
codemie sdk assistants get-tools --json
```
Then pick the desired toolkit object(s) and include them in your payload. Each entry looks like:
```json
{
  "toolkit": "Jira",
  "label": "Jira",
  "settings_config": false,
  "is_external": false,
  "tools": [
    { "name": "jira_get_issue", "settings_config": false },
    { "name": "jira_search", "settings_config": false }
  ]
}
```

**`mcp_servers` entry schema:**
```json
{
  "name": "my-mcp-server",
  "description": "Custom tool server",
  "enabled": true,
  "config": {
    "url": "https://mcp.example.com",
    "auth_token": "<optional-token>",
    "env": {}
  },
  "tools_tokens_size_limit": 4096
}
```

**`assistant_ids`** — for multi-agent orchestration, reference other assistant IDs:
```bash
codemie sdk assistants list --projects MyProject --json | jq -r '.[] | "\(.id) \(.name)"'
```

**`prompt_variables` entry schema:**
```json
{ "key": "language", "description": "Programming language to focus on", "default_value": "TypeScript" }
```
Reference in system prompt as `{{language}}`.

**Full `assistant.json` example:**
```json
{
  "name": "Code Reviewer",
  "project": "Engineering",
  "description": "Reviews code for best practices and security",
  "system_prompt": "You are a {{language}} code review assistant. Focus on {{focus_area}}.",
  "shared": true,
  "llm_model_type": "claude-3-7-sonnet",
  "temperature": 0.3,
  "conversation_starters": [
    "Review my latest PR",
    "Check this function for security issues"
  ],
  "context": [
    { "id": "<datasource-id>", "context_type": "knowledge_base", "name": "Engineering Docs" }
  ],
  "toolkits": [
    {
      "toolkit": "Jira",
      "label": "Jira",
      "settings_config": false,
      "is_external": false,
      "tools": [
        { "name": "jira_get_issue", "settings_config": false },
        { "name": "jira_search", "settings_config": false }
      ]
    }
  ],
  "prompt_variables": [
    { "key": "language", "description": "Primary language", "default_value": "TypeScript" },
    { "key": "focus_area", "description": "Review focus", "default_value": "security and performance" }
  ],
  "categories": ["code-review", "engineering"]
}
```

Output: `✓ Specified assistant saved` — **no ID is returned**. Find the new ID via:
```bash
codemie sdk assistants list --search 'My Assistant' --json | jq -r '.[0].id'
```

## Update

```bash
codemie sdk assistants update <id> --data '{"name":"Updated Name","shared":true}'
codemie sdk assistants update <id> --json updates.json
```

## Delete

```bash
# Always verify before deleting
codemie sdk assistants get <id>
codemie sdk assistants delete <id>
```

## Linking a Datasource

Datasources are attached via the `context` field — **not** `skill_ids`. Each entry requires `id`, `context_type`, and `name`.

Valid `context_type` values: `"knowledge_base"` (file/confluence/jira datasources), `"code"` (code repository datasources).

```bash
# Get the datasource ID first
codemie sdk datasources list --search 'my-docs' --json

# Attach to assistant
codemie sdk assistants update <id> --data '{
  "context": [
    {
      "id": "<datasource-id>",
      "context_type": "knowledge_base",
      "name": "<datasource-name>"
    }
  ]
}'
```

> **Note:** `skill_ids` holds built-in platform skills, not datasources. Do not use it to attach datasources.

## Linking a Toolkit (Integration)

Use the `toolkits` array to attach integrations (Git, Jira, etc.) to an assistant.

Known toolkit names: `"Git"`, `"Jira"`, `"Confluence"`, `"Access Management"`, `"Codebase Tools"`, `"Project Management"`, `"Research"`.

```bash
# Attach Git toolkit
codemie sdk assistants update <id> --data '{
  "toolkits": [
    {
      "toolkit": "Git",
      "label": "Git",
      "settings_config": true,
      "is_external": false,
      "tools": [{ "name": "git_tools", "settings_config": false }]
    }
  ]
}'
```

If the integration credentials can't be validated (test/fake credentials), add `"skip_integration_validation": true` at the top level:

```bash
codemie sdk assistants update <id> --data '{
  "toolkits": [...],
  "skip_integration_validation": true
}'
```

## Scripting

```bash
# Create then immediately fetch the new ID
codemie sdk assistants create --data '{"name":"My Bot","project":"Eng","system_prompt":"You are helpful."}'
ID=$(codemie sdk assistants list --search 'My Bot' --json | jq -r '.[0].id')

# Find assistant by name
codemie sdk assistants list --search 'My Bot' --json | jq -r '.[].id'

# Update all assistants in a project to shared
codemie sdk assistants list --projects Engineering --json | jq -r '.[].id' | while read id; do
  codemie sdk assistants update "$id" --data '{"shared":true}'
done
```
