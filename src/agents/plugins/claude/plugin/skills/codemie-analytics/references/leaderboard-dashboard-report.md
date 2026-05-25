# Leaderboard Dashboard HTML Report — Reference

> **Purpose**: This document describes the canonical leaderboard HTML report built for
> CodeMie AI/Run analytics. Use it as a template spec when generating new leaderboard
> dashboards so all reports are consistent in structure, components, and UX.

---

## Overview

The leaderboard report is a **self-contained single-file HTML dashboard** that combines
leaderboard ranking data (from the analytics API) with EPAM profile data (from OneHub).
It is dark-themed by default, uses the CodeMie design system (inlined CSS), and Chart.js
for all visualisations.

**Key properties:**
- No external CSS dependencies (all 8 CodeMie CSS files inlined in `<style>`)
- Google Fonts (`Inter`, `JetBrains Mono`) loaded via `@import`
- Chart.js 4.4.0 loaded via CDN (`https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js`)
- All data stored in a `PEOPLE` JavaScript array — no runtime API calls
- Fully portable: open directly in any browser

---

## Data Sources

| Source | How fetched | What it provides |
|--------|------------|------------------|
| Analytics API | `leaderboard-top <N> --pretty` via `analytics-cli.js` | Rank, score, tier, D1–D6 dimension scores |
| Analytics API | `leaderboard-summary --pretty` | KPI totals (champion count, top score, tier breakdown) |
| EPAM OneHub | `epam-peopleassignments-finder` agent (parallel batches of 5) | Job title, department, location, active projects, skills |

---

## Page Structure

```
<header>            — Dashboard title + tier summary badges
<info-bar>          — Alert banner explaining the scoring model
<stat-grid>         — 5 KPI cards (champions tracked, top score, avg score, countries, avg D5)
<card>              — Leaderboard Rankings card
  <tabs>            — Rankings Table / Score Chart / Dimension Analysis / Geography
    [Tab 1] Rankings Table     — sortable table with inline dimension bars + EPAM data
    [Tab 2] Score Chart        — horizontal bar chart of all 15 scores
    [Tab 3] Dimension Analysis — radar chart (group avg) + dimension summary bars
    [Tab 4] Geography          — location pie chart + primary skill pie chart + geo list
<section>           — Talent Distribution (location pie + skill pie side by side)
<modal>             — User detail modal (opens on row click)
```

---

## Components Used (CodeMie Design System)

| Component | Class(es) | Usage |
|-----------|-----------|-------|
| Stat cards | `.stat-grid` / `.stat-card` | KPI tiles at the top |
| Card | `.card` / `.card-header` / `.card-body` | Main leaderboard container |
| Tabs | `.tabs` / `.tabs-list` / `.tab-item` / `.tabs-panel` | Four views inside the card |
| Table | `.table` | Rankings table |
| Badges (tier) | `.tier-pioneer` / `.tier-expert` | Tier labels (custom classes, styled inline) |
| Rank badge | `.rank-badge .rank-1/2/3/rank-other` | Numbered rank circles |
| Avatar | `.avatar .avatar-color-N` | User initials, 21 colour variants |
| Tags | `.tag` / `.tag-sm` / `.tag-blue` | Project codes and skill labels |
| Alert | `.alert .alert-info` | Scoring model info banner |
| Modal overlay | `.modal-overlay` | Backdrop for user detail modal |
| Pagination | `.pagination` / `.page-btn` | (added if list > one page) |

---

## Charts

### 1. Score Bar Chart (Tab 2 — "Score Chart")
- **Type**: Horizontal bar (`Chart.js` — `bar`, `indexAxis: 'y'`)
- **Data**: Each person's `score` value (0–100)
- **Colours**: Pioneer bars use purple (`#C084FC`); Expert bars use blue (`#2297F6`)
- **Canvas**: `id="scoreBarChart"`
- **Lazy init**: Initialised only when the tab is first activated (`window._scoreChartInit` flag)

### 2. Radar Chart — Group Averages (Tab 3 — "Dimension Analysis")
- **Type**: Radar (`Chart.js` — `radar`)
- **Data**: Average D1–D6 scores across all 15 people
- **Labels**: `D1 Platform Use`, `D2 Platform Create`, `D3 Workflow Use`, `D4 Workflow Create`, `D5 CLI & Agentic`, `D6 Impact`
- **Canvas**: `id="radarChart"`
- **Lazy init**: `window._radarInit` flag

### 3. Location Pie Chart (Tab 4 + Talent Distribution section)
- **Type**: Doughnut (`Chart.js` — `doughnut`)
- **Data**: Grouped count of people per location country
- **Canvas**: `id="locationPieChart"`
- **Legend**: Custom HTML legend `id="location-legend"` rendered beside the chart
- **Lazy init**: `window._locationPieInit` flag

### 4. Primary Skill Pie Chart (Tab 4 + Talent Distribution section)
- **Type**: Doughnut (`Chart.js` — `doughnut`)
- **Data**: First skill of each person, normalised via `primarySkill()`:
  - `SET.Java` → `Java`
  - `Python.Core` → `Python`
  - `Support.Users` → `User Support`
  - `Software Development Management` → `Mgmt`
