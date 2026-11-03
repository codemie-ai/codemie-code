# Technical Analysis — VS Code model token limits

**Date**: 2026-10-02
**Source**: `VSCODE_MODEL_TOKEN_LIMITS.md` (reviewed against the proposal; no separate codebase sweep)

## Feature area

`codemie proxy connect --vscode` — generation of VS Code BYOK model entries (`chatLanguageModels.json`).

## Current behaviour

- Each enabled tenant model gets an entry with `maxInputTokens` and `maxOutputTokens`.
- Both values come from the repository: a hardcoded capability table for known model families, and fixed defaults (128000 input / 8192 output) for everything else.
- The connector already fetches the tenant model catalog (`GET /v1/llm_models?include_all=true`), which reports `max_input_tokens` for most models, but the value is ignored when building entries.
- Effect: models absent from the table get 128000 even when the tenant reports up to ~1M; VS Code uses the value as its prompt budget and summarizes context too early.

## Affected components

- Tenant catalog parsing (`src/cli/commands/proxy/connectors/tenant-catalog.ts`) — model descriptor does not carry token limits.
- VS Code model capability table and defaults (`src/cli/commands/proxy/connectors/vscode-models.ts`).
- VS Code connector model assembly (`src/cli/commands/proxy/connectors/vscode.ts`).
- SSO HTTP client model type (`src/providers/plugins/sso/sso.http-client.ts`) — no `max_output_tokens` field yet.
- User docs (`docs/COMMANDS.md`, VS Code BYOK section).

## Proposed resolution order (per field, independently)

| Field | 1st | 2nd | 3rd |
|---|---|---|---|
| Input limit | tenant catalog value | capability table | default 128000 |
| Output limit | tenant catalog value (not returned by API today) | capability table | default 8192 |

A value is usable only if it is a finite number > 0; otherwise fall through.

## Risks / notes

- Output limits remain table/default-driven until the backend returns `max_output_tokens`.
- Models with no catalog value (routers, static-config catalogs) keep today's behaviour.
- Reasoning efforts, API type and headers stay in the table (no API equivalent).
- Small, contained change: ~4 source files + 1 doc, single repository, no new dependencies.
