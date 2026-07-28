# Phase 0 Validation Spike — GitHub Copilot CLI local telemetry

**Date:** 2026-07-28
**Method:** empirical inspection of a real `~/.copilot` install — 78 session directories,
Copilot CLI versions `0.0.381` → `1.0.48`, macOS, `copilot` at `/opt/homebrew/bin/copilot`.

This resolves the open question that gated `docs/superpowers/specs/2026-06-17-copilot-cli-analytics-design.md`:
*where, exactly, does the Copilot CLI persist per-model token counts?*

**Answer: `session.shutdown.data.modelMetrics` in `events.jsonl`, from CLI `1.0.x` onward.**
Not OTel, not the SQLite stores.

---

## 1. On-disk layout

```
~/.copilot/
├── session-state/<uuid>/
│   ├── workspace.yaml      ← manifest. present in 78/78 (100%)
│   ├── events.jsonl        ← transcript. present in 54/78 (69%)
│   ├── session.db          ← todos/inbox only — NOT usage
│   ├── checkpoints/ files/ research/ rewind-snapshots/
├── session-store.db        ← global search index; 8 rows, NO token columns
├── config.json             ← logged-in users, installed plugins
├── settings.json           ← default model
└── otel/                   ← ABSENT (opt-in, off by default)
```

### `workspace.yaml` is the discovery manifest

Present in **every** session dir, including those with no transcript. Cheap to read
(~300–450 bytes) versus parsing a 1.5 MB `events.jsonl`:

```yaml
id: 879c0438-dace-429f-b4db-450aae9bde54
cwd: /Users/x/Personal/oss/codemie-code
git_root: /Users/x/Personal/oss/codemie-code
repository: codemie-ai/codemie-code
host_type: github
branch: fix/analytics-subagent-token-usage
user_named: false
summary_count: 0
created_at: 2026-06-16T06:21:01.974Z
updated_at: 2026-06-16T06:21:05.138Z
name: does the app support Copilot and Codex sessions extraction ...
```

This gives `sessionId`, `createdAt`, `updatedAt`, `projectPath` (`cwd`/`git_root`),
repository, and branch — everything `SessionDescriptor` needs, without opening the transcript.
Older sessions omit `host_type`/`name`/`user_named`; treat all fields as optional.

---

## 2. `events.jsonl` schema

JSONL. Every line: `{ type, data, id, parentId, timestamp }`. Event types observed:

| Event | Count (sample session) | Carries |
|---|---|---|
| `session.start` | 1 | `sessionId`, `copilotVersion`, `producer`, `startTime`, `context{cwd,gitRoot,branch,headCommit,repository,hostType,repositoryHost,baseCommit}` |
| `assistant.message` | 22 | **`model`**, **`outputTokens`**, `turnId`, `interactionId`, `requestId`, `toolRequests[]`, `phase` |
| `assistant.turn_start` / `turn_end` | 22 / 22 | `turnId` only — **no tokens** |
| `tool.execution_start` / `_complete` | 63 / 63 | tool name, args, result |
| `hook.start` / `hook.end` | 64 / 64 | hook metadata |
| `permission.requested` / `.completed` | 13 / 13 | permission prompts |
| `user.message` | 5 | user turns |
| `session.model_change` | 1 | `{previousModel, newModel, reasoningEffort}` |
| `session.context_changed` | 2 | context edits |
| `skill.invoked` | 2 | skill name |
| **`session.shutdown`** | 1 | **the full per-model usage block** |

### `session.shutdown` — the primary token source

```json
{
  "shutdownType": "routine",
  "totalPremiumRequests": 3,
  "totalApiDurationMs": 121081,
  "sessionStartTime": 1781590861967,
  "codeChanges": { "linesAdded": 0, "linesRemoved": 0, "filesModified": [] },
  "modelMetrics": {
    "gpt-5.4": {
      "requests": { "count": 22, "cost": 3 },
      "usage": {
        "inputTokens": 1431122,
        "outputTokens": 10684,
        "cacheReadTokens": 1235968,
        "cacheWriteTokens": 0,
        "reasoningTokens": 4422
      }
    }
  },
  "currentModel": "gpt-5.4",
  "currentTokens": 101497,
  "systemTokens": 14208,
  "conversationTokens": 77501,
  "toolDefinitionsTokens": 9785
}
```

`modelMetrics` is keyed by model — mixed-model sessions produce multiple entries, so
per-model accumulation works naturally.

---

## 3. Coverage is version-gated, not exit-gated

| CLI version | Sessions | `session.shutdown` | per-turn `outputTokens` |
|---|---|---|---|
| no `events.jsonl` (pre-schema) | 24 | — | — |
| `0.0.381` – `0.0.411` | 48 | **0** | **0** |
| `1.0.17`, `1.0.45`, `1.0.48` | **6** | **6 (100%)** | **100%** |

Raw coverage across this machine's backlog is 6/78 (7.7%), but that is a **historical
artifact**, not a ceiling: the correlation with version is perfect. Every `1.0.x` session has
complete telemetry; no `0.0.x` session has any. Token telemetry landed in Copilot CLI `1.0.x`.

**Practical consequence:** sessions from `1.0.0`+ are fully priceable; older sessions carry no
usage data at all and must degrade to listed-but-unpriced.

**Residual risk (unmeasured):** all 6 observed `1.0.x` sessions have `shutdownType: "routine"`.
A `SIGKILL`ed or still-running session plausibly never writes `session.shutdown`. The fallback
in §4 covers that case partially.

---

## 4. Per-turn fallback — validated exact

