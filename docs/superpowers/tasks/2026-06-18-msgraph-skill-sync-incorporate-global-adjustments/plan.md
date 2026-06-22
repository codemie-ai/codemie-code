# msgraph Skill Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the 13 substantive adjustments present in the codemie-installed msgraph plugin (`~/.codemie/claude-plugin/skills/msgraph/`) back into the codemie-code source-of-truth at `src/agents/plugins/claude/plugin/skills/msgraph/`, so the in-repo plugin source matches the runtime behaviour users already have.

**Architecture:** Mechanical, line-for-line code port from a known-good runtime copy. No new features designed in this plan — every change is a verbatim copy of code that already runs successfully via the installed plugin. Verification is by normalised diff: after the port, `diff <(normalise src) <(normalise installed)` of both `SKILL.md` and `scripts/msgraph.js` must be empty.

**Tech Stack:** Node.js CLI (vanilla `https`/`URLSearchParams`, no deps). Microsoft Graph v1.0 REST. Plugin loaded by Claude via `${CLAUDE_PLUGIN_ROOT}` placeholder.

**Note on tests:** Per `AGENTS.md` rule 2 ("Tests Only On Explicit Request") and the absence of any existing Vitest coverage targeting plugin skill scripts, every task below is marked `Test-first: no`. Behaviour is already validated in production (the installed plugin is in active use). Verification is the post-port normalised diff.

---

## Files

- **Modify:** `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` (1612 → ~1728 LOC, +136/-20 across 13 hunks)
- **Modify:** `src/agents/plugins/claude/plugin/skills/msgraph/SKILL.md` (+3 lines in `### Channels` section)
- **Reference (read-only):** `~/.codemie/claude-plugin/skills/msgraph/scripts/msgraph.js`
- **Reference (read-only):** `~/.codemie/claude-plugin/skills/msgraph/SKILL.md`
- **Build artefact (regenerated, not hand-edited):** `dist/agents/plugins/claude/plugin/skills/msgraph/**`
- **Out of scope:** `/Users/Nikita_Levyankov/repos/codemie-ai/codemie-public-skills/skills/productivity/msgraph/**`

---

## Task 1: Set up isolated work environment

**Files:** none modified; branch + worktree state only.

- [ ] **Step 1: Confirm current dirty state is unrelated**
  Run: `git status --porcelain`
  Expected: only files under `.ai-run/`, `.codemie/`, `.gitignore`, `AGENTS.md`, `package*.json`, `.claude/skills/playwright-cli/`, `tests/e2e/` — none touching `src/agents/plugins/claude/plugin/skills/msgraph/`.

- [ ] **Step 2: Stash unrelated work**
  Run: `git stash push -u -m "EPMCDME-12772 WIP — set aside for msgraph sync"`
  Expected: `Saved working directory and index state On feature/EPMCDME-12772: …`.

- [ ] **Step 3: Refresh main**
  Run: `git fetch origin && git checkout main && git pull --ff-only origin main`
  Expected: `Already up to date.` or fast-forward.

- [ ] **Step 4: Create the feature branch**
  Run: `git checkout -b feature/msgraph-skill-sync-incorporate-installed-adjustments`
  Expected: `Switched to a new branch 'feature/msgraph-skill-sync-incorporate-installed-adjustments'`.
  Note: no Jira ticket is currently associated. If a ticket is required by the org's git workflow, run the `brianna` skill to create one and rename the branch to `feature/EPMCDME-<id>-msgraph-skill-sync` before the first commit.

- [ ] **Step 5: Commit** — nothing to commit at this step; branch is empty.

---

## Task 2: Port `httpsRequest` to expose response headers in errors

**Files:**
- Modify: `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` around line 71

**Test-first:** no — port of in-production code; verification by post-port diff.

- [ ] **Step 1: Edit the file**
  In the `httpsRequest` rejection branch (the `if (res.statusCode >= 400)` arm), add a line populating `err.headers` from the response headers. The final shape:
  ```js
  err.statusCode   = res.statusCode;
  err.responseBody = text;
  err.responseUrl  = urlStr;
  err.headers      = res.headers;
  return reject(err);
  ```

- [ ] **Step 2: Verify the hunk applied**
  Run: `grep -n 'err.headers' src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js`
  Expected: one match around line 74.

