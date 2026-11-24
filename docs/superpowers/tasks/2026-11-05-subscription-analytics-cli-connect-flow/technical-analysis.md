# Technical Research (CLI slice: codemie-code)

**Task**: EPMCDME-16849 subscription analytics with private-session isolation; CLI (`codemie-code`) slice only
**Generated**: 2026-11-04 (sliced from parent technical-analysis.md; no new research)
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16849 "[CLI Analytics] Track subscription-funded work in project analytics with private-session isolation". Authoritative story: `C:/codemie-dev/_local/epmcdme-16849/jira.json` (ACs 1-10). Technical notes: `C:/codemie-dev/_local/epmcdme-16440/subscription-analytics-technical.md`.
CLI-relevant requirements: explicit work-folder connection to a CodeMie project enables publishing of work sessions incl. conversation content under project permissions; personal subscription must not force connected work sessions to the personal project; global work profile alone must not authorize publication from unrelated folders; preserve existing collection-disable and folder-exclusion settings, no separate personal toggle, no profile-name policy; expose API-based vs subscription consumption (client signal); /clear, resume, folder change must not disclose personal history or duplicate consumption; suspend publication with actionable notification if safe separation not guaranteed; no automatic profile switch. Out of scope: Control Plane, UI work, ticket attribution, Cost per Point, pet-project detection.

---

## 2. Codebase Findings

### Repository classification
- `codemie-code` (CLI): **affected** (this slice). Collection, folder link/allowlist, evidence classification, session project pin/binding, header injection.
- `codemie` (backend): reference only.
- `codemie-ui`: not_affected.

### Resolved baselines
- CLI `origin/main` = `916710fbeb309fcaf07fb412c2e08b9711eb1755`. Findings read only from this ref (`git show/grep origin/main`). It already contains the 16440 classification/routing work (`src/agents/core/evidence/classify.ts`). Checked-out repo sits on a stale 16025 branch and local `main` is stale; neither is the baseline.
- (Backend baseline for reference: `origin/main` `25a3458506ab12b3c93ce2540d096480cd2fac94`.)

### Existing Implementations

**A. Only explicitly connected folders publish; global profile alone does not**
- Folder allowlist (path-only): `CODEMIE_ANALYTICS_PROJECT_FILTER` in `~/.claude/settings.json` env; `src/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.ts:32` (env name), shared path semantics `src/agents/core/project-allowlist.ts` (`parseAllowlist`), managed by `src/cli/commands/proxy/connectors/claude-code-otlp.ts` (:529-728) and `claude-code-otlp-flow.ts:78`. Untracked folder: hook does nothing; OTel-only data never sent (completeness gate skip). It holds paths only, no project.
- A folder -> project link exists separately: `src/agents/core/evidence/stamp.ts` `hookTimeFields` resolves `project` (`resolveSessionProject(cwd, sessionId)`) and `project_source` (`'linked_folder' | 'profile' | 'none'`, `record-store.ts:30`) from the profile identity's `projectOrigin` (`ConfigLoader.resolveProfileIdentity`); `'none'` when the project came from env/pin and differs from config. Sent as `X-CodeMie-Project` / `-Project-Source` (`otlp-spool/evidence-send.ts:40`). Commits #753/#758 (project parity, per-profile project) are on main (not diffed).

**B. Funding classification (CLI)**
- `evidence/classify.ts` `classify()` -> codemie|corporate|personal|unknown (+status/basis/policy_version); inputs `routed_via_codemie`, `routing_proof`, `organization`; sent as `X-CodeMie-Subscription-Type` plus `-Organization`, `-Policy-Version`, `-Routed-Via-CodeMie` (`header-injection.plugin.ts` `buildAttributionHeaders`). `evidence/routing.ts` `oauthAccountPays()` is the only payer evidence: true when the saved Claude OAuth login pays; `claude-code-otlp.plugin.ts` sends `organization` only then. API-key / apiKeyHelper / cloud / unproven routes give no org -> `unknown`. No sent field says API vs subscription.

