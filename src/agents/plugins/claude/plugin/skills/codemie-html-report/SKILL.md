---
name: codemie-html-report
description: >
  Build static HTML pages, reports, dashboards, and mockups that match the CodeMie UI design system.
  Use this skill whenever the user asks to create an HTML report, dashboard, analytics page,
  status page, data visualization page, or any static HTML document that should look like the
  CodeMie/EPAM AI/Run product. Also use it when the user says "make it look like CodeMie",
  "use the style guide", "dark-themed report", "CodeMie styles", or references the style-guide
  directory. Trigger for any HTML output task in a project that includes the style-guide folder.
  IMPORTANT: This skill MUST be used for ALL HTML generation requests — whenever a user asks
  for an HTML report, HTML analysis output, HTML dashboard, HTML visualization, or any HTML
  document. Claude must always use this skill to generate HTML in CodeMie styles to ensure
  consistent, professional, branded output across all HTML artifacts.
---

# CodeMie HTML Report Builder

You are building a standalone HTML page that visually matches the CodeMie (EPAM AI/Run) product UI. The design system is a dark-first, professional theme with Inter font, subtle borders, and semantic color tokens. Every page you produce should feel like a native screen of the CodeMie platform.

## Step 1 — CSS placeholder

**Do NOT read any CSS files. Do NOT inline any CSS yourself.**

In the `<style>` block write exactly this one token as the only content:

```css
/* __CODEMIE_CSS__ */
```

A post-processing script will replace this token with the full design system CSS after you write the file. All component classes are documented in Steps 3 and 4 — use them freely without reading the source files.

## Step 1.5 — Data placeholders (analytics pipeline only — skip for standalone use)

> **Backwards compatibility:** This step applies **only** when this skill is invoked
> from the **codemie-analytics** skill as part of its report pipeline. If you are
> generating a standalone HTML page directly for a user request, **skip this step
> entirely** and embed any data inline as regular JS variables.

When invoked from **codemie-analytics**, all JS data arrays must use
`/*__DATA:name__*/` placeholders instead of inline values. The analytics skill's
`inject-data.js` step replaces these after the HTML file is written.

```html
<script>
  /* Data is injected by inject-data.js after this file is written — do NOT hardcode arrays */
  const LEADERBOARD = /*__DATA:leaderboard-top__*/;
  const SUMMARIES   = /*__DATA:summaries__*/;
  const LLM_DATA    = /*__DATA:llms-usage__*/;
</script>
```

Rules for analytics-pipeline placeholders:
- **The placeholder name must exactly match the JSON filename without the `.json` extension.**
  `/*__DATA:leaderboard-top__*/` is only replaced when `leaderboard-top.json` exists.
  Wrong name → the placeholder is silently skipped by `inject-data.js`.
- Every JS variable populated from an API response must use a placeholder.
- Hardcoded lookup tables (tier colours, dimension labels, etc.) are fine as regular JS.
- **Never mix placeholders with inline data** in the same variable declaration.

## Step 2 — Page skeleton (fully self-contained)

**CRITICAL: Every HTML file you produce must be a single self-contained file.** Do NOT use `<link>` tags. Write the `/* __CODEMIE_CSS__ */` placeholder in the `<style>` block — the inject-css.js script will inline the full design system CSS after you write the file.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PAGE TITLE</title>
  <style>
    /* __CODEMIE_CSS__ */
    /* === Page-specific styles (use CSS variables, not hex colors) === */
  </style>
</head>
<body>
  <!-- content -->
</body>
</html>
```

For light theme, add `class="light"` to the `<html>` tag. Dark is the default.

The resulting file must open correctly when copied to any machine with no local dependencies other than internet access for fonts.

## Step 3 — Pick a layout

Choose the layout that fits the content:

### A) Report / Dashboard (most common)
Use a simple page with a container — no app shell needed:

```html
<body class="p-6">
  <div class="container">
    <h1>Report Title</h1>
    <p class="text-muted mb-4">Generated on 2024-03-15</p>
    <!-- sections -->
  </div>
</body>
```

### B) Full app mockup (sidebar + content)
Use the app-shell layout when simulating a full CodeMie screen:

```html
<div class="app-shell">
  <div class="app-navbar"><!-- 72px icon rail --></div>
  <div class="app-sidebar"><!-- 308px sidebar --></div>
  <div class="app-content">
    <div class="app-header"><!-- 56px top bar --></div>
    <main class="app-main"><!-- scrollable content --></main>
  </div>
