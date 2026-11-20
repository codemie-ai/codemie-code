# Projects Examples

Always single-quote project names. Refuse names containing shell metacharacters (including `'`).

Exit codes for `exists`, `get`, `members`: `0` ok, `2` project not found or not accessible, `1` error (auth/server).

## List projects

```bash
codemie sdk projects list
codemie sdk projects list --search demo --page 0 --per-page 20 --sort-by created_at --sort-order desc --json
```

**JSON fields:** `data[]` (`name`, `display_name`, `description`, `project_type`, `created_by`, `user_count`, `admin_count`, `created_at`, `counters`), `pagination` (`total`, `page`, `per_page`)

## Get project

```bash
codemie sdk projects get 'my-project'
codemie sdk projects get 'my-project' --json
```

**JSON fields:** `name`, `display_name`, `description`, `project_type`, `created_by`, `user_count`, `admin_count`, `created_at`, `cost_center_id`, `cost_center_name`, `members[]` (`user_id`, `is_project_admin`, `date`)

## Check project exists

```bash
codemie sdk projects exists 'my-project'
codemie sdk projects exists 'my-project' --json
```

**JSON fields:** `name`, `exists`

## List members

```bash
codemie sdk projects members 'my-project'
codemie sdk projects members 'my-project' --json
```

**JSON fields:** array of `user_id`, `is_project_admin`, `date`

## Create project

```bash
codemie sdk projects create --data '{"name":"my-project","description":"Demo","display_name":"My Project"}'
codemie sdk projects create --json path/to/project.json
```

**Required:** `name`. **Optional:** `display_name` (max 150), `description`, `cost_center_id`, `cli_analytics_enabled`

**JSON fields:** `name`, `display_name`, `description`, `project_type`, `created_by`, `created_at`, `cost_center_id`, `cost_center_name`

## Update project

```bash
codemie sdk projects update 'my-project' --data '{"description":"New description"}'
codemie sdk projects update 'my-project' --json path/to/update.json
```

**Optional fields:** `name`, `display_name`, `description`, `clear_description`, `cost_center_id`, `clear_cost_center`, `enforce_member_spend_limits`, `chargeback_attribution`, `cli_analytics_enabled`

**JSON fields:** same as create

## Delete project

Ask the user before running this.

```bash
codemie sdk projects delete 'my-project'
codemie sdk projects delete 'my-project' --json
```

**JSON fields:** `message`, `name`

## Transfer ownership

Ask the user before running this.

```bash
codemie sdk projects transfer-ownership 'my-project' <userId>
codemie sdk projects transfer-ownership 'my-project' <userId> --json
```

**JSON fields:** `name`, `created_by`, `message`

## Assign user

```bash
codemie sdk projects assign 'my-project' <userId>
codemie sdk projects assign 'my-project' <userId> --admin --json
```

**JSON fields:** `message`, `user_id`, `project_name`, `is_project_admin`

## Update member role

One of `--admin` / `--no-admin` is required.

```bash
codemie sdk projects update-member 'my-project' <userId> --admin
codemie sdk projects update-member 'my-project' <userId> --no-admin --json
```

**JSON fields:** `message`, `user_id`, `project_name`, `is_project_admin`

## Remove member

```bash
codemie sdk projects remove-member 'my-project' <userId>
codemie sdk projects remove-member 'my-project' <userId> --json
```

**JSON fields:** `message`, `user_id`, `project_name`

## Bulk assign users

`users.json` holds 1-1000 entries: `[{"user_id":"<id>","is_project_admin":false}]`

```bash
codemie sdk projects bulk-assign 'my-project' --file users.json
codemie sdk projects bulk-assign 'my-project' --file users.json --json
```

**JSON fields:** `message`, `project_name`, `total`, `results[]` (`user_id`, `action`, `is_project_admin`)

## Bulk remove users

Ask the user before running this. 1-100 user ids.

```bash
codemie sdk projects bulk-remove 'my-project' <userId1> <userId2>
codemie sdk projects bulk-remove 'my-project' <userId1> <userId2> --json
```

**JSON fields:** `message`, `project_name`, `total`, `results[]` (`user_id`, `action`)

## Validate users CSV

```bash
codemie sdk projects csv-validate 'my-project' ./users.csv
codemie sdk projects csv-validate 'my-project' ./users.csv --json
```

**JSON fields:** `users[]` (`email`, `role`, `error`)

## Import users from CSV

```bash
codemie sdk projects csv-import 'my-project' ./users.csv
codemie sdk projects csv-import 'my-project' ./users.csv --json
```

**JSON fields:** `message`, `project_name`, `total`, `results[]` (`user_id`, `action`, `is_project_admin`)

## Scripting

```bash
# Check existence and branch on the exit code
codemie sdk projects exists 'my-project' >/dev/null 2>&1
case $? in
  0) echo "project exists" ;;
  2) echo "project not found or not accessible" ;;
  *) echo "error (auth or server)" ;;
esac

# All project names
codemie sdk projects list --per-page 100 --json | jq -r '.data[].name'

# Admin members of a project
codemie sdk projects members 'my-project' --json | jq -r '.[] | select(.is_project_admin) | .user_id'

# Created project name
codemie sdk projects create --data '{"name":"my-project"}' | jq -r '.name'

# CSV rows with validation errors
codemie sdk projects csv-validate 'my-project' ./users.csv --json | jq -r '.users[] | select(.error) | "\(.email): \(.error)"'
```
