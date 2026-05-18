---
name: codemie-analytics
description: >
  CodeMie Analytics expert — use this skill whenever the user asks about CodeMie usage data,
  AI adoption metrics, user leaderboards, CLI insights, spending, LiteLLM costs, token usage,
  or wants to build a dashboard/report from CodeMie or LiteLLM APIs.
  Also triggers for: "who uses CodeMie most", "show me AI analytics", "get spending data",
  "generate a report", "leaderboard", "cost analysis", "LiteLLM customer info",
  "enrich CSV with costs", "top performers", "AI champions", "tier distribution",
  or any custom analytics query against the platform.
  Always use this skill when CodeMie analytics, reporting, or cost data is involved.
---

# CodeMie Analytics Skill

You are an analytics expert for the CodeMie (EPAM AI/Run) platform. You know every analytics
API endpoint, how to call LiteLLM directly, and how to orchestrate data into a final report.

The plumbing (config lookup, SSO credential decryption, token refresh messaging) lives in
`scripts/analytics-cli.js`. You never need to touch those details — just invoke the CLI and
react to what it prints.

---

## Step 1 — Understand what the user wants

Identify the analytics scenario. The CLI supports these command families:

### Leaderboard (AI Champions)

The leaderboard ranks users across **6 scoring dimensions**:
- D1: Core Platform Usage (20%) — conversations, assistant interactions
- D2: Core Platform Creation (20%) — assistants, datasources created
- D3: Workflow Usage (10%) — workflow executions
- D4: Workflow Creation (10%) — workflows authored
- D5: CLI & Agentic Engineering (30%) — coding agent sessions, tokens, repos
- D6: Impact & Knowledge (10%) — marketplace publishing, knowledge sharing

**Tiers**: pioneer (80+), expert (65+), advanced (45+), practitioner (25+), newcomer (<25)

| Scenario | Command | What it retrieves |
|----------|---------|-------------------|
| Full leaderboard (paginated, filterable) | `leaderboard` | `data.rows[]` — rank, user_name, total_score, tier_name, score_delta, `dimensions[]` (id/score/weight per D1–D6), `summary_metrics{}` (cli_sessions, active_days, total_lines_added, total_spend, web_conversations, …) |
| Leaderboard KPI summary | `leaderboard-summary` | `data` — total_users, avg_score, top_score, `tier_counts{}` (pioneer/expert/advanced/practitioner/newcomer counts and percentages) |
| Single user champion profile | `leaderboard-user <id\|email>` | `data` — same shape as a leaderboard row but for one user; includes full dimension breakdown and all summary_metrics |
| Tier distribution | `leaderboard-tiers` | `data.rows[]` — tier_name, user_count, percentage; one row per tier |
| Average dimension scores | `leaderboard-dimensions` | `data.rows[]` — dimension id/label, avg_score, weight; one row per D1–D6 |
| Top N performers | `leaderboard-top [limit]` | `data.rows[]` — same shape as `leaderboard` rows, limited to top N (max 50, default 10) |
| Score histogram | `leaderboard-scores` | `data.rows[]` — score_range (e.g. "0-10"), user_count; one row per 10-point bin |
| Framework metadata | `leaderboard-framework` | `data.framework{}` — title, principles, calculation_steps; `data.tiers[]` — name, label, min_score; `data.dimensions[]` — id, label, weight, description |
| Computation snapshots | `leaderboard-snapshots` | `data.rows[]` — snapshot_id, created_at, status, period_start, period_end, user_count |
| Available seasons | `leaderboard-seasons --view monthly\|quarterly` | `data.rows[]` — season_key (e.g. "2026-03"), label, start_date, end_date |

Leaderboard filters: `--view` (current/monthly/quarterly), `--season-key` (2026-03, 2026-Q1),
`--tier`, `--intent` (cli_focused/platform_focused/hybrid/sdlc_unicorn), `--search`, `--sort-by`, `--sort-order`.

