# Formats

How to read, scan and apply for each kind of input. A file outside version control gets a copy,
`<name>.orig.<ext>`, before the first edit.

## Plain text and Markdown

- Scan the file directly, or pasted text with `--stdin --md`. Code fences, front matter, inline
  code, link targets and quoted spans are skipped. Quoted lines (`>`) are reported but never
  edited.
- Before renaming a heading, check whether other files link to its anchor.
- Keep table data, link targets and reference-style link labels byte-identical.

## HTML pages and reports

- Scan the file; both layers run. Findings carry the source line; give the selector or the
  section heading too, so the author can find each item in seconds.
- Text: edit text nodes; keep entities, inline markup and attributes.
- CSS: edit the page's own rules. When a page inlines a design system, wrap that block in
  `/* slop:ignore-start */ … /* slop:ignore-end */` so the scan reports only the page's own
  choices, and raise a design-system problem in the plan instead of editing the system.
- Third-party embeds, widgets and injected toolbars: add `data-slop-ignore` to their element.
- Chat transcripts and terminal replicas show a product's real output. The scanner treats
  elements whose class names a chat, terminal, transcript or message bubble as quoted. Do not
  rewrite them; check them only for facts.

## CSS, SCSS and design tokens

- No flag is needed for CSS or SCSS. JSON or JS token files get no look findings: check their
  colours against `visual.md` by hand. A token file defines colours legitimately; judge how they
  are used, not that they exist.
- Fix at the lowest level that holds: the token when every use is wrong, the rule when one
  component is.

## Components: React, Vue, Svelte, templates

- The scanner reads class lists (Tailwind included), inline styles, `<style>` blocks,
  styled-components templates, and the visible text: JSX and template text, UI props such as
  `title` and `placeholder`, and copy in data arrays (`title:`, `description:`).
- Search the tests for a string before changing it, and keep every import that is still used and
  none that is not.

## JSON, YAML and i18n content

- JSON: the scanner reads prose string values with their line numbers and skips keys and
  identifier fields (`id`, `href`, `icon`, `kind` and the like).
- Edit values only, check the file still parses, and run the project's content tests. In i18n
  files, change every locale you can; flag the ones you cannot.

## Word documents

- Extract the text with the docx skill, `pandoc -t markdown`, or `python-docx`; scan the extract;
  plan against headings and paragraph numbers.
- Apply through the docx skill or `python-docx`, editing runs in place so styles survive. Write
  `<name>.clean.docx` unless told to overwrite. Offer tracked changes when the document is shared.

## Slide decks

- Extract per slide with the pptx skill or `python-pptx`, speaker notes included. Plan per slide.
- An HTML deck needs no extraction: the scan reads each slide's `data-notes` as prose, at its line.
- Keep layouts and masters; change text inside its shapes. Write `<name>.clean.pptx` unless told
  to overwrite. Moving detail into the notes is a **Consider** item, because it changes what the
  audience sees.

## PDF

- Audit only: extract the text with the pdf skill or `pdftotext -layout`, scan it, and return the
  plan with paste-ready replacements. Say
  that layout findings are approximate.

## Web pages by URL

- Audit only: you cannot edit a live page. Read the rendered text (the browser's page text, or
  `read_page` when you need element references; a fetch tool as the fallback), not the raw
  source. If you cannot reach the page, say so and ask for a paste; never audit from the URL slug
  or the meta description.
- Strip navigation, cookie banners, consent dialogs and footers before scanning (`--stdin`).
  Note where the first screen ends, and say if content loaded on scroll went unread.
- The first screen is worth more than the rest of the page; spend the plan there. Check every
  proof number against another page on the site, and never adjust or round one.
- Copy kept for search (repeated keywords, long-tail headings, location text): propose wording
  that keeps the keyword, and mark the item as SEO-constrained so the search owner can veto it.

## Code comments, commit messages, merge request descriptions

- In scope only when asked. The tells: comments that restate the code ("// This function handles
  the processing of…"), "ensures that" in every docstring, emoji in commit subjects, merge request
  bodies whose Summary, Changes, Impact and Testing sections say the same thing four times.
