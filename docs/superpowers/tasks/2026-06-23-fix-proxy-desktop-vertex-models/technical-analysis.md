# Technical Analysis: Proxy Connect Desktop — Vertex-Only Claude Models

**Task:** Fix `codemie proxy connect desktop` failing with *"Local proxy did not expose any Claude models"* when `/v1/llm_models?include_all=true` returns only Vertex-hosted Claude model IDs.

**Repo:** `codemie-code`  
**Primary files:** `src/cli/commands/proxy/connectors/desktop.ts`, `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

---

## Codebase Findings

### Failure path and command flow

`codemie proxy connect desktop` (`src/cli/commands/proxy/index.ts`) starts or reuses the local SSO proxy daemon, then calls `writeDesktopConfig(state.url, state.gatewayKey)`. Model discovery happens inside `writeDesktopConfig`:

1. `fetchClaudeModels(proxyUrl, gatewayKey)` → GET `{proxyUrl}/v1/llm_models?include_all=true` with `Authorization: Bearer {gatewayKey}`
2. If the returned Claude ID list is empty → throws `ConfigurationError`: *"Local proxy did not expose any Claude models from …"*
3. `selectPreferredClaudeModels(discoveredModels)` → curates to `PREFERRED_CLAUDE_MODELS`
4. If curation yields nothing → throws *"Local proxy discovered Claude models, but none matched the preferred CodeMie desktop set."*
5. Resolved model names are written to Claude Desktop `configLibrary/<uuid>.json` as `inferenceModels`

The reported error corresponds to step 2 — discovery returns zero IDs after filtering, not step 3.

### Root cause: unconditional `-vertex` exclusion in `fetchClaudeModels`

```104:106:src/cli/commands/proxy/connectors/desktop.ts
    const claudeIds = ids
      .filter((id) => /^claude-/i.test(id))
      .filter((id) => !/-vertex$/i.test(id));
