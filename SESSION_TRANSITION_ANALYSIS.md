# Session Transition Logic Analysis

## Expected Behavior (User Requirements)

### Scenario 1: Agent Start
1. Session created
2. Logged
3. Correlated with agent session file
4. CodeMie session file created
5. Metrics and conversation synced and sent via API
6. Clear logs indicating process

### Scenario 2: Agent Stop
1. Session marked as completed
2. File updated
3. Final metrics sent
4. Final conversation sent

### Scenario 3: /clear Command
**Should be**: Scenario 2 (end old) + Scenario 1 (start new)
- Execute complete "stop" flow for old session
- Execute complete "start" flow for new session
- Agent process continues running
- No code duplication

---

## Current Implementation Analysis

### ✅ Scenario 1: Agent Start (COMPLIES)

**File**: `BaseAgentAdapter.ts` lines 200-350

**Flow**:
```
1. SessionOrchestrator.create()
   └─ SessionStore.createSession() → creates ~/.codemie/metrics/sessions/{id}.json

2. executeOnSessionStart() → SSO hook
   └─ handler.sendSessionStart() → sends START metric via API
   └─ Logged: "[SSO] Sending session start metric..."

3. beforeAgentSpawn()
   └─ FileSnapshotter.snapshot() → baseline snapshot

4. Agent spawns

5. afterAgentSpawn()
   └─ SessionCorrelator.correlateWithRetry()
   └─ Updates session.correlation.agentSessionFile
   └─ SessionStore.saveSession()
   └─ Logged: "[SessionCorrelator] Session matched: {agentSessionId}"

6. startIncrementalMonitoring()
   └─ File watcher on agent session file
   └─ DeltaWriter collects metrics to _metrics.jsonl

7. SSOSessionSyncPlugin periodic sync (every 2 minutes)
   └─ MetricsProcessor: syncs deltas → API
   └─ ConversationsProcessor: syncs messages → API
```

**Status**: ✅ **COMPLIES** - All steps present, properly logged, metrics sent

---

### ✅ Scenario 2: Agent Stop (COMPLIES)

**File**: `BaseAgentAdapter.ts` lines 457-499

**Flow**:
```
1. prepareForExit()
   └─ stopMonitoring() → stops file watcher
   └─ collectFinalDeltas() → writes remaining deltas to _metrics.jsonl
   └─ Logged: "[SessionOrchestrator] Scanning session for new activity..."

2. executeOnSessionEnd() → SSO hook
   └─ handler.sendSessionEnd(exitCode) → sends END metric via API
   └─ Logged: "[SSO] Sending session end metric (exitCode={code})..."

3. cleanup()
   └─ Proxy stop triggers SSOSessionSyncPlugin.onProxyStop()
   └─ processSession() runs ALL processors:
       ├─ MetricsProcessor: syncs _metrics.jsonl deltas → API
       └─ ConversationsProcessor: syncs agent session messages → API
   └─ Logged: "[sso-session-sync] Processed session {id}"
   └─ Logged: "[metrics] Successfully synced X deltas"
   └─ Logged: "[conversations] Successfully synced conversation"

4. markSessionComplete(code)
   └─ session.status = 'completed'
   └─ session.endTime = Date.now()
   └─ SessionStore.saveSession()
   └─ Logged: "[SessionOrchestrator] Session marked as completed"

5. executeAfterRun() → optional cleanup hook
```

**Status**: ✅ **COMPLIES** - All steps present, properly logged, metrics sent

---

### ❌ Scenario 3: /clear Command (DOES NOT COMPLY)

**File**: `SessionOrchestrator.ts` lines 628-724

