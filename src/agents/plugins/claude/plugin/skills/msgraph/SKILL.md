---
name: msgraph
description: >
  Work with Microsoft 365 services via the Graph API — emails, calendar events, SharePoint sites
  (read and write), Teams chats and channel messages, OneDrive files, OneNote notebooks, Planner
  task boards, Microsoft To Do task lists, AI meeting insights (Copilot recap), contacts, and org
  chart. Use this skill whenever the user asks about their emails, inbox, unread messages, meetings,
  calendar, Teams messages or chats, channel messages, SharePoint documents, OneDrive files, OneNote
  notes or notebooks, Planner plans or tasks, "my tasks", to-do lists, action items, meeting
  summaries, colleagues, manager, direct reports, or any personal/organizational Microsoft data.
  Invoke proactively any time the user mentions Outlook, Teams, SharePoint, OneDrive, OneNote,
  Planner, Microsoft To Do, or wants to interact with their Microsoft 365 account. The skill uses a
  local Node.js CLI (msgraph.js) that handles authentication, token caching, and all API calls.
---

# Microsoft Graph API Skill

This skill lets you interact with Microsoft 365 services on behalf of the user using the
Microsoft Graph API. The Node.js CLI at `scripts/msgraph.js` handles everything — no Python
or extra packages needed, only the Node.js that CodeMie already requires.

## Setup & Authentication

**Check login status first** — always run this before any other command:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js status
```

**Output interpretation:**
- `Logged in as: user@company.com` → proceed with any command below
- `NOT_LOGGED_IN` → follow the Login Flow below
- `TOKEN_EXPIRED` → session expired, also follow the Login Flow below

### Login Flow (first time or after expiry)

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js login
```

This opens the **system browser** for Microsoft authentication (PKCE flow). If the browser
does not open automatically, a URL will be printed in the terminal — navigate to it manually.
After successful sign-in, the token is cached at `~/.ms_graph_token_cache.json` and all
subsequent commands run silently.

Use `--force` to re-authenticate even when already logged in:
```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js login --force
```

### When NOT logged in or token expired

If status returns `NOT_LOGGED_IN` or `TOKEN_EXPIRED`, tell the user:

> "You need to log in to Microsoft first. Run this command in your terminal:
> ```
> node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js login
> ```
> Your browser will open for Microsoft sign-in. If it doesn't open automatically, a URL
> will appear in the terminal — navigate to it to complete authentication."

---

## Available Commands

### Profile & Org

```bash
# Your profile
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js me

# Your manager
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js org --manager

# Your direct reports
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js org --reports
```

### Emails

```bash
# List recent emails (default 10)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js emails

# More emails
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js emails --limit 25

# Unread only
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js emails --unread

# Search emails
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js emails --search "invoice Q4"

# Read a specific email by ID (copy ID from list output)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js emails --read MESSAGE_ID

# Send an email
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js emails --send recipient@example.com --subject "Hello" --body "Message text"

# Browse specific folder (inbox, sentitems, drafts, deleteditems, junkemail)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js emails --folder sentitems --limit 5

# Machine-readable JSON output
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js emails --json
```

### Calendar

```bash
# Upcoming events (default 10)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js calendar

# More events
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js calendar --limit 20

# Create an event
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js calendar --create "Team Standup" \
  --start "2024-03-20T09:00" --end "2024-03-20T09:30" \
  --location "Teams" --timezone "Europe/Berlin"

# Check availability for a time window
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js calendar --availability \
  --start "2024-03-20T09:00:00" --end "2024-03-20T18:00:00"
```

### SharePoint

```bash
# List followed/joined SharePoint sites
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js sharepoint --sites

# Browse files in a specific site (use ID from --sites output)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js sharepoint --site SITE_ID

# Browse a subfolder within a site
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js sharepoint --site SITE_ID --path "Documents/Reports"

# Download a file
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js sharepoint --download ITEM_ID --output report.xlsx
```

### Teams

```bash
# List all Teams chats
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js teams --chats

# Read messages from a chat (use chat ID from --chats output)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js teams --messages CHAT_ID

# Send a message to a chat
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js teams --send "Hello team!" --chat-id CHAT_ID

# List teams you're a member of
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js teams --teams-list
```

### OneDrive

