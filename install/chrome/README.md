# EPAM AI/Run CodeMie — Chrome Extension

A Chrome (Manifest V3) side-panel extension that brings the CodeMie AI assistant into the
browser. It reads and answers questions about the page you're on (including direct HTTP(S) PDF
URLs), and — with your approval on each action by default — can click, type, and navigate to
carry out multi-step tasks for you.

**Live on the Chrome Web Store** — install from there, no manual/developer-mode steps required:

**https://chromewebstore.google.com/detail/epam-airun-codemie/fhjgonmmblodipinpnhohbdbcobgeemp**

## What it does

- Answers questions about the current page, grounded in its actual content.
- Reads direct HTTP(S) PDF URLs and answers questions about the extracted text.
- Select text on a page and ask about it, from the right-click menu or the floating **Ask
  CodeMie** button.
- Acts on the page on your behalf — clicking, typing, and multi-step flows. State-changing
  actions ask for approval by default; Auto-approve skips that prompt and should only be used on
  trusted pages for a narrowly scoped task.
- Records a sequence of actions once and replays it later.
- Attaches other open tabs as extra context for a question.
- Searches the web and connects to your own tools via MCP servers.
- Saves pages and notes locally as **Knowledge**, and can include matching snippets as context
  when you enable it.
- Syncs conversations tied to a selected assistant to your CodeMie account. Chats without an
  assistant, and temporary chats, stay local to the current browser session only.

## Install

1. Open the extension's
   [Chrome Web Store listing](https://chromewebstore.google.com/detail/epam-airun-codemie/fhjgonmmblodipinpnhohbdbcobgeemp).
2. Click **Add to Chrome**, then confirm **Add extension**.
3. Pin **EPAM AI/Run CodeMie** from the toolbar puzzle-piece menu so the icon is always visible.

Open the side panel with the toolbar icon, or the keyboard shortcut `Cmd+Shift+Y` (macOS) /
`Ctrl+Shift+Y` (Windows/Linux). If the shortcut doesn't respond, check
`chrome://extensions/shortcuts` — Chrome silently drops a shortcut if another extension already
claims it.

### First-run setup

The extension ships with no credentials pre-configured:

1. Open the side panel.
2. On the sign-in screen, enter your organization's CodeMie instance URL under **CodeMie
   address**.
3. Click **Sign in** — this opens your organization's SSO page in a new tab. Authenticate there.

Authentication is session-scoped: after Chrome restarts, or if the CodeMie session expires, sign
in again. There's no separate account or API key to manage — the extension always authenticates
through your organization's CodeMie instance.

### Updating

The Chrome Web Store keeps the extension up to date automatically. No manual steps are needed.

## Requirements

- Google Chrome 114+ (Manifest V3 `sidePanel` API). Chromium forks (Edge, Brave, etc.) are
  untested.
- A CodeMie account to sign in with.

## Documentation

Full user guide: **https://docs.codemie.ai/user-guide/chrome-extension/**