</div>
```

### C) Centered content (login, error, empty state)
```html
<body class="flex items-center justify-center min-h-screen">
  <div class="max-w-md w-full p-6"><!-- centered card --></div>
</body>
```

## Step 4 — Build with components

Use the library classes. Here are the most common patterns for reports:

### Metric / KPI section
```html
<div class="stat-grid">
  <div class="stat-card">
    <span class="stat-card-label">TOTAL USERS</span>
    <span class="stat-card-value">10,761</span>
    <span class="stat-card-desc">All registered accounts</span>
  </div>
  <!-- more stat-cards -->
</div>
```

### Data table
```html
<div class="table-wrapper">
  <table class="table">
    <thead>
      <tr>
        <th>Name</th>
        <th>Status</th>
        <th class="td-number">Score</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>John Doe</td>
        <td><span class="badge badge-success"><span class="badge-dot"></span>Active</span></td>
        <td class="td-number">92.5</td>
      </tr>
    </tbody>
  </table>
</div>
```

### Section with card
```html
<div class="card mt-4">
  <div class="card-header">
    <div class="card-title">Section Title</div>
    <button class="btn btn-secondary btn-sm">Action</button>
  </div>
  <div class="card-body">
    <!-- content -->
  </div>
</div>
```

### Tabs for different views
```html
<div class="tabs">
  <div class="tabs-list">
    <button class="tab-item active">Overview</button>
    <button class="tab-item">Details</button>
    <button class="tab-item">History</button>
  </div>
  <div class="tabs-panel">
    <!-- active tab content -->
  </div>
</div>
```

### Key-value details
```html
<dl class="dl-grid">
  <dt>Project</dt>    <dd>CodeMie Platform</dd>
  <dt>Status</dt>     <dd><span class="badge badge-success"><span class="badge-dot"></span>Active</span></dd>
  <dt>Owner</dt>      <dd>Jane Smith</dd>
  <dt>Created</dt>    <dd>2024-01-15</dd>
</dl>
```

### Alert / info banner
```html
<div class="alert alert-info">
  This report was generated automatically. Data reflects the last 30 days.
</div>
```

### Pagination (below a table)
```html
<div class="pagination">
  <span class="pagination-info">Showing 1-20 of 84</span>
  <button class="page-btn disabled">&laquo;</button>
  <button class="page-btn active">1</button>
  <button class="page-btn">2</button>
  <button class="page-btn">3</button>
  <button class="page-btn">&raquo;</button>
</div>
```

## Design rules

These rules ensure visual consistency with the CodeMie product:

1. **Always use CSS variables for colors** — never hardcode hex values. This keeps the page compatible with both dark and light themes. Example: `color: var(--color-text-primary)` not `color: #FFFFFF`.

2. **Use the provided component classes** — the library already handles border-radius, padding, font-size, hover states. Don't re-invent card or button styles with inline CSS.

3. **Use semantic HTML** — `<table>` for data, `<button>` for actions, `<nav>` for navigation, `<label>` for form fields. Never use `<div>` where an interactive element belongs.

4. **Font stack** — Inter is the primary font (loaded via Google Fonts in tokens.css). JetBrains Mono for code. These are included automatically through the stylesheet import.

5. **Spacing** — Use utility classes (`p-4`, `mt-2`, `gap-3`, `mb-4`) or CSS variables (`var(--space-4)`) for custom spacing. The spacing scale is: 2px, 4px, 6px, 8px, 10px, 12px, 16px, 20px, 24px, 32px.

6. **Border radius** — Cards use `--radius-xl` (12px). Inputs/buttons use `--radius-lg` (8px). Badges use `--radius-full`. Small elements use `--radius-sm` (4px) or `--radius-md` (6px).

7. **Typography** — Body text is 14px (`--text-sm`). Small text is 12px (`--text-xs`). Headings: h1=32px, h2=24px, h3=16px, h4=14px. Always use the heading classes or elements.

