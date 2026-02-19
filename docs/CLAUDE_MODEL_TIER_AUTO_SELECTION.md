# Claude Model Tier Auto-Selection

## Overview

Changed the Claude model tier configuration from manual selection to automatic selection during setup.

## Changes Made

### 1. Removed Manual Configuration Prompt

**Before:**
- User was prompted: "Configure model tiers for Claude? (haiku/sonnet/opus)"
- If yes, user manually selected each tier (haiku, sonnet, opus)
- Default was "no" - most users skipped configuration

**After:**
- No prompt - automatic selection for Claude-compatible providers
- Intelligent selection based on available models

### 2. Automatic Model Selection Logic

The new `autoSelectModelTiers()` function implements the following logic:

#### Priority 1: Environment Variables (Highest Priority)
If `ANTHROPIC_DEFAULT_*_MODEL` environment variables are already set, use those:
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` → haiku tier
- `ANTHROPIC_DEFAULT_SONNET_MODEL` → sonnet tier
- `ANTHROPIC_DEFAULT_OPUS_MODEL` → opus tier

This allows users to override automatic selection via environment variables.

#### Priority 2: Automatic Selection from Available Models

If environment variables are not set, auto-select from available models:

1. **Haiku Tier**: Latest haiku model
   - Filter models containing "haiku" (case-insensitive)
   - Parse version numbers from model names
   - Select model with highest version number
   - Example: `claude-haiku-4-5-20251001`

2. **Sonnet Tier**: User's selected model
   - Use the model the user selected during setup
   - This is the default/main model for the profile
   - Example: `claude-4-5-sonnet`

3. **Opus Tier**: Latest opus model
   - Filter models containing "opus" (case-insensitive)
   - Parse version numbers from model names
   - Select model with highest version number
   - Example: `claude-opus-4-6-20260205`

### 3. Version Comparison Logic

The version comparison handles different Claude model naming patterns with intelligent fallback:

**Supported Patterns:**

*Dash-separated:*
- `claude-4-opus` → version `[4]`
- `claude-4-1-opus` → version `[4, 1]`
- `claude-opus-4-5-20251101` → version `[4, 5, 20251101]`
- `claude-opus-4-6-20260205` → version `[4, 6, 20260205]`
- `claude-haiku-4-5-20251001` → version `[4, 5, 20251001]`

*Dot-separated:*
- `claude-haiku-4.5` → version `[4, 5]` (dots normalized to dashes)
- `claude-opus-4.6.20260205` → version `[4, 6, 20260205]`

*Mixed formats:*
- `claude-4.5-sonnet` → version `[4, 5]`
- `claude-opus-4.6-20260205` → version `[4, 6, 20260205]`

**Comparison Algorithm:**
1. Normalize dots to dashes: `4.5` → `4-5`
2. Extract all numeric segments from model name
3. Compare segment-by-segment (left to right)
4. Higher version = newer model
5. Automatically adapts to new versions (e.g., Claude 5, 6, etc.)

**Fallback Behavior:**
- If version parsing fails (no numbers found), falls back to string comparison
- Ensures consistent ordering even for unparseable model names
- Logs warning to debug log when fallback is used
- Example: `claude-opus-latest` vs `claude-opus-beta` → lexical comparison

**Example:**
```
claude-opus-4-5-20251101  vs  claude-opus-4-6-20260205
     ↓                              ↓
   [4, 5, 20251101]            [4, 6, 20260205]
     ↓                              ↓
   4 = 4  (continue)
   5 < 6  (4-6 is newer)
```

Result: `claude-opus-4-6-20260205` is selected as the latest opus model.

## Benefits

1. **Zero Configuration**: Works automatically for most users
2. **Always Latest**: Automatically selects newest models as they're released
3. **Override Capability**: Users can still override via environment variables
4. **Future-Proof**: Handles Claude 4.7, 5.0, etc. without code changes
5. **Flexible Format Support**: Handles dashes, dots, and mixed formats
6. **Robust Fallback**: Works even when version parsing fails
7. **Debug Logging**: Logs fallback usage for troubleshooting

## Example Scenarios

### Scenario 1: Fresh Setup (No Env Vars)

Available models:
- `claude-haiku-4-5-20251001`
- `claude-4-5-sonnet` (user selects this)
- `claude-opus-4-5-20251101`
- `claude-opus-4-6-20260205`

Result:
- Haiku: `claude-haiku-4-5-20251001` (only haiku available)
- Sonnet: `claude-4-5-sonnet` (user's selection)
- Opus: `claude-opus-4-6-20260205` (latest opus: 4.6 > 4.5)

### Scenario 2: Environment Variables Set

User has set:
```bash
export ANTHROPIC_DEFAULT_HAIKU_MODEL=custom-haiku
export ANTHROPIC_DEFAULT_SONNET_MODEL=custom-sonnet
export ANTHROPIC_DEFAULT_OPUS_MODEL=custom-opus
```

Result:
- Haiku: `custom-haiku` (from env var)
- Sonnet: `custom-sonnet` (from env var)
- Opus: `custom-opus` (from env var)

Auto-selection is skipped entirely.

### Scenario 3: Partial Environment Variables

User has set:
```bash
export ANTHROPIC_DEFAULT_OPUS_MODEL=custom-opus
```

Result:
- Haiku: Auto-selected (latest haiku from available models)
- Sonnet: User's selected model
- Opus: `custom-opus` (from env var)

Hybrid approach: env var for opus, auto-select for haiku/sonnet.

### Scenario 4: Future Claude Versions

When Claude 5.0 is released with models like:
- `claude-opus-5-0-20270101`
- `claude-opus-4-6-20260205` (older)

The version parser will:
- Parse `claude-opus-5-0-20270101` → `[5, 0, 20270101]`
- Parse `claude-opus-4-6-20260205` → `[4, 6, 20260205]`
- Compare: `5 > 4` → Select `claude-opus-5-0-20270101`

No code changes needed!

## Technical Details

### Modified Files

- `src/cli/commands/setup.ts`:
  - Replaced `promptForModelTiers()` with `autoSelectModelTiers()`
  - Added `parseModelVersion()` helper
  - Added `compareModelVersions()` helper
  - Updated call site to pass `selectedModel` instead of `providerTemplate`

### Function Signatures

```typescript
// Old (removed)
async function promptForModelTiers(
  models: string[],
  providerTemplate?: any
): Promise<{ haikuModel?: string; sonnetModel?: string; opusModel?: string }>

