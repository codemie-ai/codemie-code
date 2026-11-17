# CodeMie HTML Report

Creates standalone HTML reports, dashboards, status pages, and mockups using the CodeMie visual design system.

## Use It For

- Static HTML reports and analysis pages.
- Dashboard-style summaries with metrics, tables, charts, or status sections.
- Slide decks you present from the browser.
- CodeMie-styled mockups that should open as a single portable HTML file.

## How To Ask

Examples:

- "Create a CodeMie-styled HTML report for these findings."
- "Build a dashboard page I can switch to dark while presenting."
- "Make this analysis output look like CodeMie."
- "Make a report with a chart of weekly spend that I can email to a client."
- "Make a 6-slide deck for our CFO on renewing the code review pilot."
- "Build a workshop deck for the SRE guild on how our triage agent works; here are the facts."
- "Turn my slide draft into a CodeMie deck." (the draft's agenda, hype and "Thank you" slide go)

## What It Needs

- The content or data to present.
- Any preferred title, sections, or output path.
- Node 18 or later, for the build script (`scripts/build.mjs`). Chrome, Chromium or Edge, if
  present, lets the build measure a deck's layout.

Without Node, a page can be assembled by hand, with no slop scan or layout check: paste the
style-guide CSS files in order (tokens, base, typography, buttons, forms, components, layout,
utilities, and `deck` for slides) between `/* slop:ignore-start */` and `/* slop:ignore-end */`
in place of the placeholder; paste `style-guide/css/controls.css` into a
`<style data-slop-ignore>`, and `style-guide/js/controls.js` (then `deck.js` for slides) into a
`<script>` before `</body>`. Such a page loads its fonts from Google, so it is not
self-contained.

## What Every Page Gets

- **The product's look.** A page reads like a screen of the CodeMie app, checked against the
  running app in both themes: Geist Mono for titles, labels, numbers, tables and buttons, Geist for
  paragraphs and lists, the app's type scale (24 / 20 / 18 px, weight 600), white or `#212224`
  section cards with an 8 px corner and a hairline, elevated metric tiles with uppercase labels,
  tables in a hairline box with a near-white header row, and the app's soft violet light in the
  lower left corner of the window, which shows only in the margins.
- **One file that opens offline.** The design system, the fonts and, for a page with charts,
  Chart.js are embedded, so the page looks the same as an email or Teams attachment, behind a
  proxy that blocks CDNs, or with no network. Only the font subsets the page needs go in: an
  English page or deck carries Geist and Geist Mono, 69 KB together, and a page in Polish or
  Ukrainian gets those subsets too. Each
  build prints whether the page is self-contained, counting a file loaded from beside the page as a dependency too. `--cdn` loads fonts and Chart.js from
  CDNs instead, for a page served from a website.
- **Decks that present like slides.** Ask for a deck and the slides sit on a 1600 × 900 stage that
  scales to the window, one at a time, with section markers, footers, page numbers, backup slides,
  `#4` links to a slide, and one slide per page when printed or saved as PDF. The skill plans the
  storyline first, one idea per slide in sentence titles, and picks each slide's visual by the
  shape of its evidence: a number that grows over stages becomes bars (ranges such as 15–20
  included), parts of one total a stack, levels or a career path a ladder, many sources one
  bracket into a total, inputs into one system and what it gives back a hub with a drawn connector
  per row, work between people a chain of cards or zones, a system's architecture its
  layers, real things rows with a drawn icon and a unit, before and after two panes with an arrow,
  a set of names chips. The slides look like the CodeMie product: Geist type, white cards with
  coloured top edges, mono labels and values, one colour per level, a dark card for the key
  number. As a slide opens its parts rise in turn and the connectors flow; `?static`, reduced
  motion and print show it still. The layouts are ready-made, so no deck writes its own CSS, and a token-coloured SVG kit
  covers any other drawing. `style-guide/deck-gallery.src.html` shows
  every visual once; build it with `node scripts/build.mjs style-guide/deck-gallery.src.html --out
  deck-gallery.html` to browse them.
- **Decks checked before you see them.** The build lists each slide's visual and fails a deck with
  a stock slide (Agenda, Thank you, Summary), a title that asks a question, titles that end two
  ways, a slide that is only bullets, notes missing from some slides, or one visual on three
  slides in a row. It flags a title that may name a topic, numbers left in a table that a chart
  should draw, a cover without a picture, and a visual repeated too often. When
  Chrome, Chromium or Edge is installed, it also lays the deck out headless and measures every
  slide for overlapping text, text out of its box (a label past its shape in a drawing included)
  or off the slide, overflow, text under 14 px and slides whose content fills under a third of
  them, in about two seconds and without screenshots. A sparse slide's text grows, up to 26 px,
  and sits in the middle of the slide. A deck is written to `deck.src.html` and built with
  `--out deck.html`, so the source stays small to edit and rebuild.
- **Charts that follow the theme.** `CodeMieCharts.create()` colours the series from the design
  tokens, keeps red, amber and green for status, and recolours the chart when the theme switches.
  Small figures (a sparkline, a few bars, one percentage) are inline SVG with no library.
- **Light and dark themes**, with a switch in the corner. Light is what opens; the choice is
  remembered per browser.
- **Presenting controls** — section navigation, a laser pointer, a timer and fullscreen. Slide
  decks additionally get a Focus presenter view for a second display, with speaker notes.
- **Copy without AI slop.** The title states the finding, every number carries its unit, period
  and base, and nothing appears that the input does not contain: no invented trend, benchmark or
  "10x". No emoji icons, gradient text, glass, glow or decorative animation. In a deck the speaker
  notes are scanned like the slides.
- **Our words.** Terms of our work (AI/Run, CodeMie, the Hyperfactory, factories, flows, gates,
  harnesses, headless agents, the control plane, tokenomics, pay for output) follow one glossary,
  internal names such as Flywheel stay off client pages, and no client name, codename or price
  appears unless you supply it for the page.

The controls are added by `scripts/inject-controls.mjs` as a build step, so no page needs bespoke
theme code. The build runs the `codemie-humanizer` skill's slop scan on the page as written. The build
fails on any high finding and on any medium look finding (gradients, glass, glow, eyebrows,
accent rails, uppercase labels, decorative icons or motion) in the page's own markup and styles,
so the page ships without them.

Its writing and look rules are the `codemie-humanizer` skill's, cut down to what a CodeMie page needs. They
live inside this skill, so it needs no other skill installed. To clean an existing page in place
and keep its own design, use `codemie-humanizer`; this skill rebuilds the content as a CodeMie page.

| File | Holds |
| --- | --- |
| `references/writing.md` | The voice for our audience, titles, numbers, sources, sections, decks |
| `references/glossary.md` | The words of our work, their spelling, the words to avoid, internal-only names |
| `references/visual.md` | Which CodeMie component does which job; colour, type, icons, charts, inline-SVG figures, diagrams, slides |
| `references/deck.md` | How a deck is planned, laid out and written: arcs, skeleton, every slide layout, writing rules, checks, one finished slide |
| `references/analytics.md` | The data-placeholder contract the `codemie-analytics` skill relies on |
| `style-guide/css/deck.css`, `style-guide/js/deck.js` | The deck stage, layouts and runtime the build adds to a page with slides |
| `style-guide/deck-gallery.src.html` | Every deck visual once, on the evidence it is for; the tests build it |
| `evals/contact-sheet.mjs`, `evals/visual-review.md` | Light and dark contact sheets of a built deck, and the checklist to review them by |
| `scripts/slop-scan.mjs` | The scanner the build runs, with a self-test (`--self-test`) |
| `scripts/inject-data.mjs` | Fills a page's `/*__DATA:name__*/` placeholders from the codemie-analytics skill's JSON files, escaped so no value can break out of its script |
| `style-guide/js/charts.js` | `CodeMieCharts`, the chart theming helper the build embeds |

For maintainers:

- After a change to `deck.css` or `deck.js`, build the gallery, render it with
  `node evals/contact-sheet.mjs deck-gallery.html` (Chrome, outside a sandbox) and review both
  sheets against `evals/visual-review.md`. Eval 17 in `evals/evals.json` checks that a deck picks
  its visuals by the shape of the evidence.
- `scripts/slop-scan.mjs` and `references/glossary.md` are byte-identical copies of the files in
  the `codemie-humanizer` skill, which is their source of truth. Edit them there and copy them over;
  `src/agents/plugins/claude/__tests__/skills-shared-files.test.ts` fails when they drift.
- This copy differs from its codemie-public-skills source on purpose: the build and inject scripts
  are ES modules (`.mjs`, `import`, the script folder from `import.meta.url`) rather than
  CommonJS `.js`, so they run under this repository's `"type": "module"` with no nested
  `package.json`. Keep that when you copy a newer source over.
- `style-guide/fonts/fonts.css` (Geist and Geist Mono, which pages and decks use, plus Inter and
  JetBrains Mono, which no build embeds any more; every subset, base64) and
  `style-guide/js/chart.umd.min.js` (Chart.js 4.5.1) are vendored. Refresh them with
  `node scripts/vendor-assets.mjs`, and keep its Chart.js version and hash in step with
  `scripts/inject-charts.mjs`: the script refuses a download whose hash differs, and `--cdn` pages
  load Chart.js with that hash as their `integrity`. All four fonts are SIL OFL 1.1 (`style-guide/fonts/LICENSE-OFL.txt`);
  Chart.js is MIT, its licence in the file's banner. Both permit embedding.
