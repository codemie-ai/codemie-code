# Decks

A deck is one HTML file of slides that presents like PowerPoint: a 1600 × 900 stage scaled to the
window, light first, with the presenting controls. The build adds the stage, every layout below,
the section markers, footers, page numbers, presenter view and the checks. You write the story and
the slides' markup: no CSS, and no script but a chart's `CodeMieCharts.create` call.

This file is all a deck needs, with `writing.md` and `glossary.md` where SKILL.md says; read
`visual.md` only for a Chart.js chart. Section 6 is the reference slide: there is no other to look
for, and the scripts and CSS are not documentation.

## 1. Plan before any markup

Plan one line per slide, in your reply or your head, not in the file:

```
03  First response fell from 9 h to 2 h in three quarters  | grows over stages → bars | helpdesk export, Q1–Q3
```

The title is the sentence the slide proves. The shape is what its evidence does (grows, adds up,
compares, builds up in levels, passes between people), and section 3 turns the shape into the
visual. Read the titles alone, in order: they must carry the whole argument.

- The cover states the answer or the ask, not the topic, in under 60 characters; its lede carries
  the numbers.
- One idea per slide, stated with its number: "Two reruns each turn 46 suspects into 31
  quarantines", never "Results" or "Pilot overview".
- Every slide but a statement and the close shows its idea in one visual picked by its shape
  (section 3); the cover too, small. A bullet list is not a visual.
- A deck that asks for something ends on the ask: `ol.decisions`, each decision with who makes it
  and by when, or a `.slide.close` when each fits a few words. One that asks for nothing, such as an
  explainer, ends on a `.slide.close` stating what the input concludes. Backup slides after it
  answer the questions you expect.
- No agenda, "Thank you", "Questions?", takeaways, summary or divider slides. `data-section` on
  every slide but the cover and the close names its part ("Part 1 · How it works"), shown over the
  title after a dot in the slide's colour, and in the footer.
- 6 to 12 main slides fill 20 to 30 minutes; a workshop runs 12 to 18.

Arcs that work:

- **Decision**: cover with the ask → why now, one sourced number → what we propose, as a mechanism
  → evidence → cost, risk and limits → the ask → backup.
- **Explainer or workshop**: cover with the one picture → the problem in numbers → the whole model
  on one slide → one slide per part, in that part's colour → one real case end to end → evidence →
  what people still decide and what it cannot do → decisions → backup.
- **Status**: cover with the status in one line → numbers against plan → what changed and why →
  risks with owners → asks.

## 2. Skeleton

```html
<!DOCTYPE html>
<html lang="en" class="light">
<head><meta charset="UTF-8"><title>Short deck name</title><style>/* __CODEMIE_CSS__ */</style></head>
<body data-deck="Deck name · what it decides">
<section class="slide cover" data-notes="…">…</section>
<section class="slide c1" data-section="Part 1 · How it works" data-notes="What to say. Sources: …">
  <h2>The title states the slide's one idea</h2>
  <p class="lede">Optional: one line of context, the period, the scope.</p>
  <div class="slide-body">…</div>
</section>
<section class="slide close" data-notes="…">…</section>  <!-- or end on the ol.decisions slide -->
<section class="slide" data-backup data-section="Backup" data-notes="…">…</section>
</body>
</html>
```

`data-deck` fills the footers, `data-section` the marker above the title, `data-notes` the
presenter view. The cover has the only `h1`; every other slide but the close has one `h2`.

Colour carries one meaning through the deck: `c1` blue, `c2` purple, `c3` green, `c4` cyan, `c5`
amber, `c0` grey for "other" or "before" (never on bars); `ok`, `warn` and `bad` are status only. On a
slide (`class="slide c1"`) it colours that part's markers, bullets, callouts and steps; on a pane,
zone, chain part, row, bar or SVG group it colours that element.
Where a slide relies on colour, a `.legend` names it.

## 3. Pick the visual by the shape of the evidence

Inside `.slide-body`. Every class here exists; write no page CSS for anything they do.

