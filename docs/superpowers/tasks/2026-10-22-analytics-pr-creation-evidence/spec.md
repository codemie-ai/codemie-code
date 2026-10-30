# Confirmed PR/MR creation evidence in analytics reports

Date: 2026-10-22. Status: proposed for user review.

## Intent and approach

Enable downstream analytics to link an AI session to a GitHub PR or GitLab MR it created, using observed native tool execution evidence. A PR link or branch mention alone is insufficient. The enclosing report session supplies the session identity; this change supplies a narrowly verified creation event. It does not establish that all work on the PR happened in that session.

Reuse native parsing → enrichment → shared report projection and Claude ownership/replay handling, independently of token pricing. Paired local execution evidence avoids the false positives of substring matching and requires no network lookups.

## Additive report contract

Add optional `changeRequestCreation` to each `ReportSessionRecord`, in JSON, HTML and per-session reports. Existing costs/fields remain unchanged; omission in older reports means unknown coverage.

```json
{
  "changeRequestCreation": {
    "status": "available",
    "events": [{
      "type": "pr_created",
      "provider": "github",
      "host": "github.com",
      "repository": "owner/repository",
      "number": 36,
      "url": "https://github.com/owner/repository/pull/36",
      "timestamp": "2026-10-22T10:00:00.000Z",
      "source": "gh_cli",
      "toolUseId": "toolu_example",
      "owner": "root"
    }]
  }
}
```

`provider` is `github` or `gitlab`; `type` is respectively `pr_created` or `mr_created`. `host` is the canonical URL authority (including a nondefault port); `repository` is the full target project path, including GitLab subgroups. `number` is GitHub PR number or GitLab project-local **iid**, never its global MR `id`. `source` is `gh_cli`, `glab_cli`, `github_mcp` or `gitlab_mcp`; `owner` is `root` or `subagent`, with `ownerId` required for a subagent. Timestamp is the observed result time. Enclosing `sessionId` owns the event; tool/owner IDs retain provenance.

`status` is `available` (supported native log inspected), `partial` (known unresolved, rejected or truncated candidate evidence, or extraction failure), `unavailable` (required native log unavailable), or `unsupported` (non-Claude/OTEL-only source). Empty events mean no supported creation observed, not no creation. Partial retains verified events. Unknown integrations are outside coverage.

Bound output to 100 events per session; an overflow marks partial. Identity strings are validated and at most 256 characters; invalid identities are omitted, never truncated into a different identity. Export only the allowlisted fields above. Canonical HTTPS URLs use provider-specific paths: GitHub `/<owner>/<repo>/pull/<number>` or GitLab `/<group>/<subgroup...>/<project>/-/merge_requests/<iid>`. Support GitHub.com and GitLab.com/self-managed GitLab DNS hosts with optional ports; never infer provider solely from a URL. Discard query/fragment and reject credentials, encoded path separators, dot segments, issues/preview URLs and ambiguous identities. Numbers must be positive safe integers. Hosts and project identities must agree across the recognized call and its response wherever supplied; no remote validation occurs.

## Recognition and ownership

Require recognized invocation plus uniquely paired successful result. Errors/nonzero exit, contradictory identities, missing result/time or ambiguous ownership suppress the candidate and mark partial. Lack of error alone is insufficient.

For Bash, support a single direct `gh pr create` or `glab mr create` command with ordinary literal arguments, including quoted title/body values. Require an unambiguous standalone provider-specific URL in the successful result. glab's non-TTY output is the MR URL; TTY output adds a summary followed by a URL line. No command substitution, pipes, control operators, wrappers, redirects or multiline scripts. Operators inside literal quotes are harmless. Match executable tokens, not examples/comments/echo. Explicit target repository and host selectors must match the result; `--head` denotes the source fork, not the target. Omit unsupported numeric CLI project selectors. Existing-request responses, help/browser-preview modes and failed post-creation actions do not qualify. A known glab creation call plus its unique validated MR result is the evidence for self-managed hosting, not a generic URL pattern.

