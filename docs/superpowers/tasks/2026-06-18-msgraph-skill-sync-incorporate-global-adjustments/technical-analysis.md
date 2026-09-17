# Technical Analysis: msgraph skill sync

## Investigation

Three copies of the msgraph skill exist on this machine. We compared all three after normalising path differences (the only difference between the placeholder `${CLAUDE_PLUGIN_ROOT}/skills/msgraph` and the user-specific `/Users/Nikita_Levyankov/.codemie/claude-plugin/skills/msgraph`).

| Location | Role | SKILL.md md5 (normalised) | scripts/msgraph.js LOC |
|---|---|---|---|
| `codemie-code/src/agents/plugins/claude/plugin/skills/msgraph/` | Source of truth in repo | `408f159fc8a69e2339e5042cc1b6075a` | 1612 |
| `codemie-public-skills/skills/productivity/msgraph/` | Public mirror | (byte-identical to src) | 1612 |
| `~/.claude/skills/msgraph/` | Truly global skill | `408f159fc8a69e2339e5042cc1b6075a` (== src) | (no scripts dir) |
| `~/.codemie/claude-plugin/skills/msgraph/` | codemie-installed plugin | `a83daa91c3fafa4433cf43140a7c5414` | **1728 (+116)** |

The `~/.claude/skills/msgraph/` copy that the user labelled "global" has **no functional adjustments** — it is content-identical to source-of-truth modulo a hardcoded user path. The genuine adjustments live in the codemie-installed plugin at `~/.codemie/claude-plugin/skills/msgraph/`. The decision to treat that as the source for this port was confirmed by the user.

The public-skills mirror is byte-identical to codemie-code/src, so we only need to port to codemie-code/src for now (per user decision).

## Codebase Findings

### scripts/msgraph.js — installed vs src

13 substantive change regions, +136 lines / -20 lines:

1. **`httpsRequest` error object** (`@@ -71`): expose `err.headers = res.headers` so callers can read `Retry-After`.
2. **`graphGet` retry loop** (`@@ -97`): 3-attempt loop, honours `Retry-After` on HTTP 429, exponential backoff fallback (capped at 60 s).
3. **`emails` — `--conversation CONV_ID`** (`@@ -486` new branch): fetch all messages in a thread (`$filter conversationId eq …`), sort client-side because Graph rejects `$orderby + $filter conversationId` ("InefficientFilter").
4. **`emails` default `$select`** (`@@ -491` line): add `bodyPreview` and `conversationId` to the default listing so output carries preview text + thread anchor.
5. **`teams --chats`** (`@@ -643`): switch to `$expand=lastMessagePreview`. Graph's chat-level `lastUpdatedDateTime` is frequently stale by months/years; the preview carries the real last-message timestamp. New "Last msg" column in the table output.
6. **`teams --messages …`** (`@@ -693`): add `--max N` pagination via `@odata.nextLink` (capped at 50 per page by Graph). Output now shows total count.
7. **`teams --teams-list`** (`@@ -731`): fall back to `/me/memberOf` filtered to groups whose `resourceProvisioningOptions` includes `Team` when `/me/joinedTeams` returns 403. Avoids needing `Team.ReadBasic.All` scope.
8. **`channels --list` `$select`** (`@@ -731`): add `membershipType` field.
9. **`channels --members`** (`@@ -746` new): list team members via `/groups/{teamId}/members/microsoft.graph.user` (teamId == groupId), paginated. Uses `Group.Read.All` only.
10. **`channels --replies MSG_ID`** (`@@ -753` new): list replies to one channel message, chronologically.
11. **`channels --messages --expand-replies`** (`@@ -761`): `$expand=replies` then render the reply tree under each message (max 160-char preview, sorted by `createdDateTime`).
12. **`parseArgs` BOOL set** (`@@ -1487`): remove `'messages'` (was a parsing bug — `--messages CHAT_ID` set `args.messages=true` and dropped CHAT_ID); add `'expandReplies'` and `'members'`.
13. **CLI help banner** (`@@ -1523`, `@@ -1531`): documents `--conversation`, `--members`, `--expand-replies`, `--replies`.

### SKILL.md — installed vs src

One change region, +3 lines:

* **`### Channels` section** (between `--messages` and `--send` examples): adds a documented invocation
  ```
  # Read messages with their reply threads (needed to detect unanswered/clarification-only threads)
  node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js channels --team-id TEAM_ID --channel-id CHANNEL_ID --messages --expand-replies --json
  ```

The other ~60 path-only differences in SKILL.md (hardcoded `/Users/…` instead of `${CLAUDE_PLUGIN_ROOT}`) are **installation artefacts and must NOT be ported back** — they would break portability for every other user of the plugin.

### README.md — installed vs src

Byte-identical. No port needed.

## Risk Indicators

1. **No existing test coverage** for `scripts/msgraph.js`. The skill is a standalone Node CLI; the project's Vitest suite does not target plugin skill scripts. AGENTS.md tests-on-explicit-request rule already implies we do not add tests here.
2. **Parser-bug change is behaviour-altering** (item 12 above). The src treats `--messages` as boolean; the installed plugin treats it as a value-taking flag. Any caller that was relying on the buggy behaviour (passing `--messages CHAT_ID` and somehow handling the resulting 404) will see a behaviour change — but the SKILL.md doc has always told users to invoke it as `--messages CHAT_ID`, so the buggy path is unlikely to be load-bearing.
3. **Build artefact divergence**: `dist/agents/plugins/claude/plugin/skills/msgraph/` is generated from src by the build pipeline. After the src port, a `npm run build` must regenerate the dist copy so the bundled CLI ships the new version. We will rely on the project's existing build script rather than hand-editing `dist/`.
4. **codemie-public-skills mirror will drift** after this port. The user explicitly scoped this to codemie-code; a follow-up sync to the public-skills mirror is out of scope but noted here for visibility.
5. **No new Microsoft Graph scopes required** by any added feature. `lastMessagePreview`, `$expand=replies`, `--conversation`, `/groups/{teamId}/members` all use scopes already requested by the existing auth flow (`User.Read`, `Mail.Read`, `Chat.Read`, `ChannelMessage.Read.All`, `Group.Read.All`, etc.).
