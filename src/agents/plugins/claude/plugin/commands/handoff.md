---
description: Save current session state as strict JSON to docs/handoff-context.md for the next session to resume from.
---

# Handoff

Write current session state to `docs/handoff-context.md` as strict JSON. No preamble, no prose, no fences — pure JSON.

## Procedure

1. `docs/` missing? create (`mkdir -p docs` via Bash).
2. Synthesize state from this conversation. Don't re-explore — use context already in memory.
3. Write `docs/handoff-context.md` via Write tool. Must parse as valid JSON.
4. Confirm ONE line: `Handoff saved: docs/handoff-context.md`.

## Schema (strict — follow exactly)

```json
{
  "session_started": "ISO8601 best estimate",
  "task": "one sentence — what the user asked for",
  "completed_tasks": [
    "one line each, concrete things finished this session"
  ],
  "current_state": "where things stand right now — in-flight work, files modified, what works, what's broken",
  "constraints_to_preserve": [
    "Quote verbatim. Cover: ruled-out approaches + why, user rules (don't do X, must do Y), technical constraints discovered"
  ],
  "files_touched": [
    {"path": "absolute path", "status": "created|modified|deleted", "summary": "one line"}
  ],
  "issues_discovered": [
    "bugs, gotchas, surprises found this session — and how we worked around them"
  ],
  "open_questions": [
    "unresolved decisions the user must answer before next step"
  ],
  "next_steps": [
    "ordered, specific. First item = literally first action for the new session"
  ],
  "resume_prompt": "one paragraph the user can paste into a fresh session to resume"
}
```

## Rules

- **Verbatim constraints**: never paraphrase user rules. Copy exact wording.
- **Concrete, not vague**: `"fixed token expiry in auth/middleware.ts:42"` not `"fixed auth bug"`.
- **Ordered `next_steps`**: array order = execution order.
- **No speculation**: unknown → omit. Empty arrays fine.
- **Pure JSON**: file must parse. No headings, no fences, no trailing prose.
- **Overwrite**: always overwrite. One handoff per project.

Verify: `head -3` of the output file shows the `---` frontmatter delimiters and the description line.

Report DONE or BLOCKED.