### CLI Insights

| Scenario | Command | What it retrieves |
|----------|---------|-------------------|
| Full CLI overview (agents, repos, tools, errors) | `cli-insights` | Composite object with sub-keys: `summary` (total sessions, cost, tokens, repos, users), `agents[]` (agent name + session count), `top_users[]`, `top_repos[]`, `errors[]`, `llms[]` |
| User classification & top spenders | `cli-insights-users` | `data.rows[]` — user_name, classification (cli_focused/platform_focused/hybrid/sdlc_unicorn), total_cost, session_count, token_count |
| Detailed single-user CLI profile | `cli-insights-user <name>` | Composite: key_metrics (sessions, cost, tokens, repos, tools), tools[], models[], repositories[], workflow_intent, category_breakdown[] |
| Project classification & top by cost | `cli-insights-projects` | `data.rows[]` — project_name, classification, total_cost, session_count, user_count |
| Usage patterns (weekday, hourly, session depth) | `cli-insights-patterns` | Composite with sub-keys: `weekday.data.rows[]` (weekday_name, session_count), `hourly.data.rows[]` (hour_utc, session_count), `session_depth.data.rows[]` (depth_bucket, count) |

### General Analytics

| Scenario | Command | What it retrieves |
|----------|---------|-------------------|
| Overall usage summary (tokens, cost, users) | `summaries` | `data` — total_cost, total_tokens, total_requests, unique_users (MAU), unique_users_daily (DAU), cli_invocations, assistants_count, workflows_count, skills_count, mcp_servers_count |
| User list + activity trends | `users` | `data.rows[]` — user_name, email, total_cost, total_tokens, last_active; plus `activity[]` time-series |
| Per-project spending | `projects-spending` | `data.rows[]` — project_name, total_cost, total_tokens, user_count, request_count |
| Per-project activity time-series | `projects-activity` | Composite with `activity.data.rows[]` and `uniqueDaily.data.rows[]` |
| LLM model breakdown | `llms-usage` | `data.rows[]` — model_name, request_count, total_tokens, input_tokens, output_tokens, total_cost |
| Tool usage | `tools-usage` | `data.rows[]` — tool_name, invocation_count, success_count, error_count, total_tokens |
| Workflow execution analytics | `workflows` | `data.rows[]` — workflow_name, run_count, success_count, failure_count, avg_duration_ms, total_cost |
| Agent execution analytics | `agents-usage` | `data.rows[]` — assistant_name, execution_count, total_cost, total_tokens |
| Embedding model usage | `embeddings-usage` | `data.rows[]` — model_name, request_count, total_tokens, total_cost |
| Chat assistant conversations | `assistants-chats` | `data.rows[]` — assistant, conversation_count, user_count, total_cost |
| Webhook invocation analytics | `webhooks-usage` | `data.rows[]` — user_id, invocation_count, total_cost |
| MCP server usage | `mcp-servers` | `data.rows[]` — mcp_name, request_count, user_count, total_cost |
| MCP server usage by user | `mcp-servers-by-users` | `data.rows[]` — user_name, mcp_name, request_count |
| Power user analytics | `power-users` | `data.rows[]` — user_email, session_count, total_cost, features_used |
| Knowledge sharing metrics | `knowledge-sharing` | `data.rows[]` — user_email, shared_count, viewed_count |
| Top agents by usage | `top-agents` | `data.rows[]` — assistant_name, execution_count, total_cost |
| Top workflows by usage | `top-workflows` | `data.rows[]` — workflow_name, run_count, total_cost |
| Assets published to marketplace | `marketplace` | `data.rows[]` — user_email, asset_name, published_at |
| Budget alerts (soft + hard limits) | `budget` | Composite with `soft.data.rows[]` and `hard.data.rows[]` — user_email, max_spent (users approaching or over limit) |
| Personal spending & budget | `spending` | `data` — current_spend, budget_limit, hard_budget_limit, budget_reset_at, percentage_used |
| Per-user spending (platform + cli split) | `spending-by-users` | Composite with `platform.data.rows[]` and `cli.data.rows[]` — user_name/email, total_cost, token_count |
| Weekly engagement histogram | `engagement` | `data.rows[]` — day_label, hour_start, feature_type, session_count, cost; covers last 7 days in 3-hour intervals |

