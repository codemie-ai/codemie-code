# Conversation Sync Test Fixtures

**Purpose**: Validate Claude session → Codemie conversation transformation

This directory contains real Claude Code session files and their expected transformation outputs for testing the conversation sync functionality.

---

## Structure

```
fixtures/
├── README.md                    # This file
├── sessions/                    # All Claude session JSONL files
│   ├── single-user-message.jsonl      # Small (5 KB)
│   ├── simple-qa.jsonl                # Small (5 KB)
│   ├── unknown-operation-error.jsonl  # Small (1 KB)
│   ├── system-messages-only.jsonl     # Small (1 KB)
│   ├── c3a574c5.jsonl                 # Medium (476 KB)
│   ├── a1f75e0f.jsonl                 # Medium (348 KB)
│   └── b68cb16e.jsonl                 # Medium (319 KB)
└── expected/                    # Expected transformation outputs (golden dataset)
    ├── single-user-message.json
    ├── simple-qa.json
    ├── unknown-operation-error.json
    ├── system-messages-only.json
    ├── c3a574c5-expected.json
    ├── a1f75e0f-expected.json
    └── b68cb16e-expected.json
```

---

## Golden Dataset: Small Sessions

### 1. Single User Message (No Response)

**File**: `single-user-message.jsonl`
**Original Session ID**: `e674ad02-33e2-4bf2-9319-762534d36f0e`
**Scenario**: User sends "show tools", encounters API errors (403 forbidden)

**Expected Transformation**:
- **History entries**: 2 (User + Assistant with error)
- **User message**: "show tools"
- **Assistant message**: Error summary with API error thoughts
- **Thoughts**: 8 error thoughts (API errors with 403 status)
- **Error structure**: `error: true`, `output_format: 'error'`, `author_type: 'Agent'`

**Key Validation Points**:
- User message has all required fields (`message`, `message_raw`, `history_index`, `date`, `file_names`)
- Assistant message contains error summary
- All 8 API errors preserved as thoughts
- Error thoughts have correct structure

---

### 2. Simple Q&A Session

**File**: `simple-qa.jsonl`
**Original Session ID**: `e7ac541c-f642-4bb5-b970-037eeb324655`
**Scenario**: User asks "show tools", gets successful response with intermediate thinking

**Expected Transformation**:
- **History entries**: 2 (User + Assistant)
- **User message**: "show tools"
- **Assistant message**: Full tool listing response
- **Input tokens**: 20
- **Output tokens**: 593
- **Cache creation tokens**: 77,484
- **Cache read tokens**: 0
- **Response time**: 16.23 seconds
- **Thoughts**: 1 intermediate response thought (Agent type)

**Key Validation Points**:
- Token metrics populated correctly
- Response time calculated from user → assistant timestamps
- Intermediate assistant response preserved as Agent thought
- Thought has `metadata.type: 'intermediate_response'`
- AssistantId populated correctly

---

### 3. UnknownOperationException Error

**File**: `unknown-operation-error.jsonl`
**Original Session ID**: `4f696351-4842-4a14-847d-92c0c78ea31b`
**Scenario**: Operation fails with `UnknownOperationException`

**Expected Transformation**:
- **History entries**: 2 (User + Assistant with error)
- **User message**: Command that triggered error
- **Assistant message**: Contains "Error: UnknownOperationException"
- **Thoughts**: 1 error thought

**Key Validation Points**:
- Error thought: `error: true`, `output_format: 'error'`
- Assistant message includes error details
- Error metadata preserved in thought

---

### 4. System Messages Only (Filtered Out)

**File**: `system-messages-only.jsonl`
**Original Session ID**: `13ffbdb2-f857-433f-86c0-fafb337b4120`
**Scenario**: Session contains only system messages (Caveat + Unknown command)

**Expected Transformation**:
- **History entries**: 0 (all filtered out)
- **Reason**: System messages and conversation splitters are filtered

**Key Validation Points**:
- Empty history array
- AssistantId and folder still populated
- No errors during transformation

---

## Golden Dataset: Medium Sessions

### 1. Session c3a574c5 - Baseline with Extensive Tool Usage

**File**: `c3a574c5.jsonl`
**Size**: 476 KB (173 lines)
**Original Session ID**: `c3a574c5-3ba6-4307-b123-b48a5d021db8`
**Scenario**: `/memory-refresh` command with extensive file reads and edits

**Expected Transformation**:
- **History entries**: 2 (User + Assistant)
- **User message**: "/memory-refresh"
- **Assistant message**: Comprehensive audit summary
- **Input tokens**: 9,748
- **Output tokens**: 12,798
- **Cache creation tokens**: 920,251
- **Cache read tokens**: 4,974,428
- **Agent thoughts**: 35 (meta message + intermediate responses)
- **Tool thoughts**: 64 (Glob, Read, Edit operations)

