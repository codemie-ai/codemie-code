# Categories Examples

> **Note:** Categories can only be used for **assistants**. Set a category on an assistant via the `categories` field (array of category IDs) when creating or updating.

## List

```bash
# List all categories (public, no admin required)
codemie sdk assistant-categories list
codemie sdk assistant-categories list --json

# Paginated list with assistant counts (admin required)
codemie sdk assistant-categories list --paginated
codemie sdk assistant-categories list --paginated --page 0 --per-page 25 --json
```

**Non-paginated JSON fields:** `id`, `name`, `description`

**Paginated JSON fields:** `categories[]` (with `id`, `name`, `description`, `marketplaceAssistantCount`, `projectAssistantCount`, `createdAt`, `updatedAt`), `page`, `per_page`, `total`, `pages`

## Get

```bash
codemie sdk assistant-categories get <id>
codemie sdk assistant-categories get <id> --json
```

Admin access required. Returns `id`, `name`, `description`, `marketplaceAssistantCount`, `projectAssistantCount`, `createdAt`, `updatedAt`.

## Create

```bash
# Minimal (name only)
codemie sdk assistant-categories create --data '{"name":"DevOps"}'

# With description
codemie sdk assistant-categories create --data '{"name":"Code Review","description":"Skills for reviewing code quality and security"}'

# From file
codemie sdk assistant-categories create --json category.json
```

**Field reference:**

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | ✅ | string | 1–255 chars |
| `description` | — | string | Optional, max 1000 chars |

Admin access required.

## Update

```bash
codemie sdk assistant-categories update <id> --data '{"name":"Updated Name"}'
codemie sdk assistant-categories update <id> --data '{"name":"DevOps","description":"Updated description"}'
```

Admin access required.

## Delete

```bash
# Verify before deleting
codemie sdk assistant-categories get <id>
codemie sdk assistant-categories delete <id>
```

Admin access required. Fails with **409** if any assistants are still assigned to this category — reassign or remove those assistants first.

## Using Categories with Assistants

Categories are referenced by their `id` in the assistant `categories` field.

```bash
# Get available category IDs
codemie sdk assistant-categories list --json | jq -r '.[] | "\(.id) \(.name)"'

# Create an assistant with categories
codemie sdk assistants create --data '{
  "name": "Code Reviewer",
  "project": "Engineering",
  "system_prompt": "You are a code review assistant.",
  "categories": ["<category-id-1>", "<category-id-2>"]
}'

# Update an assistant to add categories
codemie sdk assistants update <assistant-id> --data '{
  "categories": ["<category-id>"]
}'
```

## Scripting

```bash
# Find category ID by name
codemie sdk assistant-categories list --json | jq -r '.[] | select(.name == "DevOps") | .id'

# List all categories with assistant counts (admin)
codemie sdk assistant-categories list --paginated --json | jq -r '.categories[] | "\(.name): \(.marketplaceAssistantCount) marketplace, \(.projectAssistantCount) project"'
```
