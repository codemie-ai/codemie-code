# Look

For HTML, CSS, components, slides, charts and diagrams. The look gives a page away before anyone
reads a word: a reviewer called one generated dashboard "boring, like AI generated content"
although every fact on it was right. It was a grid of equal bordered boxes, uppercase mono labels
on everything, a coloured rail on each card and a different colour per section.

Density is the signal here too. One gradient on the brand's own primary button is the brand;
gradients on the headline, the background and every card are slop.

## Colour

- **The stock AI palette.** Violet, indigo, fuchsia and pink (Tailwind's indigo-500 `#6366f1`,
  violet-500 `#8b5cf6`, purple-500 `#a855f7`, pink-500 `#ec4899`), a violet-to-blue gradient,
  cyan accents on near-black. Fix: the design system's tokens and one accent.
- **Rainbow.** A different saturated colour per card, section or category, meaning nothing.
  Fix: one muted colour per category that means something, nameable aloud ("the teal layer");
  everything else neutral (surface, border, text, muted text).
- **Colour as fill.** Tinted backgrounds on every card and row. Fix: a category's colour marks
  what is its own (its name, a light tint and border on its band, its line); it does not fill
  the page.
- **Traffic lights for categories.** Red, amber and green used for things that are not status.
  Fix: keep them for status.
- **Hard-coded colours beside a token system**, so the other theme breaks. Fix: tokens.

## Effects

- **Gradient text** (`background-clip: text`) on headings. Fix: the text colour; if one phrase
  must stand out, give it the accent token.
- **Gradient backgrounds**, blobs, orbs, mesh, aurora, noise and dot grids behind content. Fix: a
  flat surface.
- **Glass:** `backdrop-filter: blur()` on translucent cards. Fix: an opaque surface and a 1px
  border.
- **Glow:** coloured `box-shadow` or `text-shadow`, neon outlines. Fix: no shadow, or the
  system's elevation token.
- **Decorative motion:** pulsing dots, shimmer, floating cards, animated gradients, sparkles,
  typewriter headlines, numbers that count up. Fix: remove; motion marks a change of state
  (loading, opening, progress).
- **Hover lift** on cards that are not clickable. Fix: hover states only on things you can
  click.
- **Rounded and shadowed everything.** Fix: the system's radius and elevation scale.

## Type

- **Uppercase letterspaced labels** over everything: eyebrows, kickers, "STEP 01", "KEY INSIGHT",
  stat labels typed in capitals. Fix: write labels in normal case; a smaller size and the muted
  colour carry the label role. Keep uppercase only where the design system puts it (a table
  header, a product component).
- **Mono type for labels** that are not code.
- **Several families and weights.** Fix: one family plus a mono for code; semibold for
  headings, regular for the rest.
- **A huge hero headline that says nothing.** Fix: the name and one specific claim, at a size
  that holds it on one line.
- **Eyebrow, subtitle and tagline stacked over the title.** Fix: the title, then one line of
  what the page answers, then content. Nothing above the title unless the page cannot do
  without it.

## Icons and emoji

- **Emoji as icons** in headings, bullets, buttons and navigation (🚀 ✨ 💡 🔥 ✅ 📊 🎯 ⚡).
  Fix: remove them. Emoji as data, in a status column or a legend, can stay.
- **An icon on every card**, often in a tinted circle. Fix: drop decorative icons; keep icons
  that carry meaning (status, file type, an action).
- **Sparkles as the sign for AI.** Fix: say what the AI does.
- **Boxes standing for things.** Fix: draw the thing itself (a terminal, an invoice, a git
  branch, a budget bar) or nothing.

## Components and layout

- **The identical card grid:** three, four or six cards, each an icon, a title and two lines,
  all the same height. Fix by what the items are: parallel facts become a table or a list; steps
  become a flow; when one item matters most, lead with it. Cards for a real catalogue are fine.
- **Accent rails:** a 3–4px coloured left or top border on cards and callouts. Fix: remove it,
  or use a 1px neutral border. A left border on a blockquote is ordinary.
- **Badge clutter:** "New", "Beta", "AI-powered", "Popular", "Pilot", "Coming soon"; two status
  cues on one item. Fix: one cue at most, and status in words where it matters.
- **The stat band:** "10x", "99.9%", "500+", "24/7" in huge type with no base. Fix: number,
  unit, base, period and source, or cut it.
- **Callout boxes:** "Key takeaways", "Pro tip", "Did you know?" with an emoji. Fix: fold the
  one new fact into the text and delete the box.
- **The landing-page formula on a report:** a centred hero, eyebrow, headline, subhead, two
  buttons, a logo row, testimonials. Fix: a title, one line of what the page answers, the
  content.
- **Fake proof:** "Trusted by" logo rows, testimonials with stock names, star ratings. Fix:
  remove unless real and approved.
- **Decorative window chrome:** red, amber and green dots on every code block. Fix: a plain
  block.
- **Status drawn as style:** dashed boxes, faded "planned" lines, a legend explaining them. Fix:
  dashed only for what is genuinely not built, if at all; status in the copy.
- **Fixed-height cards** with clipped or overflowing text. Fix: size from content.
- **Loose alignment:** frames that do not hug their content, edges a few pixels apart, uneven
  gaps between like cards, empty bands. Fix: one grid; snap the edges; one focal visual per view.

## Charts

- The title states the finding ("Active users doubled after the March release"), not the metric
  name ("Monthly active users").
- One colour for one series; more colours only when series differ in meaning. No rainbow
  slices, 3D, gradient fills or shadows.
- Units on axes and labels; bars start at zero; no donut for two values; direct labels before a
  legend.
- Every number on a chart says what it counts and against what base.

## Diagrams

- One picture per claim, drawn from its own content. A picture that needs a paragraph or a
  legend to read is the wrong picture.
- Label each connection with what passes along it ("approved models · budgets · limits"), never
  "powers", "enables" or "governs".
- One connection per relationship, not arrows to and from every box. Arrows start and end on
  edges, run straight, never cross text or boxes, never end in empty space.
- Every named part says what it does, on the drawing.

## Slides

- One idea per slide; its title is a sentence that states it.
- About 100 words of body, large type; details, sources and caveats go in the speaker notes.
- Not every slide a title, three bullets and a takeaway line.

## Before and after

> Hero. Before: an uppercase eyebrow "THE FUTURE OF SOFTWARE" over "Unlock Seamless AI-Powered
> Delivery at Scale 🚀" in violet-to-blue gradient text.
> After: "Delivery FinOps: AI Cost per Accepted Story", the name in the text colour and the claim
> in the accent. No eyebrow.

> Feature grid. Before: six cards, each a tinted icon circle, a Title Case name and two lines
> about being seamless, robust and scalable.
> After: a four-row table of what each part does, what it needs and who decides, because the
> parts were parallel facts.

## Do not flag

- The design system's own components: the brand gradient on its primary button, its uppercase
  table header, its status colours, its icon set in a toolbar.
- Dark themes, rounded corners, a single accent colour, cards for genuinely parallel items,
  icons that carry meaning, emoji as data, screenshots or replicas of a real product's UI.
- Anything the brand guidelines require. Flag it once in the plan if it reads as generated; do
  not change it.

## Fixing without breaking

- Replace a gradient with the flat colour the design system uses for that role, not a colour you
  pick.
- After a colour change, check both themes. After a type change, check that the text still fits
  at 1280 and 1440 wide, and on a phone if the page is meant for one.