### LiteLLM & CSV Enrichment

| Scenario | Command | Output |
|----------|---------|--------|
| LiteLLM customer lookup | `litellm-customer [user_id]` | JSON |
| LiteLLM spend logs | `litellm-spend` | Spend entries |
| LiteLLM virtual keys | `litellm-keys` | Key info |
| Enrich CSV/Excel with LiteLLM costs | `enrich-csv <file>` | Enriched table |
| Unlisted / experimental endpoint | `custom /v1/analytics/<path>` | Raw JSON — use a named command if one exists |

---

## Security

**Never include raw API keys, bearer tokens, cookie values, LiteLLM keys, or session
credentials in your responses to the user.** If CLI output contains sensitive fields
(e.g. from `litellm-keys`), the CLI automatically redacts them — but if you encounter
any token, key, or secret in raw output, redact it before displaying. Never run `env`,
`printenv`, or similar commands that could expose `LITELLM_KEY` or `CODEMIE_API_KEY`
to the conversation context.

---

## Step 2 — Run the analytics CLI

The CLI script lives at `scripts/analytics-cli.js` next to this skill. It handles
authentication internally. If something is wrong with credentials, it prints a clear
actionable message to stderr; pass that along to the user verbatim.

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/codemie-analytics/scripts/analytics-cli.js <command> [options]
```

LiteLLM commands (`litellm-*`, `enrich-csv`) require `LITELLM_URL` + `LITELLM_KEY` env vars.

### Collecting data for reports (batch pattern)

**Only fetch the data the report actually needs.** Read the user's request, identify which
sections the report requires, and collect only the relevant endpoints. Do not run every
available command — unnecessary fetches waste time and tokens.

When building an HTML report, run all needed CLI commands in a single Bash call using
`--save <filepath>` on each. This triggers one permission prompt for the entire
collection phase and keeps API responses out of the conversation context.

### Directory layout

Every report lives in its own folder under `reports/`. Derive the folder name from the
current date and a short kebab-case description of the report:

```
reports/
  2026-05-07-cli-usage/          ← report folder (date + name)
    cli-usage.html               ← the HTML report (saved here directly)
    temp/                        ← all temp/data files go here
      summaries.json
      summaries.schema.json
      cli-insights.json
      ...
