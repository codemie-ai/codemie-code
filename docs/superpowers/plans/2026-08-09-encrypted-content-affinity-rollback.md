# Retiring the Encrypted Content Sanitizer after `encrypted_content_affinity` lands

**Status:** DONE (2026-08-10) — affinity verified live on `preview`; proxy switched to pass-through
with a self-healing fallback. Remaining: update the two test files listed in §5.
**Owner:** codemie-code proxy
**Trigger:** CodeMie LiteLLM enables `encrypted_content_affinity` on the Responses-API model groups

> **Implementation note.** §4 proposed a transparent retry. Inspecting the interceptor contract
> showed no retry primitive exists — `streamResponse` pipes the upstream response straight through,
> so retrying would mean buffering every 400 body in `sso.proxy.ts`, the shared path for all
> clients. Because interceptors are constructed once per proxy (`sso.proxy.ts:123`) they can hold
> state, so the shipped design latches a flag on first rejection instead: pass-through by default,
> strip for the rest of the proxy's life once upstream rejects a replay. Same self-healing outcome,
> zero changes to the proxy core, at the cost of one visible error per occurrence.
>
> **Verified on preview (2026-08-10):** reasoning item ids now arrive as
> `encitem_<base64>` decoding to
> `litellm:model_id:gpt-5-6-terra-2026-07-09-swedencentral-1;item_id:rs_...`, a two-turn encrypted
> replay returns HTTP 200 with context carried, and a multi-turn `codemie-pi` tool-calling session
> completed with the interceptor active and never triggering a strip.

---

## 1. Why this document exists

The local CodeMie proxy currently deletes reasoning state from every Responses-API request
before forwarding it to the CodeMie gateway. This is a deliberate workaround for a LiteLLM
routing gap, and it costs real answer quality. Once DevOps enables server-side
`encrypted_content_affinity`, the workaround becomes both unnecessary and actively harmful —
it prevents the affinity check from ever engaging.

This document records exactly what is being stripped today, what to change once the server
config is live, and how to verify the change.

---

## 2. What the sanitizer removes today — and what it costs

`src/providers/plugins/sso/proxy/plugins/codex-encrypted-content-sanitizer.plugin.ts`
runs at priority 16 on outbound requests for `codemie-codex`, `codemie-code`,
`codemie-opencode`, `codemie-pi`, and `vscode-byok`. It rewrites the JSON body and performs
three deletions:

| # | What is deleted | Where |
|---|---|---|
| 1 | Every array element whose `type` is `"reasoning"` — the whole item, including its `summary` and `content` | `input[]` |
| 2 | Every object key named `encrypted_content`, at any nesting depth | anywhere in the body |
| 3 | The string `"reasoning.encrypted_content"` | `include[]` |

### What this means for the model

Yes — data is being removed from the agent↔LLM interaction, and it is not a trivial slice.

A reasoning item is the container for the model's own prior thinking. Deleting the item
removes **both** the encrypted chain-of-thought blob and the human-readable `summary` that
travels inside it. Deletion #3 goes further and stops the gateway from producing encrypted
reasoning at all, so there is nothing to carry forward even in principle.

Net effect on every turn after the first:

| Preserved | Discarded |
|---|---|
| `reasoning: { effort, summary }` request parameter — the model still thinks at the selected effort | All reasoning the model produced on previous turns |
| Visible assistant messages | Encrypted chain-of-thought (`encrypted_content`) |
| Tool calls, call IDs, tool outputs | Reasoning summaries attached to prior turns |
| User messages, instructions, tools | — |

The model re-derives its reasoning from visible history on each turn instead of resuming it.
For single-shot questions this is close to invisible. For long multi-step agent loops —
extended debugging, refactors spanning many tool calls — it degrades continuity and burns
extra reasoning tokens re-establishing context the model had already worked out.

This is a fidelity-for-availability trade. Without it, sessions fail hard.

### Why it is currently unavoidable

Two distinct upstream failures, both observed on `gpt-5.6-terra-2026-07-09`:

1. **`invalid_encrypted_content`** — the client replays an encrypted reasoning item; LiteLLM
   load-balances the follow-up to a deployment with a different API key, which cannot decrypt
   it. This is what `encrypted_content_affinity` fixes.
2. **`Item with id 'rs_...' not found`** — with deletion #3 in place the upstream returns
   reasoning items with no `encrypted_content`; pi persists and replays the bare `rs_...` id,
   and a `store: false` request cannot resolve an id the server never persisted. This is a
   direct consequence of deletion #3 and disappears with it.

Failure 2 is self-inflicted by the workaround. Failure 1 is the actual upstream gap.

---

## 3. Precondition — do not start until this is confirmed

The LiteLLM proxy config must contain:

```yaml
router_settings:
  enable_pre_call_checks: true
  optional_pre_call_checks:
    - encrypted_content_affinity
  deployment_affinity_ttl_seconds: 86400
```

and every deployment in each affected model group must carry a unique, stable
`model_info.id`. Affinity is tracked per deployment id; without stable ids the check cannot
pin anything.

**Verify against the live gateway before touching this repository.** Run the two-turn probe
in §6 with the sanitizer bypassed (a local build with the plugin unregistered is enough). If
turn 2 returns 200, the server side is ready. If it returns `invalid_encrypted_content`, it is
not — stop and go back to DevOps.

---

## 4. Recommended design: fallback, not deletion

Do **not** simply delete the plugin.

`deployment_affinity_ttl_seconds` means the affinity pin expires. A pi or codex session
resumed after the TTL window replays encrypted content whose pin is gone, and
`invalid_encrypted_content` returns. Deleting the sanitizer outright trades a permanent
degradation for an intermittent hard failure, which is worse for users because it is
unpredictable.

