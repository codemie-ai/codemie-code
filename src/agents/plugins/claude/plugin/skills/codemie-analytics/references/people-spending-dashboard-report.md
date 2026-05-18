# People Spending Dashboard — Reference

> **Purpose**: This document describes the canonical spending dashboard built for tracking
> LiteLLM costs for a specific list of people (e.g. a training cohort, project team, or
> bootcamp). Use it as the authoritative spec whenever someone asks to build a spending
> report or cost dashboard for a named list of users.

---

## Overview

The people spending dashboard is a **self-contained single-file HTML report** that combines
direct LiteLLM customer costs with CodeMie platform analytics (leaderboard, CLI insights).
It is dark-themed, uses the CodeMie design system (inlined CSS), and Chart.js for charts.

**Key properties:**
- No external CSS dependencies — all 8 CodeMie CSS files inlined in `<style>`
- Google Fonts (`Inter`, `JetBrains Mono`) via `@import`
- Chart.js 4.4.0 via CDN
- All data pre-fetched at build time and embedded in JS variables — no runtime API calls
- Three-account LiteLLM model per user (Web, CLI, Premium) — see account scheme below
- Fully portable: open in any browser on any machine

---

## LiteLLM Account Scheme (3 accounts per user)

Each user in the CodeMie platform has up to **three distinct LiteLLM customer accounts**.
The email address is the base identity:

| Account | `end_user_id` pattern | What it tracks |
|---------|----------------------|----------------|
| Web / Platform | `first_last@domain.com` | Conversations via the web UI and assistants |
| CLI | `first_last@domain.com_codemie_cli` | Claude Code / agent CLI sessions |
| Premium Models | `first_last@domain.com_codemie_premium_models` | Opus / premium model requests |

> **Important**: The LiteLLM customer endpoint requires the `end_user_id` query parameter
> (not `user_id`). The correct endpoint is:
> ```
> GET /customer/info?end_user_id=<email_or_email_suffix>
> ```

Each account independently tracks `spend`, `max_budget`, `soft_budget`, and `budget_duration`.
The total per-user spend is the sum of all three accounts.

---

## Data Sources

| Source | How fetched | What it provides |
|--------|------------|------------------|
| LiteLLM API | Python `aiohttp` with concurrency (see below) | Actual spend, budget, blocked status per account |
| CodeMie Leaderboard | `leaderboard --per-page 500` (paginated, all pages) | Tier, champion score, D1–D6 dimensions, rank, usage intent |
| CodeMie CLI Insights | `cli-insights-users --per-page 500` | CLI sessions, lines added/removed, classification |
| Source list | Excel/CSV (`.xlsx` via `openpyxl`) | Participant emails |

---

## Step-by-Step Build Process

### Step 1 — Parse the source list

The source list is an Excel file with participant emails.

```python
import openpyxl

wb = openpyxl.load_workbook('participants.xlsx')
ws = wb['participants']  # sheet name may vary

emails = []
for row in ws.iter_rows(min_row=3, values_only=True):  # row 1 = headers, row 2 = totals
    if row[0] and '@' in str(row[0]):
        emails.append(str(row[0]).strip().lower())
```

> **Row layout note**: Row 1 may be column headers, row 2 may be a TOTAL row.
> Always start from the first data row (check the file structure).

---

### Step 2 — Fetch LiteLLM spend for all 3 accounts per user

Use Python `asyncio` + `aiohttp` for concurrent calls. With 656 users × 3 accounts = 1,968
calls, use a semaphore of 25 to avoid overwhelming the API.

```python
import asyncio, aiohttp, json, os

LITELLM_URL = os.environ['LITELLM_URL']   # e.g. https://litellm.my-company.com
LITELLM_KEY = os.environ['LITELLM_KEY']   # master key or admin key

SUFFIXES = {
    'web':     '',                            # plain email
    'cli':     '_codemie_cli',
    'premium': '_codemie_premium_models',
}

async def fetch_customer(session, sem, email, acct_type):
    user_id = email + SUFFIXES[acct_type]
    url = f'{LITELLM_URL}/customer/info'
    headers = {'Authorization': f'Bearer {LITELLM_KEY}'}
    async with sem:
        try:
            async with session.get(url, params={'end_user_id': user_id},
                                   headers=headers, ssl=False) as resp:
                if resp.status == 200:
                    return acct_type, email, await resp.json()
                return acct_type, email, None
        except Exception:
            return acct_type, email, None

async def fetch_all(emails):
    sem = asyncio.Semaphore(25)
    connector = aiohttp.TCPConnector(ssl=False)
    results = {}
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = [
            fetch_customer(session, sem, email, acct)
            for email in emails
            for acct in ('web', 'cli', 'premium')
        ]
        for coro in asyncio.as_completed(tasks):
            acct_type, email, data = await coro
            results.setdefault(email, {})[acct_type] = data
    return results

raw = asyncio.run(fetch_all(emails))
```