```

**Never overwrite an existing report folder.** Always resolve a free name before creating
anything. Use a suffix loop — this is mandatory, not optional:

```bash
BASE=reports/$(date +%Y-%m-%d)-<short-name>
REPORT_DIR=$BASE
n=2
while [ -d "$REPORT_DIR" ]; do REPORT_DIR="${BASE}-${n}"; n=$((n+1)); done
OUT="$REPORT_DIR/temp"
```

Then run only the commands the report needs:

```bash
CLI=${CLAUDE_PLUGIN_ROOT}/skills/codemie-analytics/scripts/analytics-cli.js
mkdir -p "$OUT" && \
node $CLI summaries   --save "$OUT/summaries.json"   && \
node $CLI cli-insights --save "$OUT/cli-insights.json" && \
# ... only endpoints needed for this report ...
echo "✓ All data saved → $OUT"
```

Each command prints: `✓ Saved → <path>`. The final `echo` confirms the directory
path — save it, you will reference it in every subsequent step.

**Do not `cat`, `Read`, or print the saved JSON files into the conversation.**
Raw API responses can be hundreds of KB. Use Step 2.5 to inspect structure instead.

Temp files are not cleaned up automatically.

### Common filter flags

| Flag | Example | Notes |
|------|---------|-------|
| `--time-period` | `last_30_days` | Predefined period |
| `--start-date` | `2024-01-01T00:00:00` | Custom range start |
| `--end-date` | `2024-03-31T23:59:59` | Custom range end |
| `--users` | `alice,bob` | Comma-separated usernames |
| `--projects` | `my-project` | Comma-separated project names |
| `--page` | `1` | Pagination |
| `--per-page` | `100` | Results per page (default 50) |
| `--output` | `json` | `json` \| `table` \| `csv` |
| `--pretty` | (flag) | Pretty-print JSON |

### Leaderboard-specific flags

| Flag | Example | Notes |
|------|---------|-------|
| `--view` | `monthly` | `current` \| `monthly` \| `quarterly` |
| `--season-key` | `2026-Q1` | Specific season to query |
| `--tier` | `pioneer` | Filter by tier |
| `--intent` | `cli_focused` | Filter by user intent profile |
| `--search` | `john` | Partial name/email search |
| `--sort-by` | `total_score` | `rank` \| `total_score` \| `user_name` \| `tier_level` |
| `--sort-order` | `desc` | `asc` \| `desc` |
| `--limit` | `20` | Max entries for `leaderboard-top` (max 50) |

### Example invocations

```bash
CLI=${CLAUDE_PLUGIN_ROOT}/skills/codemie-analytics/scripts/analytics-cli.js

# Full leaderboard — top 50 pioneers sorted by score
node $CLI leaderboard --tier pioneer --sort-by total_score --sort-order desc --per-page 50 --pretty

# Single user champion profile
node $CLI leaderboard-user user@example.com --pretty

# Leaderboard KPI summary for Q1 2026
node $CLI leaderboard-summary --view quarterly --season-key 2026-Q1 --pretty

# Dimension averages (D1–D6) for current snapshot
node $CLI leaderboard-dimensions --pretty

# Tier distribution
node $CLI leaderboard-tiers --pretty

# Top 10 performers
node $CLI leaderboard-top 10 --pretty

# 30-day platform summary
node $CLI summaries --time-period last_30_days --pretty

# Full CLI insights
node $CLI cli-insights --time-period last_30_days --pretty

# Detailed CLI profile for a specific user
node $CLI cli-insights-user alice@example.com --time-period last_30_days --pretty

# Usage patterns (weekday + hourly + session depth)
node $CLI cli-insights-patterns --time-period last_30_days --pretty

# Per-user spending breakdown
node $CLI spending-by-users --time-period last_30_days --pretty

# Custom endpoint
node $CLI custom /v1/analytics/mcp-servers --time-period last_30_days --pretty
```

---

## Step 2.5 — Inspect data structure

After collection, run `inspect-schema.js` to generate a compact `.schema.json` file
alongside each saved JSON — one permission prompt, no data in context:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/codemie-analytics/scripts/inspect-schema.js "$OUT"
```

Output is a short listing of generated schema files with sizes, for example:
```
Schemas written to: reports/2026-05-07-cli-usage/temp/
  ✓ leaderboard-top.schema.json (1.3 KB)
  ✓ summaries.schema.json (0.4 KB)
  ...
```

Then **read only the `.schema.json` files you actually need** for the report using the
`Read` tool. Each schema shows field names, types, array lengths, and string samples —
enough to write extraction code without touching the raw responses:

> **CRITICAL — schema is the source of truth for field names.**
> Never use field names or metric IDs from this skill's documentation when writing
> report code. Documentation can be stale. The `.schema.json` files are generated from
> live API responses and are always correct. Every `id`, key, or column name referenced
> in JS must be verified against the schema you just read — not assumed from the tables
> above. If the schema contradicts the docs, trust the schema.

