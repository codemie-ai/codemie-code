#!/usr/bin/env python3
"""
msgraph.py — Microsoft Graph API CLI for Claude Code skill

Authentication: MSAL device code flow with persistent token cache.
First time: python msgraph.py login
Subsequent: token refreshed silently from cache.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from msal import PublicClientApplication, SerializableTokenCache
    import requests
except ImportError:
    print("Missing dependencies. Install with:")
    print("  pip install msal requests")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────────────────
CLIENT_ID  = "14d82eec-204b-4c2f-b7e8-296a70dab67e"   # MS GraphAPI public client
AUTHORITY  = "https://login.microsoftonline.com/common"
SCOPES     = [
    "User.Read",
    "Mail.Read",
    "Mail.Send",
    "Calendars.Read",
    "Calendars.ReadWrite",
    "Files.Read",
    "Files.ReadWrite",
    "Sites.Read.All",
    "Chat.Read",
    "Chat.ReadWrite",
    "People.Read",
    "Contacts.Read",
]
CACHE_FILE = Path.home() / ".ms_graph_token_cache.json"
GRAPH_BASE = "https://graph.microsoft.com/v1.0"

# ── Token Cache ───────────────────────────────────────────────────────────────
def load_cache() -> SerializableTokenCache:
    cache = SerializableTokenCache()
    if CACHE_FILE.exists():
        cache.deserialize(CACHE_FILE.read_text())
    return cache

def save_cache(cache: SerializableTokenCache):
    if cache.has_state_changed:
        CACHE_FILE.write_text(cache.serialize())

# ── Authentication ────────────────────────────────────────────────────────────
def get_access_token(force_login: bool = False) -> str:
    cache = load_cache()
    app = PublicClientApplication(
        client_id=CLIENT_ID,
        authority=AUTHORITY,
        token_cache=cache
    )

    if not force_login:
        accounts = app.get_accounts()
        if accounts:
            result = app.acquire_token_silent(SCOPES, account=accounts[0])
            if result and "access_token" in result:
                save_cache(cache)
                return result["access_token"]

    # Device Code Flow
    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise RuntimeError(f"Failed to initiate device flow: {flow.get('error_description')}")

    print("\n" + "=" * 60)
    print(flow["message"])
    print("=" * 60 + "\n")

    result = app.acquire_token_by_device_flow(flow)
    if "access_token" not in result:
        raise RuntimeError(f"Authentication failed: {result.get('error_description')}")

    save_cache(cache)
    return result["access_token"]

def get_token_or_exit() -> str:
    """Get token from cache only — exit with helpful message if not logged in or token expired."""
    cache = load_cache()
    app = PublicClientApplication(
        client_id=CLIENT_ID,
        authority=AUTHORITY,
        token_cache=cache
    )
    accounts = app.get_accounts()
    if not accounts:
        print("NOT_LOGGED_IN")
        sys.exit(2)
    result = app.acquire_token_silent(SCOPES, account=accounts[0])
    if not result or "access_token" not in result:
        print("TOKEN_EXPIRED")
        sys.exit(2)
    save_cache(cache)
    return result["access_token"]

# ── Graph API Helpers ─────────────────────────────────────────────────────────
def graph_get(endpoint: str, token: str, params: dict | None = None) -> dict:
    r = requests.get(
        f"{GRAPH_BASE}{endpoint}",
        headers={"Authorization": f"Bearer {token}"},
        params=params or {}
    )
    r.raise_for_status()
    return r.json()

def graph_post(endpoint: str, token: str, body: dict) -> dict:
    r = requests.post(
        f"{GRAPH_BASE}{endpoint}",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        },
        json=body
    )
    r.raise_for_status()
    return r.json() if r.content else {}

def graph_download(endpoint: str, token: str) -> bytes:
    r = requests.get(
        f"{GRAPH_BASE}{endpoint}",
        headers={"Authorization": f"Bearer {token}"},
        allow_redirects=True
    )
    r.raise_for_status()
    return r.content

def graph_upload(endpoint: str, token: str, content: bytes, content_type: str = "application/octet-stream") -> dict:
    r = requests.put(
        f"{GRAPH_BASE}{endpoint}",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": content_type
        },
        data=content
    )
    r.raise_for_status()
    return r.json()

# ── Formatters ────────────────────────────────────────────────────────────────
def fmt_dt(iso: str) -> str:
    """Format ISO datetime to readable string."""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return iso[:16].replace("T", " ")

def fmt_size(size: int) -> str:
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"

def print_json(data: dict | list):
    print(json.dumps(data, indent=2, ensure_ascii=False))

# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_login(args):
    """Authenticate and cache credentials."""
    print("Starting Microsoft authentication...")
    token = get_access_token(force_login=True)
    me = graph_get("/me", token)
    print(f"\nLogged in as: {me['displayName']} <{me['userPrincipalName']}>")
    print(f"User ID: {me['id']}")
    print(f"Token cached at: {CACHE_FILE}")

def cmd_logout(args):
    """Remove cached credentials."""
    if CACHE_FILE.exists():
        CACHE_FILE.unlink()
        print(f"Logged out. Cache removed: {CACHE_FILE}")
    else:
        print("No cached credentials found.")

def cmd_status(args):
    """Check login status."""
    cache = load_cache()
    app = PublicClientApplication(client_id=CLIENT_ID, authority=AUTHORITY, token_cache=cache)
    accounts = app.get_accounts()
    if not accounts:
        print("NOT_LOGGED_IN")
        print(f"\nTo login, run:\n  python {Path(__file__).name} login")
        return
    # Verify token can actually be acquired (not just that account exists in cache)
    result = app.acquire_token_silent(SCOPES, account=accounts[0])
    if result and "access_token" in result:
        save_cache(cache)
        print(f"Logged in as: {accounts[0]['username']}")
        print(f"Cache file: {CACHE_FILE}")
    else:
        print("TOKEN_EXPIRED")
        print(f"Account: {accounts[0]['username']}")
        print(f"\nSession expired. Re-authenticate with:\n  python {Path(__file__).name} login")

def cmd_me(args):
    """Show user profile information."""
    token = get_token_or_exit()
    me = graph_get("/me", token)
    fields = ["displayName", "userPrincipalName", "id", "mail", "jobTitle",
              "department", "officeLocation", "businessPhones", "mobilePhone"]
    if args.json:
        print_json({k: me.get(k) for k in fields if me.get(k)})
        return
    print(f"Name       : {me.get('displayName', 'N/A')}")
    print(f"Email      : {me.get('userPrincipalName', 'N/A')}")
    print(f"Job Title  : {me.get('jobTitle', 'N/A')}")
    print(f"Department : {me.get('department', 'N/A')}")
    print(f"Office     : {me.get('officeLocation', 'N/A')}")
    print(f"Phone      : {me.get('businessPhones', ['N/A'])[0] if me.get('businessPhones') else 'N/A'}")
    print(f"User ID    : {me.get('id', 'N/A')}")

def cmd_emails(args):
    """List, read, send or search emails."""
    token = get_token_or_exit()

    if args.send:
        # Send email: --send "To <email>" --subject "Subject" --body "Body"
        to_email = args.send
        body_content = args.body or ""
        subject = args.subject or "(no subject)"
        payload = {
            "message": {
                "subject": subject,
                "body": {"contentType": "Text", "content": body_content},
                "toRecipients": [{"emailAddress": {"address": to_email}}]
            }
        }
        graph_post("/me/sendMail", token, payload)
        print(f"Email sent to {to_email}")
        return

    if args.read:
        # Read a specific email by ID
        msg = graph_get(f"/me/messages/{args.read}", token)
        print(f"Subject  : {msg.get('subject')}")
        print(f"From     : {msg['from']['emailAddress']['name']} <{msg['from']['emailAddress']['address']}>")
        print(f"Date     : {fmt_dt(msg['receivedDateTime'])}")
        print(f"Read     : {'Yes' if msg['isRead'] else 'No'}")
        print(f"\n{'─'*60}")
        body = msg.get("body", {})
        if body.get("contentType") == "text":
            print(body.get("content", ""))
        else:
            # Strip basic HTML tags for readability
            import re
            text = re.sub(r'<[^>]+>', '', body.get("content", ""))
            print(text[:2000])
        return

    # List/search emails
    params: dict = {
        "$top": args.limit,
        "$select": "id,subject,from,receivedDateTime,isRead,hasAttachments,importance",
        "$orderby": "receivedDateTime desc"
    }
    if args.search:
        params["$search"] = f'"{args.search}"'
        params.pop("$orderby", None)  # $search incompatible with $orderby
    if args.folder:
        endpoint = f"/me/mailFolders/{args.folder}/messages"
    elif args.unread:
        params["$filter"] = "isRead eq false"
        endpoint = "/me/messages"
    else:
        endpoint = "/me/messages"

    data = graph_get(endpoint, token, params)
    emails = data.get("value", [])

    if args.json:
        print_json(emails)
        return

    if not emails:
        print("No emails found.")
        return

    print(f"\n{'ID':<36}  {'Date':<16}  {'Rd'}  {'Subject'}")
    print("─" * 80)
    for e in emails:
        read_mark = "✓" if e["isRead"] else "●"
        attach = "📎" if e.get("hasAttachments") else "  "
        subject = e.get("subject", "(no subject)")[:45]
        sender = e["from"]["emailAddress"].get("name", "")[:20]
        date = fmt_dt(e["receivedDateTime"])
        print(f"{e['id'][:36]}  {date}  {read_mark}   {attach} {subject}  ({sender})")

def cmd_calendar(args):
    """List or create calendar events."""
    token = get_token_or_exit()

    if args.create:
        # Create event: --create "Title" --start "2024-03-15T10:00" --end "2024-03-15T11:00"
        if not args.start or not args.end:
            print("Error: --create requires --start and --end (format: YYYY-MM-DDTHH:MM)")
            sys.exit(1)
        tz = args.timezone or "UTC"
        payload = {
            "subject": args.create,
            "start": {"dateTime": args.start, "timeZone": tz},
            "end": {"dateTime": args.end, "timeZone": tz},
        }
        if args.location:
            payload["location"] = {"displayName": args.location}
        if args.body:
            payload["body"] = {"contentType": "Text", "content": args.body}
        event = graph_post("/me/events", token, payload)
        print(f"Event created: {event.get('subject')}")
        print(f"ID: {event.get('id')}")
        return

    if args.availability:
        # Check free/busy for a time range
        start = args.start or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        end   = args.end   or datetime.now(timezone.utc).replace(hour=23, minute=59).strftime("%Y-%m-%dT%H:%M:%S")
        view = graph_get(
            "/me/calendarView",
            token,
            {"startDateTime": start, "endDateTime": end,
             "$select": "subject,start,end,showAs", "$orderby": "start/dateTime"}
        )
        events = view.get("value", [])
        if not events:
            print(f"You're free between {start[:16]} and {end[:16]}.")
        else:
            print(f"\nBusy slots ({len(events)} events):")
            for e in events:
                print(f"  {fmt_dt(e['start']['dateTime'])} — {fmt_dt(e['end']['dateTime'])}: {e.get('subject', '(no title)')}")
        return

    # List upcoming events
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    data = graph_get(
        "/me/calendarView",
        token,
        {
            "startDateTime": now,
            "endDateTime": f"{datetime.now(timezone.utc).year + 1}-01-01T00:00:00Z",
            "$top": args.limit,
            "$select": "id,subject,start,end,location,organizer,isOnlineMeeting,onlineMeetingUrl",
            "$orderby": "start/dateTime"
        }
    )
    events = data.get("value", [])

    if args.json:
        print_json(events)
        return

    if not events:
        print("No upcoming events.")
        return

    print(f"\n{'Date & Time':<20}  {'Duration':<10}  {'Title'}")
    print("─" * 80)
    for e in events:
        start = fmt_dt(e["start"]["dateTime"])
        title = e.get("subject", "(no title)")[:45]
        organizer = e["organizer"]["emailAddress"].get("name", "")[:20]
        online = "🎥" if e.get("isOnlineMeeting") else "  "
        loc = e.get("location", {}).get("displayName", "")[:20]
        print(f"{start:<20}  {online}  {title}  ({organizer})" + (f"  @ {loc}" if loc else ""))

def cmd_sharepoint(args):
    """Browse SharePoint sites and files."""
    token = get_token_or_exit()

    if args.sites:
        # List all joined sites
        data = graph_get("/me/followedSites", token, {"$select": "id,displayName,webUrl"})
        sites = data.get("value", [])
        if not sites:
            # Fallback: search for sites
            data = graph_get("/sites", token, {"search": "*", "$top": args.limit})
            sites = data.get("value", [])
        if args.json:
            print_json(sites)
            return
        print(f"\n{'ID':<50}  {'Name'}")
        print("─" * 80)
        for s in sites[:args.limit]:
            print(f"{s['id']:<50}  {s.get('displayName', 'N/A')}")
            print(f"  URL: {s.get('webUrl', 'N/A')}")
        return

    if args.site:
        # Browse files in a site's drive
        site_id = args.site
        path = args.path or "root"
        endpoint = f"/sites/{site_id}/drive/root/children" if path == "root" else f"/sites/{site_id}/drive/root:/{path}:/children"
        data = graph_get(endpoint, token, {"$top": args.limit, "$select": "id,name,size,lastModifiedDateTime,file,folder"})
        items = data.get("value", [])
        if args.json:
            print_json(items)
            return
        print(f"\nFiles in site {site_id} / {path}:")
        print("─" * 60)
        for item in items:
            kind = "📁" if "folder" in item else "📄"
            size = fmt_size(item.get("size", 0)) if "file" in item else ""
            modified = fmt_dt(item.get("lastModifiedDateTime", ""))
            print(f"  {kind} {item['name']:<40} {size:<10} {modified}")
        return

    if args.download:
        # Download a file by item ID from personal drive (use --site for SharePoint)
        content = graph_download(f"/me/drive/items/{args.download}/content", token)
        out_path = Path(args.output or f"downloaded_{args.download[:8]}")
        out_path.write_bytes(content)
        print(f"Downloaded {len(content)} bytes to {out_path}")
        return

    print("SharePoint commands: --sites | --site SITE_ID [--path PATH] | --download ITEM_ID")

def cmd_teams(args):
    """List Teams chats and messages."""
    token = get_token_or_exit()

    if args.chats:
        # List all chats
        data = graph_get("/me/chats", token, {
            "$top": args.limit,
            "$select": "id,topic,chatType,lastUpdatedDateTime"
        })
        chats = data.get("value", [])
        if args.json:
            print_json(chats)
            return
        print(f"\n{'Chat ID':<50}  {'Type':<10}  {'Topic'}")
        print("─" * 80)
        for c in chats:
            topic = c.get("topic") or "(direct message)"
            print(f"{c['id']:<50}  {c.get('chatType',''):<10}  {topic}")
        return

    if args.messages:
        # Get messages in a chat
        data = graph_get(f"/me/chats/{args.messages}/messages", token, {
            "$top": args.limit,
            "$select": "id,from,body,createdDateTime"
        })
        msgs = data.get("value", [])
        if args.json:
            print_json(msgs)
            return
        print(f"\nMessages in chat {args.messages[:20]}...:")
        print("─" * 60)
        for m in reversed(msgs):
            sender = m.get("from", {}).get("user", {}).get("displayName", "Unknown") if m.get("from") else "System"
            time = fmt_dt(m.get("createdDateTime", ""))
            import re
            body = re.sub(r'<[^>]+>', '', m.get("body", {}).get("content", ""))[:200]
            print(f"[{time}] {sender}: {body}")
        return

    if args.send and args.chat_id:
        # Send message to a chat
        payload = {"body": {"content": args.send}}
        result = graph_post(f"/me/chats/{args.chat_id}/messages", token, payload)
        print(f"Message sent. ID: {result.get('id')}")
        return

    if args.teams_list:
        # List joined teams
        data = graph_get("/me/joinedTeams", token, {"$select": "id,displayName,description"})
        teams = data.get("value", [])
        if args.json:
            print_json(teams)
            return
        for t in teams:
            print(f"{t['id'][:36]}  {t['displayName']}")
        return

    print("Teams commands: --chats | --messages CHAT_ID | --send MSG --chat-id CHAT_ID | --teams-list")

def cmd_onedrive(args):
    """Browse, upload and download OneDrive files."""
    token = get_token_or_exit()

    if args.upload:
        src = Path(args.upload)
        if not src.exists():
            print(f"File not found: {src}")
            sys.exit(1)
        dest_path = args.dest or src.name
        content = src.read_bytes()
        result = graph_upload(f"/me/drive/root:/{dest_path}:/content", token, content)
        print(f"Uploaded: {result.get('name')} ({fmt_size(result.get('size', 0))})")
        print(f"ID: {result.get('id')}")
        return

    if args.download:
        content = graph_download(f"/me/drive/items/{args.download}/content", token)
        out_path = Path(args.output or f"download_{args.download[:8]}")
        out_path.write_bytes(content)
        print(f"Downloaded {fmt_size(len(content))} to {out_path}")
        return

    if args.info:
        item = graph_get(f"/me/drive/items/{args.info}", token)
        if args.json:
            print_json(item)
            return
        print(f"Name    : {item.get('name')}")
        print(f"Size    : {fmt_size(item.get('size', 0))}")
        print(f"Modified: {fmt_dt(item.get('lastModifiedDateTime', ''))}")
        print(f"URL     : {item.get('webUrl', 'N/A')}")
        return

    # List files in a path
    path = args.path or ""
    endpoint = "/me/drive/root/children" if not path else f"/me/drive/root:/{path}:/children"
    data = graph_get(endpoint, token, {
        "$top": args.limit,
        "$select": "id,name,size,lastModifiedDateTime,file,folder",
        "$orderby": "name"
    })
    items = data.get("value", [])

    if args.json:
        print_json(items)
        return

    if not items:
        print(f"No files found in /{path or ''}")
        return

    print(f"\nOneDrive: /{path or ''}")
    print("─" * 60)
    for item in items:
        kind = "📁" if "folder" in item else "📄"
        size = fmt_size(item.get("size", 0)) if "file" in item else ""
        modified = fmt_dt(item.get("lastModifiedDateTime", ""))
        count = f"  ({item['folder']['childCount']} items)" if "folder" in item else ""
        print(f"  {kind} {item['id'][:16]}  {item['name']:<40} {size:<10} {modified}{count}")

def cmd_people(args):
    """List relevant people and contacts."""
    token = get_token_or_exit()

    if args.contacts:
        # Outlook contacts
        params = {"$top": args.limit, "$select": "displayName,emailAddresses,mobilePhone,jobTitle,companyName"}
        if args.search:
            params["$search"] = f'"{args.search}"'
        data = graph_get("/me/contacts", token, params)
        contacts = data.get("value", [])
        if args.json:
            print_json(contacts)
            return
        print(f"\n{'Name':<30}  {'Email':<35}  {'Title'}")
        print("─" * 80)
        for c in contacts:
            emails = [e["address"] for e in c.get("emailAddresses", [])]
            email = emails[0] if emails else "N/A"
            print(f"{c.get('displayName',''):<30}  {email:<35}  {c.get('jobTitle','')}")
        return

    # Relevant people (AI-ranked by interaction)
    params = {"$top": args.limit}
    if args.search:
        params["$search"] = f'"{args.search}"'
    data = graph_get("/me/people", token, params)
    people = data.get("value", [])

    if args.json:
        print_json(people)
        return

    if not people:
        print("No people found.")
        return

    print(f"\n{'Name':<30}  {'Email':<35}  {'Title'}")
    print("─" * 80)
    for p in people:
        emails = [s["address"] for s in p.get("scoredEmailAddresses", [])]
        email = emails[0] if emails else "N/A"
        print(f"{p.get('displayName',''):<30}  {email:<35}  {p.get('jobTitle','')}")

def cmd_org(args):
    """Show organizational info: manager, reports, colleagues."""
    token = get_token_or_exit()

    if args.manager:
        try:
            mgr = graph_get("/me/manager", token)
            print(f"Manager: {mgr.get('displayName')} <{mgr.get('userPrincipalName')}>")
            print(f"Title  : {mgr.get('jobTitle', 'N/A')}")
        except requests.HTTPError as e:
            if e.response.status_code == 404:
                print("No manager found (you may be at the top of the org).")
            else:
                raise
        return

    if args.reports:
        data = graph_get("/me/directReports", token,
                         {"$select": "displayName,userPrincipalName,jobTitle"})
        reports = data.get("value", [])
        print(f"\nDirect Reports ({len(reports)}):")
        for r in reports:
            print(f"  {r.get('displayName'):<30}  {r.get('userPrincipalName')}")
        return

    # Default: show org context
    try:
        mgr = graph_get("/me/manager", token)
        print(f"Manager: {mgr.get('displayName')}")
    except Exception:
        pass
    reports = graph_get("/me/directReports", token, {"$select": "displayName"}).get("value", [])
    print(f"Direct Reports: {len(reports)}")
    colleagues = graph_get("/me/people", token, {"$top": 5}).get("value", [])
    print(f"\nFrequent colleagues:")
    for p in colleagues:
        print(f"  {p.get('displayName')}")

# ── CLI Setup ─────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Microsoft Graph API CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python msgraph.py login                          # Authenticate
  python msgraph.py status                         # Check login status
  python msgraph.py me                             # Show profile
  python msgraph.py emails --limit 10              # List 10 emails
  python msgraph.py emails --unread                # Unread emails
  python msgraph.py emails --search "invoice"      # Search emails
  python msgraph.py emails --read MSG_ID           # Read specific email
  python msgraph.py emails --send "a@b.com" --subject "Hi" --body "Hello"
  python msgraph.py calendar --limit 10            # Upcoming events
  python msgraph.py calendar --create "Meeting" --start 2024-03-15T10:00 --end 2024-03-15T11:00
  python msgraph.py sharepoint --sites             # List SharePoint sites
  python msgraph.py teams --chats                  # List Teams chats
  python msgraph.py teams --messages CHAT_ID       # Read chat messages
  python msgraph.py onedrive                       # List OneDrive root
  python msgraph.py onedrive --path "Documents"    # Browse folder
  python msgraph.py onedrive --upload file.txt     # Upload file
  python msgraph.py people                         # Frequent contacts
  python msgraph.py org --manager                  # Show your manager
"""
    )

    # Global flags
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    subparsers = parser.add_subparsers(dest="command")

    # login
    subparsers.add_parser("login", help="Authenticate with Microsoft")

    # logout
    subparsers.add_parser("logout", help="Remove cached credentials")

    # status
    subparsers.add_parser("status", help="Check login status")

    # me
    p_me = subparsers.add_parser("me", help="Show user profile")
    p_me.add_argument("--json", action="store_true")

    # emails
    p_email = subparsers.add_parser("emails", help="Work with emails")
    p_email.add_argument("--limit", type=int, default=10, help="Number of emails to show")
    p_email.add_argument("--search", help="Search query")
    p_email.add_argument("--unread", action="store_true", help="Show only unread emails")
    p_email.add_argument("--folder", help="Mail folder (inbox, sentitems, drafts, etc.)")
    p_email.add_argument("--read", metavar="ID", help="Read email by ID")
    p_email.add_argument("--send", metavar="TO", help="Send email to address")
    p_email.add_argument("--subject", help="Email subject (for --send)")
    p_email.add_argument("--body", help="Email body text")
    p_email.add_argument("--json", action="store_true")

    # calendar
    p_cal = subparsers.add_parser("calendar", help="Work with calendar")
    p_cal.add_argument("--limit", type=int, default=10)
    p_cal.add_argument("--create", metavar="TITLE", help="Create event with this title")
    p_cal.add_argument("--start", help="Start datetime (YYYY-MM-DDTHH:MM)")
    p_cal.add_argument("--end", help="End datetime (YYYY-MM-DDTHH:MM)")
    p_cal.add_argument("--location", help="Event location")
    p_cal.add_argument("--body", help="Event description")
    p_cal.add_argument("--timezone", default="UTC", help="Timezone (e.g. Europe/Berlin)")
    p_cal.add_argument("--availability", action="store_true", help="Check free/busy")
    p_cal.add_argument("--json", action="store_true")

    # sharepoint
    p_sp = subparsers.add_parser("sharepoint", help="Browse SharePoint")
    p_sp.add_argument("--sites", action="store_true", help="List followed sites")
    p_sp.add_argument("--site", metavar="SITE_ID", help="Browse files in site")
    p_sp.add_argument("--path", help="Path within site drive")
    p_sp.add_argument("--download", metavar="ITEM_ID", help="Download file by ID")
    p_sp.add_argument("--output", help="Output file path")
    p_sp.add_argument("--limit", type=int, default=20)
    p_sp.add_argument("--json", action="store_true")

    # teams
    p_teams = subparsers.add_parser("teams", help="Work with Teams")
    p_teams.add_argument("--chats", action="store_true", help="List all chats")
    p_teams.add_argument("--messages", metavar="CHAT_ID", help="Get messages from chat")
    p_teams.add_argument("--send", metavar="TEXT", help="Send a message")
    p_teams.add_argument("--chat-id", dest="chat_id", help="Target chat ID for --send")
    p_teams.add_argument("--teams-list", action="store_true", help="List joined teams")
    p_teams.add_argument("--limit", type=int, default=20)
    p_teams.add_argument("--json", action="store_true")

    # onedrive
    p_od = subparsers.add_parser("onedrive", help="Work with OneDrive")
    p_od.add_argument("--path", help="Folder path to browse")
    p_od.add_argument("--upload", metavar="FILE", help="Upload a local file")
    p_od.add_argument("--dest", help="Destination path in OneDrive (for --upload)")
    p_od.add_argument("--download", metavar="ITEM_ID", help="Download by item ID")
    p_od.add_argument("--output", help="Output file path")
    p_od.add_argument("--info", metavar="ITEM_ID", help="Get file metadata")
    p_od.add_argument("--limit", type=int, default=20)
    p_od.add_argument("--json", action="store_true")

    # people
    p_ppl = subparsers.add_parser("people", help="Browse people and contacts")
    p_ppl.add_argument("--contacts", action="store_true", help="Use Outlook contacts (not people)")
    p_ppl.add_argument("--search", help="Search by name")
    p_ppl.add_argument("--limit", type=int, default=20)
    p_ppl.add_argument("--json", action="store_true")

    # org
    p_org = subparsers.add_parser("org", help="Organizational info")
    p_org.add_argument("--manager", action="store_true", help="Show your manager")
    p_org.add_argument("--reports", action="store_true", help="Show direct reports")
    p_org.add_argument("--json", action="store_true")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    command_map = {
        "login":      cmd_login,
        "logout":     cmd_logout,
        "status":     cmd_status,
        "me":         cmd_me,
        "emails":     cmd_emails,
        "calendar":   cmd_calendar,
        "sharepoint": cmd_sharepoint,
        "teams":      cmd_teams,
        "onedrive":   cmd_onedrive,
        "people":     cmd_people,
        "org":        cmd_org,
    }

    try:
        command_map[args.command](args)
    except requests.HTTPError as e:
        status = e.response.status_code
        if status == 401:
            print("Error: Authentication expired. Run: python msgraph.py login")
        elif status == 403:
            print(f"Error: Permission denied for this operation ({e.response.url})")
            print("You may need additional OAuth scopes.")
        elif status == 404:
            print(f"Error: Resource not found ({e.response.url})")
        else:
            print(f"HTTP Error {status}: {e.response.text[:200]}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(0)

if __name__ == "__main__":
    main()