8. **Page background** — The main page background is `--color-bg-page` (#1A1A1A dark / #F9F9F9 light). Cards sit on `--color-bg-card` (#151515 dark / #FFFFFF light). These are handled by the body style and `.card` class automatically.

9. **Borders** — Default border is `--color-border-structural` (#333436 dark / #E5E5E5 light). Use the `.border` utility class or `border: 1px solid var(--color-border-structural)`.

10. **Status colors** — Use badge variants for status: `badge-success` (green), `badge-error` (red), `badge-warning` (yellow/orange), `badge-in-progress` (blue), `badge-pending` (cyan), `badge-advanced` (purple), `badge-not-started` (gray).

## Charts and graphs

The style guide does not include a charting library. If the report needs charts:

- Use **Chart.js** (recommended) or any lightweight chart library via CDN
- Match the chart's color palette to the design tokens:
  - Primary blue: `#2297F6`
  - Purple: `#C084FC`
  - Green: `#259F4C`
  - Red: `#F9303C`
  - Yellow: `#F5A534`
  - Cyan: `#06B6D4`
- Set chart background to transparent
- Use `var(--color-text-muted)` for axis labels and grid lines
- Wrap charts in a `.card` for consistent framing

## Putting it together — a typical report structure

```
body.p-6 > .container
  h1           (report title)
  p.text-muted (subtitle / date)

  .alert.alert-info  (optional context banner)

  .stat-grid         (KPI summary cards)
    .stat-card x N

  .card.mt-4         (main data section)
    .card-header > .card-title + action buttons
    .card-body
      .table-wrapper > table.table
      .pagination

  .card.mt-4         (another section)
    .card-header > .card-title
    .card-body
      .tabs > .tabs-list + .tabs-panel

  .card.mt-4         (details section)
    .card-body > dl.dl-grid
```

This pattern matches the analytics dashboard layout in the live CodeMie product and works for most reporting use cases.

## Final Step — Inject CSS

After writing the HTML file, run this command to replace the placeholder with the full
design system bundle and make the report self-contained:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/codemie-html-report/scripts/inject-css.js <path-to-the-html-file-you-just-wrote>
```

For example:
```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/codemie-html-report/scripts/inject-css.js reports/leaderboard-2026-Q1.html
```

Expected output: `✓ CSS injected into reports/leaderboard-2026-Q1.html`

## Final Step — Inject Data (analytics pipeline only — skip for standalone use)

> This step applies **only** when invoked from the **codemie-analytics** skill. Standalone
> HTML generation embeds data inline and must skip this step.

After the HTML file is written, run `inject-data.js` to replace every `/*__DATA:name__*/`
placeholder with the matching JSON file from the temp directory:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/codemie-html-report/scripts/inject-data.js \
  <path-to-html> <temp-dir>
```

For example:
```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/codemie-html-report/scripts/inject-data.js \
  reports/2026-05-07-leaderboard/leaderboard.html \
  reports/2026-05-07-leaderboard/temp/
```

**Placeholder names must exactly match the JSON filenames** (without `.json`):
- `/*__DATA:leaderboard-top__*/` is replaced from `leaderboard-top.json`
- `/*__DATA:summaries__*/` is replaced from `summaries.json`

A wrong name means the placeholder is silently skipped. If no placeholders are matched at
all, the script exits with an error.

Expected output:
```
  ✓ injected leaderboard-top
  ✓ injected summaries
✓ 2 data block(s) injected into reports/2026-05-07-leaderboard/leaderboard.html
```

**Do not run inject-data.js before the HTML file exists.**
Run inject-css.js after inject-data.js.

## Final Step — Temp file cleanup (analytics pipeline only — skip for standalone use)

> **Backwards compatibility:** This step applies **only** when this skill is invoked
> from the **codemie-analytics** skill. Standalone HTML generation has no temp
> directory and must skip this step.

After the CSS is injected and the report is complete, **always ask the user**:

> The report is ready at `<path>`. The `temp/` directory (`<OUT>`) contains the raw
> API response files used to build it (~N files). Would you like to delete it?

If the user says **yes**, delete the temp directory:

```bash
rm -rf "<OUT>"
# e.g. rm -rf "reports/2026-05-07-executive-spending/temp"
```

Confirm deletion:
```
✓ Temp files deleted → reports/2026-05-07-executive-spending/temp
```

If the user says **no** (or does not respond), leave the directory intact and note its
location so they can inspect or re-use the raw data later.
