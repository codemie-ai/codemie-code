# Spec summary — Codex Desktop Connect

Add `--codex-desktop` to `codemie proxy connect` plus a `proxy disconnect` counterpart. The Codex
desktop app embeds the same codex-core as the CLI and reads the same user-level
`~/.codex/config.toml` — the whole seam. The proxy pipeline needs no change.

## Fixed decisions
Custom `[model_providers.codemie]` provider (not `openai_base_url`); macOS + Windows; one pinned
`model` slug (picker showing "Custom" is expected); static `Authorization: Bearer <key>` in
`http_headers`, never `~/.codex/auth.json`; the app's default Codex home, not the plugin's
isolated `CODEX_HOME`; marker-delimited splice, parse only to validate; third
`EffectiveClientType` value `codex-desktop`; atomic write + write-ahead marker instead of
changing `TargetResult`; hard-fail on missing app, `--force` bypasses. `wire_api` = `"responses"`.

## Units
`codex-config-toml.ts` (new, pure zero-IO splice/strip/find); `codex-desktop.ts` (new: paths, app
detection, model choice, backup, atomic write, marker state); `connect-orchestrator.ts` (edit:
`codexDesktop` target, third client type, `runCodexDesktop`); `disconnect-orchestrator.ts` (new);
`proxy/index.ts` (edit).

## Managed block
Two regions, since TOML allows top-level keys only before tables: header prepended
(`model_provider`, `model`), table appended (`[model_providers.codemie]`). Sentinels
`# >>> codemie proxy connect (codex-desktop)` / `# <<<`. Outside stays byte-identical. Unmanaged
top-level `model_provider`/`model` commented in place, restored on disconnect.

## Deviations, errors, tests
Disconnect is surgical-first with backup fallback; backup keyed on marker presence (fixes Kimi's
stale-backup bug). Missing app, malformed TOML, foreign `model_provider`, no model, unknown
`--model` → `ConfigurationError` before any write; runner returns `{ok:false}`, never throws.
`codex-config-toml.test.ts` carries the weight: comments preserved, keys-before-tables,
idempotent re-splice, `strip(splice(x)) === x`. Connector tests over `TempWorkspace`.