```json
{
  "_envelope": "[envelope] data_as_of: '2026-05-07T02:00:10', total_count: 50",
  "data": {
    "rows": {
      "_type": "array",
      "_count": 50,
      "_item": {
        "rank": "number",
        "user_name": "string ~ 'Jane Smith'",
        "total_score": "number",
        "tier_name": "string ~ 'expert'",
        "score_delta": "number | null",
        "dimensions": { "_type": "array", "_count": 6, "_item": { "id": "string ~ 'd1'", "score": "number", "weight": "number" } },
        "summary_metrics": { "cli_sessions": "number", "active_days": "number", "total_lines_added": "number", "total_spend": "number" }
      }
    }
  }
}
```

---

## Step 3 — Build the HTML report

**Save the HTML report directly inside `$REPORT_DIR`** (not in `temp/`).
Use a kebab-case filename matching the folder name:

```
reports/2026-05-07-cli-usage/cli-usage.html
reports/2026-05-07-leaderboard/leaderboard.html
reports/2026-05-07-spending/spending.html
```

### Step 3a — Write the HTML

Invoke the **`codemie-html-report`** skill. Pass:

1. **The schemas** inspected in Step 2.5 — field names and structure.
2. **The user's intent** — e.g. "leaderboard dashboard with tier distribution".
3. **Timestamp context** — `_envelope` lines in schemas include `data_as_of`.
4. **Output path** — e.g. `$REPORT_DIR/leaderboard.html`.

The HTML skill writes the file using `/*__CSS__*/` for styles and
**`/*__DATA:name__*/` placeholders for all embedded JS data arrays**:

```html
<script>
  const LEADERBOARD = /*__DATA:leaderboard__*/;
  const SUMMARIES   = /*__DATA:summaries__*/;
</script>
```

Each placeholder name maps to a saved file in `$OUT` (without the `.json` extension).

### Step 3b — Inject data

**After the HTML file exists**, run the shared `inject-data.js` from the `codemie-html-report`
skill. It matches each JSON file in `$OUT` to a `/*__DATA:name__*/` placeholder by filename
(without `.json`) and replaces it in-place.

**Do not run inject-data.js before the HTML file is written.**

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/codemie-html-report/scripts/inject-data.js \
  "$REPORT_DIR/<report>.html" "$OUT"
```

Placeholder names must exactly match the JSON filenames — `/*__DATA:leaderboard-top__*/`
is only replaced when `leaderboard-top.json` exists in `$OUT`.

Expected output:
```
  ✓ injected leaderboard-top
  ✓ injected summaries