**D. Cost (CLI)**
- `cost-enricher.ts`, `otel-pricing.ts`, `utils/pricing.ts`/`pricing.json`/`bedrock-pricing.mjs`; per-model `unpriced`/`estimated`; the report shows `meta.unpricedModels` / `estimatedModels` (`report/client/app.js:815`). Report-time and local only.

**E. /clear, resume, folder change**
- `src/agents/core/session-project-pin.ts` (pin by hashed session_id, 24h TTL, "long enough for a --resume"), `otlp-spool/session-project.ts` + `session-status.ts` (`projectConflict`, `projectSeal`, `noop` once conflicted), `spool-io.ts`, `tick-processor.ts`, `forwarder.ts`. Hook types know `SessionStart.source = startup|resume|clear|compact|fork` (`claude-agent-sdk-hooks.d.ts:531`); no code branching on `clear` found in `claude-code-otlp`. Behaviour across /clear (new session_id?), resume into a personal segment and folder change: unverified, needs a real run.

**Other touched code**: `src/cli/commands/hook.ts`, `otlp.plugin.ts`, `otlp-spool/{classification,verdict-store,policy-cache}.ts`.

### Decisions Already in the Code
- Fail closed: unproven routing never personal (`classify.ts`).
- Data direction: the folder link is stored in profile/workspace config and the path allowlist separately; `project_source` is computed at stamp time and frozen in the evidence record.
- Old clients: absence of every evidence header makes the backend select its legacy gate (backend behaviour, codemie (reference only)).
- CLI retains its spool ~24h when the backend returns a retryable 503.

### Task Statements Checked Against the Code
- "A globally configured work profile alone does not authorize publication from unrelated folders": partly holds: the path allowlist gates hooks; `project_source='profile'` is accepted by the backend as a routable explicit source, so a profile-sourced project reaches routing when the folder is tracked.
- "Reuse existing folder filters": holds for the allowlist (path-only); the folder -> project mapping lives in the profile identity (`linked_folder`), not in the allowlist.
- "Missing prices reported, not free": CLI report has `unpriced`; local only.
- "API vs subscription separately": nothing found in CLI sending it.
- "No separate personal-analytics toggle": no such switch found.

### Consumers of Changed Contracts
- `X-CodeMie-Subscription-Type/-Organization/-Project/-Project-Source/-Repo-Remote/-Policy-Version/-Routed-Via-CodeMie/-Session-Id`: producers `header-injection.plugin.ts`, `evidence-send.ts` (this repo); consumers are backend `cli_analytics_ingest_route.py`, `cli_analytics_project_gate.py`, `postgres/ingestor.py`, `otlp.py`, `session_binding.py`, `ports.py` (codemie (reference only)).
- Backend-consumed contracts (codemie (reference only)): `resolve_destination` currently ignores the header project for a personal-capable user's `personal` session (always the personal project); routes header project only when `project_source` is `linked_folder` or `profile`; first accepted evidence request binds owner + destination for the session (`session_binding`), so a mid-session project change is discarded as `session_project_conflict`; stale `policy_version` yields 409; the backend derives the class itself and the client class is advisory.

### Architecture and Layers Affected
CLI: hook/plugin (`claude-code-otlp`), evidence (classify/routing/record-store), OTLP spool/forwarder/header injection, config/allowlist and connect command, report-time cost.

### Integration Points
- CLI -> backend ingest POST (OTLP and plugin events) with `X-CodeMie-*` headers; backend policy endpoint (organizations, version) cached by CLI (`policy-cache.ts`).

### Patterns and Conventions
- Pure classify function + injected consumer seam; fail closed; sticky verdict store; length-prefixed record keys.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- CLI: `.ai-run/guides/` (project, quality-gates, standards, testing, security), `docs/HOOKS.md`, `docs/ARCHITECTURE-PROXY.md` (§6.14 allowlist), `docs/ARCHITECTURE-OTLP-PLUGIN.md`.
- Prior stories/evidence: `C:/codemie-dev/_local/epmcdme-16440/`.

