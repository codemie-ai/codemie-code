# Text

Passes in order: substance, then words, then shape. Each item is a place to look, not proof.
Generated text shows itself through density and co-occurrence: four tells in one paragraph, or
one tell on a fixed rhythm. When unsure, leave it; a false positive costs the author their voice.

Some tells justify an edit on one sighting: a contrast with something nobody claimed (not X but
Y), a closing line that repeats the point, a saying that sounds deep, a staged run-up, an answer
to an objection nobody raised, and assistant residue. Others count only beside other tells in the
same passage: one dash, curly quotes, one hedge, a passive sentence, one sentence about the page.

## 1. Substance

**The delete test.** For each sentence: if it went, what would the reader no longer know,
counting what they already have from earlier in the text or the conversation? If nothing, it
goes, however well it reads. One exception: a sentence that orients a reader landing
mid-document (runbooks, references, long proposals) can stay.

The usual shapes of water:

- Context the reader already has: "In today's fast-moving environment, teams face growing
  pressure to modernise." Start with the first sentence that is only true of this situation.
- The heading restated: a section "Migration risks" opening with "There are several risks
  associated with this migration."
- A fact followed by its interpretation: "We moved to Postgres 16, reflecting our commitment to
  keeping the platform current." Keep the fact.
- The summary of what was just read: "Key takeaways", "In conclusion", a TL;DR that repeats the
  body in the same order.
- Sections that exist for shape: "Challenges" every project has, "Benefits" restating the
  features in the future tense, "Future outlook", "Next steps" with no owner or date, an
  "Introduction" describing what the document will describe.
- Writing about the document instead of its subject: "The table below compares the options",
  "This report was generated from the tracker", "was added to replace the old flow". Keep a
  source credit, a caveat that changes what the reader does, and a convention they cannot see
  ("click a block for details"), once.

**Claims need something under them.** Strongest first: a measurement, a dated event, a named
source the reader can find, a first-hand observation, the mechanism. Not evidence:
"significantly", "dramatically", "industry-leading", "studies show", "experts agree", "many
organisations report". The scanner only matches numerals, so a claim backed by a named source or
a dated event is still flagged; confirm by reading.

**When there is no evidence**, in order of preference:

1. Replace the claim with the mechanism. "The pipeline improves developer productivity" →
   "Developers stop waiting for the shared staging box; each branch gets its own environment."
2. Replace it with what was observed. "Onboarding is much faster" → "The last two joiners shipped
   a change in their first week."
3. Say what is known and that it was not measured. "We expect the bill to drop, mostly from
   turning off the idle staging cluster. We have not modelled it."
4. In a proposal, turn it into a commitment. "We will publish escaped-defect counts monthly."
5. Cut it. Most unsupported claims lose nothing when deleted.
6. Mark it: `[NEEDS: a number for "faster onboarding"]`.

Never hedge a claim into mush ("may potentially help improve outcomes in some cases"). It
survives review because nobody can object to it, and it teaches the reader that nothing in the
document is worth checking.

**Numbers need a base.** "10x faster", "50% less effort", "3x ROI", "500+ teams": faster than
what, measured how, when, by whom? Keep a number with its unit, base, period and source beside
it: "review time fell from 6 h to 2 h per story, median of 40 stories, March". Prefer a share of
a stated base ("45% of today's cost") to index points ("today = 100"). A forecast is a range,
not a point, and says what it rests on. When two figures measure different work, say so.
Illustrative data is labelled as such.

**Sources are findable, typed and current.** Name, date and kind: survey of 472 respondents,
analyst forecast, vendor report, academic preprint. Late in a year, use that year's sources; an
older one stays only with the reason next to it. Follow each external fact with what it means
for the decision in front of the reader.

**Diagnose before prescribing.** A recommendation with no stated cause is an opinion. The order
that persuades: what is happening, why, what to do, what it costs. Watch for a problem named in
the first section and never mentioned again; the middle drifted into a capability list.

**Name who acts.** "Access is reviewed quarterly" → "the platform team reviews access every
quarter"; "costs are linked to usage" → "grow with" or "are billed per". If the source does not
say, mark `[NEEDS: owner]` or keep the vague word; never invent it.

**The decision test.** A proposal states scope, what is out of scope, a price basis and a date.
An ADR names a real rejected option and why it lost. A decision memo states the decision in its
first sentence. A status report says what changed and what is at risk. An incident review says
what broke, the impact in numbers, why the checks missed it and what changed. If the source lacks
it, mark the gap; never manufacture one.