```bash
# List root files
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js onedrive

# Browse a folder
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js onedrive --path "Documents"

# Upload a file
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js onedrive --upload ./report.pdf --dest "Documents/report.pdf"

# Download a file by ID
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js onedrive --download ITEM_ID --output local_copy.pdf

# File metadata
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js onedrive --info ITEM_ID
```

### OneNote

```bash
# List all notebooks
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js onenote --notebooks

# List sections in a notebook (use ID from --notebooks output)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js onenote --sections NOTEBOOK_ID

# List pages in a section (use ID from --sections output)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js onenote --pages SECTION_ID

# Read a page's content (use ID from --pages output)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js onenote --read PAGE_ID

# Search pages across all notebooks
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js onenote --search "meeting notes"

# Create a new page in a section
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js onenote --create "My Note" \
  --section SECTION_ID --body "Note content here"

# Machine-readable JSON output
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js onenote --notebooks --json
```

### Planner

Team/group task boards. Plans live inside Microsoft 365 groups, so `--plans` needs the
`Group.Read.All` scope. Updates use optimistic concurrency under the hood (etag handling is
automatic).

```bash
# List all plans shared with you (one call)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js planner --plans

# Tasks assigned to you across all plans (the usual starting point)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js planner --my-tasks

# List tasks in a specific plan (use ID from --plans)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js planner --plan-id PLAN_ID --tasks

# List buckets (columns) in a plan
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js planner --plan-id PLAN_ID --buckets

# Show one task's details (description, % complete, due date)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js planner --task-id TASK_ID

# Create a task in a plan (bucket, due date and assignee are optional)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js planner --plan-id PLAN_ID \
  --create "Write release notes" --bucket-id BUCKET_ID --due 2026-06-20 --assign USER_AAD_ID

# Mark a task complete (reads the etag, then sets it to 100%)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js planner --complete TASK_ID

# Machine-readable JSON output (on any read command)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js planner --my-tasks --json
```

> `--my-tasks` returns only `planId`/`bucketId` (no names). To turn an ID into a readable
> plan name, run `planner --plans`. Use `people --search NAME` to get a user's AAD ID for `--assign`.

### To Do

Personal Microsoft To Do task lists (simpler than Planner — flat lists of tasks).

```bash
# List your task lists
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js todo --lists

# List tasks in a list (use ID from --lists)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js todo --list-id LIST_ID --tasks

# Create a task
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js todo --list-id LIST_ID \
  --create "Renew certificate" --body "Before it expires" --due 2026-06-15

# Mark a task complete
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js todo --list-id LIST_ID --complete TASK_ID
```

### Channels

```bash
# List channels in a team (use team ID from teams --teams-list)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js channels --team-id TEAM_ID --list

# Read recent messages in a channel
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js channels --team-id TEAM_ID --channel-id CHANNEL_ID --messages

# Post a message to a channel
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js channels --team-id TEAM_ID --channel-id CHANNEL_ID --send "Hello channel!"
```

### Transcripts

```bash
# List online meetings in a date range (defaults to last 7 days)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js transcripts --start 2026-03-06

# List online meetings in a specific date range
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js transcripts --start 2026-03-06 --end 2026-03-07

# Find meetings by subject keyword and show their transcripts
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js transcripts --start 2026-03-06 --subject "standup"

# List transcripts for a known meeting ID
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js transcripts --meeting MEETING_ID

# Read transcript content (plain text, printed to stdout)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js transcripts --meeting MEETING_ID --transcript TRANSCRIPT_ID

# Save transcript to a file
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js transcripts --meeting MEETING_ID --transcript TRANSCRIPT_ID --output meeting.txt

# Download as VTT (timestamped captions format)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js transcripts --meeting MEETING_ID --transcript TRANSCRIPT_ID --vtt --output meeting.vtt

# AI meeting recap (Copilot-generated notes, action items, mentions) for a known meeting
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js transcripts --meeting MEETING_ID --insights

# AI recap by date + subject (resolves the meeting for you)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js transcripts --start 2026-06-09 --subject "planning" --insights
```

> **AI Insights require a Microsoft 365 Copilot license.** Insights are generated only after a
> meeting ends (with transcription/recording on) and can take up to 4 hours to appear. A `403`
> means the Copilot license is missing; an empty result means insights aren't ready yet.

