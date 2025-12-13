# Codex Configuration Merge Test Fixtures

This directory contains test fixtures for validating Codex configuration merge and cleanup logic.

## Directory Structure

```
fixtures/codex/
├── README.md                              # This file
├── single-profile-add-ollama/             # Single profile → Add new profile
│   ├── input-auth.json                   # Before session starts
│   ├── input-config.toml                 # Before session starts
│   ├── expected-auth.json                # After session starts (with session keys)
│   └── expected-config.toml              # After session starts (with markers)
├── multi-profile-add-ollama/              # Multiple profiles → Add another
│   ├── input-auth.json                   # Before session starts
│   ├── input-config.toml                 # Before session starts
│   ├── expected-auth.json                # After session starts (with session keys)
│   └── expected-config.toml              # After session starts (with markers)
├── cleanup-after-session/                 # Cleanup after session
│   ├── input-auth.json                   # Before session (also after cleanup)
│   ├── input-config.toml                 # Before session (also after cleanup)
│   ├── expected-auth.json                # After session starts (with session keys)
│   └── expected-config.toml              # After session starts (with markers)
└── empty-config-session/                  # Empty config → Session → Cleanup
    ├── input-auth.json                   # Before session: {} (also after cleanup)
    ├── input-config.toml                 # Before session: empty (also after cleanup)
    ├── expected-auth.json                # After session starts
    └── expected-config.toml              # After session starts (with markers)
```

## Fixture File Logic

- **input files**: Represent the state BEFORE a session starts (also the state after cleanup)
- **expected files**: Represent the state AFTER a session starts (with session markers/keys)
- **Session markers**: Use `ollama-{timestamp}` format where `{timestamp}` is a placeholder for the actual timestamp generated during session creation

## Test Scenarios

### `single-profile-add-ollama/`: Single Profile → Add New Profile

**Initial State**: Codex config with only OpenAI profile

**Action**: Start Codex session with Ollama profile

**Expected Behavior**:
- OpenAI profile preserved
- Ollama profile added
- Active profile set to Ollama
- Auth keys merged (user keys preserved)

**Environment Variables**:
```bash
CODEMIE_PROVIDER=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=not-required
OPENAI_MODEL=qwen3-vl:235b-cloud
```

**Verification Points**:
- `auth.json`: Contains both OpenAI and Ollama credentials
- `config.toml`: Contains both `[profiles.openai]` and `[profiles.ollama]`
- `config.toml`: Active profile is `ollama`
- Project trust settings preserved

### `multi-profile-add-ollama/`: Multiple Profiles → Add Another

**Initial State**: Codex config with OpenAI and Anthropic profiles

**Action**: Start Codex session with Ollama profile

**Expected Behavior**:
- All existing profiles preserved (OpenAI, Anthropic)
- Ollama profile added
- Active profile set to Ollama
- All auth keys merged

**Environment Variables**:
```bash
CODEMIE_PROVIDER=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=not-required
OPENAI_MODEL=qwen3-vl:235b-cloud
```

**Verification Points**:
- `auth.json`: Contains OpenAI, Anthropic, and Ollama credentials
- `config.toml`: Contains 3 profiles (openai, anthropic, ollama)
- `config.toml`: All model providers preserved
- Project trust settings preserved

### `cleanup-after-session/`: Cleanup After Session

**Initial State**: Codex config with temporary session keys

**Action**: End Codex session (cleanup via `afterRun` hook)

