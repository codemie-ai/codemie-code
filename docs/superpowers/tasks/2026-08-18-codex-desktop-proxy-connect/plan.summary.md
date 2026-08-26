# Plan summary — Codex Desktop Connect

15 TDD tasks, each with a `Test-first:` line, commit per task.

1. **Sentinels + `findManagedRegions`** — pure region discovery; truncated block = unmanaged.
2. **Displaced keys** — comment/restore root-level `model`/`model_provider`; skips in-table keys.
3. **`spliceManagedBlocks`/`stripManagedRegions`** — `strip(splice(x)) === x` is the spec.
4. **`buildManagedBlocks`** — `wire_api = "responses"`, bearer header, escaped values; must parse.
5. **Paths + app detection** — honours user `CODEX_HOME`, never the plugin's isolated home;
   per-platform app candidates.
6. **`backupIfUnmanaged`** — keyed on marker presence, not backup presence (fixes Kimi's bug).
7. **`discoverCodexModels`** — `/v1/llm_models?include_all=true` via proxy with bearer key, filtered
   by `isCodexCompatibleModelName`; rejects unavailable `--model`.
8. **`writeCodexDesktopConfig`** — validate → backup → marker **write-ahead** → atomic splice via
   `writeAtomically`. Rejects malformed TOML and foreign `model_provider` unless forced.
9. **`removeCodexDesktopConfig`** — surgical strip primary, backup fallback if result won't parse.
10. **Orchestrator** — `codexDesktop` target, `ConnectOptions.model`, third `EffectiveClientType`,
    priority `claude-desktop > codex-desktop > vscode-byok`.
11. **`runCodexDesktop`** — returns `TargetResult{ok:false}`, never throws; app-missing hard-fails
    unless `--force`.
12. **`disconnect-orchestrator.ts`** — no-op when nothing connected, exit 1 on failure; daemon stays.
13. **CLI wiring** — `--codex-desktop`, `--model <slug>`, new `disconnect` subcommand.
14. **Docs** — `COMMANDS.md`: target, restart, "Custom" picker, backup path, Codex-home divergence.
15. **Gate run** — lint, typecheck, build, unit; pre-existing dirty files stay unstaged.

Reuses `writeAtomically` from `connectors/vscode.ts`; does **not** copy Kimi's non-atomic write or
create-once backup. Flagged adjustments: newline seam (T3), `TempWorkspace` disposal name (T5),
strip spy (T9), `SpawnOptions` widening (T10).
