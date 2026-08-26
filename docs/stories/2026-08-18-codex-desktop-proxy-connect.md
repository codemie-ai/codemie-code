# Connect the Codex Desktop App to CodeMie Models — Story

**Date**: 2026-08-18
**Status**: Draft
**Ticket**: —

---

## Context

- `codemie proxy connect` already supports GUI targets today: `--claude-desktop`, `--vscode` (Copilot BYOK) and `--vscode-claude-code`, sharing one daemon on port 4001 with per-target summaries and rollback on total failure.
- The Claude Desktop connector redirects the app by writing a config-library entry under the app's `Claude-3p` support directory, setting a gateway base URL plus a static gateway key, and asking the user to restart the app. It writes no env vars and does no TLS work.
- The `codex` agent plugin (`codemie-codex`) already redirects the **CLI** to CodeMie, but does so purely at runtime: it maps base-URL and key env vars and prepends `--config` overrides defining a `codemie` model provider with `wire_api` set to the Responses API. It deliberately never writes `~/.codex/config.toml`, and isolates itself with a dedicated `CODEX_HOME` specifically so that plain Codex and the Codex Desktop app keep using the default home.
- The local proxy is a transparent pass-through — `/v1/responses` reaches the gateway unchanged — and it already carries a Codex-specific encrypted-content sanitizer plus a gateway-key plugin that validates a static bearer token and strips it before forwarding.
- **Nothing exists for a Codex desktop/GUI target**: no connector, no target flag, no `~/.codex/config.toml` writer, and the model-discovery helper filters to Claude models only.
- External research confirms the Codex desktop app (shipped inside the ChatGPT desktop app) embeds the same Codex core and reads the same user-level `~/.codex/config.toml`, which makes a file-based connector viable. See **Research Notes** below.

---

## Story

**As a** CodeMie developer who prefers a GUI coding agent over a terminal, **I want** a single CodeMie command that points the Codex desktop app at my CodeMie models through the local proxy, **so that** I get the same governed, billed-to-CodeMie model access in the Codex app that `codemie-codex` already gives me in the CLI — without hand-editing TOML or holding a personal OpenAI subscription for model access.

---

## Background

CodeMie today governs model access for terminal agents and for two GUI surfaces (Claude Desktop, VS Code). Developers who have adopted the Codex desktop app are stranded: they either run their coding work through a personal ChatGPT subscription, which sits outside CodeMie's cost and policy controls, or they drop back to the Codex CLI purely to get CodeMie models. Because the Codex app reads the same user-level configuration file as the Codex CLI, CodeMie can redirect it declaratively — the same "one command, restart the app" experience already proven with Claude Desktop.

The catch is ownership: Codex intentionally forbids project-local configuration from overriding provider definitions, so the connector must write the developer's real user-level Codex config — a file their Codex CLI also depends on. Reversibility is therefore part of the feature, not a nice-to-have.

---

## Acceptance Criteria

- [ ] Given the Codex desktop app is installed and CodeMie is authenticated, when the developer runs the proxy-connect command with the new Codex-app target, then the local proxy daemon is running, the user-level Codex configuration selects a `codemie` model provider pointing at the local proxy over the Responses wire protocol, and the command tells the developer to restart the Codex app.
- [ ] Given the connector has written the configuration, when the developer restarts the Codex app and starts a task, then the request is served by a CodeMie model through the local proxy, and no request reaches OpenAI's own endpoint.
- [ ] Given the developer's `~/.codex/config.toml` already contains unrelated settings, when the connector writes its configuration, then all unrelated settings are preserved byte-for-identical in meaning, a restorable backup of the prior file exists, and only CodeMie-owned keys are added or replaced.
- [ ] Given a previous successful connect, when the developer runs the corresponding disconnect, then every CodeMie-owned key is removed, the prior configuration is restored from backup, and a subsequent plain Codex CLI run behaves exactly as it did before the first connect.
- [ ] Given the connector runs on macOS and on Windows, when it resolves the Codex configuration location, then it uses the correct per-platform user Codex home on each, and the resulting configuration is functionally identical on both.
- [ ] Given the developer's CodeMie credentials authorize the proxy, when the Codex app sends a request, then authentication is carried by a static bearer header supplied from the connector's configuration, and no CodeMie key is written into the Codex account credential file.
- [ ] Given the Codex app's model picker cannot list locally configured models, when the developer opens the picker after connecting, then a single CodeMie model is pinned and in effect, the picker's display of a generic "Custom" label is treated as expected behaviour, and the effective model is stated in the connector's output so the developer knows what they are running.

### Negative / edge-case criteria

- [ ] Given the Codex desktop app is **not** installed, when the developer runs the connect command with the Codex-app target, then the command fails with a message naming the missing app and the expected location, writes nothing to disk, and exits without leaving a daemon running solely for this target.
- [ ] Given `~/.codex/config.toml` already declares a non-CodeMie custom model provider as the active provider, when the developer runs connect, then the connector refuses or requires explicit confirmation before overwriting the active provider selection, and states which provider it would displace.
- [ ] Given the configuration file exists but is malformed and cannot be parsed, when the connector runs, then it aborts before writing, reports the parse failure with the file path, and leaves the original file untouched.
- [ ] Given a connect attempt fails partway through, when the command exits, then the Codex configuration is rolled back to its pre-run state, consistent with the existing rollback behaviour for other connect targets.