**LiteLLM response shape** (one per `end_user_id`):

```json
{
  "user_id": "first_last@domain.com_codemie_cli",
  "spend": 151.92,
  "max_budget": 150.0,
  "soft_budget": 100.0,
  "budget_duration": "30d",
  "budget_reset_at": "2026-05-01T00:00:00",
  "blocked": false,
  "allowed_model_region": null,
  "allowed_routes": null
}
```

---

### Step 3 — Build the enriched users array

```python
def extract_budget(acct_data):
    if not acct_data:
        return None
    return {
        'soft':     acct_data.get('soft_budget'),
        'max':      acct_data.get('max_budget'),
        'duration': acct_data.get('budget_duration'),
        'blocked':  acct_data.get('blocked', False),
    }

users = []
for email in emails:
    r = raw.get(email, {})
    web_d  = r.get('web')
    cli_d  = r.get('cli')
    prem_d = r.get('premium')

    web_spend  = float(web_d.get('spend', 0))  if web_d  else 0.0
    cli_spend  = float(cli_d.get('spend', 0))  if cli_d  else 0.0
    prem_spend = float(prem_d.get('spend', 0)) if prem_d else 0.0

    users.append({
        'email':          email,
        'web_spend':      round(web_spend,  4),
        'cli_spend':      round(cli_spend,  4),
        'premium_spend':  round(prem_spend, 4),
        'total_spend':    round(web_spend + cli_spend + prem_spend, 4),
        'in_litellm':     any([web_d, cli_d, prem_d]),
        'web_budget':     extract_budget(web_d),
        'cli_budget':     extract_budget(cli_d),
        'premium_budget': extract_budget(prem_d),
    })

users.sort(key=lambda u: u['total_spend'], reverse=True)
```

**Save to intermediate file** (`/tmp/users_v2.json`) so you can re-run the HTML build
without re-fetching the API:

```python
with open('/tmp/users_v2.json', 'w') as f:
    json.dump(users, f)
```

---

### Step 4 — Fetch CodeMie analytics for modal enrichment

These calls are optional — they add AI Champion and CLI sections to the per-user modal.
Run them **after** the LiteLLM fetch to avoid redundant work.

#### 4a. Leaderboard (paginated — fetch ALL pages)

```python
import subprocess

all_lb_rows = []
CLI = os.path.expanduser('~/.claude/skills/codemie-analytics/scripts/analytics-cli.js')

for page in range(1, 100):  # break on has_more=false
    result = subprocess.run(
        ['node', CLI, 'leaderboard', '--per-page', '500', '--page', str(page), '--output', 'json'],
        capture_output=True, text=True
    )
    data = json.loads(result.stdout)
    all_lb_rows.extend(data['data']['rows'])
    if not data['pagination']['has_more']:
        break

lb_by_email = {r['user_email'].lower(): r for r in all_lb_rows if r.get('user_email')}
```

**Leaderboard row shape:**

```json
{
  "rank": 491,
  "user_email": "sergiy_example@epam.com",
  "user_name": "Sergiy Example",
  "total_score": 35.49,
  "tier_name": "practitioner",
  "d1_score": 49.7,
  "d2_score": 17.5,
  "d3_score": 0,
  "d4_score": 0,
  "d5_score": 63.8,
  "d6_score": 29.2,
  "usage_intent": "developer",
  "usage_intent_label": "💻 Developer"
}
```

