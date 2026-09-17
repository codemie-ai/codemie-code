# Changelog

All notable changes to this project are documented in this file, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Feature tips: short "did you know" hints shown at session start and end, with no-repeat rotation and a `CODEMIE_TIPS` off switch
- `codemie tips` command to browse the full tip catalog, grouped by category
- `codemie whatsnew` command showing release notes from this changelog
- Once-per-upgrade "What's new" notice on CLI start after an update
- Tips also surface after `codemie doctor` and on the first-run, quick-start, and post-setup screens

## [0.15.1] - 2026-09-08

### Fixed

- Windows hook paths now use forward slashes so hooks resolve correctly
- Claude plugin auto-updates keep working with the pinned binary
- Gemini agent analytics tracking now records sessions correctly
- Credential storage keys are normalized to protocol+host, avoiding duplicate prompts

### Changed

- Setup no longer enforces a mandatory LiteLLM/SSO provider gate

## [0.15.0] - 2026-09-01

### Added

- New `codemie docs` surface for docs and knowledge tools, plus the OpenWiki agent
- Ollama cloud support across setup and agents
- Analytics report gained a Frameworks compare view
- `codemie proxy status` now supports API key input and `--json` output
- Proxy handling improved with noProxy rules and fallback mechanisms
- Codex assistants detect file attachments based on rollout availability
- Provider configuration is decoupled from workspace configuration
- Sessions modal in the analytics report offers session-ID and file-location copy buttons
- OpenWiki runs honor `CODEMIE_DEBUG` and stream idle timeout settings

### Fixed

- Claude now honors the profile model instead of overriding it
- Per-subagent model overrides are honored on multi-tier Claude tenants
- `codemie-claude` hooks no longer fail with command-not-found or reject the effort parameter
- Codex Desktop proxying now honors the active profile model
- Hook failures are surfaced clearly instead of failing silently
- LiteLLM setup no longer crashes on validation and no longer shows confusing SSO prompts

## [0.14.1] - 2026-08-21

### Fixed

- Claude Desktop OAuth now works even when the backend omits the issuer, by falling back to a default

## [0.14.0] - 2026-08-19

### Added

- `codemie proxy connect` unifies desktop integrations behind target flags (`--claude-desktop`, `--vscode`)
- Codex Desktop app can connect to CodeMie models through the proxy
- Claude model recommendations auto-update from the live model catalog
- Gemini CLI sessions are discovered and included in the analytics report
- Metrics sync is gated on authentication status
- Pi model list shows per-model cost rates

### Fixed

- Root base URLs are normalized to the code-assistant-api path
- Externally resumed sessions no longer pollute analytics reports
