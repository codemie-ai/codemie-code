# CodeMie HTML Report — Style Guide

## CSS Bundle

`css/bundle.css` is a pre-built, minified concatenation of all 8 design-system CSS files.
It is committed to the repo so report generation requires no build step at runtime.

**Do not edit `bundle.css` directly.** Edit the individual source files instead, then rebuild.

### Source files (order matters)

| File | What it covers |
|------|---------------|
| `css/tokens.css` | CSS custom properties — colors, spacing, radii, shadows, gradients |
| `css/base.css` | Reset, body, scrollbar, code blocks, links, focus ring |
| `css/typography.css` | Headings h1–h6, text size/weight/color utilities |
| `css/buttons.css` | All button variants and sizes |
| `css/forms.css` | input, textarea, select, checkbox, radio, switch |
| `css/components.css` | card, badge, alert, avatar, stat-card, chip, empty-state, etc. |
| `css/layout.css` | table, tabs, pagination, modal, nav-sidebar, app-shell |
| `css/utilities.css` | flex, grid, gap, padding, margin, width, overflow, border |

### Rebuilding bundle.css

Run this command from the repo root whenever any source CSS file changes:

```bash
npx clean-css-cli -o src/agents/plugins/claude/plugin/skills/codemie-html-report/style-guide/css/bundle.css \
  src/agents/plugins/claude/plugin/skills/codemie-html-report/style-guide/css/tokens.css \
  src/agents/plugins/claude/plugin/skills/codemie-html-report/style-guide/css/base.css \
  src/agents/plugins/claude/plugin/skills/codemie-html-report/style-guide/css/typography.css \
  src/agents/plugins/claude/plugin/skills/codemie-html-report/style-guide/css/buttons.css \
  src/agents/plugins/claude/plugin/skills/codemie-html-report/style-guide/css/forms.css \
  src/agents/plugins/claude/plugin/skills/codemie-html-report/style-guide/css/components.css \
  src/agents/plugins/claude/plugin/skills/codemie-html-report/style-guide/css/layout.css \
  src/agents/plugins/claude/plugin/skills/codemie-html-report/style-guide/css/utilities.css
```

Commit the updated `bundle.css` alongside the source CSS change.
