BLOCKED (code done and verified, uncommitted: a PreToolUse hook rejected `git add`/`git commit` with "git mutations are the orchestrator's prerogative")

Commit sha: none. Orchestrator should commit exactly these paths (do not stage .codemie/codemie-cli.config.json):
- src/providers/plugins/sso/proxy/plugins/otlp-spool/session-project.ts
- src/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.ts
- docs/ARCHITECTURE-OTLP-PLUGIN.md
Suggested message: fix(analytics): EPMCDME-16441 pin first-seen project for multi-project sessions (+ Generated with AI / Co-Authored-By trailer).

Verification: `npm run typecheck` EXIT=0; `npx eslint forwarder.ts session-project.ts` EXIT=0.

Findings: identity-fields.ts resolveProjectName already reads/writes the pin (CODEMIE_PROJECT env wins), so hook events carry one project per session; OTEL records carry no project. No bypass path rerouted. identity-fields.ts and session-project-pin.ts unchanged. No doctor check reads spool/session status, so no doctor line added.

Changes: decideProject now binds/noops on first-bound project (status.project, else first candidate) when several distinct sendable names; conflict kept only when any candidate is unsendable (non-ASCII/whitespace; blank is ignored as before). applyProjectDecision logs logger.warn with sanitizeLogArgs on conflict. unwrapHookRecords(records, project?) gained an optional project and rewrites differing codemie_project_name (top level and raw) via new private pinEventProject; forwardHooks passes batch.project (same value as the X-CodeMie-Project header). Seal logic kept: still reachable (bound session then an unsendable name). No symbols removed/renamed; reused logger, sanitizeLogArgs. Docs: replaced conflict/discard/accepted-limitation text with pin-first-seen behavior.

Stale existing tests (not edited): otlp-spool/__tests__/session-project.test.ts (multi-name -> conflict expectations), project-interleave.test.ts, tick-processor.test.ts, spool-io.test.ts, forwarder.test.ts (any case expecting two distinct sendable projects to conflict/seal).