// New
async function autoSelectModelTiers(
  models: string[],
  selectedModel: string
): Promise<{ haikuModel?: string; sonnetModel?: string; opusModel?: string }>
```

### Data Flow

```
Setup Process
    ↓
Fetch available models from provider
    ↓
User selects default model
    ↓
Check if provider supports Claude (e.g., Bedrock, LiteLLM, SSO)
    ↓
Auto-select model tiers:
  1. Check ANTHROPIC_DEFAULT_*_MODEL env vars
  2. If not set, auto-select from available models:
     - Haiku: latest haiku
     - Sonnet: user's selected model
     - Opus: latest opus
    ↓
Save to profile config (haikuModel, sonnetModel, opusModel)
    ↓
At runtime:
  Profile → CODEMIE_*_MODEL env vars → ANTHROPIC_DEFAULT_*_MODEL env vars → Claude Code
```

## Testing

### Unit Tests

Comprehensive test suite with **31 test cases** covering:

**Version Parsing:**
- ✅ Dash-separated versions: `claude-4-opus` → `[4]`
- ✅ Dot-separated versions: `claude-haiku-4.5` → `[4, 5]`
- ✅ Mixed formats: `claude-4.5-sonnet-v2` → `[4, 5, 2]`
- ✅ Multiple version segments
- ✅ Models without numbers (returns empty array)
- ✅ Edge cases: empty strings, numeric-only strings

**Version Comparison:**
- ✅ Single-segment versions: `claude-4-opus` vs `claude-3-opus`
- ✅ Multi-segment versions: `claude-opus-4-6-20260205` vs `claude-opus-4-5-20251101`
- ✅ Different version lengths: `claude-4-1-opus` vs `claude-4-opus`
- ✅ Dot-formatted versions: `claude-haiku-4.5` vs `claude-haiku-4.4`
- ✅ Mixed formats: `claude-4.5-sonnet` = `claude-4-5-sonnet`
- ✅ Unparseable versions (fallback): `claude-opus-latest` vs `claude-opus-beta`
- ✅ Mixed parseable/unparseable
- ✅ Edge cases: empty strings, identical names

**Model Selection:**
- ✅ Latest opus selection from real Bedrock model list
- ✅ Latest haiku selection with multiple versions
- ✅ Latest sonnet selection
- ✅ Models with date suffixes
- ✅ Unparseable versions (still selects consistently)
- ✅ Mixed parseable/unparseable versions
- ✅ Edge cases: empty array, single model, duplicates

**Integration Tests:**
- ✅ Environment variable priority
- ✅ Mix of env vars and auto-selection
- ✅ Auto-selection without env vars
- ✅ Missing model tiers (returns undefined)

**Test Results:**
```
✓ src/cli/commands/__tests__/model-tier-auto-selection.test.ts (31 tests) 8ms
  Test Files  1 passed (1)
  Tests       31 passed (31)
```

### Manual Testing

Verified logic with sample models from screenshot:

```javascript
Models: [
  'claude-haiku-4-5-20251001',
  'claude-4-opus',
  'claude-4-1-opus',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6-20260205'
]

Results:
- Latest Haiku: 'claude-haiku-4-5-20251001' ✓
- Latest Opus: 'claude-opus-4-6-20260205' ✓ (4.6 > 4.5)
```

**Additional scenarios tested:**
- Dot-separated versions: `claude-haiku-4.6` > `claude-haiku-4.5` ✓
- Mixed formats: `claude-haiku-4.6` = `claude-haiku-4-6` ✓
- Future versions: `claude-opus-6-0` > `claude-opus-5-0` > `claude-opus-4-6` ✓
- Unparseable: `custom-opus-model` (selects consistently via string comparison) ✓

## Migration Notes

**For existing profiles:**
- No migration needed
- Existing `haikuModel`, `sonnetModel`, `opusModel` values remain unchanged
- Only affects new profiles created after this change

**For users with env vars:**
- `ANTHROPIC_DEFAULT_*_MODEL` variables take precedence
- Behavior unchanged - setup respects existing env vars

## Future Enhancements

Potential improvements (not implemented):

1. **Manual Override Option**: Add `--manual-tiers` flag to setup command
2. **Tier Update Command**: `codemie update-tiers` to refresh to latest models
3. **Smart Filtering**: Filter by region/availability (e.g., only select models available in user's region)
4. **Tier Display**: Show selected tiers during setup (for transparency)

## Rollback Plan

To revert to manual selection:

1. Restore `promptForModelTiers()` function from commit `73bddee`
2. Replace `autoSelectModelTiers(models, selectedModel)` with `promptForModelTiers(models, providerTemplate)`
3. Rebuild: `npm run build`

No data migration needed - profile schema unchanged.