For MCP, support only these explicit, fixture-backed contracts (native structured content or text-wrapped JSON):

- `mcp__github__create_pull_request`: successful create response with consistent PR URL/number and matching owner/repository arguments when present.
- `mcp__gitlab__create_merge_request`: the archived reference GitLab server contract: `project_id` request, result object with `web_url`, `iid` and numeric `project_id`. A path/URL-encoded project request must match the canonical URL path; a numeric request must match response `project_id`. The result `iid` must match the URL; do not use global `id`. Derive host/project path from this operation's result and reject any conflicting supplied host/path.

The GitLab contract is evidenced by the reference server, not a claim of universal support for current GitLab MCP deployments. Other aliases, official tools with different schemas, action-dispatching tools, reads/searches and arbitrary returned links are unsupported. Recognized operations with conflicting/malformed envelopes produce partial coverage.
Reuse root/subagent ownership and session bounds; never attach replay/shared-file events to unrelated sessions. Deduplicate by owned invocation and provider/host/project/number, preserving distinct creations. Isolate extraction failures per session; no new discovery/network access.

## Acceptance criteria

- AC1: Successful gh and glab creation yields one canonical event; include GitLab subgroups/self-managed host, result timestamp, session ownership and literal quoted arguments.
- AC2: Both explicitly recognized MCP contracts yield equivalent evidence, including subagents, numeric/path GitLab project matching and iid/global-id distinction.
- AC3: Failed, incomplete, already-existing, conflicting and unsupported compound executions yield no false creation; examples, ordinary links, issue URLs, read operations and host/project mismatches yield none.
- AC4: Replayed messages, shared native files, duplicate tool IDs and ambiguous ownership cannot duplicate or misattribute creation evidence; identical numbers on distinct hosts/projects remain distinct.
- AC5: Missing logs, unsupported providers, malformed candidates and event limits produce the documented coverage statuses without aborting other sessions.
- AC6: Shared JSON/HTML/per-session payloads expose only bounded allowlisted metadata; secrets, command bodies, tool arguments and raw responses never appear in the new field.
- AC7: Creation evidence remains available when native logs exist but no priced usage exists; existing costs, dispatch events and report fields retain their semantics.
- AC8: Add and run focused synthetic-fixture tests covering AC1–AC7, plus relevant existing enrichment/export regressions and repository typecheck/lint/build checks. Test authorization was explicitly granted by the user on 2026-10-22.
- AC9: Analytics documentation describes the schema, supported command/tool forms, limitations and distinction between observed creation and comprehensive work/cost attribution.

## Non-goals

- Collector, Control Plane, Jira linkage, monetary allocation or story-point calculations.
- Hosting-service API calls, credentials, webhooks, new dependencies or runtime configuration.
- GitHub Enterprise, HTTP-only hosting, arbitrary shell parsing or additional MCP aliases.
- Exporting transcripts, PR/MR bodies, branch names, raw commands or raw tool results.
- Capturing PR/MR updates/reads, attributing every historical development session, changing external-session inclusion or adding report UI.

## Remaining risks

Host identity and creation are locally observed, not independently authenticated. Unsupported formats and truncated history miss real events. Empty events must not mean zero AI use or automatic spend allocation.


## GitLab contract evidence

Checked 2026-10-22: [glab command](https://docs.gitlab.com/cli/mr/create/), [creation flow](https://gitlab.com/gitlab-org/cli/-/blob/main/internal/commands/mr/create/mr_create.go), [DisplayMR output](https://gitlab.com/gitlab-org/cli/-/blob/main/internal/commands/mr/mrutils/mrutils.go), archived MCP [create handler](https://github.com/modelcontextprotocol/servers-archived/blob/main/src/gitlab/index.ts) and [schemas](https://github.com/modelcontextprotocol/servers-archived/blob/main/src/gitlab/schemas.ts). Fixtures should preserve these operation/response shapes without real user data.
