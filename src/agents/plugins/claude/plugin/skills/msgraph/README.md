# Microsoft Graph API Skill for Claude Code

Work with your Microsoft 365 account from Claude Code — emails, calendar, SharePoint, Teams, OneDrive, contacts, and org chart — all via the Microsoft Graph API.

---

## Quick Start

### 1. Log in (first time only)

```bash
node ~/.codemie/claude-plugin/skills/msgraph/scripts/msgraph.js login
```

You'll see a message like:
```
============================================================
To sign in, use a web browser to open the page https://microsoft.com/devicelogin
and enter the code ABCD-1234 to authenticate.
============================================================
```

Open the URL in your browser, enter the code, and sign in with your Microsoft account.
Your token is cached at `~/.ms_graph_token_cache.json` — you won't need to log in again until it expires (tokens refresh automatically).

### 2. Ask Claude anything

After logging in, just ask Claude naturally:

- *"Show me my unread emails"*
- *"What meetings do I have this week?"*
- *"Find the Q4 report in SharePoint"*
- *"What did Alice send me in Teams?"*
- *"Who reports to me?"*

Claude will use this skill automatically.

---

## No dependencies required

The CLI uses **only built-in Node.js modules** — no `pip install`, no `npm install`.
Node.js >= 18 is the only requirement, which CodeMie already provides.

---

## CLI Reference

```
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js <command> [options]
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
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js emails --limit 20

# Read a specific email (paste the ID from list output)
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js emails --read AAMkAGI2...

# Send an email
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js emails \
  --send colleague@company.com \
  --subject "Quick question" \
  --body "Are you free tomorrow at 2pm?"

# Upcoming calendar events
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js calendar --limit 5

# Create a meeting
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js calendar \
  --create "Design Review" \
  --start "2024-03-20T14:00" \
  --end "2024-03-20T15:00" \
  --timezone "Europe/Berlin"

# List SharePoint sites you follow
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js sharepoint --sites

# Browse a site's documents
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js sharepoint \
  --site "contoso.sharepoint.com,abc123,def456" \
  --path "Documents/2024"

# Download a OneDrive file
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js onedrive --download ITEM_ID --output report.xlsx

# Upload to OneDrive
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js onedrive \
  --upload ./presentation.pptx \
  --dest "Documents/presentations/deck.pptx"

# Recent Teams chats
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js teams --chats

# Read a chat conversation
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js teams --messages 19:abc123@thread.v2

# Search your contacts
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js people --search "John"

# Your manager
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js org --manager
```

---

## Token Cache

Credentials are stored in `~/.ms_graph_token_cache.json`.
- Access tokens refresh automatically (they last ~1 hour, silently renewed via refresh token)
- Refresh tokens last ~90 days by default in Azure
- Run `logout` to remove the cache: `node msgraph.js logout`

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
| `Sites.Read.All` | SharePoint sites (read) |
| `Sites.ReadWrite.All` | SharePoint sites (read & write) |
| `Chat.Read` / `Chat.ReadWrite` | Teams chats |
| `ChannelMessage.Read.All` | Read Teams channel messages (requires admin consent) |
| `ChannelMessage.Send` | Send Teams channel messages |
| `People.Read` | People rankings |
| `Contacts.Read` | Outlook contacts |
| `offline_access` | Silent token refresh |

If your organization restricts some permissions, certain commands may return `Permission denied`.

---

## Troubleshooting

**`NOT_LOGGED_IN`**
```bash
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js login
```

**`TOKEN_EXPIRED`**
```bash
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js login
```

**`Permission denied (403)`**
Your organization may have restricted that Graph API permission. Contact your IT admin.

**`Authentication expired (401)`**
```bash
node .codemie/claude-plugin/skills/msgraph/scripts/msgraph.js login
```
