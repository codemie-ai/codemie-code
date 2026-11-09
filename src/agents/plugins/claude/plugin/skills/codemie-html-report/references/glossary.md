# Glossary: the words for our work

One word per concept for EPAM AI/Run, CodeMie and AI-native delivery. Use the **headword**; keep
_Avoid_ words out of anything a reader sees ("(on screen)": fine in code and notes; "(for this)":
fine in another sense). A project's own `GLOSSARY.md` wins over this file.

- Keep one name per thing: the same in the title, table header, chart legend and next page.
- Spell an acronym out at first use: "forward-deployed engineer (FDE)".
- Open with the client's question; put our framework's name under it.
- Names are Title Case on screen, lower case in running text ("a headless agent").

## Spelling

| Write | Not | Note |
| --- | --- | --- |
| EPAM, AI/Run | Epam, AI Run, AIRun | AI/Run: EPAM's ecosystem of agentic AI platforms and offerings |
| CodeMie | Codemie, Code Mie | The agentic AI platform; the product, not the ecosystem |
| AI/Run Hyperfactory | iFactory, Hyper Factory | One casing per document; the site writes "Hyperfactory" |
| AI Runway | AI/Run (for this) | EPAM's bootcamp for factory work; not AI/Run |
| LiteLLM, MCP server, DIAL, Keycloak | LightLLM | MCP = Model Context Protocol |
| Claude Code, Codex, Cursor, GitHub Copilot | Copilot (alone, for the product) | Coding-agent tools: harnesses |
| GitHub, GitLab, Azure DevOps, Jira, Confluence | ADO (on screen) | The client's tools |

## Internal only: never on a client page

