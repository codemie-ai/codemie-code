---
name: msgraph
description: >
  Work with Microsoft 365 services via the Graph API — emails, calendar events, SharePoint sites,
  Teams chats, OneDrive files, OneNote notebooks, contacts, and org chart. Use this skill whenever
  the user asks about their emails, inbox, unread messages, meetings, calendar, Teams messages or
  chats, SharePoint documents, OneDrive files, OneNote notes or notebooks, colleagues, manager,
  direct reports, or any personal/organizational Microsoft data. Invoke proactively any time the
  user mentions Outlook, Teams, SharePoint, OneDrive, OneNote, or wants to interact with their
  Microsoft 365 account. The skill uses a local Node.js CLI (msgraph.js) that handles
  authentication, token caching, and all API calls.
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

This starts the **Device Code Flow** — it will print a URL and a short code like:
```
To sign in, use a web browser to open the page https://microsoft.com/devicelogin
and enter the code ABCD-1234 to authenticate.
```

Tell the user exactly that message, then wait. Once they complete login in the browser,
the token is cached at `~/.ms_graph_token_cache.json` and all subsequent commands run silently.

### When NOT logged in or token expired

If status returns `NOT_LOGGED_IN` or `TOKEN_EXPIRED`, tell the user:

> "You need to log in to Microsoft first. Run this command in your terminal:
> ```
> node ${CLAUDE_PLUGIN_ROOT}/skills/msgraph/scripts/msgraph.js login
> ```
> A code and URL will appear — open the URL in your browser and enter the code."

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

### "Who's my manager?" / "Who reports to me?"
- Run `org --manager` or `org --reports`

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
