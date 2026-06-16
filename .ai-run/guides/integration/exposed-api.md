# Exposed API

**Category**: Integration | **Complexity**: Medium

Public API surface exported by `src/index.ts` for external integration (VSCode extension, CLI, custom tooling).

---

## API Surface Summary

| Export | Purpose | Source |
|--------|---------|--------|
| `CodeMieSSO` | Browser-based SSO authentication & credential storage | `src/providers/plugins/sso/sso.auth.ts:33` |
| `CodeMieProxy` | Plugin-based HTTP proxy with streaming | `src/providers/plugins/sso/proxy/sso.proxy.ts:41` |
| `getPluginRegistry` | Singleton accessor for the plugin registry | `src/providers/plugins/sso/proxy/plugins/registry.ts:142` |
| `processEvent` | Programmatic hook event processing | `src/cli/commands/hook.ts:1152` |
| `ConfigLoader` | Unified config loader with priority system | `src/utils/config.ts:29` |

---

## CodeMieSSO

Handles browser-based OAuth; manages credential storage, session lifecycle, and callback handling. Credentials are stored per base URL and expire after 24 hours.

**Key methods** (`src/providers/plugins/sso/sso.auth.ts:33`):

| Method | Signature |
|--------|-----------|
| `authenticate` | `(config: SSOAuthConfig) => Promise<SSOAuthResult>` |
| `getStoredCredentials` | `(url?, allowFallback?) => Promise<SSOCredentials \| null>` |
| `clearStoredCredentials` | `(baseUrl?) => Promise<void>` |

**Auth flow**: starts local HTTP server → opens browser to `${codeMieBase}/v1/auth/login/${port}` → waits for OAuth callback → stores credentials via `CredentialStore`.

```typescript
const sso = new CodeMieSSO();
const result = await sso.authenticate({ codeMieUrl: 'https://codemie.lab.epam.com', timeout: 120000 });
// result.success, result.apiUrl, result.error
```

**Types**:

| Interface | Key Fields |
|-----------|-----------|
| `SSOAuthConfig` | `codeMieUrl: string`, `timeout?: number` (default 120 000 ms) |
| `SSOAuthResult` | `success: boolean`, `apiUrl?`, `cookies?`, `error?` |
| `SSOCredentials` | `cookies`, `apiUrl`, `expiresAt: number` |

| DO | DON'T |
|----|-------|
| Call `authenticate()` before accessing stored credentials | Assume credentials exist without checking `getStoredCredentials()` |
| Store credentials per URL | Use global fallback for all URLs |
| Call `clearStoredCredentials()` on logout | Leave credentials in storage |

---

## CodeMieProxy

Plugin-extensible HTTP proxy that streams requests to an upstream API and runs plugin hooks at each lifecycle stage. Never buffers — all streaming is chunk-by-chunk.

**Key methods** (`src/providers/plugins/sso/proxy/sso.proxy.ts:41`):

| Method | Signature |
|--------|-----------|
| `constructor` | `(config: ProxyConfig)` |
| `start` | `() => Promise<{ port: number; url: string }>` |
| `stop` | `() => Promise<void>` |

**ProxyConfig key fields** (`src/providers/plugins/sso/proxy/sso.proxy.ts:41`):

| Field | Type | Notes |
|-------|------|-------|
| `targetApiUrl` | `string` | Required upstream URL |
| `port?` | `number` | Auto-assigned if omitted |
| `clientType?` | `string` | e.g. `'vscode-codemie'` |
| `timeout?` | `number` | Default 300 000 ms |
| `provider?` | `string` | e.g. `'ai-run-sso'` |
| `sessionId?` | `string` | For traceability |

**Request processing order**: build context → `onRequest` hooks → forward to upstream → `onResponseHeaders` hooks → stream chunks (`onResponseChunk`) → `onResponseComplete` hooks.

**Plugin lifecycle hooks**:
`onProxyStart` → `onRequest` → `onResponseHeaders` → `onResponseChunk` → `onResponseComplete` → `onProxyStop` / `onError`

| DO | DON'T |
|----|-------|
| Register plugins before `proxy.start()` | Register plugins after initialization |
| Let proxy auto-assign port | Hard-code port (causes conflicts) |

---

## getPluginRegistry

Singleton accessor; returns a `PluginRegistry` that manages plugin ordering and lifecycle for the proxy.

**`PluginRegistry` methods** (`src/providers/plugins/sso/proxy/plugins/registry.ts:14`):

| Method | Purpose |
|--------|---------|
| `register(plugin, config?)` | Register at startup; lower `priority` = earlier execution |
| `initialize(context)` | Called by proxy on `start()`; returns `ProxyInterceptor[]` |
| `setEnabled(id, enabled)` | Toggle plugin at runtime |
| `getAll()` / `getConfig(id)` / `updateConfig(id, updates)` | Inspect / mutate |
| `clear()` | Reset for tests |

**`ProxyPlugin` contract**:
```typescript
interface ProxyPlugin {
  id: string; name: string; priority: number;
  createInterceptor(context: PluginContext): Promise<ProxyInterceptor>;
  onEnable?(): Promise<void>; onDisable?(): Promise<void>;
}
```
(`src/providers/plugins/sso/proxy/plugins/registry.ts:14`)

