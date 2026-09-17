# End-to-End Verification — EPMCDME-12920

## Setup

- Branch: `EPMCDME-12920_assistant-skill-generators-conversation-id`
- Build: `npm run build` after all 6 fix commits (4 generators + 1 persister module + 1 chat wiring).
- CLI invoked via local dev build: `node bin/codemie.js …` (resolves to `dist/`).

## Workflow id used

`brianna-verify-v2-20260618-125718`

## Calls

### Call 1 — initial draft

Input: "Draft a Jira Task description for a hypothetical EPMCDME ticket titled 'Audit npm scripts for kebab-case naming consistency'. Do NOT create the ticket. Just produce the description text in Jira wiki markup with sections: h3. General purpose, h3. Scope, h3. Acceptance criteria. Keep it under 15 lines total."

Output: clean three-section draft, as requested.

Persistence check:
```
ls -la ~/.codemie/sessions/brianna-verify-v2-20260618-125718_conversation.jsonl
→ 2712 bytes written
```

Verbose log (chat):
```
[DEBUG] [jsonl-writer] Atomically wrote 2 records to .../brianna-verify-v2-…_conversation.jsonl
[DEBUG] Persisted conversation turn
```

### Call 2 — refine (memory test)

Input: "Now ALSO add a 'h3. Out of scope' section to that draft listing 'External CI workflows' and 'Dependencies in node_modules'. Return the COMPLETE updated description with all sections."

Verbose log (chat):
```
[DEBUG] Loaded conversation history for single message {
  conversationId: 'brianna-verify-v2-20260618-125718',
  historyLength: 2,
  ...
}
```

Output: returned the FULL original draft (General purpose / Scope / Acceptance criteria from call 1) **plus** the new "Out of scope" section appended. The assistant saw the prior draft.

## Result

| Aspect | Before fix | After fix |
|---|---|---|
| Multi-turn memory with arbitrary `--conversation-id` | broken — `historyLength: 0` every call | works — `historyLength: 2` after first turn |
| JSONL file backing arbitrary id | never written by CLI | written by `historyPersister.ts` after each call |
| Apply-confirmation corruption | reproducible (saw `Please provide the updated Description…` overwrite) | not reproduced with this fix because (a) the multi-turn now works, (b) the new template documents the single-shot rule as the preferred path for writes |
| Cross-topic context bleed via shared `CODEMIE_SESSION_ID` | reproducible | not eliminated by this fix in isolation, but no longer the only option — callers can opt into an isolated workflow id |

## Negative control

Verified earlier in the session: without `--conversation-id`, the CLI uses the env-var fallback to `CODEMIE_SESSION_ID` and either pulls unrelated topics into the assistant's context (cross-topic bleed) or returns "I don't have the previous draft" when no JSONL backing exists. The new persister only fires when `--conversation-id` is passed explicitly, so existing agent-session callers are unaffected.

## Conclusion

End-to-end verification passes. The 4 generator templates emit instructions that match the actually-working CLI behaviour:

- Generators teach the calling LLM to mint a workflow id and pass `--conversation-id` on every call.
- CLI now writes `~/.codemie/sessions/<id>_conversation.jsonl` on each turn when `--conversation-id` is explicit.
- HistoryLoader reads the same path on subsequent calls.
- Multi-turn workflows now have isolated, persistent context, decoupled from the calling agent's `CODEMIE_SESSION_ID`.

Ready for PR.
