# EPMCDME-13664 — CodeMie CLI setup SSO times out on Windows when PowerShell Start-Process is blocked by WDAC/AppLocker

**External Ticket**: https://jiraeu.epam.com/browse/EPMCDME-13664
**Status**: In Development
**Branch**: EPMCDME-13664_sso-windows-browser-fallback
**External Sync**: pending

## Summary

CodeMie CLI SSO authentication fails on Windows corporate machines when browser opening via `open` npm v10+ (which uses `powershell.exe -EncodedCommand "Start <url>"`) fails silently due to WDAC/AppLocker restrictions. No SSO URL fallback is printed, causing a 120-second timeout.

## Acceptance Criteria

- SSO URL is always printed in the terminal as a manual fallback
- On Windows, `explorer.exe` is used instead of `open()` to launch the browser
- On macOS and Linux, existing `open()` behavior is unchanged
- CodeMie setup can be completed on Windows 11 Enterprise machines with WDAC/AppLocker restrictions

## History

| When | Event |
|---|---|
| 2026-07-23 | Work item created; complexity assessed S (12/36) initial |