`assistant.message` carries `model` + `outputTokens` per turn. Summing per-turn values
reproduces `session.shutdown` **exactly**, including model attribution in a mixed-model session:

| Session | Model | Σ per-turn `outputTokens` | shutdown `outputTokens` | turns | shutdown `requests.count` |
|---|---|---|---|---|---|
| `879c0438` (v1.0.48) | `gpt-5.4` | 10 684 | **10 684** ✓ | 22 | **22** ✓ |
| `2bcffe67` (v1.0.48) | `gpt-5.2` | 173 180 | **173 180** ✓ | 374 | **374** ✓ |
| `2bcffe67` (v1.0.48) | `claude-sonnet-4.5` | 27 215 | **27 215** ✓ | 60 | **60** ✓ |

So a shutdown-less `1.0.x` session can still be reconstructed for **output tokens and request
counts per model**. It cannot recover `inputTokens` / `cacheReadTokens` / `cacheWriteTokens` —
no per-turn event carries them. Since input dominates volume by ~100:1, an output-only session
is a severe undercount and must be flagged as partial rather than presented as a total.

---

## 5. Pricing semantics — `inputTokens` is INCLUSIVE of `cacheReadTokens`

This is the highest-risk correctness detail. Copilot normalizes all providers to the
**OpenAI convention** (`prompt_tokens` includes cached tokens) — including for Anthropic models,
whose native API uses the opposite convention.

Evidence — a 2-request session, `52d0033c` (v1.0.17):

```
inputTokens: 34257,  cacheReadTokens: 16896,  requests: 2
```

Request 1 is a cold start (no cache). A cold Copilot prompt measures ~20.5 k
(session `7c01d5f5`: 1 request, `inputTokens` 20 505, `cacheReadTokens` 0 — corroborated by
`systemTokens` 14 208 + `toolDefinitionsTokens` 9 785 ≈ 24 k).

- **Inclusive reading:** prompt₁ ≈ 17.4 k + prompt₂ ≈ 17.4 k (of which 16 896 cached, ~0.4 k
  fresh) = 34 257 total. Self-consistent, and request 2's fresh delta (~400 tokens) matches one
  user turn plus a 404-token reply.
- **Exclusive reading:** would require request 2 to contribute 17 k of *fresh* input on a turn
  that produced 404 output tokens. Implausible.

Scale of the error if implemented wrong, session `2bcffe67` / `gpt-5.2`:

| | Billed as fresh input | Billed as cache read |
|---|---|---|
| Correct (inclusive) | 381 719 | 13 694 976 |
| Naive (exclusive) | 14 076 695 | 13 694 976 |

**≈36× over-count on the input component.** The derived rule:

```
freshInput   = inputTokens − cacheReadTokens          (never let this go negative)
cacheRead    = cacheReadTokens
cacheWrite   = cacheWriteTokens                        (Anthropic models only; 0 for GPT)
output       = outputTokens                            (already includes reasoningTokens)
reasoning    = reasoningTokens                         (informational — do NOT bill separately)
```

`cacheWriteTokens` is non-zero only for Claude models (`claude-sonnet-4.5`: 125 660; every GPT
model: 0), consistent with Anthropic being the only provider that bills cache writes. Whether
`cacheWriteTokens` is itself a subset of `freshInput` is **not resolvable from this data** and
needs an explicit documented assumption.

Likewise `reasoningTokens` ⊂ `outputTokens` follows the OpenAI convention
(`completion_tokens_details.reasoning_tokens`) and is consistent with the per-turn sum matching
`outputTokens` exactly, but is an assumption rather than a measurement.

---

## 6. Copilot's real billing unit is premium requests, not tokens

`session.shutdown` reports both `totalPremiumRequests` and per-model `requests.cost`:

| Session | Model | API requests | Premium requests |
|---|---|---|---|
| `7c01d5f5` | `gpt-5.2` | 1 | 1 |
| `eda71108` | `gpt-5.2` | 8 | 1 |
| `c6ed2c6e` | `gpt-5.2` | 18 | 1 |
| `2bcffe67` | `gpt-5.2` | 374 | 3 |
| `2bcffe67` | `claude-sonnet-4.5` | 60 | **0** |

Premium requests are what GitHub actually bills, and they do not track token volume — 374 API
requests cost 3 premium requests, while 60 Claude requests cost 0 (an included model on this
plan). A token-derived USD figure is therefore an **estimate for cross-agent comparison**, not
Copilot's bill. `totalPremiumRequests` is available for free and is the only number that maps to
real Copilot billing.

---

## 7. Model strings

Observed in `modelMetrics` keys, `assistant.message.model`, and `session.model_change`:

```
gpt-5.2   gpt-5.4   gpt-5-mini   claude-sonnet-4.5   claude-sonnet-4.6
```

Dot-form, **no vendor prefix** (no `copilot/`, no `anthropic/`). The existing normalizer's
lowercase + dot→dash fold should map these onto existing `pricing.json` keys; `claude-sonnet-4.6`
and `gpt-5.4` need a coverage check against the current pricing table.

---

## 8. Rejected / unavailable sources

- **OTel** (`~/.copilot/otel/*.jsonl`) — directory absent; requires `COPILOT_OTEL_ENABLED=true`
  set *before* the session. Not viable as a default path.
- **`session-store.db`** — 8 rows for 78 sessions, no token columns. A search index, not usage.
- **`session.db`** (per-session) — tables are `todos`, `todo_deps`, `inbox_entries`. No usage.
- **`~/.copilot/logs/*.log`** — unstructured process logs.
- **`gh copilot`** extension — no session state at all; explicitly not this integration.
