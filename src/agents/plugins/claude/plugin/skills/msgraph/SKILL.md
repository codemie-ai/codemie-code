---
name: msgraph
description: >
  Work with Microsoft 365 services via the Graph API — emails, calendar events, SharePoint sites,
  Teams chats, OneDrive files, contacts, and org chart. Use this skill whenever the user asks
  about their emails, inbox, unread messages, meetings, calendar, Teams messages or chats,
  SharePoint documents, OneDrive files, colleagues, manager, direct reports, or any personal/
  organizational Microsoft data. Invoke proactively any time the user mentions Outlook, Teams,
  SharePoint, OneDrive, or wants to interact with their Microsoft 365 account. The skill uses
  a local Python CLI (msgraph.py) that handles authentication, token caching, and all API calls.
---

# Microsoft Graph API Skill

This skill lets you interact with Microsoft 365 services on behalf of the user using the
Microsoft Graph API. The Python CLI at `scripts/msgraph.py` handles everything.

## Setup & Authentication

**Check login status first** — always run this before any other command:

```bash
python scripts/msgraph.py status
```

**Output interpretation:**
- `Logged in as: user@company.com` → proceed with any command below
- `NOT_LOGGED_IN` → follow the Login Flow below
- `TOKEN_EXPIRED` → session expired, also follow the Login Flow below

### Login Flow (first time or after expiry)

```bash
python scripts/msgraph.py login
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
> python scripts/msgraph.py login
> ```
> A code and URL will appear — open the URL in your browser and enter the code."

---

## Available Commands

### Profile & Org

```bash
# Your profile
python scripts/msgraph.py me

# Your manager
python scripts/msgraph.py org --manager

# Your direct reports
python scripts/msgraph.py org --reports
```

### Emails

```bash
# List recent emails (default 10)
python scripts/msgraph.py emails

# More emails
python scripts/msgraph.py emails --limit 25

# Unread only
python scripts/msgraph.py emails --unread

# Search emails
python scripts/msgraph.py emails --search "invoice Q4"

# Read a specific email by ID (copy ID from list output)
python scripts/msgraph.py emails --read MESSAGE_ID

# Send an email
python scripts/msgraph.py emails --send recipient@example.com --subject "Hello" --body "Message text"

# Browse specific folder (inbox, sentitems, drafts, deleteditems, junkemail)
python scripts/msgraph.py emails --folder sentitems --limit 5

# Machine-readable JSON output
python scripts/msgraph.py emails --json
```

### Calendar

```bash
# Upcoming events (default 10)
python scripts/msgraph.py calendar

# More events
python scripts/msgraph.py calendar --limit 20

# Create an event
python scripts/msgraph.py calendar --create "Team Standup" \
  --start "2024-03-20T09:00" --end "2024-03-20T09:30" \
  --location "Teams" --timezone "Europe/Berlin"

# Check availability for a time window
python scripts/msgraph.py calendar --availability \
  --start "2024-03-20T09:00:00" --end "2024-03-20T18:00:00"
```

### SharePoint

```bash
# List followed/joined SharePoint sites
python scripts/msgraph.py sharepoint --sites

# Browse files in a specific site (use ID from --sites output)
python scripts/msgraph.py sharepoint --site SITE_ID

# Browse a subfolder within a site
python scripts/msgraph.py sharepoint --site SITE_ID --path "Documents/Reports"

# Download a file
python scripts/msgraph.py sharepoint --download ITEM_ID --output report.xlsx
```

### Teams

```bash
# List all Teams chats
python scripts/msgraph.py teams --chats

# Read messages from a chat (use chat ID from --chats output)
python scripts/msgraph.py teams --messages CHAT_ID

# Send a message to a chat
python scripts/msgraph.py teams --send "Hello team!" --chat-id CHAT_ID

# List teams you're a member of
python scripts/msgraph.py teams --teams-list
```

### OneDrive

```bash
# List root files
python scripts/msgraph.py onedrive

# Browse a folder
python scripts/msgraph.py onedrive --path "Documents"

# Upload a file
python scripts/msgraph.py onedrive --upload ./report.pdf --dest "Documents/report.pdf"

# Download a file by ID
python scripts/msgraph.py onedrive --download ITEM_ID --output local_copy.pdf

# File metadata
python scripts/msgraph.py onedrive --info ITEM_ID
```

### People & Contacts

```bash
# Frequent collaborators (AI-ranked by Microsoft)
python scripts/msgraph.py people

# Search people by name
python scripts/msgraph.py people --search "Alice"

# Outlook address book contacts
python scripts/msgraph.py people --contacts
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

The script requires Python 3.10+ and two packages:
```bash
pip install msal requests
```

If `msal` or `requests` are not installed, the script prints the install command and exits.
IMPORTANT: you must work with current date (get it from sh/bash)