**Key Validation Points**:
- All 64 tool calls preserved as Tool thoughts
- 35 intermediate responses preserved as Agent thoughts
- Token metrics accurate
- Response time calculated

---

### 2. Session a1f75e0f - Multiple Interactions with Interruption

**File**: `a1f75e0f.jsonl`
**Size**: 348 KB (100 lines)
**Original Session ID**: `a1f75e0f-ecc5-4f62-be3d-336b8f0b3928`
**Scenario**: Multiple user-assistant exchanges with "[Request interrupted by user]"

**Expected Transformation**:
- **History entries**: 6 (3 User + 3 Assistant)
- **User messages**: 3 (system message filtered out)
- **Assistant messages**: 3
- **Input tokens**: 767
- **Output tokens**: 7,539
- **Agent thoughts**: 36
- **Tool thoughts**: 26

**Key Validation Points**:
- "[Request interrupted by user]" system message filtered out
- All 3 exchanges preserved correctly
- Token totals accurate across all messages

---

### 3. Session b68cb16e - Session Starting with /clear

**File**: `b68cb16e.jsonl`
**Size**: 319 KB (74 lines)
**Original Session ID**: `b68cb16e-c614-42d1-86fc-f0875d42724d`
**Scenario**: Session file created after `/clear` command (line 3)

**Expected Transformation**:
- **History entries**: 6 (3 User + 3 Assistant)
- **User messages**: 3
- **Assistant messages**: 3
- **Input tokens**: 525
- **Output tokens**: 6,420
- **Agent thoughts**: 20
- **Tool thoughts**: 20

**Key Validation Points**:
- `/clear` command at line 3 correctly filtered out
- All subsequent messages preserved
- No conversation split (single session file = single conversation)

**Note**: `/clear` creates NEW session files, not splits within files. Each `.jsonl` file = 1 conversation.

---

## Regenerating Expected Outputs

If the transformer logic changes, regenerate expected outputs manually:

**Option 1: Using Node REPL**
```javascript
import { readFileSync, writeFileSync } from 'fs';
import { transformMessages } from './dist/providers/plugins/sso/conversations/sync/sso.conversation-transformer.js';

const assistantId = '5a430368-9e91-4564-be20-989803bf4da2';
const folder = 'Claude Imports';

// Read session file
const content = readFileSync('tests/integration/fixtures/conversations/small-sessions/simple-qa.jsonl', 'utf-8');
const messages = content.trim().split('\n').map(line => JSON.parse(line));

// Transform
const history = transformMessages(messages, assistantId, 'Claude Code');
const output = { history, assistantId, folder };

// Save
writeFileSync('tests/integration/fixtures/conversations/expected/simple-qa.json', JSON.stringify(output, null, 2));
```

**Option 2: From Test Output**
1. Run test with console.log(actual)
2. Copy output to expected JSON file
3. Format with `npx prettier --write expected/*.json`

**Important**: Only regenerate when transformer logic intentionally changes. Expected files are the golden dataset for regression testing.

---

## Test Configuration

**Assistant ID**: `5a430368-9e91-4564-be20-989803bf4da2`
**Folder**: `Claude Imports`

These values match the production SSO sync configuration.

---

## Notes

- **Real Data**: All session files are real Claude Code sessions (not mocked)
- **No API Calls**: Tests validate transformation only, no network requests
- **Fast Execution**: Parse once per describe block, validate many times
- **Golden Dataset Pattern**: Expected outputs are source of truth

---

## Related Tests

**Test File**: `tests/integration/conversations/sync.test.ts`

### Test Structure
- **Small Sessions** (4 test suites, 14 tests): Edge cases, errors, filtering
- **Medium Sessions** (3 test suites, 15 tests): Real usage scenarios with tool calls
- **Total**: 29 tests, ~27ms execution time

### Test Pattern
**Parse once in beforeAll, validate many times**:
1. Load session JSONL file from fixtures
2. Transform with `transformMessages()`
3. Compare actual vs expected JSON (`expect(actual).toEqual(expected)`)
4. Additional targeted assertions for specific fields

### Small Session Test Cases
- [S1] Single user message - No response, API errors
- [S2] Simple Q&A session - Show tools with response
- [S3] UnknownOperationException error
- [S4] System messages only - Filtered out

### Medium Session Test Cases
- [M1] c3a574c5 - Extensive tool usage (476 KB)
- [M2] a1f75e0f - Multiple interactions (348 KB)
- [M3] b68cb16e - Session starting with /clear (319 KB)