✓ 2 data block(s) injected into reports/2026-05-07-<name>/<report>.html
```

---

## Full API Reference

### Leaderboard endpoints (`GET /v1/analytics/leaderboard/...`)

Admin-only. All accept `snapshot_id`, `view`, `season_key` query params.

| Endpoint | Additional Params | Returns |
|----------|------------------|---------|
| `/leaderboard/summary` | — | Total users, tier counts, top score |
| `/leaderboard/entries` | `tier`, `search`, `intent`, `sort_by`, `sort_order`, `page`, `per_page` | Paginated ranked entries |
| `/leaderboard/user/{user_id}` | path: user ID or email | Full user profile with D1–D6 breakdown |
| `/leaderboard/tiers` | — | Tier name, count, percentage |
| `/leaderboard/scores` | — | Score histogram (10-point bins) |
| `/leaderboard/dimensions` | — | Average D1–D6 scores |
| `/leaderboard/top-performers` | `limit` (default 3, max 50) | Top N by total score |
| `/leaderboard/snapshots` | `view`, `status`, `is_final`, `page`, `per_page` | Computation snapshots |
| `/leaderboard/seasons` | `view` (required: monthly/quarterly), `page`, `per_page` | Available seasonal periods |
| `/leaderboard/framework` | — | Static metadata: dimensions, tiers, intents, scoring |
| `/leaderboard/compute` (POST) | `period_days`, `view`, `season_key` | Triggers manual computation |

### CLI Insights endpoints (`GET /v1/analytics/cli-insights-...`)

| Endpoint | Params | Returns |
|----------|--------|---------|
| `/cli-insights-weekday-pattern` | time filters | Weekday usage patterns |
| `/cli-insights-hourly-usage` | time filters | Hourly usage patterns |
| `/cli-insights-session-depth` | time filters | Session depth distribution |
| `/cli-insights-user-classification` | time filters | User classification breakdown |
| `/cli-insights-top-users-by-cost` | time filters | Top users ranked by cost |
| `/cli-insights-top-spenders` | time filters | Top spenders |
| `/cli-insights-users` | time filters | CLI user list |
| `/cli-insights-user-detail` | `user_name` (required), `user_id` | Full user detail |
| `/cli-insights-user-key-metrics` | `user_name` (required), `user_id` | User KPIs |
| `/cli-insights-user-tools` | `user_name` (required), `user_id` | User tool usage |
| `/cli-insights-user-models` | `user_name` (required), `user_id` | User model usage |
| `/cli-insights-user-workflow-intent` | `user_name` (required), `user_id` | User workflow intent |
| `/cli-insights-user-classification-detail` | `user_name` (required), `user_id` | User classification detail |
| `/cli-insights-user-category-breakdown` | `user_name` (required), `user_id` | User category breakdown |
| `/cli-insights-user-repositories` | `user_name` (required), `user_id` | User repositories |
| `/cli-insights-project-classification` | time filters | Project classification |
| `/cli-insights-top-projects-by-cost` | time filters | Top projects by cost |

### Standard CLI analytics (`GET /v1/analytics/cli-...`)

| Endpoint | Returns |
|----------|---------|
| `/cli-summary` | CLI totals (tokens, cost, sessions) |
| `/cli-agents` | Agent breakdown |
| `/cli-llms` | Model breakdown |
| `/cli-users` | CLI user activity |
| `/cli-errors` | Error logs |
| `/cli-repositories` | Repo activity |
| `/cli-top-performers` | Top by lines added |
| `/cli-top-versions` | CLI version distribution |
| `/cli-top-proxy-endpoints` | LiteLLM endpoint usage |
| `/cli-tools` | Tool usage |

### Dashboard analytics (`GET /v1/analytics/...`)

All accept time filters + `users` + `projects` + `page` + `per_page`.

| Endpoint | Returns |
|----------|---------|
| `/summaries` | Platform totals (tokens, cost, unique users) |
| `/users-spending` | Per-user cost + tokens |
| `/users-activity` | Activity time-series |
| `/users-unique-daily` | Unique users/day |
| `/users` | User list |
| `/projects-spending` | Per-project spending |
| `/projects-activity` | Project activity time-series |
| `/projects-unique-daily` | Unique projects/day |
| `/llms-usage` | LLM model usage |
| `/tools-usage` | Tool usage |
| `/workflows` | Workflow runs |
| `/agents-usage` | Agent executions |
| `/embeddings-usage` | Embedding model usage |
| `/assistants-chats` | Chat assistant conversations |
| `/webhooks-invocation` | Webhook usage |
| `/mcp-servers` | MCP server usage |
| `/mcp-servers-by-users` | MCP by user |
| `/power-users` | Power user analytics |
| `/knowledge-sharing` | Knowledge sharing metrics |
| `/top-agents-usage` | Top agents |
| `/top-workflow-usage` | Top workflows |
| `/published-to-marketplace` | Marketplace publishing |

### Spending & Budget endpoints

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/spending` | GET | Current user: spend, budget_limit, hard_budget_limit, reset time |
| `/budget_usage` | GET | Per-key budget rows with % used |
| `/budget-soft-limit` | GET | Soft limit warnings |
| `/budget-hard-limit` | GET | Hard limit hits |
| `/spending/by-users/platform` | GET | Per-user platform spending |
| `/spending/by-users/cli` | GET | Per-user CLI spending |

