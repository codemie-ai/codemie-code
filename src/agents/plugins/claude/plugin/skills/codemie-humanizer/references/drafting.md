# Drafting: from notes to a finished artifact

The input is a bullet dump, a transcript, a voice note or three sentences in a chat. It holds the
author's real knowledge in unusable form and lacks exactly what makes writing substantive: the
number, the decision, the audience, the consequence of a no. The job is to get those out of the
author, not to generate something that fills the gap convincingly.

## 1. Classify the artifact

"Sounds human" means something different per artifact: a chat message dies of formality, an ADR
of chattiness. Decide in this order and stop at the first match:

1. If "client or internal?" changes the work, make it one of the §2 questions.
2. Read the markers: greeting and sign-off is an email; Given/When/Then is a ticket; Context,
   Decision, Consequences is an ADR; dated version headings are release notes; a hero line, three
   feature blocks and a button label are landing-page copy.
3. Read the address: second person is documentation or marketing; first person plural with
   commitments is a proposal; no person is a report or a reference.
4. Under 60 words with no headings is a message; a `.md` file in a repository is documentation.
5. Otherwise assume an internal document, and say so.

| Artifact | Reads as written by a person when | Cannot be written without | Never |
| --- | --- | --- | --- |
| Proposal | it names constraints only someone who did the work knows | a price or pricing basis, an out-of-scope list, a named risk with an owner, a date | invent a reference, metric or past engagement; soften a scope boundary while "improving flow" |
| ADR, RFC, architecture document | the rejected option is real and losing it cost something | the decision in one sentence, one real alternative and why it lost, a consequence the author dislikes | describe the previous version like a change log, unless it is a migration document |
| Executive summary | sentence one is the conclusion, sentence two the number | the ask, the number and the deadline, on the first screen | run past a page; add a Background section |
| Article, blog post | it holds something the author got wrong, a surprise, or a specific nobody would invent | a claim the author would defend, one concrete thing that happened | add an anecdote, opinion or doubt; with no experience in the source, say the piece needs one |
| README, technical docs | it says what the thing does, how to run it, and what will bite you | a working command and its prerequisites | touch code, commands, paths, flags or output; drop a warning; turn a reference into prose |
| Email | it opens with the reason and closes with what the reader must do | the ask and its deadline | add warmth the author did not write; grow three lines into paragraphs |
| Chat message | it comes in bursts, conclusion first | who it goes to | add a greeting, a sign-off or punctuation; merge the bursts |
| Slides and notes | slides carry claims and notes carry evidence | one message per slide, stated as a sentence | a bullet longer than a line; a slide that restates its title |
| Release notes | they say what changed for the user and what to do | the version, the date, breaking changes first | invent an issue number, version or contributor; describe a refactor users cannot see |
| Landing page | it says the specific: "Deploy to production in four minutes" | what the product does, in the reader's words, on the first screen | invent social proof, names, ratings or numbers; cut legal copy; alter a trademark or tagline |
| Status report, meeting summary | it says what changed, what is at risk, what the reader must decide | the change since the last one, an owner on anything open | turn an attributed statement into an unattributed one |
| Ticket, user story | the acceptance criteria are falsifiable | the observable change and what makes it done | invent an ID, estimate, assignee or dependency; widen the scope |

No profile fits: who reads it and what do they do next (that sets the ask); what decision or fact
does it carry (the spine); what could only someone who did the work know (protect and elicit
it); what is contractual or someone else's words (untouchable).

## 2. Ask, at most three questions

One message, asked once, then stop. A question earns its place only if the profile says the artifact cannot
be written without the answer, the answer is not in the material, the repository or the
conversation (look first), and it changes more than one sentence. Rank by blast radius and keep
three; everything below the cut becomes a `[NEEDS: …]` marker in the draft.

Ask closed, concrete questions: "What is the number for 'much faster onboarding'? Even a rough
one." "Is the March cut-over committed to the client, or internal?" Never ask about tone, style
or length, whether to proceed, or anything the material answers. Skip questions for chat
messages and "just write it": draft and mark the gaps.

## 3. Mine, do not generate

A thin section tempts you to write more; that is how water is made. Look at what the author did,
not only what they said: commits, tickets, threads, an earlier document. Find the thing that went
wrong, the number that already exists in a dashboard or report (cite where), and the option that
was rejected and why. If the material holds nothing specific, the honest draft is short: four
sentences and three `[NEEDS: …]` markers beat two convincing pages.

## 4. The spine, before any prose

```
CLAIM     what is asserted or decided, in one sentence
EVIDENCE  what makes it true: the number, the event, the mechanism
COST      what it takes, what it breaks, what was given up
RISK      what could go wrong, and who owns it
ASK       what the reader must do, by when
```

Every artifact needs CLAIM and EVIDENCE; a README has no ASK, a change log no RISK. A hole in the
spine is a hole in the document: fill it or declare it. Show the spine to the author when the
piece is long, contested or client-facing.

Write the section that carries the argument first. If it comes out thin, no framing will save it.
The introduction comes last, if at all, in one or two sentences.

## 5. Length

Count the distinct facts the reader does not already know and could check; that sets the size.
One paragraph of 40 to 80 words per cluster of facts: six facts is a page, two is a paragraph
even when the request said "document". When the honest answer is three sentences, write three
and say why it is short.

At every section, look in the material for what someone who did the work would say: the tool by
version, what took three days, the part they are unsure of. If it is missing, mark
`[NEEDS: …]`. Never describe the industry or conclude that the answer is balance.

## 6. Self-check before returning

Any "no" is rework, not a caveat.

- Is every fact traceable to the source, the author or a file I read?
- Does every claim of effect have a number, a named source, a dated event or a mechanism?
- Would anything be lost if I deleted the first paragraph?
- Would it turn false if I swapped in a competitor's name or another project?
- Does it end on the last useful fact rather than a summary or an outlook?
- Is any personality in it one I added rather than found?
- Did I mark every gap instead of writing around it?
- Does the scanner show no `high` findings, and did I check the ones it shows?

Then reread it for sentences of one length; cadence is the last thing to go and the first thing a
reader notices.