**Current Flow**:
```
1. prepareForExit()
   └─ ✅ Same as Scenario 2 step 1

2. onSessionTransition() callback → BaseAgentAdapter.ts lines 87-113
   └─ ❌ DUPLICATE: handler.sendSessionEnd(0) called directly
   └─ ❌ NOT using executeOnSessionEnd() hook
   └─ Logged: "[claude] Sending END metric for old session: {oldId}"

3. ❌ MISSING: cleanup() is NOT called
   └─ No final sync triggered!
   └─ Metrics deltas NOT sent immediately
   └─ Conversation NOT sent immediately
   └─ Will sync on next periodic cycle (2 minutes later)

4. markSessionComplete(0)
   └─ ✅ Same as Scenario 2 step 4

5. ❌ MISSING: No "Scenario 1" flow for new session
   └─ No executeOnSessionStart() → no START metric
   └─ No beforeAgentSpawn()
   └─ Just updates correlation: old agent session → new agent session
   └─ Resets sync state counters
   └─ Same CodeMie session continues (not a new session)
```

**Status**: ❌ **DOES NOT COMPLY**

---

## Critical Issues Found

### Issue 1: Code Duplication

**Location**: `BaseAgentAdapter.ts` lines 95-110

```typescript
// DUPLICATE LOGIC - shouldn't exist
onSessionTransition: async (event) => {
  // ...
  const handler = env.__SSO_LIFECYCLE_HANDLER;
  if (handler) {
    logger.info(`Sending END metric for old session: ${event.oldSessionId}`);
    await handler.sendSessionEnd(0);  // ❌ DUPLICATE!
    logger.info(`END metric sent for old session`);
  }
}
```

**Problem**: This duplicates the logic from `executeOnSessionEnd()` hook (Scenario 2, step 2). Should reuse existing hook mechanism instead.

---

### Issue 2: Missing cleanup() Call

**Location**: `SessionOrchestrator.ts` lines 720-723

```typescript
// Mark session complete - final sync will process BOTH old and new correlations
// Processors will send END metrics for old session + START metrics for new
logger.info(`[SessionOrchestrator] Marking session complete for final sync`);
await this.markSessionComplete(0);  // ❌ No cleanup() before this!
```

**Problem**:
- Comment says "final sync will process" but NO sync is triggered
- `cleanup()` (which triggers `SSOSessionSyncPlugin.onProxyStop()`) is never called
- Final metrics/conversations NOT sent immediately
- Relies on periodic sync (2 minutes later)

**Evidence from logs**:
```
12:37:27 - Transition complete
12:37:27 - Session marked as completed
12:38:25 - [sso-session-sync] Processing correlated session  ← 58 seconds later!
```

---

### Issue 3: Doesn't Create New Session

**Location**: `SessionOrchestrator.ts` lines 690-702

```typescript
// Update correlation to point to new agent session
await this.store.updateSessionCorrelation(this.sessionId, correlation);
this.session!.correlation = correlation;

// Reset sync state for new session
if (this.session!.sync?.metrics) {
  this.session!.sync.metrics.lastProcessedLine = 0;
  this.session!.sync.metrics.processedRecordIds = [];
  // ...
}
```

**Problem**: This just updates the SAME CodeMie session to track a different agent session. It does NOT:
- Create a new CodeMie session with new ID
- Send START metric for new session
- Execute full Scenario 1 flow

**Current behavior**:
- CodeMie session `c316ee15` started tracking agent session `7a276c6b`
- After `/clear`: CodeMie session `c316ee15` now tracks agent session `79ee2d1b`
- Still the SAME CodeMie session, just different correlation

**Expected behavior** (based on user requirements):
- CodeMie session `c316ee15` ends (Scenario 2 complete flow)
- New CodeMie session `NEW-ID` starts tracking `79ee2d1b` (Scenario 1 complete flow)

---

### Issue 4: Incorrect Session Status

**Problem**: After transition, session is marked `status: "completed"` but agent process continues running.

**Current**:
```json
{
  "sessionId": "c316ee15",
  "status": "completed",  ← ❌ Wrong! Process still running
  "endTime": 1768135047792,
  "correlation": {
    "agentSessionId": "79ee2d1b"  ← New agent session
  }
}
```

