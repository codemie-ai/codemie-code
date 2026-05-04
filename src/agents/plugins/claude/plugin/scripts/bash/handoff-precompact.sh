#!/usr/bin/env bash
# PreCompact hook: synthesize handoff JSON before context compaction.
# Requires: jq (silently skips if absent), claude CLI (falls back to raw dump if absent).
# Always exits 0 — never blocks compaction.
command -v jq &>/dev/null || exit 0
set -uo pipefail

INPUT=$(cat)
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // "."' 2>/dev/null)

[[ -z "${TRANSCRIPT:-}" || ! -f "$TRANSCRIPT" ]] && exit 0
[[ -z "${CWD:-}" ]] && CWD="."

mkdir -p "$CWD/docs"
OUT="$CWD/docs/handoff-context.md"

PROMPT='You are generating a session handoff for the NEXT Claude Code session. Read the transcript provided below. Output STRICT JSON ONLY — no preamble, no prose, no markdown fences, no commentary. Schema:

{
  "session_started": "ISO8601 best estimate",
  "task": "one sentence — overall user goal",
  "completed_tasks": ["concrete things finished, one line each"],
  "current_state": "where things stand right now — in-flight work, files modified, what works, what is broken",
  "constraints_to_preserve": ["user rules VERBATIM (dont do X, must do Y)", "ruled-out approaches + why", "tech constraints hit (API limits, edge cases)"],
  "files_touched": [{"path": "absolute path", "status": "created|modified|deleted", "summary": "one line"}],
  "issues_discovered": ["bugs/gotchas + how we worked around them"],
  "open_questions": ["unresolved decisions user must answer"],
  "next_steps": ["ordered, specific. next_steps[0] = literally first action"],
  "resume_prompt": "one paragraph user can paste into a fresh session to resume"
}

Rules: quote user rules verbatim, never paraphrase. Concrete not vague. Array order = execution order. Empty arrays ok. Must parse as valid JSON.'

TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout 60"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout 60"
else TIMEOUT_BIN="perl -e \"alarm 60; exec @ARGV or die\" --"
fi

run_with_claude() {
  command -v claude >/dev/null 2>&1 || return 1
  {
    printf '%s\n\nTRANSCRIPT (JSONL, newest last):\n' "$PROMPT"
    tail -c 200000 "$TRANSCRIPT"
  } | eval "$TIMEOUT_BIN claude -p --bare --model claude-sonnet-4-6 --output-format text" > "$OUT.tmp" 2>/dev/null
  if [[ -s "$OUT.tmp" ]] && jq empty < "$OUT.tmp" >/dev/null 2>&1; then
    mv "$OUT.tmp" "$OUT"
    return 0
  fi
  rm -f "$OUT.tmp"
  return 1
}

fallback_raw_dump() {
  {
    printf '{"status":"HANDOFF_AUTO_PARTIAL","note":"claude -p unavailable or failed; raw transcript tail below. Manual /handoff recommended.","transcript_path":"%s","generated_at":"%s"}\n' \
      "$TRANSCRIPT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '\n---RAW_TRANSCRIPT_TAIL---\n'
    tail -c 50000 "$TRANSCRIPT"
  } > "$OUT"
}

run_with_claude || fallback_raw_dump
exit 0