### Engagement

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/engagement/weekly-histogram` | GET | 3h intervals, last 7 days, by feature type |

### LiteLLM endpoints (via `LITELLM_URL` + `LITELLM_KEY`)

| Endpoint | Method | Params | Description |
|----------|--------|--------|-------------|
| `/customer/info` | GET | `user_id` | Customer spend + budget + allowed models |
| `/spend/logs` | GET | `start_date`, `end_date`, `user_id` | Spend log entries |
| `/key/info` | GET | `key` | Virtual key details + spend |
| `/model/info` | GET | — | Available models |
| `/health` | GET | — | Proxy health |

### Response envelope

Most CodeMie endpoints return:
```json
{
  "data": { ... },
  "metadata": {
    "timestamp": "2024-03-15T12:00:00Z",
    "data_as_of": "2024-03-15T12:00:00Z",
    "filters_applied": {},
    "execution_time_ms": 45.2
  }
}
```

Always extract `response.data` for the actual payload.

---

## Custom analytics requests

For endpoints not covered by preset commands:

```bash
node analytics-cli.js custom /v1/analytics/mcp-servers --time-period last_30_days

# POST endpoints
node analytics-cli.js custom /v1/analytics/ai-adoption-overview --method POST \
  --time-period last_30_days
```

---

## Offline CLI analytics (no API key needed)

The `codemie analytics` CLI command reads **local session files** from `~/.codemie/sessions/`
with no API calls:

```bash
codemie analytics --last 7d --output json
codemie analytics --agent claude --last 30d --export csv
```

---

## Report References

Reference files in `references/` describe canonical report layouts. **Always check the
relevant reference before building a new HTML report** — it defines the exact components,
charts, data structure, and modal design to use, ensuring consistency across users.

| Report type | Reference file | When to use |
|-------------|---------------|-------------|
| Leaderboard dashboard | [`${CLAUDE_PLUGIN_ROOT}/references/leaderboard-dashboard-report.md`](${CLAUDE_PLUGIN_ROOT}/references/leaderboard-dashboard-report.md) | Any request for leaderboard rankings, AI champions, top performers, tier distribution |
| People spending dashboard | [`${CLAUDE_PLUGIN_ROOT}/references/people-spending-dashboard-report.md`](${CLAUDE_PLUGIN_ROOT}/references/people-spending-dashboard-report.md) | Any request to track LiteLLM costs for a specific list of users (cohort, team, bootcamp, project) |

---

## Use Cases

### Use Case: People Spending Dashboard (cohort / team / bootcamp)

**Trigger phrases**: "build a spending dashboard for people from X", "track LiteLLM costs
for a list of users", "how much did this team spend", "bootcamp spending report",
"costs for people in this CSV/Excel".

**Also applies when**: the user asks to enrich analytics with EPAM employee data, map
platform users to EPAM people, or look up user assignments/org details.

**⚠️ EPAM People & Assignments Finder — required for this use case only**

Before proceeding, verify the assistant is accessible:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/codemie-analytics/scripts/analytics-cli.js \
  custom /v1/assistants/5ca384d0-d042-480c-a0a9-d28150e2352f 2>&1 | head -5
```

If the command returns an auth error, HTTP 401/403/404, or "No CodeMie credentials" —
**stop. Do not run anything else.** Notify the user:

> ⛔ **EPAM People & Assignments Finder** assistant is not configured on your account.
>
> **Assistant:** EPAM People & Assignments Finder
> **ID:** `5ca384d0-d042-480c-a0a9-d28150e2352f`
>
> Add it with:
> ```bash
> codemie assistants add 5ca384d0-d042-480c-a0a9-d28150e2352f
> ```
> Or open in browser and click **Add to my assistants**:
> https://codemie.lab.epam.com/#/assistants/5ca384d0-d042-480c-a0a9-d28150e2352f
>
> Once added, resume this session with:
> ```bash
> claude -f
> ```

**Full workflow** (see `${CLAUDE_PLUGIN_ROOT}/references/people-spending-dashboard-report.md` for all details):

