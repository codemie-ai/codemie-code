# The look without AI slop

Use the system's components for their jobs and add nothing decorative; the build's slop scan
catches most of what gets added. This file says what to use instead, beyond SKILL.md's design
rules.

## Use the component made for the job

| The content | Use | Not |
| --- | --- | --- |
| The three to five numbers the reader came for | `.stat-grid` of `.stat-card` | a stat band of "10x", "99.9%", "500+" |
| Parallel facts about several things | `table.table` | a grid of identical cards |
| A thing's properties | `dl.dl-grid` | bold-label bullets |
| Status of a row or item | one `.badge` variant | a coloured dot plus a pill plus a tinted row |
| A note about the data (period, source, a gap) | `.alert.alert-info` | a "Key takeaways" or "Pro tip" box |
| A real warning | `.alert.alert-warning` | red text or an emoji |
| Nothing to show yet | `.empty-state` with what is missing | a filler card |
| Steps in order | an ordered list, or one table row per step | a row of cards with arrow emoji |
| Several views of one subject | one `.card` per view, each titled with its finding | several pages of cards, or tabs: nothing on a static page switches them |

## Colour, type and layout

- One accent for highlights. Never a different colour per card, section or category unless the
  colour carries meaning, and then the meaning is named on the page.
- The system's headings and text utilities only: no extra font families, no extra weights. The
  title is short enough for one line; never resize the `h1`.
- No landing-page formula: no centred hero, two call-to-action buttons, logo row or testimonials. A
  report opens on its title, its subtitle, the stat cards and the ask.
- One focal element per screen. No "Pilot", "Beta" or "New" badge as decoration, and no dashed
  boxes or faded lines for status.
- Frames hug their content; like cards in a row share one gap; edges line up.

## Charts

Put `<script>/* __CODEMIE_CHARTS__ */</script>` before the script that draws; the build embeds
Chart.js and the `CodeMieCharts` helper there. Draw into a canvas inside a sized frame, in a `.card`:

```html
<div class="chart-frame"><canvas id="deploys" aria-label="Deploys per day, most on Tuesday at 14"></canvas></div>
<script>/* __CODEMIE_CHARTS__ */</script>
<script>
CodeMieCharts.create('deploys', { type: 'bar', data: { labels: ['Mon', 'Tue', 'Wed'],
  datasets: [{ label: 'Deploys', data: [9, 14, 11] }] } });
</script>
```

- `create` colours the series (blue, purple, cyan, then grey for "other"), styles axes, legend and
  tooltips from the tokens, turns animation off, drops the legend for a single series, and
  recolours on a theme switch. Your options win, callbacks included. A status series names its
  token: `{ label: 'Failed', data: [...], token: 'error' }` (`success`, `warning`, `error`).
- `chart-frame` is 320 px tall, `chart-frame-sm` 220 px, `chart-frame-lg` 420 px.
- Four series at most; past that, split the chart or use a table.
- The card title states the finding ("Deploys peaked on Tuesday at 14"), not the metric's
  name.
- Units on axes and in tooltips; bars start at zero; values labelled directly where a legend would
  be the only key; no 3D, gradient fills, shadows, or a donut for two values.
- Every number on a chart says what it counts and against what base.

## Charts without a library

Chart.js is for data a reader will explore: several series, tooltips. For a picture of one number
(a trend in a table cell, a few bars, one percentage), inline SVG costs a few hundred bytes, needs
no script and follows the theme through the colour tokens.

```html
<!-- A trend: the stroke stays 2 px however the sparkline stretches -->
<svg viewBox="0 0 100 24" class="w-full" preserveAspectRatio="none" aria-hidden="true">
  <polyline points="0,18 20,14 40,16 60,8 80,10 100,4" fill="none"
            stroke="var(--color-chart-blue)" stroke-width="2" vector-effect="non-scaling-stroke"/>
</svg>

<!-- Bars: heights in proportion to the values, from a zero baseline -->
<svg viewBox="0 0 200 120" class="w-full" role="img" aria-label="Runs by unit: Web 4,182, Core 3,905, Tools 1,244">
  <g fill="var(--color-chart-blue)">
    <rect x="10" y="10" width="40" height="90" rx="4"/>
    <rect x="80" y="16" width="40" height="84" rx="4"/>
    <rect x="150" y="73" width="40" height="27" rx="4"/>
  </g>
  <line x1="0" y1="100" x2="200" y2="100" stroke="var(--color-border-structural)"/>
  <g fill="var(--color-text-muted)" font-size="9" text-anchor="middle">
    <text x="30" y="113">Web</text><text x="100" y="113">Core</text><text x="170" y="113">Tools</text>
  </g>
</svg>

<!-- One percentage: the circumference is 100, so the dash array is the value -->
<svg viewBox="0 0 42 42" width="120" height="120" role="img" aria-label="76% of repositories indexed">
  <circle cx="21" cy="21" r="15.915" fill="none" stroke="var(--color-border-structural)" stroke-width="4"/>
  <circle cx="21" cy="21" r="15.915" fill="none" stroke="var(--color-chart-blue)" stroke-width="4"
          stroke-dasharray="76 24" stroke-dashoffset="25"/>
  <text x="21" y="23.5" text-anchor="middle" font-size="8" fill="var(--color-text-primary)">76%</text>
</svg>

<!-- Magnitude per table row, beside its number -->
<td class="td-number">4,182 <span class="chart-bar"><span style="width: 100%"></span></span></td>
```

## Charts every reader can use

- A chart that carries information gets `role="img"` and an `aria-label` that states its finding
  ("Runs by unit, Web highest at 4,182"); a decorative one gets `aria-hidden="true"`.
  `CodeMieCharts` adds the role to its canvas; the label is yours to write.
- When the numbers are also in a table on the page, say so under the chart: the table is the
  accessible version.
- Colour is never the only key. Label series directly, or vary the dash (`borderDash: [4, 4]`).

## Diagrams

- Draw a diagram only when the content has a real flow or structure: inline SVG in token colours,
  boxes for the real things (a service, a queue, a store), not boxes standing for ideas.
- Label each arrow with what passes along it ("order events", "approved models · budgets"), never
  "powers", "enables" or "drives".
- One arrow per relationship. Arrows start and end on box edges, run straight, never cross text or
  boxes, never end in empty space.
- If the notes do not say how two parts connect, draw no arrow and list the gap under the diagram.

## Check before delivering

If a browser is loaded, look at a report or dashboard at 1280 px in light and in dark: read its
text or DOM for overflow first, then take one scaled-down screenshot per theme. A deck needs no
look; its build measures the layout.
