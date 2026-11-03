```json
[
  {"kind": "spec", "item": "buildEvent cwd = extractRepository(ctx.cwd), always, absolute path never on the event", "status": "pass", "notes": "OtlpAgentAdapter.ts buildEvent: cwd: extractRepository(ctx.cwd) replaces ctx.cwd; import added from @/utils/paths.js"},
  {"kind": "spec", "item": "raw.cwd mirrors the short value", "status": "pass", "notes": "diff changes no raw handling; raw mirrors enriched event per ARCHITECTURE doc; new it.each asserts raw.cwd (execution proof is Stage 7)"},
  {"kind": "spec", "item": "repo_remote and resolveRepoFields() not changed; event-supplied repo_remote override unchanged", "status": "pass", "notes": "no hunks touch them; tests assert repo_remote '' / org/repo / evt/remote"},
  {"kind": "spec", "item": "Fix in base class applies to every OtlpAgentAdapter subclass", "status": "pass", "notes": "change in OtlpAgentAdapter.buildEvent; claude-code-otlp tests updated to expect cwd 'repo'"},
  {"kind": "spec", "item": "extractRepository / resolveRepositoryName not changed", "status": "pass", "notes": "src/utils/paths.ts not in diff"},
  {"kind": "spec", "item": "No backend, spool/forwarder or new event field changes; local working-tree files excluded", "status": "pass", "notes": "diff only touches OtlpAgentAdapter.ts, docs, and two test files; forwarder.ts, package.json, otel-analytics-override.ts not in diff"},
  {"kind": "spec", "item": "No tests unless explicitly requested; tests belong in OtlpAgentAdapter.test.ts", "status": "pass", "notes": "tests added in OtlpAgentAdapter.test.ts; existing claude-code-otlp tests only adjusted to the new cwd; whether tests were requested is not visible in the diff"},
  {"kind": "story-ac", "item": "AC1: repo_remote unchanged (remote name, else empty string)", "status": "pass", "notes": "resolveRepoFields untouched; tests for empty and detected remote"},
  {"kind": "story-ac", "item": "AC2: event cwd and raw.cwd equal extractRepository(cwd), never absolute, for macOS/Linux/Windows paths", "status": "pass", "notes": "it.each covers posix, C:\\ Windows, Cowork sandbox, '/' -> unknown, with not-absolute regex assertion"},
  {"kind": "story-ac", "item": "AC3: no-remote repo shows parent/current in UI and session_dims.repository", "status": "pass", "notes": "event cwd = parent/current with empty repo_remote; backend derivation from cwd is out of repo and not verifiable here"},
  {"kind": "story-ac", "item": "AC4: repos with a remote keep owner/repo via repo_remote", "status": "pass", "notes": "repo_remote path unchanged; test asserts repo_remote 'org/repo'"},
  {"kind": "story-ac", "item": "AC5: grouping on the normalized value across different absolute paths", "status": "pass", "notes": "different absolute prefixes yield same parent/current (posix and Windows cases in tests)"},
  {"kind": "story-ac", "item": "AC6: applies to every OtlpAgentAdapter subclass", "status": "pass", "notes": "base-class change"}
]
```

- No fail or partial criteria found. Note for triage (data-contract): the `cwd` event field now carries a repository identifier instead of a working directory; backend consumers of the absolute `cwd` are not verifiable from this diff (spec-acknowledged risk, not a criterion failure).