**`ProxyInterceptor` hooks** (all optional): `onProxyStart`, `onRequest`, `onResponseHeaders`, `onResponseChunk`, `onResponseComplete`, `onProxyStop`, `onError`.

**`PluginContext` fields**: `config: ProxyConfig`, `logger`, `credentials?: SSOCredentials`, `profileConfig?`.

---

## processEvent

Stateless function that processes hook events programmatically — same logic as the CLI hook command but accepts event objects and throws exceptions (instead of `process.exit`) when `config` is supplied.

**Signature** (`src/cli/commands/hook.ts:1152`):
```typescript
export async function processEvent(event: BaseHookEvent, config?: HookProcessingConfig): Promise<void>;
```

**`HookProcessingConfig` required fields**: `agentName`, `sessionId`. Optional: `provider`, `apiBaseUrl`, `cookies`, `apiKey`, `clientType`, `version`, `profileName`, `project`, `model`, `ssoUrl`.

**Per-event processing**:

| Event | Steps |
|-------|-------|
| `SessionStart` | Create session record → send start metrics → init activity tracking |
| `SessionEnd` | Accumulate activity → transform messages → sync to API → send end metrics → rename files with `completed_` prefix |
| `Stop` / `SubagentStop` | Accumulate duration → incremental sync |
| `UserPromptSubmit` | Start activity tracking |

**`BaseHookEvent` required fields**: `session_id`, `transcript_path`, `permission_mode`, `hook_event_name`. Optional per-event: `cwd`, `source` (SessionStart), `reason` (SessionEnd), `agent_id` / `agent_transcript_path` / `stop_hook_active` (SubagentStop).

**Behavior difference**:

| Feature | With `config` | Without `config` (CLI fallback) |
|---------|--------------|--------------------------------|
| Error handling | Throws exceptions | Sets `process.exitCode` |
| Config source | Config object | Environment variables |
| Logger init | Config-based | Environment-based |

---

## ConfigLoader

Unified config loader with a fixed priority chain. Supports legacy single-provider config and multi-provider profile (v2) format.

**Priority** (highest → lowest): CLI args → env vars → project config (`.codemie/codemie-cli.config.json`) → global config (`~/.codemie/codemie-cli.config.json`) → defaults.

**Static methods** (`src/utils/config.ts:29`):

| Method | Use when |
|--------|----------|
| `load(workingDir?, cliOverrides?)` | Config is optional / might be partial |
| `loadAndValidate(workingDir?, cliOverrides?)` | Required fields must exist; throws if not |
| `loadFull(workingDir?, cliOverrides?)` | Need full `MultiProviderConfig` with all profiles |
| `loadWithSources(workingDir?)` | Need to know which layer each field came from |
| `showWithSources(workingDir?)` | Human-readable source attribution |

**Config formats** (`src/utils/config.ts:29`):

Legacy (v1): flat `{ provider, apiKey, model, baseUrl, ... }`.  
Multi-provider (v2): `{ version: 2, activeProfile: string, profiles: Record<string, CodeMieConfigOptions>, analytics? }`.

**Profile isolation**: when an explicit profile name is passed via CLI, env vars for `baseUrl`/`apiKey`/`model`/`provider` are filtered out to prevent contamination.

| DO | DON'T |
|----|-------|
| Use `loadAndValidate()` when required fields must exist | Use `load()` when validation is needed |
| Use `ConfigLoader` for all config access | Read config files directly |
| Use profile names for multi-provider config | Hardcode provider configuration |

---

## Error Handling Reference

| Surface | Error type | Handling |
|---------|-----------|---------|
| `CodeMieSSO.authenticate` | Returns `{ success: false, error }` — does not throw | Check `result.success` |
| `CodeMieSSO.getStoredCredentials` | May throw on store failure | `try/catch` |
| `CodeMieProxy.start` | `AuthenticationError`, `NetworkError` | `try/catch`; `TimeoutError` also possible |
| `processEvent` with config | Throws on validation / processing failure | `try/catch`; check `error.message` |
| `ConfigLoader.loadAndValidate` | Throws on missing required fields | `try/catch`; check for `'Profile'` or `'API key'` in message |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "SSO credentials not found" | No stored credentials | Call `sso.authenticate()` first |
| "Profile not found" | Invalid profile name | Check profiles with `ConfigLoader.loadFull()` |
| "Plugin not initialized" | Plugin registered after proxy start | Register before `proxy.start()` |
| "Missing required field" | Invalid hook event object | Ensure all `BaseHookEvent` required fields present |
| "Authentication timeout" | User didn't complete browser flow | Increase `timeout` or retry |
| Proxy port conflict | Hard-coded port in use | Omit `port` to let proxy auto-assign |

---

## See Also

- Architecture guide: `.ai-run/guides/architecture/architecture.md`
- Security guide: `.ai-run/guides/security/security-practices.md`
- External integrations: `.ai-run/guides/integration/external-integrations.md`
