---
schema: sdlc-factory/code-review@1
decision: request-changes
reviewed_head: 5b686dbfc2cabfd7db4106ed5eff0fbc80893546
---

# Code review — 2026-10-21-omp-review-followups

**Decision:** request-changes (final round, confidence low)  
**Reviewed head:** `5b686db` · **Rounds:** final

Six blocking findings: an attribution-derivation change that needs a security-review sign-off, a provider endpoint snapshotted at load while the catalog re-reads it, an embedding filter that ignores base_name, two test gaps the user asked to close, and a missing JSDoc required by the code-quality standard. The acceptance lens was n/a because sdlc-light writes no spec, so confidence is low; CR-003 and CR-005 have unconfirmed reachability because the catalog contents and daemon port-change frequency are unverified. 0 deferred; 1 dismissed (the invalid-URL error message, which is below the floor because the daemon writes the state file).

## Open — 6

### CR-001 · evidence · major — Attribution derivation change lacks security sign-off

`src/cli/commands/proxy/connect-orchestrator.ts:128` · not re-checked

**Problem:** deriveDaemonIdentity adds a branch that maps the new --omp target to the codemie-daemon client type, and that client type feeds the X-CodeMie-Client attribution header. security-practices.md and git-workflow.md require any change to an attribution derivation source to be called out as CRITICAL and signed off by security review before merge. No sign-off is recorded.

**Impact:** Merging without the review breaks the repository's documented gate for attribution changes. The value itself is not new (proxy start already uses codemie-daemon), but the derivation path is.

**Recommendation:** Call the change out as CRITICAL in the PR #649 description and record a security-review sign-off for the new omp → codemie-daemon client-type derivation, following the reviewer checklist in .ai-run/guides/security/security-practices.md. No source edit is required.

### CR-002 · code · major — Malformed daemon state fallback is untested

`src/cli/commands/proxy/connectors/omp/codemie-models.extension.ts:50` · not re-checked

**Problem:** Regression gap: readDaemonConnection() catches read and JSON-parse errors and falls back to http://127.0.0.1:4001 and the codemie-proxy key, but codemie-models.extension.test.ts covers only a missing proxy-daemon.json. An implementation that falls back only on ENOENT would still pass.

**Impact:** Consumer: fetchRoster() and provider registration in the installed omp extension. If the fallback regressed, a present but corrupt state file would make omp models refresh fail instead of using the documented defaults. The user explicitly asked for tests of the relevant parts.

**Recommendation:** Add a case to codemie-models.extension.test.ts that writes a present but malformed proxy-daemon.json (for example `{not json`), registers the providers, fetches the catalog, and asserts the request goes to `http://127.0.0.1:4001/v1/llm_models?include_all=true` with `Authorization: Bearer codemie-proxy`.

### CR-003 · code · major — Inference endpoint snapshotted while catalog re-reads

`src/cli/commands/proxy/connectors/omp/codemie-models.extension.ts:98` · not re-checked

**Problem:** codemieModels() reads the daemon URL and gateway key once at load and binds them into both registerProvider baseUrl/apiKey values. fetchRoster() re-reads proxy-daemon.json on every refresh, and its comment says this is because the daemon may have restarted on another port. If the daemon moves (for example from `proxy start --port N` to `proxy connect --omp` on 4001), the catalog refresh reaches the new daemon while inference still targets the old URL and key.

**Impact:** omp lists models successfully but every inference request fails against a dead endpoint until omp is restarted, and the extension's error guidance says nothing about this. Reachability is unconfirmed: the code path exists, but it depends on the daemon changing port or key during an omp session.

**Recommendation:** Keep discovery and inference on the same connection. Either derive the provider baseUrl and apiKey from the same per-refresh read, if omp's registerProvider supports re-registration, or drop the "daemon may have restarted on another port" premise and document in docs/COMMANDS.md that omp must be restarted after the daemon's port or key changes.

### CR-004 · code · major — Exported buildOmpModelRoster lacks JSDoc

`src/cli/commands/proxy/connectors/omp/omp-models.ts:75` · not re-checked

**Problem:** code-quality.md requires JSDoc on all public APIs. The new exported buildOmpModelRoster has none; only the private helpers and the types are documented.

**Impact:** The documented code-quality requirement is only partly met, and no lint gate enforces it. The function's filtering and cap-resolution rules are visible only by reading its body.

**Recommendation:** Add a concise JSDoc comment above buildOmpModelRoster that describes how it splits the catalog into OpenAI-wire and Anthropic-wire rosters, which rows it filters out, and how it resolves the router output cap and the defaults.

### CR-005 · code · major — Embedding filter ignores base_name

`src/cli/commands/proxy/connectors/omp/omp-models.ts:88` · not re-checked

**Problem:** The non-chat exclusion tests NON_CHAT only against id = deployment_name || base_name. A deployment with a custom deployment_name and an embedding base_name (for example deployment_name 'team-embed', base_name 'text-embedding-3-large') passes the filter and enters the chat roster. This partly undoes the follow-up meant to keep embedding deployments out of the chat rosters.

**Impact:** An embedding deployment would appear as a selectable omp chat model and fail on first use. Reachability is unconfirmed: it depends on whether the CodeMie catalog contains custom-named embedding deployments, which was not verified.

**Recommendation:** Apply NON_CHAT to both deployment_name and base_name (for example `[model.deployment_name, model.base_name].some(name => name && NON_CHAT.test(name))`), and add an omp-models.test.ts case with a custom deployment_name over an embedding base_name.

### CR-006 · code · major — No CLI wiring test for --omp flags

`src/cli/commands/proxy/index.ts:310` · not re-checked

**Problem:** Broken verification gap: connect-wiring.test.ts asserts only `omp: false` for the other connect flags, and its disconnect case parses only --codex-desktop. No test parses `connect --omp` or `disconnect --omp`, and disconnect-orchestrator.test.ts has no omp case. The wiring in index.ts (lines 310, 332, 347, 362) is correct today but unpinned.

**Impact:** Consumer: the `codemie proxy connect --omp` and `codemie proxy disconnect --omp` commands. A regression that drops either option would leave the extension uninstalled or not removed while every current test still passes. The user explicitly asked for tests of the relevant parts.

**Recommendation:** In connect-wiring.test.ts, assert that `parseAsync(['connect','--omp'])` calls connectTargets with `targets.omp === true`, and that `parseAsync(['disconnect','--omp'])` calls disconnectTargets with `targets: { claudeCodeOtlp: false, codexDesktop: false, omp: true }`.

## Coverage

Standards: commit-format pass · code-quality partial · security na