| The evidence | Draw it as |
| --- | --- |
| A number that grows over time or stages | `div.bars` with `style="--max: 20"`, columns `<div style="--v: 8"><b>8</b><span>Month 3</span></div>`; a range adds `--hi` (`--v: 15; --hi: 20`, label `15–20`); `fill` on the column to stress lightens the rest; the bars fill the height they have, `--h` at least (260 px) |
| Amounts compared across things | `div.hbars` with `style="--max: 46"`, rows `<div style="--v: 31"><span>Quarantined</span><i></i><b>31</b></div>`; `fill` on the row to stress |
| Parts of one total: hours, a budget, a share | `div.stack` of `<i style="--v: 2.5"><b>2–3 h</b>code review</i>`; parts take blue, purple, cyan and green in turn, `c1`… colours one, `lo` is a light part |
| Counts of outcomes, n of N | `div.waffle` of `<i class="ok" data-n="27"></i><i class="bad" data-n="3"></i>`, ten to a row (`--cols`), with a `.legend` |
| Levels, a maturity scale, a career path | `div.ladder` of 3 to 6 `div`s, each `<b>02</b><h3>Quarantine</h3><p>what it does</p><p class="foot">when, or how much</p>`, rising left to right, each level in its own colour; `fill` on where we are |
| Many sources into one total or outcome | `div.into`: a `div` of rows `<div><b>GitHub<small>per seat</small></b><span>$38K</span></div>`, an empty `i` (the bracket), then the total, usually a `div.focus` |
| Inputs into one system, and what it gives back | `div.hub` of two or three columns: the inputs, the core, then the outputs if any. Inputs and outputs are `div.rows`, a `p.cap` first in one to label it; the core a `div.pane fill` with an `i.ico`, `h3`, `p` and `p.chips`; the runtime draws one connector per row, in the row's colour |
| Before and after, then and now | `div.cols-2.flow` of two panes: the before `pane c0`, the after `pane c1` (or `fill`); the arrow is drawn |
| Work passing between people or systems | `div.chain` of `b` cards: `<b class="c1">Detect<small>failed, then passed</small><em>46</em></b><i>suspect</i><b class="fill">Quarantine</b>`; a part's class colours its top edge, `em` is its value in mono; an `i` between parts is a labelled arrow, `b.who` a person's step, `chain down` runs downward |
| Tools, systems, teams or sources, each with a detail, a unit or a value | `div.rows` of `<div class="c2"><i class="ico" data-i="server"></i><b>Build runners<small>self-hosted</small></b><span class="chip">minutes</span></div>`; an `em` in place of the chip is a value, a row's class colours its icon and chip |
| The layers of a system, an architecture | `div.layers` of 2 to 5 bands, top first: `<div class="c1"><b>Assistant<small>in the helpdesk</small></b><span>Tagger</span><span>Drafter</span></div>`; each `span` is a part (`small` inside for its detail), `fill` on the one the slide is about |
| Who owns which parts | `div.zone c1` with `<header><b>Find and quarantine</b><span>Agent, nightly</span></header>`, a chain and a `p`; `zone bound` is a boundary named by a first-child `span.chip` |
| Work going back | `div.loop` after a chain or zones: `<div class="loop" style="--from: 20%; --to: 20%"><span>a failed release goes back</span></div>` |
| Steps over time, a plan | `ol.steps` of `<li><b>Week 1</b>what happens</li>`; `fill` on the current step |
| The one number | `div.focus` (a dark card): `<span>label</span><b class="num-xl">310</b><p>its base</p><p class="fine">source</p>` |
| Two to four numbers side by side | `div.kpis` of `<div><b class="num-l">3 h</b><span>median time to first review, September (19 h in June)</span></div>`; `kpis col` stacks them |
| Parallel parts or options | `div.cols-2`, `cols-3` or `cols-4` of `div.pane`: an `i.ico` for what the part is (`span.n`, 01, only when the order matters), `h3`, `p`, `ul`, `p.foot` |
| A set of named things: languages, tools, teams | `p.chips` of `span`s; `c1`… on one |
| Several things on several attributes | `table.table`, six rows at most |
| A trend over many points, data to read precisely | `.chart-frame` and `CodeMieCharts.create`, one chart per slide (`references/visual.md`) |
| A command and its output | `pre.terminal`: `<b>` the command, `span.dim` line numbers, `span.ok`, `span.warn`, `span.c2` |
| The product's screen | `div.screen`: `div.bar` (one or two `span`s), then an `img`, or `div.body` with `h4` and `dl.kv` (`dd.ok`, `dd.warn`; `.mono` for paths) |
| A drawing no layout gives | `svg.dg` (below) |
| The ask | `ol.decisions`: `<li class="head"><b>Decision</b><span>Who</span><span>By</span></li>`, then `<li><b>Run it on all 40 repositories from 6 January<small>same rules as the pilot</small></b><span>Engineering leads</span><span>12 November</span></li>` |
| One message | `.slide.statement` with only its `h2` |
| The close | `.slide.close`: two or three `p` lines of a few words, under 36 characters, each opening on a coloured verb, `c1` to `c3` in turn: `<b class="c1">Approve</b> the January rollout.` The numbers stay on the slides before; the deck's name shows over the lines |
| The cover | `.slide.cover`: `p.context` (team · occasion · date), `h1` with its key phrase in `<span class="c1">`, `p.lede`, an optional `ul` of two or three points, and `div.cover-art` on the right: the deck's model small (a ladder, a chain, a zone) or its key number in a `focus` |