### People & Contacts

```bash
# Frequent collaborators (AI-ranked by Microsoft)
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js people

# Search people by name
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js people --search "Alice"

# Outlook address book contacts
node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js people --contacts
```

---

## Workflow Patterns

### "Show me my emails"
1. Run `status` → check login
2. Run `emails --limit 15` → show results
3. If user wants to read one, run `emails --read ID`

### "What's on my calendar today/this week?"
1. Run `calendar --limit 10`
2. Parse dates in output and filter for user's timeframe

### "Find a file in SharePoint"
1. Run `sharepoint --sites` → list sites
2. Run `sharepoint --site SITE_ID` → browse files
3. Use `--path` to drill into folders
4. Offer `--download ITEM_ID` if user wants the file

### "Check my Teams messages"
1. Run `teams --chats` → list chats
2. User picks a chat → run `teams --messages CHAT_ID`

### "Show me my OneNote notes" / "Find a note about X"
1. Run `onenote --notebooks` → list notebooks
2. Run `onenote --sections NOTEBOOK_ID` → list sections
3. Run `onenote --pages SECTION_ID` → list pages, or use `onenote --search "keyword"` to search directly
4. Run `onenote --read PAGE_ID` → display page content

### "Show me the transcript from yesterday's standup"
1. Run `transcripts --start YYYY-MM-DD --subject "standup"` → finds the meeting and lists transcript IDs
2. Run `transcripts --meeting MEETING_ID --transcript TRANSCRIPT_ID` → reads full transcript text

### "Get all meeting transcripts for today"
1. Run `transcripts --start YYYY-MM-DD` → lists all online meetings for the day
2. Run `transcripts --meeting MEETING_ID` → lists available transcripts per meeting
3. Run `transcripts --meeting MEETING_ID --transcript TRANSCRIPT_ID --output meeting.txt` → saves each transcript

### "Post a message to a Teams channel"
1. Run `teams --teams-list` → get the team ID
2. Run `channels --team-id TEAM_ID --list` → get the channel ID
3. Run `channels --team-id TEAM_ID --channel-id CHANNEL_ID --send "message"`

### "Who's my manager?" / "Who reports to me?"
- Run `org --manager` or `org --reports`

### "What are my tasks?" / "What's on my Planner?"
1. Run `planner --my-tasks` → tasks assigned to you across all plans
2. Run `planner --plans` to map any `planId` in the output to a readable plan name
3. Drill in with `planner --plan-id PLAN_ID --tasks` if the user wants a specific board
4. Also check `todo --lists` then `todo --list-id LIST_ID --tasks` for personal To Do items

### "Add a task to Planner" / "Create a to-do"
1. Planner: run `planner --plans` (then `--buckets` if a column is needed) to get IDs, then
   `planner --plan-id PLAN_ID --create "TITLE"` (add `--due`, `--assign`, `--bucket-id` as needed)
2. To Do: run `todo --lists`, then `todo --list-id LIST_ID --create "TITLE"`

### "Mark that task done"
- Planner: `planner --complete TASK_ID`  ·  To Do: `todo --list-id LIST_ID --complete TASK_ID`

### "Summarize yesterday's meeting" / "What were the action items?"
1. Run `transcripts --start YYYY-MM-DD --subject "keyword" --insights` (resolves the meeting and
   prints Copilot notes, action items, and mentions)
2. Or, with a known meeting ID: `transcripts --meeting MEETING_ID --insights`
3. If you get a `403`, tell the user a Microsoft 365 Copilot license is required; if empty, insights
   may not be ready yet (up to 4 hours after the meeting ends)

---

## Error Handling

| Exit code | Meaning |
|-----------|---------|
| 0 | Success |
| 1 | API error (shown in output) |
| 2 | NOT_LOGGED_IN — user must run `login` |

When you see `Permission denied` errors, it means the OAuth scope isn't granted for that operation.
This can happen if the user's organization has restricted certain Graph API permissions.

---

## Dependencies

**None** — the script uses only built-in Node.js modules (`https`, `fs`, `path`, `os`).
Node.js >= 18 is required, which is already a CodeMie prerequisite.
IMPORTANT: you must work with current date (get it from sh/bash)