```

The JSDoc states vertex aliases are excluded because *"the gateway already picks the right backend for the canonical names."* That assumption holds when both canonical and vertex registrations exist, but breaks for deployments where **only** vertex registrations are exposed (e.g. `claude-sonnet-4-5-vertex`, `claude-sonnet-4-6-vertex` with `provider: vertex_ai-anthropic_models`).

In the vertex-only scenario:

| API response ID | Passes `^claude-` | Survives `!/-vertex$/` | In discovery result |
|---|---|---|---|
| `claude-sonnet-4-6-vertex` | yes | **no** | excluded |
| `claude-sonnet-4-5-vertex` | yes | **no** | excluded |
| `gpt-5` | no | — | excluded (correct) |

Result: `claudeIds.length === 0` → hard failure at `writeDesktopConfig` line 324–327.

### Response parsing (`fetchClaudeModels`)

The handler supports two shapes from the proxy/upstream:

- **Array** (CodeMie native): maps `id || base_name || deployment_name` per entry (`CodeMieLlmModel`)
- **OpenAI-style**: maps `data[].id` (`ModelsListResponse`)

Vertex deployments typically use `base_name` / `deployment_name` with the `-vertex` suffix; the parser itself is fine — the loss happens in the post-filter.

`CodeMieLlmModel` in `desktop.ts` omits `provider`, but upstream entries can include `provider: "vertex_ai-anthropic_models"`. That field is unused today; suffix-based detection is sufficient for this bug.

### Preferred model curation (`selectPreferredClaudeModels`)

```144:162:src/cli/commands/proxy/connectors/desktop.ts
export function selectPreferredClaudeModels(
  available: string[],
  preferred: readonly string[] = PREFERRED_CLAUDE_MODELS
): string[] {
  // ...
  for (const name of preferred) {
    if (availableSet.has(name)) { resolved.push(name); continue; }
    // dated fallback: `${name}-YYYYMMDD` (6–10 digit suffix)
    const dated = available.filter(...).sort().pop();
    if (dated) resolved.push(dated);
  }
```

**Current resolution order per preferred entry:**

1. Exact ID match (e.g. `claude-sonnet-4-6`)
2. Latest dated variant (e.g. `claude-opus-4-6-20260205`)

**Missing:** vertex fallback (e.g. `claude-sonnet-4-6-vertex`). Even if `fetchClaudeModels` were fixed to return vertex IDs, curation would still fail unless `selectPreferredClaudeModels` maps preferred names to `-vertex` suffixed registrations.

**Default preferred set** (`PREFERRED_CLAUDE_MODELS`):

- `claude-sonnet-4-6`
- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-haiku-4-5`

### Existing tests (`desktop.test.ts`)

| Area | Coverage | Gap |
|---|---|---|
| `fetchClaudeModels` | Mixed list with canonical + `-vertex`; asserts vertex **excluded** when canonical present | No vertex-only response; no assertion that vertex-only env succeeds |
| `selectPreferredClaudeModels` | Exact + dated fallback; order preservation | No `-vertex` suffix fallback |
| `writeDesktopConfig` | Full happy path with `MODEL_LIST_RESPONSE` (canonical + vertex in raw response, vertex filtered out) | No integration test for vertex-only discovery |
| Error path | Empty `[]` → *"did not expose any Claude models"* | No test distinguishing vertex-only vs truly empty |

The fixture `MODEL_LIST_RESPONSE` includes both `claude-sonnet-4-6` and `claude-sonnet-4-6-vertex`, so current tests never exercise the failing production case.

### Related model-list logic elsewhere (no shared helper today)

There is **no shared module** for Claude desktop model filtering. Similar `/v1/llm_models?include_all=true` consumers behave differently:

| Location | Vertex handling | Notes |
|---|---|---|
| `src/providers/plugins/sso/sso.http-client.ts` — `fetchCodeMieModels` / `fetchCodeMieLlmModels` | **No** vertex filter | Returns all IDs / full descriptors; used by setup, OpenCode, JWT flows |
| `src/agents/plugins/opencode/opencode-dynamic-models.ts` | **No** vertex filter | Uses `deployment_name` as OpenCode model ID |
| `src/providers/integration/setup-ui.ts` — `isRecommendedModel` | **No** vertex filter | Partial string match; vertex IDs would match recommended patterns |
| `src/cli/commands/setup.ts` — `autoSelectModelTiers` | **No** vertex filter | `parseModelVersion` tests include `*-vertex` names for tier sorting |
| `src/cli/commands/proxy/health-check.ts` | N/A | Deep check only verifies HTTP success of `/v1/llm_models?include_all=true` |

**Callers of desktop-specific functions:** only `writeDesktopConfig` (in `desktop.ts`) and tests import `fetchClaudeModels` / `selectPreferredClaudeModels`. The bug is isolated to the desktop connector.

### Downstream compatibility (proxy + Claude Desktop)

- **Gateway routing:** Vertex IDs are registered deployment names on the CodeMie platform; Claude Desktop must send the **actual** registered ID in `inferenceModels`, not a canonical alias the gateway cannot resolve. Writing `claude-sonnet-4-6-vertex` (not `claude-sonnet-4-6`) is correct for vertex-only tenants.
- **Claude request normalizer** (`claude-request-normalizer.plugin.ts`, scope includes `claude-desktop`): model patterns use embedded version segments with `(?:[^0-9]|$)` boundaries. Names like `claude-opus-4-7-vertex` and `claude-haiku-4-5-vertex` still match existing thinking/no-thinking rules — no change required there for this fix.

---

## Risk Indicators

| Risk | Severity | Detail |
|---|---|---|
| **Regression when both canonical and vertex exist** | Medium | Fix must **prefer non-vertex** IDs when both are present; current tests explicitly require vertex exclusion in mixed lists. |
| **Wrong ID written to Desktop config** | Medium | Curation must emit the **registered** ID (`…-vertex`), not the preferred canonical name, when only vertex exists. |
| **Second error message still possible** | Low | Vertex-only catalogs may lack entries for all four preferred models (e.g. no opus/haiku vertex SKUs). User would then hit *"none matched the preferred CodeMie desktop set"* instead — acceptable partial success vs total failure; document expected behavior. |
| **Dated vertex variants** | Low | Observed pattern is `{base}-vertex`, not `{base}-{date}-vertex`. If dated-vertex IDs appear in the wild, curation may need an additional fallback; not required for the reported IDs. |
| **Provider-based vs suffix-based detection** | Low | Relying on `-vertex` suffix matches current API shape; `provider === "vertex_ai-anthropic_models"` could be a future enhancement but adds coupling to provider string stability. |
| **Duplicated logic vs SSO fetchers** | Low | Longer term, extracting shared “resolve preferred Claude models from llm_models response” would reduce drift; out of scope for minimal fix. |
| **Test policy** | Info | Per repo policy, tests should only be added/updated when explicitly requested; analysis includes recommended test cases for implementer either way. |

---

## Recommended Fix Approach

Minimal, two-part change in `desktop.ts` (plus test updates when requested):

### 1. `fetchClaudeModels` — conditional vertex inclusion

Replace unconditional vertex exclusion with a **prefer-non-vertex, fallback-to-vertex** strategy:

```typescript
const allClaude = ids.filter((id) => /^claude-/i.test(id));
const nonVertex = allClaude.filter((id) => !/-vertex$/i.test(id));
const claudeIds = nonVertex.length > 0 ? nonVertex : allClaude;
```

**Behavior:**

- Mixed catalog (current tests): unchanged — canonical IDs returned, vertex dropped.
- Vertex-only catalog (bug case): vertex IDs returned → discovery succeeds.

Optional: log whether the vertex fallback path was used (`availableClaudeModels`, `usedVertexFallback: true`) for support/debug.

### 2. `selectPreferredClaudeModels` — add vertex suffix fallback

After the dated-variant attempt, before dropping a preferred entry:

```typescript
const vertexId = `${name}-vertex`;
if (availableSet.has(vertexId)) {
  resolved.push(vertexId);
}
```

**Resolution order becomes:** exact → dated → `{name}-vertex`.

When both `claude-sonnet-4-6` and `claude-sonnet-4-6-vertex` exist, step 1 picks the canonical ID (because `fetchClaudeModels` only exposes non-vertex in mixed catalogs).

### 3. Tests to add/update (`desktop.test.ts`)

1. **`fetchClaudeModels` — vertex-only response** → returns `['claude-sonnet-4-6-vertex', …]`.
2. **`fetchClaudeModels` — mixed response** → keep existing assertion (vertex excluded).
3. **`selectPreferredClaudeModels` — vertex fallback** → `['claude-sonnet-4-6-vertex']` for preferred `claude-sonnet-4-6`.
4. **`writeDesktopConfig` — vertex-only mock** → succeeds; `inferenceModels` contains vertex IDs.

### 4. Out of scope (unless product asks)

- Broadening `PREFERRED_CLAUDE_MODELS` for vertex-only tenants (e.g. accepting `claude-sonnet-4-5-vertex` when `4-6` unavailable) — would need version-relaxed matching similar to `setup.ts` tier logic.
- Refactoring shared model discovery with `sso.http-client.ts`.
- Using `provider` metadata instead of suffix heuristics.

---

## Summary

The failure is caused by **over-aggressive vertex filtering** in `fetchClaudeModels`, which assumes canonical Claude registrations always exist. Vertex-only CodeMie deployments expose IDs like `claude-sonnet-4-6-vertex` that are valid gateway model names but are discarded entirely. Fix by falling back to vertex IDs when no non-vertex Claude models exist, and extend `selectPreferredClaudeModels` to resolve `{preferred}-vertex` when canonical/dated matches are absent. The change is localized to `desktop.ts`; no other callers share this filtering logic today.