Beside any visual: `ol.callouts` (`<li><b>The point</b><span>the detail</span></li>`; `<i class="mk">2</i>`
in the drawing matches callout 2), `span.chip` for a unit, a label or a status, `.legend` for colours,
`p.cap` over a group of parts (mono capitals; type it in normal case), `<span class="chip c3">Level 3</span>`
first in an `h2` for the level or stage it is about, `i.ico` with `data-i` for a real thing in a row or
a part: alert, bot, box, chart, chat, check, clock, cloud, code, coin, database, eye, file, flow, gear,
git, globe, key, laptop, layers, link, lock, mail, monitor, phone, plug, receipt, search, server,
shield, terminal, ticket, user, users,
then, at the end, `p.note` for a fact the slide does not show and `p.fine` for the source or the
sample.
Halves: `div.split` (text 5 : visual 7), `split rev`, `split even`, `split aside` (a 420 px side).

- **Draw the numbers.** Values that grow, compare or add up go in bars, hbars or a stack, never in
  a table row or a sentence.
- **Vary by shape.** No visual on two slides in a row, none on more than a third of the slides;
  two ideas with the same shape still differ in what they stress. The build lists each slide's
  visual and flags repeats; a chain and zones both count as a flow.
- **Show the things.** A pane or a row opens on the `i.ico` of what it is: a person, a document, a
  check, a tool, a system; a group of parts gets a `p.cap` over it.
- **Fill the slide.** The visual is the largest thing on it. Pair it with what explains it (a
  split with callouts, the focus number beside the stack it is made of); a slide whose content
  fills under a third of its height needs a bigger visual, not more words.

`fill` makes a ladder step, a chip or a layer part solid, and a pane, chain part or row tinted: the one
thing the slide is about. A body that fills under 70% of the slide is centred by itself, a `p.fine` staying at the
bottom; `mid` on `.slide-body` centres a fuller one. A sparse body's text grows by itself, up to
26 px; a crowded one shrinks to 15 px. As a slide opens its parts rise in turn, and hub connectors
and `dash` lines flow; there is nothing to write for it, and `?static`, reduced motion and print
show the slide still.

**`svg.dg`**, for a drawing no layout gives (a loop between two systems, an architecture, a ring):
set the viewBox in stage pixels as wide as the space it fills (1424 for the whole body, about 800
on a split's wide side) and colour with classes, never `fill` or `stroke` values. Text: `t1` dark, default
mid, `t3` light, `tk` the group's colour, `tw` on a solid shape; 16 or larger. Shapes: `box` card,
`tint` tinted panel, `solid`, `bound` dashed boundary, `dot` a person, `grid`. Lines: `ln`, plus
`dash`; arrowheads `marker-end="url(#ah)"`, or `#ah1`, `#ah2`, `#ah3`. A `c1`–`c5` class on a `<g>`
colours its contents. Give it `role="img"` and an `aria-label` that states the finding.

## 4. Writing the slides

- **Titles**: one sentence with its number, about 100 characters at most, sentence case, ending
  the same way on every slide (all with a full stop, or none).
- **Words**: 40 to 120 on a slide. The rest goes in the notes.
- **Numbers** keep their unit, period and base on the slide: "310 reruns a week, August, four
  repositories". The source goes in `p.fine` or the notes.
- **Say what is not measured data**: sample, illustrative, target, draft, stand-in name, in
  `p.fine` on that slide.
- **Show the real thing**: the parts work passes through, the command, the screen, the numbers.
  Boxes are real components, people or documents; an arrow's label says what passes ("ticket",
  "merge request"), never "powers" or "enables".
