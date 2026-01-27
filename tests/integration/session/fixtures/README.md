# Session Test Fixtures

Real Claude session files used for integration testing.

## session-9eda1058.jsonl

**Session ID:** `9eda1058-9706-484a-b992-d03f9cfa2546`

**Description:** Multi-turn conversation session with tool calls and system messages

**Statistics:**
- **Total lines:** 40
- **Snapshots:** 3
- **Total user messages:** 7
  - **User text prompts (string):** 3
  - **User text prompts (array):** 1
  - **Tool result messages:** 3
- **System messages:** 1 ("[Request interrupted by user for tool use]")
- **Tool calls:** 3

**Expected Sync Output:**
- **Turns:** 3 (one per user prompt)
- **History indices:** 0, 1, 2
- **Conversation records:** ~20 (3 new turns + ~17 continuations)
- **Tool calls extracted:** 3
- **Thinking blocks:** 7+

**Use Cases:**
- Multi-turn conversation sync
- Turn boundary detection
- System message filtering
- Tool call extraction across turns
- Incremental sync with partial data

---

## session-3fe1b6bc.jsonl

**Session ID:** `3fe1b6bc-dbd0-4320-b980-4f147befa187`

**Description:** Medium-length conversation session with 10 conversation turns and extensive tool usage

**Statistics:**
- **Total lines:** 275
- **Snapshots:** 10
- **Total user messages:** 89
  - **User text prompts (string):** 11
  - **User text prompts (array):** 2
  - **Tool result messages:** 76
- **Tool calls:** 76

**Expected Sync Output:**
- **Turns:** 10
- **History indices:** 0-9
- **Tool calls extracted:** 76

**Use Cases:**
- Testing with medium-length sessions (10-15 turns)
- High tool usage validation (76 tool calls)
- Multi-snapshot sessions (10 snapshots)
- Validating incremental sync performance

---

## session-196820da.jsonl

**Session ID:** `196820da-1026-4b6f-a513-a6aae42da1a6`

**Description:** Long conversation session with 13 conversation turns and extensive tool usage

**Statistics:**
- **Total lines:** 233
- **Snapshots:** 15
- **Total user messages:** 81
  - **User text prompts (string):** 16
  - **User text prompts (array):** 0
  - **Tool result messages:** 65
- **Tool calls:** 65

**Expected Sync Output:**
- **Turns:** 13
- **History indices:** 0-12
- **Tool calls extracted:** 65

**Use Cases:**
- Testing with longer sessions (13 turns)
- High tool usage validation (65 tool calls)
- Multi-snapshot sessions (15 snapshots)
- Performance testing for incremental sync

---

## session-624a4a58.jsonl

**Session ID:** `624a4a58-b34c-462d-a70d-13421c8125a8`

**Description:** Long conversation session with 15 conversation turns, upper bound of 10-20 turn range

**Statistics:**
- **Total lines:** 222
- **Snapshots:** 18
- **Total user messages:** 69
  - **User text prompts (string):** 18
  - **User text prompts (array):** 3
  - **Tool result messages:** 48
- **Tool calls:** 48

**Expected Sync Output:**
- **Turns:** 15
- **History indices:** 0-14
- **Tool calls extracted:** 48

**Use Cases:**
- Testing with longest sessions in the 10-20 turn range
- Multi-snapshot sessions (18 snapshots)
- Stress testing incremental sync
- Validating turn continuation detection