> **Scale note**: The leaderboard has ~12,000+ users. With 500 per page, expect ~25 pages
> (~30–60 seconds total). Typically 60–65% of a 650-person cohort will appear in the
> leaderboard (users who haven't engaged at all may not have a record).

#### 4b. CLI Insights top spenders

```python
result = subprocess.run(
    ['node', CLI, 'cli-insights-users', '--time-period', 'last_30_days',
     '--per-page', '500', '--output', 'json'],
    capture_output=True, text=True
)
cli_data = json.loads(result.stdout)
cli_rows = cli_data.get('topBySpend', {}).get('data', {}).get('rows', [])
cli_by_email = {r['user_email'].lower(): r for r in cli_rows if r.get('user_email')}
```

**CLI Insights row shape (topBySpend):**

```json
{
  "user_id": "...",
  "user_name": "Danil Melnikov",
  "user_email": "danil_melnikov@epam.com",
  "classification": "production",
  "total_sessions": 134,
  "total_lines_added": 124675,
  "total_lines_removed": 2666,
  "net_lines": 122009,
  "total_cost": 1251.27
}
```

> **Coverage note**: `topBySpend` returns only the top 500 CLI users globally. For cohorts
> of 600+ people, only ~3–5% of your list will appear here. This is expected — use it for
> the "power CLI users" section of the modal.

#### 4c. Build the analytics lookup

```python
analytics = {}
for email in [u['email'] for u in users]:
    entry = {}

    if email in lb_by_email:
        lb = lb_by_email[email]
        entry['lb'] = {
            'rank':  lb.get('rank'),
            'tier':  lb.get('tier_name'),
            'score': lb.get('total_score'),
            'intent': lb.get('usage_intent_label'),
            'd1': lb.get('d1_score'), 'd2': lb.get('d2_score'),
            'd3': lb.get('d3_score'), 'd4': lb.get('d4_score'),
            'd5': lb.get('d5_score'), 'd6': lb.get('d6_score'),
        }

    if email in cli_by_email:
        c = cli_by_email[email]
        entry['cli'] = {
            'sessions':       c.get('total_sessions'),
            'lines_added':    c.get('total_lines_added'),
            'lines_removed':  c.get('total_lines_removed'),
            'net_lines':      c.get('net_lines'),
            'classification': c.get('classification'),
            'cost':           c.get('total_cost'),
        }

    if entry:
        analytics[email] = entry

with open('/tmp/analytics_enriched.json', 'w') as f:
    json.dump(analytics, f)
```

---

### Step 5 — Compute dashboard KPIs

```python
total_users   = len(users)
active_users  = sum(1 for u in users if u['total_spend'] > 0)
in_litellm    = sum(1 for u in users if u['in_litellm'])
web_total     = round(sum(u['web_spend']     for u in users), 2)
cli_total     = round(sum(u['cli_spend']     for u in users), 2)
premium_total = round(sum(u['premium_spend'] for u in users), 2)
grand_total   = round(sum(u['total_spend']   for u in users), 2)

active_spends = [u['total_spend'] for u in users if u['total_spend'] > 0]
avg_active    = round(sum(active_spends) / len(active_spends), 2) if active_spends else 0

# Budget projection
OVERHEAD_FACTOR = 1.20   # 20% buffer
budget_projection = round(avg_active * total_users * OVERHEAD_FACTOR, 2)

stats = {
    'total_users': total_users,
    'active_users': active_users,
    'in_litellm': in_litellm,
    'web_total': web_total,
    'cli_total': cli_total,
    'premium_total': premium_total,
    'grand_total': grand_total,
    'avg_active': avg_active,
    'budget_projection': budget_projection,
    'overhead_factor': OVERHEAD_FACTOR,
}
```

**Budget projection formula:**

```
Monthly Program Budget = avg_spend_per_active_user × total_program_users × 1.20
```

The 1.20 factor adds a 20% buffer for usage spikes and new users ramping up.
Use this in a "Budget Projection" widget, not as a hard cost figure.

---

### Step 6 — Compute spend distribution histogram

Used for the "Spend Distribution" bar chart:

```python
import math

def spend_bucket(s):
    if s == 0:    return 'No spend'
    if s < 5:     return '$0–$5'
    if s < 20:    return '$5–$20'
    if s < 50:    return '$20–$50'
    if s < 150:   return '$50–$150'
    return '$150+'

from collections import Counter
ranges = Counter(spend_bucket(u['total_spend']) for u in users)
# Ordered for display:
ordered_ranges = ['No spend','$0–$5','$5–$20','$20–$50','$50–$150','$150+']
ranges = {k: ranges.get(k, 0) for k in ordered_ranges}
```

---

### Step 7 — Generate HTML (use the template file + token replacement)

**There is a ready-made template HTML file** shipped with this skill:
[`references/people-spending-dashboard-template.html`](people-spending-dashboard-template.html)

It is a complete dark-themed dashboard with inlined CSS, Chart.js, header, 8 stat cards,
budget projection card, 3 charts, paginated user table, and user detail modal (with
AI Champion and CLI sections) — the full structure with all data replaced by `__TOKEN__`
placeholders.

**Token reference** (17 placeholders, grouped by purpose):

| Token | Type | What to fill in |
|-------|------|-----------------|
| `__DASHBOARD_TITLE__` | string (×2 — `<title>` + `<h1>`) | e.g. `Bootcamp Spending Dashboard`, `Team Alpha Spending` |
| `__TOTAL_USERS__` | int (×4 — subtitle, stat card, base estimate, caption) | Total rows in the source list |
| `__REPORT_DATE__` | string (×1 — subtitle) | Generation date, e.g. `April 21, 2026` |
| `__SUBTITLE_NOTES__` | HTML (×1 — subtitle) | Empty `''` by default, or a note like `&nbsp;&middot;&nbsp; <span style="color:var(--color-warning-text);">Web/Platform: prior-cycle summed in</span>` |
| `__GRAND_TOTAL__` | string (×1 — stat card) | e.g. `$8,822.48` |
| `__WEB_TOTAL__` | string (×1 — stat card) | e.g. `$1,731.87` |
| `__CLI_TOTAL__` | string (×1 — stat card) | e.g. `$7,023.29` |
| `__PREMIUM_TOTAL__` | string (×1 — stat card) | e.g. `$67.32` |
| `__IN_LITELLM__` | int (×1 — stat card) | Users with any LiteLLM record |
| `__ACTIVE_USERS__` | int (×1 — stat card) | Users with `total_spend > 0` |
| `__AVG_SPEND__` | string (×4 — stat card + projection block) | e.g. `$16.46` — per active user |
| `__BASE_ESTIMATE__` | string (×1 — projection block) | `$avg × total_users`, e.g. `$10,798` |
| `__BUFFER_AMOUNT__` | string (×1 — projection block) | +20% of base, e.g. `+$2,160` |
| `__BUDGET_PROJECTION__` | string (×1 — projection block) | `avg × users × 1.20`, e.g. `$12,957` |
| `__ALL_USERS_JSON__` | JSON array | Users array (see Step 3) |
| `__STATS_JSON__` | JSON object | Computed stats (see Step 5) |
| `__RANGES_JSON__` | JSON object | Spend bucket counts (see Step 6) |
| `__ANALYTICS_JSON__` | JSON object | Per-email leaderboard + CLI data (see Step 4c) |

**When embedding data in HTML with Python, AVOID f-strings for the script block.**
JavaScript uses `${...}` template literals, which conflict with Python f-string syntax.
Use plain string concatenation or `str.replace()` with named tokens (as below):

```python
import json, shutil

# 1. Copy template to output location
template_path = '~/.claude/skills/codemie-analytics/references/people-spending-dashboard-template.html'
output_path = 'reports/my-spending-dashboard.html'
shutil.copy(os.path.expanduser(template_path), output_path)

with open(output_path) as f:
    html = f.read()

# 2. JSON blobs
html = html.replace('__ALL_USERS_JSON__',  json.dumps(users,     separators=(',', ':')))
html = html.replace('__STATS_JSON__',      json.dumps(stats,     separators=(',', ':')))
html = html.replace('__RANGES_JSON__',     json.dumps(ranges,    separators=(',', ':')))
html = html.replace('__ANALYTICS_JSON__',  json.dumps(analytics, separators=(',', ':')))

# 3. Header / title
html = html.replace('__DASHBOARD_TITLE__', 'Bootcamp Spending Dashboard')
html = html.replace('__TOTAL_USERS__', str(stats['total_users']))
html = html.replace('__REPORT_DATE__', 'April 21, 2026')
html = html.replace('__SUBTITLE_NOTES__', '')   # or methodology note if applicable

# 4. Stat card values (currency strings pre-formatted with commas)
html = html.replace('__GRAND_TOTAL__',   f"${stats['grand_total']:,.2f}")
html = html.replace('__WEB_TOTAL__',     f"${stats['web_total']:,.2f}")
html = html.replace('__CLI_TOTAL__',     f"${stats['cli_total']:,.2f}")
html = html.replace('__PREMIUM_TOTAL__', f"${stats['premium_total']:,.2f}")
html = html.replace('__IN_LITELLM__',    str(stats['in_litellm']))
html = html.replace('__ACTIVE_USERS__',  str(stats['active_users']))
html = html.replace('__AVG_SPEND__',     f"${stats['avg_active']:.2f}")

# 5. Budget projection block
base = round(stats['avg_active'] * stats['total_users'])
buff = round(base * 0.20)
html = html.replace('__BASE_ESTIMATE__',      f'${base:,}')
html = html.replace('__BUFFER_AMOUNT__',      f'+${buff:,}')
html = html.replace('__BUDGET_PROJECTION__',  f"${stats['budget_projection']:,.0f}")

with open(output_path, 'w') as f:
    f.write(html)
```

**Important — leftover tokens check:** after all replacements run,
`grep -c '__[A-Z_]\+__' output.html` should return **0**. Any remaining `__TOKEN__`
means a data field was missed.

---

## Page Structure

```
<body class="p-6">
  <div class="container">

    [Page header]
      h1 "Bootcamp Spending Dashboard"
      p.text-muted  "Generated: <date> · Source: LiteLLM"

    [Top KPI row — 4 stat cards]
      Grand Total Spend   (blue)
      Web / Platform      (green)
      CLI                 (purple)
      Premium Models      (orange)

    [Second KPI row — 4 stat cards]
      Participants         (total list size)
      In LiteLLM          (users found in API)
      Active Spenders      (spend > 0)
      Avg Total Spend      (per active user)

    [Budget Projection card — info border]
      Large $XX,XXX/month figure
      Formula: avg_active × total_users × 1.20

    [Charts row — side by side, align-items: start]
      .card  Spend Distribution (vertical bar, height 250px)
      .card  Top 10 by Total Spend (horizontal stacked bar, height 460px)

    [Spend Breakdown by Type — full width bar chart, height 240px]
      Stacked: web + cli + premium per user (top 20)

    [User Table card]
      Search input + sortable columns
      Columns: User · Web · CLI · Premium · Total · Status
      Each row is clickable → opens detail modal
      Pagination (20 per page)

    [User Detail Modal]
      (see modal section below)

  </div>
</body>
```

---

## Components Used (CodeMie Design System)

| Component | Class(es) | Usage |
|-----------|-----------|-------|
| Stat cards | `.stat-grid` / `.stat-card` | KPI tiles at top |
| Card | `.card` / `.card-header` / `.card-body` | All sections |
| Table | `.table-wrapper` / `.table` | User list |
| Badge | `.badge .badge-success/error/warning/...` | Status, tier, classification |
| Alert | `.alert .alert-info` | Budget projection highlight |
| Progress bar | `.progress-bar-wrap` / `.progress-bar-fill` | Budget usage bars in modal |
| DL grid | `.dl-grid` | Key-value detail rows in modal |
| Pagination | `.pagination` / `.page-btn` | Table pagination |

---

## Charts

### 1. Spend Distribution (vertical bar)
- **Type**: `bar` (vertical, `indexAxis: 'x'`)
- **Data**: Count of users per spend bucket: `No spend`, `$0–$5`, `$5–$20`, `$20–$50`, `$50–$150`, `$150+`
- **Colour**: Single colour `#2297F6` (primary blue)
- **Canvas**: `id="rangeChart"`, `height: 250px`

### 2. Top 10 by Total Spend (horizontal stacked bar)
- **Type**: `bar`, `indexAxis: 'y'`
- **Data**: Top 10 users' web + cli + premium spend, stacked
- **Colours**: Web `#259F4C` (green) · CLI `#C084FC` (purple) · Premium `#F5A534` (orange)
- **Bar thickness**: `barThickness: 28`
- **Canvas**: `id="topChart"`, `height: 460px`
- **Key CSS**: The container grid must use `align-items: start` so charts can have independent heights without stretching to match their neighbour.

```html
<div class="charts-row" style="align-items: start;">
  <div class="card">...<canvas id="rangeChart" style="height:250px">...</div>
  <div class="card">...<canvas id="topChart"  style="height:460px">...</div>
</div>
```

### 3. Spend Breakdown by Type (horizontal stacked bar, full width)
- **Type**: `bar`, `indexAxis: 'y'`
- **Data**: Top 20 users by total spend, each bar split into web + cli + premium
- **Canvas**: `id="breakdownChart"`, `height: 240px`
- **This chart is separate from the Top 10** — it is full-width, below the side-by-side pair.

---

## User Detail Modal

Opens when any table row is clicked. Closes on Escape, close button, or backdrop click.

**Layout** (top to bottom):

```
[Total spend]          — Large blue number ($XX.XX)
[Status badge]         — "Active" (green) or "No spend" (gray) + "Combined LiteLLM spend" label

[Spend breakdown row]  — 3-column grid: Web · CLI · Premium (coloured values)

[Budget Details]       — Per-account budget blocks (Web, CLI, Premium)
  Each block shows:
    Spend · Soft limit · Hard limit · Cycle duration
    Budget used % progress bar (green/orange/red)

[AI Champion Profile]  — Only if user appears in the leaderboard (~62% of users)
  Tier badge + usage intent label
  Score (large number) / 100 + Rank #N
  D1–D6 dimension bars (coloured horizontal bars, 0–100 scale)

[CLI Activity]         — Only if user is in top 500 CLI spenders globally
  Classification badge
  Sessions / Lines Added (+green) / Lines Removed (-red) / Net lines
```

**Modal max-width**: `580px`. Set `max-height: 90vh; overflow-y: auto` so long modals scroll.

### Tier → badge class mapping

| Tier | Badge class | Emoji |
|------|-------------|-------|
| pioneer | `badge-advanced` | 🏆 |
| expert | `badge-in-progress` | ⭐ |
| advanced | `badge-success` | 🔥 |
| practitioner | `badge-warning` | 📈 |
| newcomer | `badge-not-started` | 🌱 |

### D1–D6 dimension bar colours

| Dimension | Label | Weight | Colour |
|-----------|-------|--------|--------|
| D1 | Platform Usage | 20% | `#2297F6` (blue) |
| D2 | Platform Creation | 20% | `#C084FC` (purple) |
| D3 | Workflow Usage | 10% | `#259F4C` (green) |
| D4 | Workflow Creation | 10% | `#F5A534` (orange) |
| D5 | CLI & Agentic | 30% | `#06B6D4` (cyan) |
| D6 | Impact & Knowledge | 10% | `#F9303C` (red) |

### Table click — use event delegation (NOT onclick attributes)

```javascript
// CORRECT — works for dynamically rendered rows
document.getElementById('tableBody').addEventListener('click', function(e) {
  const row = e.target.closest('tr[data-email]');
  if (row) openModal(row.getAttribute('data-email'));
});

// Table row HTML
`<tr data-email="${encodeURIComponent(user.email)}">...</tr>`

// In openModal:
function openModal(enc) {
  const email = decodeURIComponent(enc);
  const u = ALL_USERS.find(x => x.email === email);
  const an = ANALYTICS_DATA[email] || {};
  ...
}
```

> **Why not onclick=""?** Python string templating mangles single-quote escaping inside
> HTML attribute strings, producing broken JS like `openModal('' + encodeURIComponent(...))`.
> `data-*` attributes + event delegation is immune to this quoting problem.

---

## JavaScript Variables Embedded in HTML

| Variable | Type | Source | Size (approx) |
|----------|------|--------|---------------|
| `ALL_USERS` | `Array<UserObject>` | LiteLLM `/customer/info` | ~200–400 KB for 600+ users |
| `STATS` | `Object` | Computed from ALL_USERS | < 1 KB |
| `RANGES` | `Object` | Spend bucket counts | < 1 KB |
| `ANALYTICS_DATA` | `Object<email, AnalyticsEntry>` | Leaderboard + CLI insights | ~60–100 KB for 400+ matches |

`ANALYTICS_DATA` is keyed by lowercase email. Entries are sparse — only users found in at
least one analytics source have an entry. Always default to `{}` on lookup:

```javascript
const an = ANALYTICS_DATA[email] || {};
const lb  = an.lb  || null;   // leaderboard data (may be null)
const cli = an.cli || null;   // CLI insights data (may be null)
```

---

## Status / Budget Colour Logic

```javascript
function budgetClass(pct) {
  if (pct >= 100) return 'fill-over';   // red
  if (pct >= 75)  return 'fill-warn';   // orange
  return 'fill-ok';                     // green
}
// pct = (spend / soft_budget) * 100, capped at 100
```

Row-level status badge in the table:

| Condition | Badge |
|-----------|-------|
| `total_spend === 0` | `badge-not-started` — "No spend" |
| `total_spend > 0` | `badge-success` — "Active" (with dot) |

---

## Spend Table — Columns and Sorting

| Column | Data field | Alignment | Default sort |
|--------|-----------|-----------|-------------|
| User (email prefix) | `email` | left | — |
| Web | `web_spend` | right (`td-number`) | — |
| CLI | `cli_spend` | right | — |
| Premium | `premium_spend` | right | — |
| Total | `total_spend` | right | **desc** (default) |
| Status | derived from `total_spend` | center | — |

Clicking a column header toggles ascending/descending sort. Active column shows
a caret (`▲`/`▼`). Search filters on email prefix (case-insensitive).

Pagination: 20 rows per page. Show "Showing X–Y of Z" counter and page buttons.

---

## File Location Convention

```
reports/
├── bootcamp-spending-dashboard.html        ← cohort spending dashboard
├── spending-<team>-<YYYY-MM>.html          ← team/project variant
└── spending-<project>-snapshot.html        ← snapshot for a specific project
```

---

## Replication Checklist

When building a new people spending dashboard:

1. **Parse the list** — extract emails from Excel/CSV (check header/total rows).
2. **Fetch LiteLLM** — use Python asyncio + aiohttp, semaphore(25), `ssl=False`,
   `end_user_id` param. Fetch 3 accounts per user (web, cli, premium suffixes).
3. **Save raw results** to `/tmp/litellm_raw.json` — avoids re-fetching on HTML rebuild.
4. **Build users array** — sum the three spend values, extract budget fields.
5. **Fetch leaderboard** — paginate all pages (`--per-page 500`), build email lookup.
6. **Fetch CLI insights** — `cli-insights-users --per-page 500`, build email lookup.
7. **Build analytics dict** — merge leaderboard + CLI into `ANALYTICS_DATA[email]`.
8. **Compute KPIs** — totals, averages, spend distribution, budget projection (avg × N × 1.20).
9. **Inline CSS** — read all 8 CodeMie CSS files, concatenate into `<style>`.
10. **Use token-safe templating** — `str.replace()` with `__TOKEN__` markers, not f-strings.
11. **Wire table clicks** — `data-email` attribute + event delegation (no onclick= attributes).
12. **Verify** — open in browser, click rows, confirm modal shows spend + analytics sections.
13. **Save** to `reports/<descriptive-name>.html`.

---

## Tips and Gotchas

| Issue | Cause | Fix |
|-------|-------|-----|
| 422 from LiteLLM | Using `user_id` param | Use `end_user_id` param |
| JS `onclick` broken | Python quote escaping in template strings | Use `data-email` + event delegation |
| Top 10 chart labels cut off | CSS Grid `align-items: stretch` makes both cards same height | Add `align-items: start` to `.charts-row` container |
| `KeyError: 'user_email'` in CLI spend | CLI rows use `user_name` key (not `user_email`) | Use correct key per data source |
| Only ~60% of users in leaderboard | Users with zero activity have no record | Expected — show analytics section only if `an.lb !== null` |
| CLI insights coverage only ~3% of cohort | `topBySpend` returns top 500 globally; small cohort ranks low | Expected — only show CLI section when data exists |
| Large HTML file (300+ KB) | ALL_USERS JSON for 600+ users is large | Acceptable for offline report; no performance issue in browser |
| Python f-string vs JS template literal conflict | `${...}` in JS conflicts with Python f-string syntax | Use plain string `TEMPLATE` with `__TOKEN__` replace() |
| Refreshed dashboard shows stale top-card values | Original template hardcoded stat-card values into HTML (not reading from `STATS` JS var) | On a refresh, patch BOTH the JS vars AND the hardcoded HTML. Hardcoded spots to update: `<span class="stat-card-value">$X</span>` (×8 cards), budget projection block (`$12,713` figure + base estimate + "+20% buffer" line + "avg $X × 656 × 1.20" caption). Also the `<h1>` date text. |
