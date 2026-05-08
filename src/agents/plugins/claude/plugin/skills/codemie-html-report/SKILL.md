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

## Step 1 — Read the CSS files

Read **all 8 CSS files** from `${CLAUDE_PLUGIN_ROOT}/skills/codemie-html-report/style-guide/css/` — you will inline them all:

| File | What it covers |
|------|---------------|
| `tokens.css` | All CSS custom properties (colors, spacing, radii, shadows, gradients) |
| `base.css` | Reset, body, scrollbar, code blocks, links, focus ring |
| `typography.css` | Headings h1-h6, text size/weight/color utilities |
| `buttons.css` | btn-primary, btn-secondary, btn-base, btn-delete, btn-tertiary, btn-magical, sizes |
| `forms.css` | input, textarea, select, checkbox, radio, switch |
| `components.css` | card, badge, tag, alert, avatar, spinner, progress, tooltip, stat-card, chip, empty-state |
| `layout.css` | table, tabs, pagination, modal, nav-sidebar, app-shell |
| `utilities.css` | flex, grid, gap, padding, margin, width, overflow, position, border, shadow |

All files are located at: `${CLAUDE_PLUGIN_ROOT}/skills/codemie-html-report/style-guide/css/<filename>`

## Step 2 — Page skeleton (fully self-contained)

**CRITICAL: Every HTML file you produce must be a single self-contained file.** Do NOT use `<link>` tags pointing to external `.css` files. Instead, inline the entire CodeMie design system directly inside a `<style>` block.

Workflow:
1. Read all 8 CSS files from `${CLAUDE_PLUGIN_ROOT}/skills/codemie-html-report/style-guide/css/`.
2. Concatenate their contents in order: tokens → base → typography → buttons → forms → components → layout → utilities.
3. Paste the full concatenated CSS into the `<style>` tag in `<head>`.
4. Keep the `@import url('https://fonts.googleapis.com/...')` line from `tokens.css` at the very top of the `<style>` block (Google Fonts CDN is acceptable as an external dependency).

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PAGE TITLE</title>
  <style>
    /* === CodeMie Design System — inlined for portability === */
    @import url('https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500&display=swap');

    /* PASTE FULL CONTENTS OF: tokens.css, base.css, typography.css,
       buttons.css, forms.css, components.css, layout.css, utilities.css */

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
