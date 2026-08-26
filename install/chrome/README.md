# EPAM AI/Run CodeMie — Chrome Extension

A Chrome (Manifest V3) side-panel extension that brings the CodeMie AI assistant into the
browser — chat with CodeMie, extract page content, and drive DOM automation on the page you're
viewing.

> **Status: not yet on the Chrome Web Store.** The listing is pending Google's review. Until it's
> approved, install the packaged build below manually ("sideloading"). No code changes are needed
> to switch to the store listing later — you'll just remove the manual install and install from
> the store instead.

## What's in this folder

| File | Version |
|---|---|
| `epam-airun-codemie-0.3.3.zip` | 0.3.3 |

This is the same package built for Chrome Web Store submission — `manifest.json` sits at the
archive root, ready to load unpacked or upload as-is.

## Install (manual, pending store review)

1. **Download and unzip** `epam-airun-codemie-0.3.3.zip` to a folder you'll keep around (Chrome
   loads the extension from this folder every time it starts — don't delete it after installing).
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top-right corner).
4. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`
   directly, not a parent folder).
5. Pin **EPAM AI/Run CodeMie** from the toolbar puzzle-piece menu so the icon is always visible.

Open the side panel with the toolbar icon, or the keyboard shortcut `Cmd+Shift+Y` (macOS) /
`Ctrl+Shift+Y` (Windows/Linux). Close it with `Cmd/Ctrl+Shift+U`. If the shortcut doesn't respond,
check `chrome://extensions/shortcuts` — Chrome silently drops a shortcut if another extension
already claims it.

### First-run setup

The extension ships with no credentials pre-configured:

1. Open the extension's **Options** page (right-click the toolbar icon → **Options**, or the gear
   icon inside the panel).
2. Set your **CodeMie base URL**.
3. Sign in via SSO.

### Updating

Chrome doesn't auto-update sideloaded extensions. To pick up a new version, download the new zip,
unzip it over the same folder (or a new one), and click **Reload** (⟳) on the extension's card in
`chrome://extensions`. Reload — don't remove and re-add — or you'll lose your saved settings and
session and have to sign in again.

## Requirements

- Google Chrome 114+ (Manifest V3 `sidePanel` API). Chromium forks (Edge, Brave, etc.) are
  untested.
- A CodeMie account to sign in with.

## Documentation

Full user guide: **https://docs.codemie.ai/user-guide/chrome-extension/**
