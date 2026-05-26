# Session Storage And Migrations Guide

## Quick Summary

CodeMie Code persists agent sessions, metrics, conversations, and migration history as local JSON/JSONL files under CodeMie-managed paths. There is no application database in this repository.

**Category**: Data
**Complexity**: Medium
**Prerequisites**: Node.js filesystem APIs, JSONL, async/await

---

## Data Model Map

| Data | Format | Owner | Evidence |
|---|---|---|---|
| Session metadata | JSON | `SessionStore` | `src/agents/core/session/SessionStore.ts:17` |
| Metrics deltas | JSONL | Metrics writers and sync processors | `src/providers/plugins/sso/session/processors/metrics/MetricsWriter.ts:17` |
| Conversation payloads | JSONL | Conversation sync processors | `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts:52` |
| Migration history | JSON | `MigrationTracker` | `src/migrations/tracker.ts:13` |
| Desktop telemetry metadata | JSON/JSONL | Desktop telemetry adapter | `src/telemetry/clients/claude-desktop/claude-desktop.parser.ts:79` |

---

## SessionStore Pattern

### Rule

Use `SessionStore` for CodeMie session metadata. It centralizes path construction, save/load behavior, completed-session lookup, and external-session lookup.

| Avoid | Prefer |
|---|---|
| Writing session JSON directly from plugins | `SessionStore.saveSession()` |
| Recreating lookup logic for completed sessions | `SessionStore.loadSession()` |
| Scanning session files without error isolation | `SessionStore.findByExternalSessionId()` |
| Updating activity duration outside the store | `startActivityTracking()` and `accumulateActiveDuration()` |

### Evidence

| Behavior | Evidence |
|---|---|
| Save session as JSON | `src/agents/core/session/SessionStore.ts:22`, `src/agents/core/session/SessionStore.ts:33` |
| Load active or completed session | `src/agents/core/session/SessionStore.ts:50`, `src/agents/core/session/SessionStore.ts:58` |
| Find by external session id | `src/agents/core/session/SessionStore.ts:79`, `src/agents/core/session/SessionStore.ts:94` |
| Track active time | `src/agents/core/session/SessionStore.ts:125`, `src/agents/core/session/SessionStore.ts:149` |

---

## JSONL Storage Pattern

### Rule

Use JSONL for append-friendly session artifacts, then atomically rewrite the file when marking records as synced or failed.

| Avoid | Prefer |
|---|---|
| Rewriting full metrics files for every tool event | Append deltas with `MetricsWriter` |
| Mutating JSONL in place | Read all records, update statuses, atomic rewrite |
| Assuming every JSONL line is valid forever | Use tolerant readers where corrupted lines are possible |
| Duplicating JSONL helpers between agents | Shared JSONL reader/writer utilities |

### Evidence

| Utility | Purpose | Evidence |
|---|---|---|
| `MetricsWriter.appendDelta()` | Append one metric delta | `src/providers/plugins/sso/session/processors/metrics/MetricsWriter.ts:25` |
| `MetricsWriter.readAllDeltas()` | Load deltas for sync | `src/providers/plugins/sso/session/processors/metrics/MetricsWriter.ts:60` |
| `readJSONL()` | Generic JSONL reader | `src/providers/plugins/sso/session/utils/jsonl-reader.ts:19` |
| `writeJSONLAtomic()` | Atomic JSONL rewrite | `src/providers/plugins/sso/session/utils/jsonl-writer.ts:30` |
| `readJSONLTolerant()` | Skip corrupted lines when appropriate | `src/agents/core/session/utils/jsonl-reader.ts:19` |

---

## Metrics Sync Pattern

### Rule

Metrics sync is two-phase: agent adapters write pending records, then sync processors aggregate and mark records after API submission.

| Step | Practice | Evidence |
|---|---|---|
| 1 | Read pending metric deltas from JSONL | `src/providers/plugins/sso/session/processors/metrics/metrics-sync-processor.ts:52` |
| 2 | Load session metadata for context | `src/providers/plugins/sso/session/processors/metrics/metrics-sync-processor.ts:113` |
| 3 | Send metrics through API client | `src/providers/plugins/sso/session/processors/metrics/metrics-api-client.ts:93` |
| 4 | Mark delta statuses and attempts | `src/providers/plugins/sso/session/processors/metrics/metrics-sync-processor.ts:213` |
| 5 | Persist updated JSONL atomically | `src/providers/plugins/sso/session/processors/metrics/metrics-sync-processor.ts:240` |

### Anti-Patterns

| Avoid | Prefer |
|---|---|
| Sending metrics directly from every tool parser | Write deltas and let sync processors own upload |
| Losing sync state on partial failure | Store status per record |
| Blocking agent launch on best-effort sync | Non-blocking lifecycle hooks where possible |
| Computing cost in the CLI when backend owns pricing | Send usage metadata, let backend compute pricing |

---

## Conversation Sync Pattern