### Architectural Decisions
Spec numbering (D7, spec 4/5/9) referenced in code comments for 16440; spec text lives in 16440 task folders (not read).

### Derived Conventions
Contract agreed before implementation; backward compatibility via absence of evidence headers.

---

## 4. Testing Landscape

### Existing Coverage
- CLI (vitest; test file names not re-verified on origin/main): `evidence/__tests__/{classify,matrix,routing,routing-contract,record-store,api-identity}.test.ts`; `otlp-spool/__tests__/{session-project,project-interleave,spool-io,forwarder,tick-processor}.test.ts`; `tests/integration/analytics/claude-analytics-disable.test.ts`, `analytics-secret-egress.test.ts`, `hook-stdout.test.ts`; allowlist tests in `claude-code-otlp/__tests__`.

### Testing Framework and Patterns
vitest; isolated CLI home helper `tests/helpers/isolated-cli.ts` (16440).

### Coverage Gaps
Nothing found testing: an explicit folder -> project mapping; /clear and resume across personal/work boundaries; an API vs subscription signal.

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_ANALYTICS_PROJECT_FILTER` (folder allowlist, in Claude settings env); `CODEMIE_PROFILE_CONFIG`, `CODEMIE_SESSION_ID` (managed vs native launch); `CODEMIE_PROJECT_DIR`.

### Configuration Files
CLI pricing `src/utils/pricing.json`; `~/.claude/settings.json`, `.claude.json` (`oauthAccount`).

### Feature Flags and Deployment Concerns
No personal-ingest switch found. Landing order (speculative): backend accepts new fields before the CLI sends them.

---

## 6. Risk Indicators

- Keeps a mechanism in place (backend, codemie (reference only)): personal-paid of a personal-capable user is routed to the personal project with header project ignored; AC1 needs the CLI to supply an explicit linked project the backend honours for regular users.
- Gap: API vs subscription not distinguishable beyond `organization` presence (`oauthAccountPays`); no sent field. Speculative: needs a new CLI field; a client signal is not billing proof.
- Unverified: /clear, resume and folder-change behaviour (no code branches on `clear`; 24h pin and project conflict/seal exist). Needs a real run with real session_id, cwd, project, transcript boundaries.
- `project_source='profile'` counts as an explicit source for backend routing; "global profile alone must not authorize" depends on the hook-side folder allowlist.
- Old-client compatibility: clients sending evidence headers without a new field must not be treated as connected-folder (speculative).
- Any new client-reported funding field has the same trust limit as the class (advisory).
- Suspension with actionable notification when safe separation is not guaranteed has no found implementation (to design).

---

## 7. Summary for Complexity Assessment

CLI slice. Origin/main (`916710fb`) already contains classification, a folder-link source (`project_source`), session project pin/seal and header injection. Remaining CLI change surface: an explicit connect flow tying a work folder to a CodeMie project (separate from the path-only allowlist), a funding-category field (API vs subscription) in evidence/headers, safe handling of /clear, resume and folder change, and suspension with notification when separation is not guaranteed.

Technical novelty is moderate: privacy-critical contract extension with old-client compatibility. Coverage is strong for classification, routing and spool/project binding; nothing found covers the new behaviours.

Key risks: unverified /clear/resume behaviour, additive-only contract, profile-sourced project reaching routing.

---

## 8. External References

- `C:/codemie-dev/_local/epmcdme-16849/jira.json`: ACs 1-10.
- `C:/codemie-dev/_local/epmcdme-16440/subscription-analytics-technical.md`: keep `subscription_type` distinct from API/subscription; use real-route/auth evidence, ambiguous -> unknown; client signals not independent billing confirmation; verify /clear and resume by real session_id, cwd, project, transcript boundaries; suspend until separate launch if separation not guaranteed; order: CLI first, agree rule with Nikita, then repository tasks.
- Root `C:/codemie-dev/AGENTS.md`, CLI AGENTS.md read.