Flywheel (Seed, Plant, Grow, Harvest, Evolve: say what gets reused instead) · iFactory, AI Factory
Umbrella, Factory Umbrella (old names of the Hyperfactory) · Dark Factory (say "the Autonomous
flow") · LEAP portal, AI Runway cohorts, the bench · client names, engagement codenames,
colleagues' names, internal usage and cost figures, prices and rates unless their owner approved
them for that page.

## The Hyperfactory

- **AI/Run Hyperfactory**: the framework of rules for building and running AI factories, over a marketplace of proven ones; not a product or platform. _Avoid_: iFactory, AI Factory Umbrella
- **Factory**: one reusable workflow for one kind of software work, owned by the client's team: specialist agents, gates a named person answers, a record of every run. _Avoid_: coding assistant, bundle
- **Factory Primitive**: skill, subagent, hook, command, guide or rule: the six building blocks of a factory.
- **Vertical**: factories and content curated for one technology ecosystem or domain; not a Hyperfactory.
- **Marketplace**: the catalog of factories that passed a quality check, each with an owner and trained people. _Avoid_: plugin marketplace (for a package repository)
- **Knowledge Foundation**: the reviewed guides, rules and decisions a factory reads before it acts on a codebase; a config file with an init command is not one.
- **Pillar** and the client question it answers: Factory Pipeline (How does the factory work?), Security First (Won't this add security issues?), Agentic Environment (What does it need from my tools?), AI-Native People (Which people do I need?), Team Jump-Start (How fast can we start?), Tokenomics (What does a task cost?).

## Factory Pipeline

- **Stage**: Discovery (weeks 1–2, knowledge foundation), Foundation (weeks 3–4, first agent-made merge requests through the client's quality gates), Delivery (week 5 on).
- **Flow**: **Light** (small, clear work; a person at the plan, review and checks), **Standard** (a person at every gate), **Autonomous** (batch work in a sandbox; stand-ins answer the gates; a person is called on an escalation). Product owner mode defines a ticket first and writes no code. _Avoid_: Lightweight, Dark Factory (on client pages)
- **Standard phases**: Requirements, Design, Build (test first), Review, Verify, Release.
- **Gate**: where a named person approves the work before it moves on; recorded either way. _Avoid_: HITL, human-in-the-loop (on screen; say who approves what)
- **Stand-in**: an agent that answers a gate in an autonomous run on the owner's behalf.
- **Owner**: the client's named person who answers for a gate or a business service.
- **Accepted**: signed off by the owner against criteria agreed before the work. _Avoid_: independently accepted
- **Factory Output**: what a factory hands over once accepted, with its record: a story, a verified branch, a fix. _Avoid_: ticket (as the unit)
- **Complexity Score**: six aspects scored 1–6, so 6–36, sizes XS–XXL; light up to 14, standard from 15, split from 27; re-taken after the build. _Avoid_: story points (for this)
- **Risk Flag**: sends a story to a spec at any score: auth, secrets, regulated data, data migration, new external integration, vague criteria, core shared code.
- **Review Lens**: a parallel reviewer at the review gate looking for one kind of problem. **Decision Ledger**: the record of every gate, who or what decided, with evidence.

## Agents

- **Harness**: the coding-agent tool engineers already use; an autonomous run goes only into a sandbox.
- **Headless Agent**: started by CI, a ticket or a schedule with no person watching; a person reviews the result. _Avoid_: background agent
- **Agent Platform**: a shared place to build, version, run and monitor agents in the client's cloud.
- **Package Repository**: where a factory package is published and installed from; versions reviewed like code. _Avoid_: plugin marketplace (on screen)
- **Token per Engineer**: an engineer's credential: only their projects, only the rights the work needs. _Avoid_: scoped token, scoped access
- **Workflow Agent**: does jobs inside a business service, acts only through its connectors, an owner decides at its gates. _Avoid_: bot, digital worker, background agent
- **Co-work Agent**: the agent a business user already has in their office suite. _Avoid_: copilot (as a generic word)
- **Product Assistant**: the AI a customer uses inside the client's product; proposes, the customer confirms. _Avoid_: chatbot (as the name)
- **Product Agent**: works one customer task behind the product's API. _Avoid_: bot
- **Connector**: a versioned, permissioned way for agents to use one business system, usually an MCP server. _Avoid_: integration (for this)
- **Trigger**: what starts an agent on a case: an event, message, call, schedule or another agent. _Avoid_: kick-off

## Control Plane

- **Control Plane**: sets what agents may use and measures what AI costs and buys; does no work itself.
- **Guardrails**: limits on models, tools and data, enforced in the tools, in CI and at the AI gateway.
- **AI Inventory**: every AI tool, agent and MCP server in use, with owner, data, vendor terms and status (approved, limited, in review, blocked). _Avoid_: shadow AI list
- **Agent Identity**: an agent's own identity, owner, narrowest rights and review date. _Avoid_: service account (for this)
- **AI Gateway**: the front door for model and MCP calls: caller, content guard, routing, budget, logs. On screen: "AI Gateway and Model Routing". _Avoid_: model gateway
- **Data Guard**: the gateway's per-call check that masks, blocks or logs data. _Avoid_: DLP (for this)
- **MCP Registry**: approved MCP servers, each tool allowed or blocked per team. _Avoid_: MCP marketplace
- **Model Routing**: each piece of work to the cheapest tier that does it well: **fast, medium, frontier** (or reasoning); cost, not failover. _Avoid_: smart routing, workhorse
- **Failover**: a failed model, vendor or region replaced by a model that passed the same test set. _Avoid_: fallback (for this)
- **Budget Ladder**: observe, alert, throttle, re-route, block. **Evidence Pack**: what one tool or agent shows an auditor for a quarter.

## Tokenomics and commercial terms

- **Tokenomics**: what a task costs in AI usage and what keeps it low; forecast per task. The price per token is not the price per task.
- **Spend Inventory** (level 1): every AI cost in one place, matched to invoices, counted once.
- **Attribution** (level 2): each cost tied to the team, service, agent and ticket it served. _Avoid_: chargeback (for this)
- **Unit Cost** (level 3): the AI cost of one accepted output, next to its quality and rework. _Avoid_: cost per ticket (as the unit)
- **Seats**: paid seats against who used them in the last 30 days. **Forecast**: a range, never a point or a quote.
- **Pay for Output**: priced per accepted unit of output, labor and AI inference in one rate. _Avoid_: how you pay, commercial models
- **Unit of Output**: the one thing an offering counts. _Avoid_: unit of work
- **Complexity Point**: one point of a story's complexity score; counts once the story is accepted; calibrated before any price. _Avoid_: story point, developer day

## People and knowledge

- **AI-Native People**: AI-Native PO/BA, AI Solution Architect, AI-Native Tech Lead, AI-Native Developer, AI-Native QA Engineer; one set of eight skill dimensions, judged on real proof.
- **Forward-Deployed Engineer**: our engineer in the client's team: leads, then pairs, then coaches. _Avoid_: FDE (without the full name first)
- **Champion**: a person in the client's function who designs the new work and trains the next team. _Avoid_: AI champion, ambassador, power user
- **Pod**: the small team that transforms one business service. _Avoid_: micro pod, squad, POD
- **Team Jump-Start**: eight weeks to a team that runs the factory: prerequisites on day 0–1, calibration in week 1, full scale by week 8.
- **Hand-Over**: Lead, Pair, Coach, On call. _Avoid_: knowledge transfer
- **Decision Pack**: what a jump-start leaves for the decision to fund, prepare first or stop. _Avoid_: deliverables, blueprint (for this)
- **Knowledge Plane**: where tribal knowledge is captured, reviewed and kept current for agents to read first.
- **Playbook**: a way of working rebuilt around agents: who decides, how work moves, how it stays secure.
- **Compounding**: each service or factory makes the next cheaper because its parts are reused. _Avoid_: synergy, flywheel

## Evaluation

- **Test Set**: an agent's cases with known outcomes, run on every change. _Avoid_: golden dataset, eval suite
- **Trace**: one run's steps, tool and model calls and cost. _Avoid_: telemetry (on screen)
- **Judge Model**: a second model scoring answers against a rubric; people check a sample. _Avoid_: LLM-as-judge (on screen), AI grader
- **Error Analysis**: reading real outputs and counting each kind of failure before writing metrics. _Avoid_: vibe check
- **Live Score**: a live conversation's score from the test set's scorers. _Avoid_: online eval (on screen)
- **Hostile Set**: attacks run on every release candidate. _Avoid_: jailbreak list, red-team suite (on screen)
- **Calibration**: testing an agent on past cases until accuracy, consistency and cost meet the bar. _Avoid_: tuning, proof of concept

## The AI Enterprise map

- **Map**: offerings across, layers down. **Offering**: AI Solutions, Business Agent Transformation, AI-Native Delivery, the Control Plane on its own.
- **Layer**: Control Plane, Work Plane, Knowledge Plane, Playbooks, Pay for Output; only the first three are planes. _Avoid_: plane (for all five)
- **Business Service**: business work with one owner, such as claims handling. _Avoid_: value stream
- **Case**: one run of a business service. **Customer Task**: one job a customer comes to the product to finish. _Avoid_: use case
- **Thinking Work**: recurring work that needs judgment. _Avoid_: cognitive load (on screen)

## Everyday replacements

AI-powered → what it does · copilot (generic) → assistant, or the product's name · bot, digital
worker → workflow agent · background agent → headless agent · HITL → who approves what · use case
→ customer task or business service · synergy, flywheel → compounding · deliverables → what we
hand over, by name · POC, pilot (as a label) → Jump-Start, calibration, "running with one team"