### Rule

Conversation payloads are processed separately from metrics. Keep raw or normalized conversation payloads in JSONL and mark sync state after upload.

| Step | Practice | Evidence |
|---|---|---|
| 1 | Read all conversation payload records | `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts:52` |
| 2 | Skip when no pending payloads exist | `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts:63` |
| 3 | Mark records as synced after submission | `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts:129` |
| 4 | Atomic rewrite of updated payload records | `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts:159` |
| 5 | Return sync updates for session metadata | `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts:165` |

---

## Processor Orchestration

### Rule

Session adapters parse native agent storage once and pass a normalized parsed session to registered processors.

| Agent | Pattern | Evidence |
|---|---|---|
| Gemini | Registers metrics and conversations processors | `src/agents/plugins/gemini/gemini.session-adapter.ts:97`, `src/agents/plugins/gemini/gemini.session-adapter.ts:244` |
| Codex | Registers processors and preserves rollout records | `src/agents/plugins/codex/codex.session.ts:53`, `src/agents/plugins/codex/codex.session.ts:311` |
| Shared contract | Session processor interface | `src/agents/core/session/BaseProcessor.ts:73` |
| Result aggregation | Aggregated processor results | `src/agents/core/session/BaseSessionAdapter.ts:59` |

### Anti-Patterns

| Avoid | Prefer |
|---|---|
| Parsing the same transcript once per processor | Adapter parses once, processors consume parsed session |
| Letting one processor failure hide all results | Aggregate per-processor success/failure |
| Persisting sync metadata in processor-specific locations only | Apply sync updates to session metadata |

---

## Migration Framework

### Rule

Runtime migrations are registered centrally and tracked in a migration history file. Add new migrations by implementing the migration interface and importing the file from the migration index.

| Concern | Evidence |
|---|---|
| Migration index imports all migrations | `src/migrations/index.ts:24` |
| Registry stores migrations | `src/migrations/registry.ts:7` |
| Registry sorts by id | `src/migrations/registry.ts:19` |
| Tracker stores history file path | `src/migrations/tracker.ts:13` |
| Tracker computes pending migrations | `src/migrations/tracker.ts:81` |
| Runner executes pending migrations | `src/migrations/runner.ts:11`, `src/migrations/runner.ts:42` |

### Migration Practice

| Avoid | Prefer |
|---|---|
| Renaming or deleting user files without checks | Read, validate, write, then record migration |
| Recording failed migrations as successful | Only record success when migration completes |
| Running migrations out of lexical id order | Use registry sorting |
| Adding migration files without importing them | Import from `src/migrations/index.ts` |

---

## File IO Practices

### Rule

Use async filesystem APIs in runtime flows and add error context with project logging utilities.

| Avoid | Prefer | Evidence |
|---|---|---|
| Sync filesystem operations in async CLI flows | `fs/promises` reads and writes | `src/agents/core/session/SessionStore.ts:8` |
| Partial JSONL writes | Write temp file then rename | `src/providers/plugins/sso/session/utils/jsonl-writer.ts:14` |
| Unstructured error logs | `createErrorContext()` and logger | `src/agents/core/session/SessionStore.ts:37` |
| Treating absent files as fatal by default | Return empty or null where absence is expected | `src/providers/plugins/sso/session/utils/jsonl-reader.ts:19` |

---

## Paths And Ownership

| Path Type | Owner | Practice |
|---|---|---|
| `~/.codemie/sessions/` | Session persistence | Use session-config helpers and `SessionStore` |
| `~/.codemie/migrations.json` | Migration tracker | Use `MigrationTracker` |
| Agent-native transcript locations | Agent adapters | Discover through adapter-specific logic |
| Temporary plugin files | Plugin injector | Clean up best-effort on session end |

---

## Quick Reference

| Need | Location |
|---|---|
| Session metadata store | `src/agents/core/session/SessionStore.ts` |
| Session config paths | `src/agents/core/session/session-config.ts` |
| Processor contract | `src/agents/core/session/BaseProcessor.ts` |
| Metrics writer | `src/providers/plugins/sso/session/processors/metrics/MetricsWriter.ts` |
| Metrics sync processor | `src/providers/plugins/sso/session/processors/metrics/metrics-sync-processor.ts` |
| Conversation sync processor | `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts` |
| Migration registry | `src/migrations/registry.ts` |
| Migration tracker | `src/migrations/tracker.ts` |
| Migration runner | `src/migrations/runner.ts` |

---

## Delivery Checklist

| Check | Reason |
|---|---|
| Session updates go through `SessionStore` | Keeps active/completed lookup consistent |
| JSONL status updates are atomic | Avoids corrupting sync state |
| Processors return structured results | Preserves partial success visibility |
| New migrations are registered and imported | Makes migration discoverable |
| Error logs include session or migration context | Makes operational issues debuggable |
| No secrets are written to session artifacts | Protects local storage |

---
