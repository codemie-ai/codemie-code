# Microsoft Graph API Skill for Claude Code

Work with your Microsoft 365 account from Claude Code — emails, calendar, SharePoint, Teams, OneDrive, contacts, and org chart — all via the Microsoft Graph API.

---

## Quick Start

### 1. Install dependencies

```bash
pip install msal requests
```

### 2. Log in (first time only)

```bash
python .codemie/claude-plugin/skills/msgraph/msgraph.py login
```

You'll see a message like:
```
==============================
To sign in, use a web browser to open the page https://microsoft.com/devicelogin
and enter the code ABCD-1234 to authenticate.
==============================
```

Open the URL in your browser, enter the code, and sign in with your Microsoft account.
Your token is cached at `~/.ms_graph_token_cache.json` — you won't need to log in again until it expires (tokens refresh automatically).

### 3. Ask Claude anything

After logging in, just ask Claude naturally:

- *"Show me my unread emails"*
- *"What meetings do I have this week?"*
- *"Find the Q4 report in SharePoint"*
- *"What did Alice send me in Teams?"*
- *"Who reports to me?"*

Claude will use this skill automatically.

---

## CLI Reference

```
python .codemie/claude-plugin/skills/msgraph/msgraph.py <command> [options]
```

### Auth commands

| Command | Description |
|---------|-------------|
| `login` | Authenticate (device code flow) |
| `logout` | Remove cached credentials |
| `status` | Check if you're logged in |

### Data commands

| Command | Key options | Description |
|---------|-------------|-------------|
| `me` | | Your profile |
| `emails` | `--limit N`, `--unread`, `--search QUERY`, `--read ID`, `--send TO --subject S --body B`, `--folder NAME` | Work with Outlook emails |
| `calendar` | `--limit N`, `--create TITLE --start DT --end DT`, `--availability` | Calendar events |
| `sharepoint` | `--sites`, `--site ID [--path P]`, `--download ID` | SharePoint files |
| `teams` | `--chats`, `--messages CHAT_ID`, `--send MSG --chat-id ID`, `--teams-list` | Teams messages |
| `onedrive` | `[--path P]`, `--upload FILE`, `--download ID`, `--info ID` | OneDrive files |
| `people` | `--search NAME`, `--contacts` | People & contacts |
| `org` | `--manager`, `--reports` | Org chart |

Add `--json` to any command for machine-readable JSON output.

---

## Examples

```bash
# List 20 most recent emails
python .codemie/claude-plugin/skills/msgraph/msgraph.py emails --limit 20

# Read a specific email (paste the ID from list output)
python .codemie/claude-plugin/skills/msgraph/msgraph.py emails --read AAMkAGI2...

# Send an email
python .codemie/claude-plugin/skills/msgraph/msgraph.py emails \
  --send colleague@company.com \
  --subject "Quick question" \
  --body "Are you free tomorrow at 2pm?"

# Upcoming calendar events
python .codemie/claude-plugin/skills/msgraph/msgraph.py calendar --limit 5

# Create a meeting
python .codemie/claude-plugin/skills/msgraph/msgraph.py calendar \
  --create "Design Review" \
  --start "2024-03-20T14:00" \
  --end "2024-03-20T15:00" \
  --timezone "Europe/Berlin"

# List SharePoint sites you follow
python .codemie/claude-plugin/skills/msgraph/msgraph.py sharepoint --sites

# Browse a site's documents
python .codemie/claude-plugin/skills/msgraph/msgraph.py sharepoint \
  --site "contoso.sharepoint.com,abc123,def456" \
  --path "Documents/2024"

# Download a OneDrive file
python .codemie/claude-plugin/skills/msgraph/msgraph.py onedrive --download ITEM_ID --output report.xlsx

# Upload to OneDrive
python .codemie/claude-plugin/skills/msgraph/msgraph.py onedrive \
  --upload ./presentation.pptx \
  --dest "Documents/presentations/deck.pptx"

# Recent Teams chats
python .codemie/claude-plugin/skills/msgraph/msgraph.py teams --chats

# Read a chat conversation
python .codemie/claude-plugin/skills/msgraph/msgraph.py teams --messages 19:abc123@thread.v2

# Search your contacts
python .codemie/claude-plugin/skills/msgraph/msgraph.py people --search "John"

# Your manager
python .codemie/claude-plugin/skills/msgraph/msgraph.py org --manager
```

---

## Token Cache

Credentials are stored in `~/.ms_graph_token_cache.json`.
- Access tokens refresh automatically (they last ~1 hour, but MSAL handles renewal)
- Refresh tokens last longer (~90 days by default in Azure)
- Run `logout` to remove the cache: `python msgraph.py logout`

---

## Permissions

The script requests these Microsoft Graph scopes on first login:

| Scope | Used for |
|-------|---------|
| `User.Read` | Profile (`me`, `org`) |
| `Mail.Read` | Reading emails |
| `Mail.Send` | Sending emails |
| `Calendars.Read` / `Calendars.ReadWrite` | Calendar events |
| `Files.Read` / `Files.ReadWrite` | OneDrive files |
| `Sites.Read.All` | SharePoint sites |
| `Chat.Read` / `Chat.ReadWrite` | Teams chats |
| `People.Read` | People rankings |
| `Contacts.Read` | Outlook contacts |

If your organization restricts some permissions, certain commands may return `Permission denied`.

---

## Troubleshooting

**`ModuleNotFoundError: No module named 'msal'`**
```bash
pip install msal requests
```

**`NOT_LOGGED_IN`**
```bash
python .codemie/claude-plugin/skills/msgraph/msgraph.py login
```

**`Permission denied (403)`**
Your organization may have restricted that Graph API permission. Contact your IT admin.

**`Authentication expired (401)`**
```bash
python .codemie/claude-plugin/skills/msgraph/msgraph.py login
```

**Token cache is at wrong path**
Edit `CACHE_FILE` at the top of `msgraph.py` to change the location.
