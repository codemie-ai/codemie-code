# Changelog

All notable changes to this project are documented in this file, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `codemie analytics` now includes oh-my-pi sub-agent spend and auxiliary model usage in omp token and cost totals, reports omp file changes, net lines and languages, shows omp skill/agent dispatches on the Timeline with per-agent cost and a root/unlinked allocation, recognizes more framework bundles (SecOps, Matt Pocock Skills, Caveman, Ponytail, CodeMie Skills, Herdr and the full CodeMie AI Factory set), and shows omp Commands as "not recorded"
- `codemie proxy connect --omp` gives oh-my-pi the active profile's live model catalog (cost, context window, output cap, image input) via an auto-loaded extension; `codemie proxy disconnect --omp` removes it; it cannot be combined with `--vscode`

### Fixed

- `codemie analytics --include-external` now finds oh-my-pi sessions in `~/.omp/agent/sessions`, including transcripts that begin with oh-my-pi's title record, and reports them as their own `omp` agent ("Oh My Pi") instead of folding them into Pi; filter with `--agent omp`. Plugin skills are named after their plugin (`sdlc-factory/mr-creator`), so the Frameworks view attributes those sessions to CodeMie AI Factory or Superpowers instead of "Pure chat"
- The analytics report and terminal output label every agent by its product name (Claude Code, CodeMie Code, CodeMie Codex, …) instead of mixing raw keys such as `claude` with names such as "GitHub Copilot CLI"; chart legends use the same labels
- Native (untracked) Pi and oh-my-pi sessions now report tool calls, skills and sub-agents; oh-my-pi `/skill:` prompts, `skill://` loads and `task` dispatches are recognized, and `sdlc-factory/…`, `sdlc-standard`, `sdlc-doctor` and `sdlc-status` mark a session as CodeMie AI Factory
- Encrypted reasoning-content recovery now also covers `codemie proxy start` and `codemie proxy connect --omp` daemons

## [0.16.6] - 2026-11-05

### Added

- The Claude plugin ships codemie-html-report 0.3 and codemie-humanizer 2.0

### Fixed

- Date-only `--from` / `--to` analytics filters use UTC day bounds
- `--json` invocations keep start-up output off stdout
- A run's analytics metrics and conversation are scoped to its own sessions and run window
- Hooks restart the proxy daemon on the recorded profile
- SSO re-authentication no longer opens the browser twice
- The OTLP endpoint stays valid across proxy daemon respawns, and the pinned port is held while SSO credentials are missing

## [0.16.5] - 2026-11-04

### Added

- Claude subscription type is classified, and CLI analytics are routed by evidence

### Fixed

- Each global profile now keeps its own CodeMie project, URL and integration
- Managed and native sessions select the same CodeMie project
- Claude analytics work again for oauth2-proxy SSO logins
- Claude Desktop sessions survive proxy daemon restarts and failed deliveries
- Metric deltas are deduplicated within a shared run window, and the sync rewrite is merged instead of overwritten
- Hook SSO auth checks use the session's profile
- Forked skills and slash commands are recognised in analytics
- Stranded sessions are finalized and undelivered ones are delivered

## [0.16.4] - 2026-11-02

### Added

- Claude Code analytics can be disabled globally or per project

### Fixed

- Git branch is now detected in repositories that have no commits yet
- UUID fragments and model tokens are no longer mistaken for story mentions in analytics
- Claude runs are baselined per record, and Codex calls are counted once their output appears
- Native `-s` flags are preserved for Codex and Gemini
- On shutdown only the agent is signalled, so its SessionEnd hook is no longer killed

## [0.16.3] - 2026-10-30

### Added

- `codemie proxy restart` command, and update notes that match the installed version
- Prompts are resumed automatically after SSO re-authentication

### Fixed

- Codemie hooks run under PowerShell on Windows, and stale hook paths are healed automatically
- Secrets are masked in forwarded OTLP hook events
- Secrets are masked in forwarded native Claude Code telemetry (logs, metrics, traces), including secret-named attributes and JSON-encoded tool parameters
- Hook output is no longer swallowed, so the agent receives the answer from `codemie hook`
- Signals sent to the wrapper are forwarded to the agent before the proxy is stopped
- `pasted_content` tags are stripped from Claude hook prompts in analytics

### Changed

- Claude Code analytics now sends native telemetry as OTLP/JSON so it can be masked. Existing users: run `codemie proxy connect --claude-code-otlp` and restart Claude Code; until then telemetry still goes out as unmasked protobuf

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