- **People and limits**: what people still decide, what the system cannot do, where it fails.
- **One focal element** per slide. Icons only from the `i.ico` set, each naming a real thing; no
  emoji, clip art, stock photos or decorative shapes.
- **Notes** are what the presenter says: 40 to 120 words of spoken sentences, the point, the number
  to stress, the caveat, then "Sources: …". The slop scan reads them like the slides.
- The words of `references/writing.md` and `references/glossary.md` apply to slides and notes.

## 5. Build and check

Write the slides once, whole, to `<name>.src.html` with one Write, and build the deck from it
with `scripts/build.mjs` in codemie-html-report's own folder
(`<plugin>/skills/codemie-html-report/`, the base directory given when codemie-html-report loaded):

```bash
node <codemie-html-report folder>/scripts/build.mjs deck.src.html --out deck.html
```

The source stays small: fix in it and build again; the slop scan's line numbers point into it.
Tell the user both files. Beyond the page checks of SKILL.md Step 4, a deck gets:

- **The slide check** and its "Visuals:" line, each slide's visual. "Fix:" for stock slides
  (Agenda, Thank you, Summary…), titles that ask a question or end two ways, a bullet-list slide,
  notes missing on some slides, a slide with no `h2`, a title over 110 characters, one visual on
  three slides in a row. "Check:" for a title that may name a topic, a cover title over 65
  characters, a slide over 150 words, one visual on two slides in a row or on over a third of
  them, numbers left in a table or text, a cover without a picture.
- **The layout check**: the deck is laid out in headless Chrome, Chromium or Edge at 1600 × 900
  and every slide measured. "Fix:" for text that overlaps text, runs out of its box (an SVG label
  past its shape included) or off the slide, a body that overflows, text under 14 px (10 px inside
  a `.screen`), a chart canvas that drew nothing, a script error. "Check:" for a body that shrank
  to fit, or content that fills under a third of it.
- **Exit 2** until no "Fix:" line is left: correct the slide it names in the source and build
  again. Never read the built file.
- "Layout check skipped … a sandbox blocks it": run the same build once outside the sandbox. "No
  Chrome … found" or "returned no measurement": say in your reply that the layout was not
  measured.

The layout check measures what a look would catch. Do not open a browser, start a server or take
screenshots of a deck unless the user asks; one look costs more than the deck. `deck.html#4`
opens slide 4, `deck.html?static#4` without the fade.

Presenting: arrow keys, Space and Page Up/Down move; Home and End jump; N lists the slides; F is
fullscreen, L the laser, T the timer; Focus opens the presenter view with the notes and the next
slide. Print or Save as PDF gives one slide per page.

Without Node: paste `style-guide/css/deck.css` after the design system, and
`style-guide/js/deck.js` in a `<script>` after `controls.js`.

## 6. One slide, finished

```html
<section class="slide c1" data-section="Part 1 · How it works" data-notes="Two halves. The agent finds and quarantines overnight; the owner fixes and releases. A test comes back only after 20 clean reruns, so a half-fix cannot slip through. Sources: pilot run logs, 1 September to 12 October 2026.">
  <h2>The agent quarantines a flaky test; its owner fixes it and brings it back after 20 clean reruns.</h2>
  <div class="slide-body mid">
    <div class="cols-2">
      <div class="zone c1"><header><b>Find and quarantine</b><span>Agent, nightly</span></header>
        <div class="chain"><b>Detect<small>failed, then passed</small></b><i>suspect</i><b>Rerun ×2</b><b class="fill">Quarantine</b></div></div>
      <div class="zone c2"><header><b>Fix and release</b><span>Test owner</span></header>
        <div class="chain"><b class="who">Owner fixes</b><b>20 reruns</b><b>Release</b></div></div>
    </div>
    <div class="loop" style="--from: 22%; --to: 22%"><span>a release that fails again goes back to quarantine</span></div>
    <p class="legend"><span class="c1">Agent</span><span class="c2">People</span><span class="who">A person decides</span></p>
    <p class="fine">Pilot on four repositories, 1 September to 12 October 2026.</p>
  </div>
</section>
```
