DONE
Edited C:/Users/Yauheni_Hil/repro-17068.mjs (node --check passes; not run, no git).
- 503 mode no longer sets CODEMIE_EVIDENCE_RECORD_IDLE_DAYS.
- New --window-ms <n> sets CODEMIE_DELIVERY_RETRY_WINDOW_MS for spawned runs.
- Verdict now read from "[exit]" lines in CODEMIE_HOME/logs (per-launch new lines), not the process output; pending/queued/dropped detected from the new notice texts (dropped count = "(started" entries).
- New hang mode: server never answers; FAIL if any session reported dropped.
- Any log line containing "Nothing is lost" -> FAIL message and exit code 1 (process.exitCode).
- Usage header prints PowerShell commands (node $HOME\repro-17068.mjs --mode 503); log hint uses Select-String.
- Note: the home copy lacks the scratchpad copy's paste-junk arg cleaning and --launches validation; left as-is per "edit the home one".
