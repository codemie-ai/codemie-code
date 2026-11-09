# Writing the page

A CodeMie page is read by people who know the subject and have little time: engineering leads,
a CTO, a client. This file adds to SKILL.md's Step 0 what a client or executive page needs.
`visual.md` is the look; `glossary.md` is the words of our work.

## Voice for our audience

- Direct and concrete. Lead with the number or the real example, not with context they have.
- No hype. Say what AI does not do well and where it fails; a reader trusts the page that names
  its limits.
- Diagnose before prescribing: what happens, why, what to do, what it costs.
- Order sections by the client's questions and title each with its answer; our framework's name
  goes in the text.
- Each section or slide carries one take the reader can repeat. When shortening, cut facts,
  never the take.
- No "we" credentials ("we have done this since spring", "our factories", "our dashboard"). Our
  own experience appears only as a story of a problem or a surprise that is itself the point.
- Beyond SKILL.md's keep-out list: rates unless their owner approved them for this page, vendor
  marketing multipliers ("193.6x faster"), and claims you could not check.

## The spine

An empty spine line: fill it from the input, show the gap on the page ("Cost per team is not in
this export"), or ask the user.

## Title and headings

- The subtitle gives the period, the source and the generation date: "6–12 October 2026 ·
  CodeMie analytics export · generated 13 October".
- Section headings and card titles say what their content shows: "Three assistants carry 70% of
  conversations", not "Top Assistants Overview".

## Numbers

- A change carries its base: "from 19 h to 3 h", "+18% on week 40 (1,027)". "10x faster" and
  "500+ teams" with no base are not allowed.
- Keep the precision the data has, and round the same way everywhere.
- Illustrative or sample data is labelled as such on the page.
- When a number the reader will expect is missing, say so instead of filling the space.
- A claim of effect in the input with nothing under it ("the assistant significantly improves
  productivity") is not a fact on the page. Show its mechanism if the input gives one ("reviews
  start before the merge request opens"), cut it, or ask for the number. Never soften it into
  "may help improve".
- A forecast is a range, not a point, and says what it rests on ("from three months of our own
  runs; recalibrate on yours"). It is never a quote.

## Sources

- Name, date and type every external figure: "Gartner press release, 24 June 2026; analyst
  forecast, no sample stated", "survey of 472 respondents in 11 industries".
- Use sources from the last 12 months; an older one stays only with the reason beside it.
- Follow each external fact with what it means for the decision on this page.
- No source, no figure. "Studies show" and "industry reports suggest" are cut, never filled in.

## Words

- Use the words in `glossary.md`: the headword for each concept of our work (factory, flow, gate,
  harness, headless agent, model routing, unit cost, complexity point and the rest), spelled as
  listed, and none of its _Avoid_ words. Internal names (Flywheel, iFactory, Dark Factory) never
  appear on a client page. A project's own `GLOSSARY.md` wins over it.
- Plain verbs and the field's own words. One name per thing: the same in the title, the table
  header and the chart legend.
- Cut on sight: comprehensive, robust, seamless, leverage, utilize, empower, unlock, elevate,
  cutting-edge, next-gen, transformative, actionable insights, game-changer, "in today's
  fast-paced…", "it's not just X, it's Y" and its split form ("This does not mean X. It means
  Y."), "Here's the thing", "The result?", "To be clear,", a closing line that restates the card
  above it ("That is the real win."), exclamation marks.
- No interpretation the data cannot carry: "showcasing strong adoption", "highlighting the
  team's commitment", "paving the way for growth".
- No chatbot lines: "Here's a breakdown", "I hope this helps", "Let me know if you'd like…".
- No sentence about the page itself ("The table below compares…", "This dashboard provides an
  overview of…"); the title and the card titles say it. Keep the subtitle's source and date, a
  data note that changes how to read a number, and a hint the reader cannot see ("click a bar
  for details").

## Sections

- The summary is the first screen: the title, the stat cards for the three to five numbers that
  matter, and the ask.
- No "Recommendations" or "Next steps" unless the input contains them or the user asked. A
  recommendation states its cause from the data; a next step has an owner and a date.
- No section, card or chart without data behind it. An empty state ("No incidents this week") is
  information; a filler card is not.
- Bold marks the one figure a scanning reader must not miss.

## Before and after

> Title. Before: "🚀 Comprehensive AI Adoption Dashboard: Unlocking Actionable Insights".
> After: "Release pipeline, week 41: 46 deploys, 2 rolled back".

> Stat card. Before: "10x" / "PRODUCTIVITY BOOST".
> After: "3 h" / "Median time to first review, September (19 h in June)".

> Section. Before: a "Key Insights 💡" box with "Adoption is accelerating rapidly across teams,
> showcasing strong engagement."
> After: nothing, or the one sentence the data supports: "Four of six teams used the assistant
> on every working day."