**Expected** (if following Scenario 2 + Scenario 1):
```json
// OLD session (ended)
{
  "sessionId": "c316ee15",
  "status": "completed",  ← ✅ Correct
  "endTime": 1768135047792,
  "correlation": {
    "agentSessionId": "7a276c6b"  ← OLD agent session
  }
}

// NEW session (active)
{
  "sessionId": "NEW-UUID",
  "status": "active",  ← ✅ Correct
  "startTime": 1768135047800,
  "correlation": {
    "agentSessionId": "79ee2d1b"  ← NEW agent session
  }
}
```

---

## Compliance Summary

| Scenario | Requirement | Current Implementation | Complies? |
|----------|-------------|------------------------|-----------|
| **1. Agent Start** | Session created, logged, correlated | ✅ Full flow implemented | ✅ YES |
| | Metrics sent via API | ✅ START metric sent | ✅ YES |
| | Clear logs | ✅ All steps logged | ✅ YES |
| **2. Agent Stop** | Session marked completed | ✅ markSessionComplete() | ✅ YES |
| | File updated | ✅ saveSession() | ✅ YES |
| | Final metrics sent | ✅ END metric via hook | ✅ YES |
| | Final conversation sent | ✅ cleanup() triggers sync | ✅ YES |
| **3. /clear** | Must execute Scenario 2 | ❌ Partial (missing cleanup) | ❌ NO |
| | Must execute Scenario 1 | ❌ Just updates correlation | ❌ NO |
| | Agent continues running | ✅ Process continues | ✅ YES |
| | No code duplication | ❌ sendSessionEnd() duplicated | ❌ NO |

---

## What Should Change

To comply with user requirements, `/clear` should:

### 1. Reuse Scenario 2 (Stop) Flow

```typescript
// Instead of custom transition logic, call existing hooks:
await this.prepareForExit();                    // ✅ Already doing this
await executeOnSessionEnd(exitCode=0);          // ❌ Need to add
await cleanup();                                // ❌ Need to add - triggers sync
await this.markSessionComplete(0);              // ✅ Already doing this
```

### 2. Reuse Scenario 1 (Start) Flow

```typescript
// Create NEW orchestrator for new session:
const newOrchestrator = await SessionOrchestrator.create(...);
await executeOnSessionStart(newSessionId);      // Sends START metric
await newOrchestrator.beforeAgentSpawn();       // Baseline snapshot
await newOrchestrator.afterAgentSpawn();        // Correlate new file
await newOrchestrator.startIncrementalMonitoring();
```

### 3. Remove Duplicated Code

**Delete**: `BaseAgentAdapter.ts` lines 95-110 (transition callback END metric logic)

**Use**: Existing `executeOnSessionEnd()` hook mechanism

---

## Benefits of Compliance

1. **No Duplication**: Reuse existing hook system
2. **Simpler Logic**: `/clear` = stop + start
3. **Immediate Sync**: cleanup() triggers sync, not waiting 2 minutes
4. **Proper Metrics**: END metric for old session, START metric for new session
5. **Correct State**: Old session marked completed, new session marked active
6. **Better Tracking**: Separate CodeMie sessions for separate agent invocations

---

## Current Architecture Issue

**Fundamental problem**: The system assumes **one CodeMie session = one agent process lifecycle**.

But `/clear` creates **multiple agent sessions within one process**, which violates this assumption.

**Two possible architectures**:

### Option A: One CodeMie Session Tracks Multiple Agent Sessions (Current)
- Pro: Simple, one session file
- Con: Doesn't follow user's Scenario 2 + Scenario 1 model
- Con: Session marked "completed" while process still running

### Option B: One CodeMie Session Per Agent Session (User's Expectation)
- Pro: Clean separation, follows Scenario 2 + Scenario 1
- Pro: Proper metrics (END for old, START for new)
- Con: More complex (need to create new orchestrator)
- Con: Multiple session files for one process

**User clearly expects Option B** based on the requirements.