Target behavior:

1. **Default path** — forward reasoning state untouched. Affinity routes the follow-up to the
   originating deployment. Full reasoning continuity, which is the entire point of the DevOps
   change.
2. **Fallback path** — on an upstream `400` whose body matches `invalid_encrypted_content`,
   strip reasoning state from that request and replay it once. The turn succeeds with degraded
   continuity instead of surfacing an error to the user.
3. **Observability** — `logger.warn` on every fallback trigger. A rising rate means the TTL is
   too short for real session lengths, or affinity has regressed.

The existing `sanitizeValue()` function is reusable as-is for the fallback path; only the
trigger changes from unconditional to error-driven.

If the fallback proves more complexity than it is worth, the acceptable simpler option is a
config flag defaulting to *off*, so the strip can be re-enabled without a release. A plain
deletion is the option to avoid.

---

## 5. Change inventory

| File | Change |
|---|---|
| `src/providers/plugins/sso/proxy/plugins/codex-encrypted-content-sanitizer.plugin.ts` | Convert `onRequest` unconditional strip into the error-triggered fallback of §4. Keep `sanitizeValue()`, `isReasoningInputItem()`, `isPlainObject()` unchanged. Rewrite the file docstring — it currently states the strip is unconditional. |
| `src/providers/plugins/sso/proxy/plugins/index.ts` | Update the priority-16 registration comment (line ~39). Registration itself stays if the fallback is retained. |
| `src/providers/plugins/sso/proxy/plugins/__tests__/codex-encrypted-content-sanitizer.plugin.test.ts` | Existing cases assert unconditional stripping and must be re-scoped to the fallback path. Add: reasoning state passes through untouched on the happy path. |
| `tests/integration/vscode-byok.test.ts` (~lines 27, 280-327) | `strips encrypted Responses state while preserving stateless reasoning and tool history` asserts the old behavior. Update to expect pass-through, and add a fallback-path case. |
| `docs/COMMANDS.md` (lines ~153-159, ~178) | Prose claims the proxy "removes deployment-bound encrypted reasoning content for `vscode-byok`". Replace with the fallback description. Rewrite the `invalid_encrypted_content` troubleshooting row — the remedy becomes "verify affinity is configured and the session is within the TTL". |
| `docs/ARCHITECTURE-PROXY.md` (lines ~726-731, ~744) | Same claim in prose plus the `PX->>PX: Normalize user and strip encrypted reasoning state` step in the Mermaid sequence diagram. |
| `src/cli/commands/proxy/connectors/vscode-models.ts` (line ~121) | Comment only. |

### Explicitly out of scope

- `src/agents/plugins/pi/pi.models.ts` — the `openai-responses` classification for
  `gpt-5.6-*` is correct and stays.
- All agent plugins — pi, codex, and opencode already replay reasoning items correctly. That
  replay is precisely what starts working. No client change is required.
- `request-sanitizer.plugin.ts` — unrelated concern (reasoning parameter shape), leave alone.

---

## 6. Verification

### 6.1 Gateway probe — before and after

```bash
# Turn 1 — capture a response carrying encrypted reasoning
curl -s "$LITELLM_URL/v1/responses" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.6-terra-2026-07-09","store":false,
       "reasoning":{"effort":"medium","summary":"auto"},
       "include":["reasoning.encrypted_content"],
       "input":[{"role":"user","content":[{"type":"input_text","text":"What is 17*23?"}]}]}' \
  | tee turn1.json

# Confirm encrypted content is actually present — if absent, affinity has nothing to key on
jq '[.output[] | select(.type=="reasoning") | .encrypted_content] | length' turn1.json

# Turn 2 — replay turn 1's output verbatim. Must return 200.
jq '{model:"gpt-5.6-terra-2026-07-09",store:false,
     reasoning:{effort:"medium",summary:"auto"},
     include:["reasoning.encrypted_content"],
     input:(.output + [{role:"user",content:[{type:"input_text",text:"And times 2?"}]}])}' turn1.json \
  | curl -s "$LITELLM_URL/v1/responses" -H "Authorization: Bearer $KEY" \
      -H 'Content-Type: application/json' -d @-
```

### 6.2 End-to-end through the agents

```bash
node ./bin/codemie-pi.js --model "gpt-5.6-terra-2026-07-09"
```

Run a conversation of at least four turns including tool calls. Success criteria:

- No `invalid_encrypted_content` and no `Item with id 'rs_...' not found`.
- With `CODEMIE_DEBUG=true`, the proxy logs show reasoning items **present** in forwarded
  request bodies — that is the observable difference from today.
- No fallback warnings during a normal session.

Repeat for `codemie-codex`, `codemie-opencode`, and VS Code BYOK. All four share this plugin,
so all four change behavior together.

### 6.3 TTL behavior

Start a session, leave it idle past `deployment_affinity_ttl_seconds`, then continue it. The
expected outcome is a single fallback warning and a successful turn — not a user-visible
error. This is the case that justifies keeping the fallback.

---

## 7. Rollback

Re-enable the unconditional strip (revert the plugin to its current `onRequest`) and rebuild.
No data migration, no coordination with the gateway. Sessions in flight recover on their next
turn.

---

## 8. Reference

- LiteLLM encrypted content affinity: https://docs.litellm.ai/docs/response_api#encrypted-content-affinity-multi-region-load-balancing
- LiteLLM load balancing config: https://docs.litellm.ai/docs/proxy/load_balancing
- LiteLLM incident write-up: https://docs.litellm.ai/blog/responses-api-encrypted-content-incident
- pi reasoning replay: `packages/ai/src/api/openai-responses-shared.ts:221-224` (replay),
  `packages/ai/src/api/openai-responses.ts:293,328` (`store: false`, `include`)
