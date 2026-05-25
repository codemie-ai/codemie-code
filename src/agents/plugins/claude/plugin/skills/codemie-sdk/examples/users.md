# Users Examples

## Get current user profile

```bash
codemie sdk users me
codemie sdk users me --json
```

**JSON fields:** `user_id`, `name`, `username`, `email`, `is_admin`, `applications`, `applications_admin`, `picture`, `knowledge_bases`

## Get current user data

```bash
codemie sdk users data
codemie sdk users data --json
```

**JSON fields:** `id`, `user_id`, `date`, `update_date`

## Scripting

```bash
# Get your username
codemie sdk users me --json | jq -r '.username'

# Get your user UUID
codemie sdk users me --json | jq -r '.user_id'

# Check if you are an admin
codemie sdk users me --json | jq -r '.is_admin'

# Get list of projects you have access to
codemie sdk users me --json | jq -r '.applications[]'

# Get list of projects where you are an admin
codemie sdk users me --json | jq -r '.applications_admin[]'
```