---

## Out of Scope

- Linux support for the Codex desktop app (currently preview-quality upstream) — deferred to a follow-up story.
- The `openai_base_url` override strategy, which redirects Codex's built-in OpenAI provider instead of defining a custom one. Evaluated and rejected for this story.
- Rotating-credential support via Codex's command-backed credential helper. Viable upstream and worth its own story; this story ships the static gateway key.
- Generating a model catalog so that multiple CodeMie models appear in the Codex app picker — blocked by an upstream client-side filter; a single pinned model is the v1 contract.
- Any patching, repackaging or code-signing of the Codex/ChatGPT app bundle.
- Session/telemetry ingestion and analytics for Codex-app sessions (the CLI path already has its own metrics pipeline; the app path is not covered here).
- Per-thread or in-app provider switching, which the Codex app does not currently expose.
- Managed/MCP server provisioning for the Codex app.

---

## Open Questions

- Does the Codex app need to be fully quit and relaunched for a configuration change to take effect, or does it re-read the file per task? This determines whether the connector's guidance says "restart" or "no restart needed", and should be verified on both macOS and Windows before implementation.
- Which single CodeMie model should be the pinned default, and should it be user-overridable at connect time or fixed by CodeMie policy?
- The Codex app and the `codemie-codex` CLI plugin will now use different Codex homes by design (default vs. CodeMie-isolated). Is that divergence acceptable to developers who use both, or does it create confusing "my chats/settings differ between app and CLI" reports we should pre-empt in docs?
- Should the new target be reachable through the existing multi-target connect flow (combinable with `--claude-desktop` in one run), and if so, does the single shared daemon on port 4001 serve both cleanly?
- Upstream has an unresolved report of the app mixing a local provider's base URL with a remote credential, observed on Windows. Do we need a detection or guard for that, or is it out of our control and documentation-only?

---

## Research Notes

Feasibility research conducted 2026-08-18. Confidence in the core mechanism is high; confidence in the picker/UX details is moderate because several upstream issues remain open.

**What the "Codex desktop app" actually is.** It ships inside the ChatGPT desktop app — macOS (Apple Silicon) since February 2026, Windows from mid-2026, Linux in preview with native packages. It is not a standalone binary. It embeds the shared Codex core and app-server, and reads the same user-level Codex configuration and credential files as the Codex CLI. That shared configuration file is the seam this story relies on.

**Confirmed levers.** A custom provider block with a display name, base URL and wire protocol; a built-in-provider base-URL override as an alternative; and a command-backed credential helper that reads a bearer token from a helper command's standard output on a refresh interval, merged into the shared Codex core on 31 March 2026.

**Confirmed constraints.**
- The `chat` wire protocol was removed in February 2026 — a custom provider must speak the OpenAI Responses API. CodeMie's proxy already passes that path through and sanitizes Codex encrypted reasoning content.
- Provider definitions and provider auth must live in the user-level config; project-local config is deliberately barred from overriding them.
- Environment-variable-based keys are unreliable for a GUI app because desktop apps do not dependably inherit shell environment. Static headers in the config file are the robust path.
- Writing a provider key into the Codex account credential file flips the app into API-key auth mode and disables ChatGPT-account features — so the connector must not touch that file.
- Reserved provider ids cannot be reused for a custom provider.

**Known upstream defects that shaped scope.**
- The desktop renderer applies a client-side allowlist that filters locally configured models out of the model picker; pinning the model in config is the accepted workaround, and the picker then shows a generic "Custom" label.
- There is no provider-aware picker, a custom catalog replaces rather than appends to the bundled one, and switching provider or Codex home can make existing chats inaccessible from the app.
- One report of a local provider's base URL being paired with a remote credential, producing an authentication failure.
- A third-party app-bundle patch exists to add per-thread provider selection, which confirms the official UX gap is real. Not a path CodeMie should take.

**Sources**
- Codex advanced configuration (custom providers, wire protocol, catalog, command-backed auth): https://learn.chatgpt.com/docs/config-file/config-advanced
- Codex authentication (account vs. API-key auth, credential file): https://learn.chatgpt.com/docs/auth
- Codex environment variables (Codex home, CA certificates): https://learn.chatgpt.com/docs/config-file/environment-variables
- ChatGPT/Codex desktop app overview and platforms: https://learn.chatgpt.com/docs/app
- Dynamic auth tokens for model providers (merged 2026-03-31): https://github.com/openai/codex/pull/16288
- Desktop model picker filters locally configured models: https://github.com/openai/codex/issues/19694
- Desktop custom providers vs. existing chats and picker: https://github.com/openai/codex/issues/29156
- Desktop mixes local base URL with remote credential: https://github.com/openai/codex/issues/24457
- Provider key in credential file breaks account auth mode: https://github.com/farion1231/cc-switch/issues/3034
- Third-party per-thread provider patch: https://github.com/Keksuccino/Better-Codex-App-Custom-Provider-Support
- Codex desktop app launch coverage: https://venturebeat.com/orchestration/openai-launches-a-codex-desktop-app-for-macos-to-run-multiple-ai-coding
- ChatGPT/Codex desktop app on Linux: https://thenewstack.io/openais-chatgpt-desktop-linux/
- Proxy/gateway configuration precedent (LiteLLM + Codex): https://docs.litellm.ai/docs/tutorials/openai_codex
