# Humanizer

Writes, rewrites, cleans and reviews content so it reads as if a person with real expertise
wrote it: chat text, email, Markdown, documents, proposals, READMEs, HTML pages, CSS, React, Vue
and Svelte components, JSON content, decks and PDFs.

Generated content fails on three layers: the substance (claims nobody can check, numbers with no base, sections that restate their
heading), the words (stock vocabulary, hype, coined names, "not X but Y") and the look (violet
gradients, emoji icons, uppercase eyebrows, a coloured rail on every card). This skill works
through them in that order, and it never invents a number to make a sentence land.

## Use It For

- Turning raw notes, a bullet dump or a meeting transcript into a proposal, architecture
  document, article, email or ticket.
- Rewriting text that reads as AI-generated without changing what it claims.
- Cleaning a generated web page, report, dashboard or component: copy, CSS and markup together.
- Reviewing a document, a file or a live URL and getting a ranked list of exact replacements,
  with nothing changed.
- Bringing content about our work in line with one glossary (AI/Run, CodeMie, the Hyperfactory,
  factories, flows, gates, harnesses, headless agents, the control plane, tokenomics, pay for
  output), with internal names such as Flywheel kept off client pages.
- Keeping the agent's own output clean for the rest of the session: replies, commit messages,
  merge request descriptions, and what other skills produce.

## How To Ask

- "Turn these notes into a proposal for the client."
- "This section sounds like ChatGPT wrote it. Fix it."
- "Deslop this page: `reports/architecture.html`. Show me the plan first."
- "The landing component looks AI-generated. Clean up the styles and the copy."
- "Review https://example.com/pricing and tell me what to change. Don't restructure it."
- "Just fix it, no need to ask: `docs/proposal.md`."
- "Is this Ukrainian intro AI-generated?"

## What You Get Back

- **Pasted text**: the rewritten text, one line per change, and anything only you can supply,
  marked `[NEEDS: …]`. Text that is already fine comes back unchanged, with the reason.
- **A file or page**: a cleaning plan first. A one-line verdict with its evidence, then numbered
  items, at most about 25 and ordered by payoff, in four groups: **Fix** (clear slop, safe to apply), **Consider** (judgment calls and
  structural changes), **Needs you** (facts only you have) and **Leave as is**. Every item names
  the line or selector, what is wrong and the exact replacement. Reply "apply all" or
  "apply 1–5"; the skill then makes targeted edits, re-scans, checks that every number, date,
  name and commitment survived, opens the page to confirm nothing broke, and reports.
- **A review or a URL**: the same plan, with the first screen first. Nothing is changed.
- **A draft**: at most three questions in one message, only ones the document cannot be written
  without; after your answers, the finished artifact with its gaps marked.

## What It Needs

Node 18 or later for the bundled scanner, run from this skill's folder:

```bash
node scripts/slop-scan.mjs <file>          # compact report
node scripts/slop-scan.mjs <file> --full   # every example; --json for scripts
node scripts/slop-scan.mjs --self-test
```

The scanner reads text, Markdown, HTML, CSS and SCSS, JSX, TSX, Vue and Svelte, and JSON content
files, and reports evidence with line numbers in two layers, text and look. It skips code, quoted
spans and anything marked `data-slop-ignore` or wrapped in `slop:ignore-start` and
`slop:ignore-end` comments; findings in `>` quotes and in depicted chats or terminals come back
as `info`. It decides nothing; it makes two reviews of
the same file agree. `--fail-on high` and `--fail-on-look medium` turn it into a gate (exit 2).
Without Node the skill still works, more slowly.

Word and PowerPoint files need the docx or pptx skill, or `pandoc` and `python-docx` /
`python-pptx`. PDFs need the pdf skill or `pdftotext`; they are reviewed, not edited. Reviewing a
live URL needs browser or web-fetch access in the session.

## What It Will Not Do

- Change a file before you approve the plan, unless you said to apply directly.
- Invent a number, date, customer, benchmark, quote or source.
- Change a commitment, scope boundary, price, condition or negation while improving the prose.
- Edit quoted material, code, data, legal copy inside a larger document (it flags it),
  testimonials, a design system's own components,
  or a product's output shown in a chat or terminal replica.
- Fake a human voice: no planted typos, sprinkled contractions, invented anecdotes or
  mechanically varied sentence lengths.
- Touch work that is already good.

If you disagree with a finding, ask it to justify that one; every judgment is anchored to quoted
text, not to taste.

## Notes

This skill absorbed the former `deslop` skill: its look layer, its scanner and its
plan-then-apply workflow now live here, and `deslop` no longer exists.

The text patterns draw on Wikipedia's *Signs of AI writing* (WikiProject AI Cleanup) and on
blader's [`humanizer`](https://github.com/blader/humanizer) skill (MIT, v3.1.0), in this skill's
own wording. The substance layer, the artifact profiles, the look layer and the scanner are
original. The look layer and the audience voice come from a product owner's design reviews of
client-facing AI pages. The glossary is built from the AI Enterprise app's glossary and the
canonical terms of the AI/Run Hyperfactory, with client names, people and figures left out.

The name collides with the globally installed `blader/humanizer` if you have both; ask for "the
codemie humanizer" or give its path when you want this one.

For maintainers: `codemie-html-report` carries byte-identical copies of `scripts/slop-scan.mjs`
and `references/glossary.md`, so it works without this skill installed. Edit them here, copy them
over, and run `npm test`: `evals/humanizer-shared-files.test.ts` fails when they drift.