**One real case beats three generic ones.** "Serves finance, healthcare and retail" says
nothing. One case with its constraint ("400 stores whose systems go offline nightly, so every
write path needed a queue") says something.

## 2. Words

**Stock vocabulary.** Above about 8 per 1,000 words, vocabulary alone gives the text away; below
about 4, ignore single hits. The scanner holds the full list; the usual ones are delve,
leverage, seamless, robust, comprehensive, crucial, pivotal, landscape, foster, showcase,
unlock, empower, elevate, streamline, enhance, facilitate, utilize, transformative,
cutting-edge, innovative, powerful, testament, tapestry.

Replace with a shorter plain word or nothing: leverage → use; utilize → use; facilitate → run,
host, or cut; empower → let; enhance → improve, or say how. Never swap a stock word for a longer
plain one ("make use of"). Technical senses stay: a robust estimator, an ecosystem in biology,
landscape orientation, a test harness, an API key, a quality gate, a deep-dive page.

**Hype and labels.** "AI-powered", "revolutionize", "the future of X", "a new era",
"world-class", "best-in-class", "blazing fast". Brochure words ("a commitment to excellence", "a
diverse array of", "renowned", "nestled in the heart of") read as an advertisement. Say what it
is and what it does, or cut.

**Figurative verbs and stock metaphors.** "Context travels with every session", "rides along",
"holds the line", "sits at the heart of", "the backbone of", "bridges the gap", "moves the
needle", "unlocks value", "north star", "single pane of glass", "game changer", "paves the way".
Say what happens: "each session records its team, repository and branch".

**Coined names for ordinary things.** "Customer Promise" for an assistant's limits, "Trust
Layer", "Velocity Engine", alliterative phases ("Assess, Align, Accelerate"). Use the field's
own word: scope, permissions, audit trail, review, approval. Before naming a control or a phase,
check that people in the field use the word.

**Jargon on a page for non-specialists.** "Scoped tokens", "HITL", "deflection", "telemetry".
Say what it does: "each engineer's token reaches only their projects"; "a person approves it
before it ships". Spell an acronym out at its first use on a page.

**Filler.** in order to → to; due to the fact that → because; has the ability to → can; it is
important to note that → cut; when it comes to → usually cut; plays a key role in → name the
role; a wide range of → name them, or cut; "Additionally," → "Also," or cut. Hyphen pairs piled
up (data-driven, cross-functional, end-to-end, real-time) read as filler too.

**Verb avoidance.** "Serves as", "stands as", "functions as", "represents", "boasts",
"features", "offers" where "is" or "has" would do.

**Synonym rotation.** The platform, then the solution, then the system, then the offering. Pick
one word per thing and keep it; in technical writing, repetition is how the reader keeps track.
If the project has a glossary, its word wins and its "avoid" words stay out.

## 3. Sentence shapes

- **Participial tail.** ", highlighting / underscoring / reflecting / ensuring / paving the way
  for …" adds an interpretation, not a fact. Almost always deletable.
- **Not X but Y.** "This isn't just a refactor, it's a rethink." The negative half names
  something nobody claimed. Act on one sighting, also when split ("This does not mean X. It
  means Y."), reversed ("Y rather than X") or clipped (", no guessing"). Keep it only when the
  reader really believes X, or both halves carry information.
- **Forced triples.** Three items where the third is cadence. Remove it; if nothing is lost, it
  was rhythm. The same habit works at paragraph scale: three parallel examples, or three short
  facts and then a lesson. Keep three when the meaning has three parts.
- **False ranges.** "From architecture to culture": two nouns posing as the ends of a range.
- **Closing lines and fragments.** A closer that restates the paragraph or explains the example
  just shown ("This shows the importance of…", "That distinction matters."), the same closer
  after every section, a row of fragments ("It failed. Every time."), "Every. Single. Day.", one
  word in capitals. Keep a short sentence that adds a fact.
- **Inflated significance.** A fact that "marks a turning point" or "sets the stage for", a
  "Despite these challenges…" paragraph, a send-off ("The future looks bright"). Keep the fact;
  end on the last concrete one.
- **Hedge stacks.** Two or more of may, might, could, potentially, typically, arguably in one
  sentence. Keep the one the evidence supports, and keep scope statements, legal and safety
  notices, and real corrections.
- **Hooks and reveals** from social posts: "Here's the thing:", "The result?", "The kicker?",
  "Let that sink in.", "This changes everything.", "What if I told you…", "No fluff.",
  "quietly reshaping". Replace with the point.
- **Rhetorical question as a transition.** "So what does this mean in practice?" Write the
  answer instead.
- **Announcing.** "Let's dive in", "Let's break this down", "Here's what you need to know", "In
  this section we will", "The thing is,", a standalone "Honestly?" before a routine claim.
  Delete; the point stands on its own. "Honestly" inside an ordinary sentence is fine.
- **Manufactured depth.** "At its core", "The real question is", "Fundamentally", "X is the Y of
  Z" ("data is the new oil"), "X becomes a trap", "not a tool but a mirror", "the currency of
  trust". State the specific claim.
- **Fake trade-off.** "Powerful, but it requires discipline." Name the actual cost or drop it.
- **The balanced close.** Both sides presented, nothing concluded. State the view, or say the
  decision is open and what would settle it.
- **Answering an objection nobody raised.** "This isn't about replacing engineers.", "To be
  clear,", "Don't get me wrong", "One might be tempted to". Cut it, or state the claim inside it.
  Keep an objection the text names and answers, and an option a reader would really weigh.
- **Vague attribution.** "Experts agree", "research shows", "industry reports", a row of outlets
  ("as featured in…"), a follower count. Name the source and what it said, or cut the claim.
- **Exclamation marks** in business prose.

## 4. Layout inside text

- **Bold mini-heading bullets** ("- **Performance:** Response times have been improved") are the
  strongest visual tell. Write the sentence. A long run of bold terms with definitions (a
  glossary, an options reference) is legitimate.
- **Bold scattered through sentences.** Bold is for the one thing a scanning reader must not
  miss: two per page, not two per paragraph.
- **Emoji** in headings, bullets and buttons. Emoji as data, in a status column, can stay.
- **Every section the same size**, perfectly parallel bullets, paragraph-then-bullets on repeat.
- **A table for two facts**, a numbered list where nothing is ordered, a rule between every
  section, heading levels used for emphasis, arrows (→) as decoration in headings and list items,
  a top heading that repeats the document's title.
- **Title Case headings** in a document whose other headings are sentence case. A consistent
  house style is not a tell.
- **Labels typed in capitals** ("KEY INSIGHT", "TOTAL USERS"). Write normal case and let the
  styling decide.

## 5. Rhythm

Metronome sentence lengths (scanner `sentence_length_cv` under 0.35; people write 0.45–0.85),
paragraphs of equal length (`paragraph_length_cv` under 0.30), the long-then-short pair in every
paragraph, every paragraph closing on a punchy line. The scanner measures only lengths; check the
rest yourself.

## 6. Assistant residue

"I hope this helps", "Certainly!", "Great question", "Let me know if you'd like", "Want me
to…?", "Should I continue?", "Here's a breakdown", "As of my last update", "based on available
information", "while specific details are limited", "not widely documented", and speculative
gap-filling ("she likely studied…"). Delete it, or state the gap as a fact of the document:
"The founding date is not in our sources."

## 7. Titles, labels, status and calls to action

- A title names the thing and states its specific claim. "Unlock the Power of AI" → "Release
  notes written from the merged tickets".
- A heading states the finding, not the topic. "Seat Utilization" → "A third of paid seats went
  unused in September". The text under it does not repeat it. No heading written for effect
  ("The decision, on one screen").
- A call to action says what happens. "Learn more" → "See the rollout plan"; "Get started" →
  "Book a 30-minute review".
- Status and caveats go in words, not pills: "running with one team", "not built yet", "a
  forecast, not a quote: its baselines come from our own runs".
- Social proof only if it is real and approved. "Trusted by 500+ teams" with no source goes.

## 8. What clean looks like

Readers who have seen every pitch (engineering leads, CTOs, CFOs) are persuaded by specifics,
not enthusiasm. Say what the thing does not do well; a reader trusts the page that names its
limits. No "we" credentials ("we have done this since spring", "our factories"): the author's
experience appears only as a problem or a surprise that is itself the point. No vendor marketing
multipliers ("193.6x faster"), single forum tests, or claims about a tool you have not checked.

- Lead with the most concrete thing: the number or the real example.
- Follow one running example through the whole document, with the same names and numbers, in
  labelled places so the general text still reads without it.
- Say each message once, in one section. Go one level deeper below a summary (the mechanism, the
  inputs, the decisions); never repeat it.
- Each section carries one take the reader can repeat. When shortening, cut facts, never the
  take.

> Stat band. Before: "10x faster · 99.9% uptime · 500+ teams".
> After: "Review time per story: 2 h, down from 6 h (median of 40 stories, March 2026)." The
> uptime and the team count go: nothing in the source supports them.

> Problem statement. Before: "Lack of visibility hinders strategic decision-making."
> After: "Leaders can't see which teams or agents produce results, so they can't decide what to
> fund, scale or stop."

## 9. Do not flag

Clean grammar; formal vocabulary outside the list; em dashes, semicolons or curly quotes on
their own; one transition word; one hedge such as "perhaps" or "tends to"; what the author's own
writing sample does on purpose; a salutation; one short sentence for emphasis; deliberate
repetition; repeated technical terms; lists and tables whose content is parallel; non-native
English; missing citations in ordinary writing; text written before 2023; quoted text, titles
and examples; a passage discussing a phrase rather than using it; terms a project glossary or
style guide defines (a house section name such as "Why it matters" is a name, not a tell); a
product's own output shown in a chat or terminal replica.

## 10. Never do

Beyond gate 4: never give every em dash the same replacement, and add no slang.

## 11. Preserve

Oddly specific details ("the lock file that only breaks on the CI runner in Frankfurt"),
unresolved tension, asides and self-corrections, uneven emphasis where the author cared, dated
references, the author's stated opinions, a deliberate quirk, sentence-length variety that is
already there.