- [ ] **Step 3: Commit**
  ```bash
  git add src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js
  git commit -m "feat(msgraph): expose response headers on httpsRequest errors"
  ```

---

## Task 3: Port `graphGet` retry-on-429 loop

**Files:**
- Modify: `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` (`graphGet` body around line 97)

**Test-first:** no — port.

- [ ] **Step 1: Replace the `graphGet` body**
  Replace the existing two-line implementation:
  ```js
  async function graphGet(endpoint, token, params = {}) {
    const qs  = new URLSearchParams(params).toString();
    const url = `${GRAPH_BASE}${endpoint}${qs ? '?' + qs : ''}`;
    const res = await httpsRequest(url, { headers: { Authorization: `Bearer ${token}` } });
    return JSON.parse(res.body);
  }
  ```
  with the retry-aware version:
  ```js
  async function graphGet(endpoint, token, params = {}) {
    const qs  = new URLSearchParams(params).toString();
    const url = `${GRAPH_BASE}${endpoint}${qs ? '?' + qs : ''}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await httpsRequest(url, { headers: { Authorization: `Bearer ${token}` } });
        return JSON.parse(res.body);
      } catch (e) {
        if (e.statusCode === 429 && attempt < 2) {
          const ra = parseInt(e.headers?.['retry-after'] || '', 10);
          const waitS = Number.isFinite(ra) && ra > 0 ? Math.min(60, ra) : Math.min(30, 2 ** attempt * 2);
          await new Promise(r => setTimeout(r, waitS * 1000));
          continue;
        }
        throw e;
      }
    }
  }
  ```

- [ ] **Step 2: Verify**
  Run: `grep -n 'retry-after' src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js`
  Expected: one match in `graphGet`.

- [ ] **Step 3: Commit**
  ```bash
  git add src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js
  git commit -m "feat(msgraph): retry graphGet on HTTP 429 with Retry-After honour"
  ```

---

## Task 4: Port `emails --conversation` flag + extend default `$select`

**Files:**
- Modify: `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` (emails handler, lines ~486–491)

**Test-first:** no — port.

- [ ] **Step 1: Insert the `--conversation` branch**
  Inside the emails handler, immediately after `const limit  = parseInt(args.limit) || 10;` and before the existing `const params = { … };`, insert:
  ```js
  if (args.conversation) {
    // Graph rejects $orderby with $filter on conversationId ("InefficientFilter").
    // Pull more rows than asked and sort client-side.
    const cv = await graphGet('/me/messages', token, {
      $filter: `conversationId eq '${args.conversation}'`,
      $top:    Math.max(limit, 25),
      $select: 'id,subject,from,sentDateTime,receivedDateTime,isRead,bodyPreview,conversationId',
    });
    let msgs = cv.value || [];
    msgs.sort((a, b) => (b.sentDateTime || b.receivedDateTime || '').localeCompare(a.sentDateTime || a.receivedDateTime || ''));
    msgs = msgs.slice(0, limit);
    if (args.json) { console.log(JSON.stringify(msgs, null, 2)); return; }
    if (!msgs.length) { console.log('No messages in this conversation.'); return; }
    console.log(`\n${'Sent'.padEnd(16)}  ${'From'.padEnd(28)}  Subject`);
    console.log('─'.repeat(80));
    for (const m of msgs) {
      const from = (m.from?.emailAddress?.name || '').slice(0, 28).padEnd(28);
      console.log(`${fmtDt(m.sentDateTime || m.receivedDateTime).padEnd(16)}  ${from}  ${(m.subject || '(no subject)').slice(0, 40)}`);
    }
    return;
  }
  ```

- [ ] **Step 2: Extend default `$select`**
  Locate `$select:  'id,subject,from,receivedDateTime,isRead,hasAttachments,importance',` and change to:
  ```js
  $select:  'id,subject,from,receivedDateTime,isRead,hasAttachments,importance,bodyPreview,conversationId',
  ```

- [ ] **Step 3: Verify**
  Run: `grep -n 'conversationId' src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js`
  Expected: ≥3 matches.

- [ ] **Step 4: Commit**
  ```bash
  git add src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js
  git commit -m "feat(msgraph): emails --conversation CONV_ID + bodyPreview in default select"
  ```

---

## Task 5: Port `teams --chats` to use `lastMessagePreview`

**Files:**
- Modify: `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` (teams handler around line 643)

**Test-first:** no — port.

- [ ] **Step 1: Replace the `--chats` branch**
  Replace the existing block:
  ```js
  if (args.chats) {
    const data  = await graphGet('/me/chats', token, { $top: limit, $select: 'id,topic,chatType,lastUpdatedDateTime' });
    const chats = data.value || [];
    if (args.json) { console.log(JSON.stringify(chats, null, 2)); return; }
    console.log(`\n${'Chat ID'.padEnd(50)}  ${'Type'.padEnd(10)}  Topic`);
    console.log('─'.repeat(80));
    for (const c of chats)
      console.log(`${(c.id || '').padEnd(50)}  ${(c.chatType || '').padEnd(10)}  ${c.topic || '(direct message)'}`);
    return;
  }
  ```
  with:
  ```js
  if (args.chats) {
    // $expand=lastMessagePreview returns the true last-message timestamp + body.
    // Graph's `lastUpdatedDateTime` on the chat is frequently stale (months/years
    // behind), so callers that need recency MUST read lastMessagePreview.
    const data  = await graphGet('/me/chats', token, { $top: limit, $expand: 'lastMessagePreview' });
    const chats = data.value || [];
    if (args.json) { console.log(JSON.stringify(chats, null, 2)); return; }
    console.log(`\n${'Chat ID'.padEnd(50)}  ${'Type'.padEnd(10)}  Last msg            Topic`);
    console.log('─'.repeat(80));
    for (const c of chats) {
      const last = c.lastMessagePreview?.createdDateTime || c.lastUpdatedDateTime || '';
      console.log(`${(c.id || '').padEnd(50)}  ${(c.chatType || '').padEnd(10)}  ${fmtDt(last).padEnd(18)}  ${c.topic || '(direct message)'}`);
    }
    return;
  }
  ```

- [ ] **Step 2: Verify**
  Run: `grep -n 'lastMessagePreview' src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js`
  Expected: ≥2 matches.

- [ ] **Step 3: Commit**
  ```bash
  git add src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js
  git commit -m "feat(msgraph): teams --chats reports real last-message time via expand"
  ```

---

## Task 6: Port `teams --messages` `--max N` pagination

**Files:**
- Modify: `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` (teams handler around line 693)

**Test-first:** no — port.

- [ ] **Step 1: Replace the `--messages` branch**
  Replace the existing block:
  ```js
  if (args.messages) {
    // Graph returns HTTP 400 if $select is used on the Teams messages endpoint — pass $top only.
    const data = await graphGet(`/me/chats/${args.messages}/messages`, token, { $top: limit });
    const msgs = data.value || [];
    if (args.json) { console.log(JSON.stringify(msgs, null, 2)); return; }
    console.log(`\nMessages in chat ${args.messages.slice(0, 20)}...:`);
    …
  }
  ```
  with the full new branch (rendering loop unchanged from the original):
  ```js
  if (args.messages) {
    // Graph returns HTTP 400 if $select is used on the Teams messages endpoint — pass $top only.
    // `--max N` paginates via @odata.nextLink up to N messages total (capped per page at 50 by Graph).
    const max = args.max ? parseInt(args.max, 10) : null;
    const perPage = max ? Math.min(50, max) : limit;
    let next = `/me/chats/${args.messages}/messages?$top=${perPage}`;
    const msgs = [];
    while (next) {
      const data = await graphGet(next.replace(GRAPH_BASE, '').replace('https://graph.microsoft.com/v1.0', ''), token, {});
      for (const m of (data.value || [])) {
        msgs.push(m);
        if (max && msgs.length >= max) break;
      }
      if (max && msgs.length >= max) break;
      const nl = data['@odata.nextLink'];
      if (!nl || !max) break; // no pagination unless --max set
      next = nl;
    }
    if (args.json) { console.log(JSON.stringify(msgs, null, 2)); return; }
    console.log(`\nMessages in chat ${args.messages.slice(0, 20)}... (${msgs.length}):`);
    console.log('─'.repeat(60));
    for (const m of [...msgs].reverse()) {
      const sender = m.from?.user?.displayName || 'System';
      const body   = stripHtml(m.body?.content || '').slice(0, 200);
      console.log(`[${fmtDt(m.createdDateTime)}] ${sender}: ${body}`);
    }
    return;
  }
  ```
  Note: the original branch's rendering loop is preserved verbatim — only the data-fetch portion above it changes.

- [ ] **Step 2: Verify**
  Run: `grep -n '@odata.nextLink' src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js`
  Expected: ≥1 match in the teams handler.

- [ ] **Step 3: Commit**
  ```bash
  git add src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js
  git commit -m "feat(msgraph): teams --messages --max N paginates via nextLink"
  ```

---

## Task 7: Port `teams --teams-list` `/me/memberOf` fallback

**Files:**
- Modify: `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` (teams handler around line 731)

**Test-first:** no — port.

- [ ] **Step 1: Replace the `--teams-list` branch**
  Replace:
  ```js
  if (args.teamsList) {
    const data  = await graphGet('/me/joinedTeams', token, { $select: 'id,displayName,description' });
    const teams = data.value || [];
    if (args.json) { console.log(JSON.stringify(teams, null, 2)); return; }
    for (const t of teams) console.log(`${t.id.slice(0, 36)}  ${t.displayName}`);
    return;
  }
  ```
  with:
  ```js
  if (args.teamsList) {
    // Prefer /me/joinedTeams (needs Team.ReadBasic.All). Fall back to /me/memberOf
    // filtered client-side to groups that are also teams (uses Group.Read.All,
    // which the default scope set already includes).
    let teams;
    try {
      const data = await graphGet('/me/joinedTeams', token, { $select: 'id,displayName,description' });
      teams = data.value || [];
    } catch (e) {
      if (!/403|Forbidden/.test(e.message)) throw e;
      const data = await graphGet('/me/memberOf', token, { $select: 'id,displayName,description,resourceProvisioningOptions', $top: 200 });
      teams = (data.value || []).filter(g => Array.isArray(g.resourceProvisioningOptions) && g.resourceProvisioningOptions.includes('Team'));
    }
    if (args.json) { console.log(JSON.stringify(teams, null, 2)); return; }
    for (const t of teams) console.log(`${(t.id || '').slice(0, 36)}  ${t.displayName}`);
    return;
  }
  ```

- [ ] **Step 2: Verify**
  Run: `grep -n 'resourceProvisioningOptions' src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js`
  Expected: ≥2 matches.

- [ ] **Step 3: Commit**
  ```bash
  git add src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js
  git commit -m "feat(msgraph): teams --teams-list falls back to /me/memberOf on 403"
  ```

---

## Task 8: Port `channels --list` membershipType + new `channels --members`

**Files:**
- Modify: `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` (channels handler around lines 731–746)

**Test-first:** no — port.

- [ ] **Step 1: Extend `--list` `$select`**
  Locate the `channels --list` branch and change:
  ```js
  const data = await graphGet(`/teams/${args.teamId}/channels`, token, { $select: 'id,displayName,description' });
  ```
  to:
  ```js
  const data = await graphGet(`/teams/${args.teamId}/channels`, token, { $select: 'id,displayName,description,membershipType' });
  ```

- [ ] **Step 2: Insert the `--members` branch**
  Immediately after the `--list` branch closes and before `if (!args.channelId) {`, insert:
  ```js
  if (args.members) {
    // Use the groups endpoint (teamId == groupId) so we don't need Team.ReadBasic.All;
    // pages through every member of the underlying M365 group.
    const members = [];
    let next = `/groups/${args.teamId}/members/microsoft.graph.user`;
    let params = { $select: 'id,displayName,userPrincipalName,mail', $top: 100 };
    while (next) {
      const page = await graphGet(next, token, params);
      for (const m of page.value || []) members.push(m);
      const nl = page['@odata.nextLink'];
      if (!nl) break;
      // Strip the base + use as endpoint; reuse no extra params (link contains them).
      next = nl.replace('https://graph.microsoft.com/v1.0', '');
      params = {};
    }
    if (args.json) { console.log(JSON.stringify(members, null, 2)); return; }
    console.log(`\nTeam members (${members.length}):`);
    console.log('─'.repeat(60));
    for (const m of members)
      console.log(`${(m.displayName || 'N/A').padEnd(34)}  ${m.userPrincipalName || m.mail || ''}`);
    return;
  }
  ```

- [ ] **Step 3: Update the required-args error line**
  Locate the error-handler block printing the `channels` usage and update:
  ```js
  console.log('         --team-id ID --channel-id ID --messages [--limit N]');
  ```
  to:
  ```js
  console.log('         --team-id ID --channel-id ID --messages [--limit N] [--expand-replies]');
  ```

- [ ] **Step 4: Commit**
  ```bash
  git add src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js
  git commit -m "feat(msgraph): channels --members + membershipType in --list"
  ```

---

## Task 9: Port `channels --replies MSG_ID` + `channels --messages --expand-replies`

**Files:**
- Modify: `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` (channels handler around lines 753–775)

**Test-first:** no — port.

- [ ] **Step 1: Insert the `--replies` branch**
  After the `if (!args.channelId) { … }` guard (so we know `channelId` is present), insert:
  ```js
  if (args.replies) {
    // --replies MSG_ID  →  replies to a specific channel message
    const data = await graphGet(`/teams/${args.teamId}/channels/${args.channelId}/messages/${args.replies}/replies`, token, { $top: limit });
    const reps = data.value || [];
    if (args.json) { console.log(JSON.stringify(reps, null, 2)); return; }
    console.log(`\nReplies to message ${args.replies.slice(0, 20)}...:`);
    console.log('─'.repeat(60));
    for (const r of [...reps].sort((a, b) => (a.createdDateTime || '').localeCompare(b.createdDateTime || ''))) {
      const rs = r.from?.user?.displayName || 'System';
      const rb = stripHtml(r.body?.content || '').slice(0, 200);
      console.log(`[${fmtDt(r.createdDateTime)}] ${rs}: ${rb}`);
    }
    return;
  }
  ```

- [ ] **Step 2: Replace the `channels --messages` branch**
  Replace the existing simple version (the original includes a `console.log('─'.repeat(60));` line between the header and the loop):
  ```js
  if (args.messages) {
    const data = await graphGet(`/teams/${args.teamId}/channels/${args.channelId}/messages`, token, { $top: limit });
    const msgs = data.value || [];
    if (args.json) { console.log(JSON.stringify(msgs, null, 2)); return; }
    console.log(`\nMessages in channel ${args.channelId.slice(0, 30)}...:`);
    console.log('─'.repeat(60));
    for (const m of [...msgs].reverse()) {
      const sender = m.from?.user?.displayName || 'System';
      const body   = stripHtml(m.body?.content || '').slice(0, 200);
      console.log(`[${fmtDt(m.createdDateTime)}] ${sender}: ${body}`);
    }
    return;
  }
  ```
  with the expand-replies-aware version:
  ```js
  if (args.messages) {
    const params = { $top: limit };
    if (args.expandReplies) params.$expand = 'replies';
    const data = await graphGet(`/teams/${args.teamId}/channels/${args.channelId}/messages`, token, params);
    const msgs = data.value || [];
    if (args.json) { console.log(JSON.stringify(msgs, null, 2)); return; }
    console.log(`\nMessages in channel ${args.channelId.slice(0, 30)}...:`);
    console.log('─'.repeat(60));
    for (const m of [...msgs].reverse()) {
      const sender = m.from?.user?.displayName || 'System';
      const body   = stripHtml(m.body?.content || '').slice(0, 200);
      console.log(`[${fmtDt(m.createdDateTime)}] ${sender}: ${body}`);
      if (args.expandReplies && Array.isArray(m.replies) && m.replies.length) {
        const replies = [...m.replies].sort((a, b) => (a.createdDateTime || '').localeCompare(b.createdDateTime || ''));
        for (const r of replies) {
          const rs = r.from?.user?.displayName || 'System';
          const rb = stripHtml(r.body?.content || '').slice(0, 160);
          console.log(`    └─ [${fmtDt(r.createdDateTime)}] ${rs}: ${rb}`);
        }
      }
    }
    return;
  }
  ```

- [ ] **Step 3: Update the bottom usage banner inside `runChannels`**
  Add the replies line to the bottom console.log block that prints when no subcommand matched:
  ```js
  console.log('channels --team-id ID --list');
  console.log('         --team-id ID --channel-id ID --messages [--limit N]');
  console.log('         --team-id ID --channel-id ID --replies MSG_ID [--limit N]');
  console.log('         --team-id ID --channel-id ID --send MSG');
  ```

- [ ] **Step 4: Commit**
  ```bash
  git add src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js
  git commit -m "feat(msgraph): channels --replies + --messages --expand-replies"
  ```

---

## Task 10: Port `parseArgs` BOOL set and CLI help banner

**Files:**
- Modify: `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` (`parseArgs` around line 1487, help banner around lines 1523/1531)

**Test-first:** no — port.

- [ ] **Step 1: Update the BOOL set**
  Locate the `BOOL` declaration in `parseArgs` and replace:
  ```js
  const BOOL = new Set(['json','unread','sites','chats','teamsList','contacts',
    'manager','reports','availability','notebooks','list','messages','vtt','help','force',
    'plans','buckets','tasks','myTasks','lists','insights']);
  ```
  with:
  ```js
  const BOOL = new Set(['json','unread','sites','chats','teamsList','contacts',
    'manager','reports','availability','notebooks','list','vtt','help','force',
    'plans','buckets','tasks','myTasks','lists','insights','expandReplies','members']);
  ```
  Note: this removes `'messages'` (it's a value-taking flag everywhere — passing `--messages CHAT_ID` should populate `args.messages = "CHAT_ID"`) and adds `'expandReplies'` + `'members'`.

- [ ] **Step 2: Update help banner — `emails` line**
  Locate:
  ```
    emails [--limit N] [--unread] [--search Q] [--folder NAME]
           [--read ID] [--send TO --subject S --body B] [--json]
  ```
  and change the second line to:
  ```
           [--read ID] [--conversation CONV_ID] [--send TO --subject S --body B] [--json]
  ```

- [ ] **Step 3: Update help banner — `channels` block**
  Locate:
  ```
    channels --team-id ID --list
             --team-id ID --channel-id ID --messages [--limit N]
             --team-id ID --channel-id ID --send MSG [--json]
  ```
  and change to:
  ```
    channels --team-id ID --list
             --team-id ID --members
             --team-id ID --channel-id ID --messages [--limit N] [--expand-replies]
             --team-id ID --channel-id ID --replies MSG_ID [--limit N]
             --team-id ID --channel-id ID --send MSG [--json]
  ```

- [ ] **Step 4: Commit**
  ```bash
  git add src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js
  git commit -m "fix(msgraph): correct parseArgs BOOL set + document new flags in help"
  ```

---

## Task 11: Port the `SKILL.md` `--expand-replies` documentation block

**Files:**
- Modify: `src/agents/plugins/claude/plugin/skills/msgraph/SKILL.md` (`### Channels` section)

**Test-first:** no — pure documentation port.

- [ ] **Step 1: Insert the new doc block**
  Locate the existing block:
  ```
  # Read recent messages in a channel
  node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js channels --team-id TEAM_ID --channel-id CHANNEL_ID --messages

  # Post a message to a channel
  ```
  and insert between them:
  ```
  # Read messages with their reply threads (needed to detect unanswered/clarification-only threads)
  node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js channels --team-id TEAM_ID --channel-id CHANNEL_ID --messages --expand-replies --json
  ```
  Note: use the `${CLAUDE_PLUGIN_ROOT}` placeholder — **NOT** the hardcoded `/Users/Nikita_Levyankov/.codemie/claude-plugin/...` path that exists in the installed copy. The hardcoded paths in the installed SKILL.md are installation artefacts and must not be ported back.

- [ ] **Step 2: Verify**
  Run: `grep -n 'expand-replies' src/agents/plugins/claude/plugin/skills/msgraph/SKILL.md`
  Expected: 1 match.

- [ ] **Step 3: Commit**
  ```bash
  git add src/agents/plugins/claude/plugin/skills/msgraph/SKILL.md
  git commit -m "docs(msgraph): document --expand-replies usage for channel messages"
  ```

---

## Task 12: Verify the port via normalised diff

**Files:** none modified; verification only.

**Test-first:** no — this IS the verification.

- [ ] **Step 1: SKILL.md diff (paths normalised)**
  Run:
  ```bash
  diff <(sed 's|${CLAUDE_PLUGIN_ROOT}/skills/msgraph|XPATHX|g; s|/Users/Nikita_Levyankov/.codemie/claude-plugin/skills/msgraph|XPATHX|g' src/agents/plugins/claude/plugin/skills/msgraph/SKILL.md) \
       <(sed 's|${CLAUDE_PLUGIN_ROOT}/skills/msgraph|XPATHX|g; s|/Users/Nikita_Levyankov/.codemie/claude-plugin/skills/msgraph|XPATHX|g' ~/.codemie/claude-plugin/skills/msgraph/SKILL.md)
  ```
  Expected: empty output (zero diff after path normalisation).

- [ ] **Step 2: scripts/msgraph.js diff**
  Run:
  ```bash
  diff src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js ~/.codemie/claude-plugin/skills/msgraph/scripts/msgraph.js
  ```
  Expected: empty output. If any hunks remain, identify the missing port and apply it in a follow-up commit before moving on.

- [ ] **Step 3: Smoke-test the script parses**
  Run:
  ```bash
  node src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js --help
  ```
  Expected: the help banner prints with the new `--conversation`, `--members`, `--expand-replies`, `--replies` entries visible. No syntax error from Node.

- [ ] **Step 4: Smoke-test a real call (read-only)**
  Run:
  ```bash
  node src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js status
  ```
  Expected: prints either "Logged in as …" or "Not logged in" — no stack trace.

- [ ] **Step 5: Commit** — nothing to commit; verification only.

---

## Task 13: Run quality gates

**Files:** none modified; tooling only.

**Test-first:** no — these are gates, not tests of the port.

- [ ] **Step 1: Lint**
  Run: `npm run lint`
  Expected: exit 0, no warnings (zero-warning policy per AGENTS.md / quality-gates.md).
  If lint fails on the ported file, fix the violations inline and re-run.

- [ ] **Step 2: Typecheck**
  Run: `npm run typecheck`
  Expected: exit 0.
  (The msgraph script is plain `.js`; the typecheck still needs to succeed for the rest of the repo.)

- [ ] **Step 3: Build**
  Run: `npm run build`
  Expected: exit 0; `dist/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` regenerated with size matching the new src (~1728 LOC).
  Verification: `wc -l dist/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` reports ~1728.

- [ ] **Step 4: Commit any build artefacts the build script writes**
  Run: `git status --porcelain`
  If `dist/` is in `.gitignore` (likely), no commit needed. If `dist/` is tracked, run:
  ```bash
  git add dist/agents/plugins/claude/plugin/skills/msgraph
  git commit -m "build: regenerate dist/msgraph after src sync"
  ```

- [ ] **Step 5: License + secret scan (if part of project gates)**
  Run: `npm run check:pre-commit`
  Expected: exit 0.
  Per AGENTS.md: do not bypass with `--no-verify` if it fails — investigate and fix.

---

## Task 14: Final review and hand-off

**Files:** none modified.

**Test-first:** no.

- [ ] **Step 1: Branch summary**
  Run: `git log --oneline main..HEAD`
  Expected: ~10 commits (Tasks 2–11 each produced one).

- [ ] **Step 2: Diff summary vs main**
  Run: `git diff --stat main..HEAD`
  Expected: only `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js` (+~136/-~20), `src/agents/plugins/claude/plugin/skills/msgraph/SKILL.md` (+3/-0), and any regenerated `dist/` files.

- [ ] **Step 3: Confirm no public-skills drift introduced**
  Run: `diff -q src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js /Users/Nikita_Levyankov/repos/codemie-ai/codemie-public-skills/skills/productivity/msgraph/scripts/msgraph.js`
  Expected: files differ (this is the expected drift between codemie-code and the public mirror; a follow-up sync is out of scope per the user's decision).
  Document the drift in the PR description so a follow-up PR can mirror it.

- [ ] **Step 4: Restore EPMCDME-12772 work (only if user wants to switch back)**
  This is a hand-off step — do not run unconditionally.
  ```bash
  git checkout feature/EPMCDME-12772
  git stash pop
  ```

- [ ] **Step 5: Hand off**
  Print: "Branch `feature/msgraph-skill-sync-incorporate-installed-adjustments` is ready. Invoke `sdlc-factory:mr-creator` to open the PR, and add a follow-up note recommending a separate sync into `codemie-public-skills`."