1. **Parse the list** from Excel/CSV using `openpyxl`. Skip header and TOTAL rows.
2. **Fetch 3 LiteLLM accounts per user** using Python `asyncio` + `aiohttp` (semaphore 25,
   `ssl=False`). Account patterns:
   - Web: `email` (plain)
   - CLI: `email_codemie_cli`
   - Premium: `email_codemie_premium_models`
   Use `end_user_id` param (not `user_id`) on `GET /customer/info`.
3. **Save raw results** to `/tmp/` to avoid re-fetching on HTML rebuild.
4. **Build users array** — sum three spend values, extract budget fields per account.
5. **Fetch leaderboard** — paginate ALL pages (`--per-page 500`), ~25 pages for 12k users.
   Expect ~60% of a typical cohort to appear.
6. **Fetch CLI insights** — `cli-insights-users --per-page 500 topBySpend` for top CLI users.
   Expect ~3–5% coverage for a general cohort.
7. **Compute KPIs** — grand total, per-type totals, active user count, avg spend.
   Budget projection: `avg_spend_per_active × total_users × 1.20`.
8. **Generate HTML** — use `str.replace()` with `__TOKEN__` markers (never f-strings, which
   conflict with JS `${...}` template literals).
9. **Wire table clicks** — use `data-email` attribute + event delegation (never `onclick=""`
   attributes, which break under Python quote escaping).
10. **Save** to `reports/<date>-<name>/<name>.html` (temp/data files in `reports/<date>-<name>/temp/`).

**Key commands:**
```bash
CLI=${CLAUDE_PLUGIN_ROOT}/skills/codemie-analytics/scripts/analytics-cli.js

# Leaderboard (run in a loop for all pages)
node $CLI leaderboard --per-page 500 --page <N> --output json

# CLI top spenders
node $CLI cli-insights-users --time-period last_30_days --per-page 500 --output json
```

**LiteLLM fetch** requires Python (not the analytics CLI) because it needs
`LITELLM_URL` + `LITELLM_KEY` env vars and concurrent calls for 1,000+ accounts.

---

## Tips

- **Always run the CLI first**, capture JSON, then hand it to the report skill — don't
  hardcode example data.
- If a command returns paginated data, loop through all pages or set `--per-page 500`.
- For time-series charts, use `/users-unique-daily` or `/projects-unique-daily` endpoints.
- Budget warnings: flag rows where `spend / max_budget > 0.8` (warn) and `> 1.0` (error).
- For the **leaderboard dashboard**, combine `leaderboard` + `leaderboard-summary` +
  `leaderboard-tiers` + `leaderboard-dimensions` to build a comprehensive view. Then follow
  `${CLAUDE_PLUGIN_ROOT}/references/leaderboard-dashboard-report.md` for the exact HTML structure.
- For a **people spending dashboard**, fetch LiteLLM directly with Python async (3 accounts
  per user), then enrich with leaderboard + CLI insights. Follow
  `${CLAUDE_PLUGIN_ROOT}/references/people-spending-dashboard-report.md` for the exact HTML structure.
- For a **single user deep-dive**, combine `leaderboard-user <email>` with
  `cli-insights-user <name>` for the full picture (champion score + CLI activity).
- If the CLI prints an auth error, forward its message verbatim — it already tells the user
  what to do next.
- Always save HTML reports to `reports/<date>-<name>/<name>.html`; temp/data files go in `reports/<date>-<name>/temp/`.

## Type-Aware Rendering for `metrics[]` Arrays

Analytics `metrics[]` arrays are **heterogeneous** — each item carries a `type` field
(`"number"`, `"string"`, `"date"`, …) and a `format` field. The `value` is numeric for most
items but may be an ISO date string or plain string for others.

**Always inspect `m.type` (and `m.format`) per item before formatting.** Never apply a single
numeric or percent formatter to the whole array — doing so silently produces `NaN` for
string/date items.