**Expected Behavior**:
- Temporary proxy keys removed (`not-required`, `proxy-handled`)
- Session base URLs removed (matching session's base URL)
- User API keys preserved (start with `sk-`, `sk-ant-`, `sk-proj-`)
- Active profile line removed from `config.toml`
- All profiles and model providers preserved

**Environment Variables** (from ended session):
```bash
CODEMIE_PROVIDER=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=not-required
```

**Verification Points**:
- `auth.json`: No `not-required` keys
- `auth.json`: No session base URLs (matching `http://localhost:11434/v1`)
- `auth.json`: User keys preserved (e.g., `sk-ant-user-key`)
- `config.toml`: No `profile = "ollama"` line
- `config.toml`: All profiles and model providers still present

### `empty-config-session/`: Empty Config → Session → Cleanup

**Initial State**: Empty auth.json and config.toml files

**Action**: Start Codex session, modify config during session, then cleanup

**Expected Behavior**:
- During session: config.toml populated with profile wrapped in session markers
- Session markers: `# --- CODEMIE SESSION START: <provider> ---` and `# --- CODEMIE SESSION END: <provider> ---`
- After cleanup: config.toml returns to empty state (all session-marked content removed)
- Empty auth.json remains empty

**Environment Variables**:
```bash
CODEMIE_PROVIDER=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=not-required
OPENAI_MODEL=qwen3-vl:235b-cloud
```

**Verification Points**:
- Initial: both files empty (`{}` for auth.json, empty string for config.toml)
- During session: config.toml contains profile and provider info wrapped in session markers
- During session: content includes `# --- CODEMIE SESSION START: ollama ---` and `# --- CODEMIE SESSION END: ollama ---`
- After cleanup: both files return to empty state
- No configuration persisted when starting from scratch

**Key Implementation Detail**:
The cleanup logic removes content between session markers, allowing for:
- Complete removal of session-added configuration when starting from empty
- Preservation of pre-existing profiles when adding to existing config

## Usage in Tests

The integration test `tests/integration/codex-config-merge.test.ts` uses these fixtures to validate:

### Merge Logic (`beforeRun` hook):
1. **Profile Preservation**: Existing profiles not overwritten
2. **Section Preservation**: All TOML sections preserved (model_providers, profiles, projects)
3. **Auth Merging**: Existing auth keys preserved, new keys added
4. **Atomic Writes**: Files never corrupted during write

### Cleanup Logic (`afterRun` hook):
1. **Selective Removal**: Only session-specific keys removed
2. **User Data Preservation**: Real API keys never removed
3. **Config Changes**: Handles config modified by other processes during session
4. **Base URL Matching**: Only removes base URLs matching session's URL

## File Format Examples

**Note**: All examples use realistic Codex configuration from [OpenAI Codex Documentation](https://developers.openai.com/codex/local-config/)

### `input-auth.json`
```json
{
  "OPENAI_API_KEY": "sk-proj-abc123def456...",
  "MISTRAL_API_KEY": "mistral-api-key-xyz..."
}
```

### `input-config.toml`
```toml
# Codex configuration file
model = "gpt-4o"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[model_providers.openai-chat-completions]
name = "OpenAI using Chat Completions"
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"
wire_api = "chat"

[profiles.openai]
model_provider = "openai-chat-completions"
model = "gpt-4o"

[features]
streamable_shell = true
web_search_request = true

[projects."/Users/dev/my-app"]
trust_level = "trusted"
```

### `expected-config.toml` (after merge with session markers)
```toml
# --- CODEMIE SESSION START: ollama ---
# CodeMie-managed configuration
# Set active profile
profile = "ollama"

[model_providers.ollama]
name = "ollama"
base_url = "http://localhost:11434/v1"

[model_providers.openai-chat-completions]
name = "OpenAI using Chat Completions"
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"
wire_api = "chat"

[profiles.ollama]
model_provider = "ollama"
model = "qwen3-vl:235b-cloud"

[profiles.openai]
model_provider = "openai-chat-completions"
model = "gpt-4o"

# --- CODEMIE SESSION END: ollama ---
# Codex configuration file
model = "gpt-4o"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[features]
streamable_shell = true
web_search_request = true

[projects."/Users/dev/my-app"]
trust_level = "trusted"
```

## Test Execution

Run integration tests with fixtures:

```bash
npm run test:run -- tests/integration/codex-config-merge.test.ts
```

**Expected Result**: All tests passing ✅

## Regenerating Fixtures

To update fixtures:

1. **Modify scenario**: Edit `input-*.json` / `input-*.toml` files
2. **Run merge logic**: Execute `beforeRun` hook with environment variables
3. **Capture output**: Copy resulting files to `expected-*.json` / `expected-*.toml`
4. **Run cleanup logic**: Execute `afterRun` hook
5. **Capture cleanup output**: For scenario-3, copy cleaned files to expected files

Or use the helper function in tests:

```typescript
// Generate expected output from input files
await generateExpectedOutput(
  'single-profile-add-ollama',
  {
    CODEMIE_PROVIDER: 'ollama',
    OPENAI_BASE_URL: 'http://localhost:11434/v1',
    OPENAI_API_KEY: 'not-required',
    OPENAI_MODEL: 'qwen3-vl:235b-cloud'
  }
);
```

## Notes

- **Input files**: Hand-crafted configurations representing common scenarios
- **Expected output files**: Generated by running actual merge/cleanup logic
- Files use **JSON** (auth.json) and **TOML** (config.toml) formats
- All fixtures are synthetic (no real API keys or secrets)
- Atomic write patterns tested via `.tmp` file detection
- Cleanup logic tested separately from merge logic