- **Canvas**: `id="skillPieChart"`
- **Legend**: Custom HTML legend `id="skill-legend"`
- **Lazy init**: `window._skillPieInit` flag

### 5. Modal Radar Chart (User detail modal)
- **Type**: Radar (`Chart.js` — `radar`)
- **Data**: Individual person's D1–D6 scores vs group average (two datasets)
- **Canvas**: `id="modal-radar-canvas"`
- **Lifecycle**: Destroyed on modal close (`_modalRadar.destroy()`), recreated on each open to avoid canvas reuse errors
- **Colours**: Pioneer → `#C084FC` (purple), Expert → `#2297F6` (blue)

---

## User Detail Modal

Opens when any table row is clicked. Closes on Escape, close button click, or overlay click.

**Layout:**

```
[modal-hero]          — Gradient header (purple tint = pioneer, blue tint = expert)
  [avatar 88px]       — Initials, colour from PEOPLE.color index
  [name + title]      — Full name, job title, rank badge, tier badge
  [score block]       — Champion score in large numerals (glassmorphism card)
  [close btn]         — Absolute top-right, frosted glass style

[info-tiles]          — 3-column grid: Location · Department · Active Projects

[modal-body two-col]
  Left column:
    [Dimension Breakdown]  — 6 rows, each: colour dot · label · weight% · bar · pct%
                             CSS grid: 14px 1fr 36px 1fr 44px
  Right column:
    [Performance Radar]    — 240px canvas, person vs group avg
    [Skills]               — tag chips for all skills
    [EPAM Projects]        — blue tag chips for project codes
```

**Key element IDs:**

| ID | Content |
|----|---------|
| `modal-hero-bg` | Hero div — background gradient set by JS |
| `modal-avatar` | Avatar div — initials + inline background colour |
| `modal-name` | Person's full name |
| `modal-subtitle` | Job title |
| `modal-rank-badge` | Rank badge HTML |
| `modal-tier-badge` | Tier badge HTML |
| `modal-score-val` | Score number (`color` set by tier) |
| `modal-location` | Location tag chip |
| `modal-dept` | Department text |
| `modal-projects-tile` | First 2 project chips in info tile |
| `modal-dim-bars` | Dimension breakdown rows (injected by JS) |
| `modal-radar-canvas` | Radar chart canvas |
| `modal-skills` | Skill tags |
| `modal-projects` | Full project tag list |

---

## PEOPLE Data Array

Each entry in the `PEOPLE` array merges leaderboard + EPAM data:

```javascript
{
  rank:     Number,      // 1–N
  name:     String,      // Full display name
  initials: String,      // 2-letter initials for avatar
  color:    Number,      // 0–20, maps to avatar colour palette
  score:    Number,      // Total champion score (e.g. 81.22)
  tier:     String,      // "pioneer" | "expert" | "advanced" | "practitioner" | "newcomer"
  d1:       Number,      // Core Platform Usage score (0–1)
  d2:       Number,      // Core Platform Creation score (0–1)
  d3:       Number,      // Workflow Usage score (0–1)
  d4:       Number,      // Workflow Creation score (0–1)
  d5:       Number,      // CLI & Agentic Engineering score (0–1)
  d6:       Number,      // Impact & Knowledge score (0–1)
  title:    String,      // EPAM job title
  dept:     String,      // EPAM department / unit name
  location: String,      // Country from EPAM profile
  projects: String[],    // EPAM active project codes
  skills:   String[]     // EPAM primary skills list
}
```

---

## Scoring Dimensions Reference

| ID | Label | Weight | Description |
|----|-------|--------|-------------|
| D1 | Core Platform Usage | 20% | Conversations, assistant interactions |
| D2 | Core Platform Creation | 20% | Assistants, datasources created |
| D3 | Workflow Usage | 10% | Workflow executions |
| D4 | Workflow Creation | 10% | Workflows authored |
| D5 | CLI & Agentic Engineering | 30% | Coding agent sessions, tokens, repos |
| D6 | Impact & Knowledge | 10% | Marketplace publishing, knowledge sharing |

**Tier thresholds:** Pioneer ≥ 80 · Expert ≥ 65 · Advanced ≥ 45 · Practitioner ≥ 25 · Newcomer < 25

---

## Replication Checklist

When building a new leaderboard dashboard for a different user or time period:

1. Run `leaderboard-top <N>` + `leaderboard-summary` + `leaderboard-tiers` + `leaderboard-dimensions`
2. For each person, call `epam-peopleassignments-finder` in parallel batches of 5
3. Merge leaderboard scores with EPAM profile data into `PEOPLE` array
4. Inline all 8 CodeMie CSS files (or link `style-guide.css` if available)
5. Include Chart.js 4.4.0 CDN script
6. Build tabs: Rankings Table · Score Chart · Dimension Analysis · Geography
7. Add user-detail modal with hero header + info tiles + dim bars + radar + skills
8. Save to `reports/<descriptive-name>.html`

---

## File Location Convention

```
reports/
├── leaderboard-top15-<date>.html     ← top-N snapshot
├── leaderboard-<season>.html         ← e.g. leaderboard-2026-Q1.html
└── leaderboard-monthly-<YYYY-MM>.html
```
