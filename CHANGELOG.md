# Changelog

All notable changes to this project are documented in this file, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Codemie hooks run under PowerShell on Windows, and stale hook paths are healed automatically
- Secrets are masked in forwarded OTLP hook events

## [0.16.2] - 2026-10-28

### Added

- Claude 5.5 models in the Claude Desktop and VS Code proxy connectors
- `codemie proxy connect` confirms Claude Code analytics before connecting
- Copilot Chat and native Copilot CLI analytics via OTLP hook ingestion

## [0.16.1] - 2026-10-27

### Added

- GitHub Copilot CLI local session analytics
- `--redact` analytics export option that omits prompts and absolute paths
- Richer hook events and new synthetic analytics events

### Fixed

- claude-haiku-5-5 and gemini-4-argon are priced from the gateway catalog
- X-CodeMie attribution headers are percent-encoded for non-Latin paths
- API-error placeholders are excluded from usage analytics
- Session reports no longer run out of memory during native session discovery
- Proxy cold start is skipped silently when no base URL is configured
- Write line counts are no longer inflated by a trailing newline, and new-file writes are counted
- OTLP hook path tolerates proxy start failures
- Forked skills keep their name on SubagentStart/SubagentStop events
- Partial output token counts are flagged in analytics

### Changed

- Removed unused dependencies (@langchain/langgraph, express, cors, minimatch, @clack)

## [0.16.0] - 2026-10-22

### Added

- Feature tips: short "did you know" hints shown at session start and end, with no-repeat rotation and a `CODEMIE_TIPS` off switch
- Tips also surface after `codemie doctor` and on the first-run, quick-start, and post-setup screens
- `codemie tips` command to browse the full tip catalog, grouped by category
- `codemie whatsnew` command showing release notes from this changelog
- Once-per-upgrade "What's new" notice on CLI start after an update
- Claude Code OTLP analytics integration, with a per-project allowlist
- codex-acp, gemini-acp and opencode-acp ACP adapters
- GPT-6 family model support
- Session project is sent as X-CodeMie-Project on analytics requests
- VS Code models use tenant catalog token limits
- Headless registration for assistants and skills
- `codemie mcp remove` and `codemie mcp list` subcommands
- Live Ollama model search with recommendations

### Fixed

- CLI no longer crashes with EPIPE when its output pipe closes early (e.g. `codemie | head -1`)
- SSO session expiry handling and zero-cost analytics misattribution
- Analytics delivery resumes after SSO re-authentication, and prompts are blocked immediately when the SSO session is invalid
- Windows system proxy and PAC settings are honored
- Windows Codex desktop MSIX installations are detected
- Multi-segment and dotted git remote repository names resolve correctly
- Conversation sync no longer re-sends in a loop

### Changed

- Analytics export is always costed and uses strict model pricing
- Server-side auto mode review is disabled for the ai-run-sso provider

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
