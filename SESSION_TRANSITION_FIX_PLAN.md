# Session Transition Fix Plan

## Goal
Make `/clear` command follow **Scenario 2 (Stop) + Scenario 1 (Start)** pattern by reusing existing flows without duplication.

---

## Architecture Decision

**Current**: One CodeMie session tracks multiple agent sessions via correlation updates
**Target**: One CodeMie session per agent session (clean separation)

**Impact**: After `/clear`:
- Old CodeMie session ends (status: completed)
- New CodeMie session starts (status: active)
- Agent process continues running with new orchestrator

---

## Phase 1: Extract Common "Stop Session" Logic

### Current State
- Agent stop (exit): Full flow in `BaseAgentAdapter.ts:457-499`
- Transition stop: Partial flow in `SessionOrchestrator.ts:628-724`

### Action: Create Reusable Method

**Location**: `SessionOrchestrator.ts`

**Method**: `async endSession(exitCode: number): Promise<void>`

**Responsibilities**:
1. Call `prepareForExit()` - collect final deltas
2. Return control to caller to execute `onSessionEnd` hook
3. Call `cleanup()` when instructed - trigger immediate sync
4. Call `markSessionComplete(exitCode)` - update session file

**Key Design Points**:
- Does NOT call lifecycle hooks (hooks are environment-specific, called by adapter)
- Provides hooks for caller to inject lifecycle callbacks
- Reusable by both normal exit and transition flows
- No duplication of stop logic

**Pseudocode Flow**:
```
endSession(exitCode, options):
  1. prepareForExit()
  2. if options.beforeCleanup: await options.beforeCleanup()  // Hook injection point
  3. if options.cleanup: await options.cleanup()
  4. markSessionComplete(exitCode)
```

---

## Phase 2: Extract Common "Start Session" Logic

### Current State
- Agent start: Scattered across `BaseAgentAdapter.ts:200-350`
- Transition start: Missing entirely

### Action: Make SessionOrchestrator Reusable

**Current Issues**:
- SessionOrchestrator created once in constructor
- Stored as instance variable
- Can't create new orchestrator for new session

**Changes Needed**:

1. **Make `create()` independently callable**
   - Already static, but need to handle being called mid-process
   - Should NOT close existing orchestrator automatically

2. **Add `destroy()` method**
   - Stop monitoring
   - Clean up resources
   - Close file watchers
   - Prepare orchestrator to be replaced

3. **Allow orchestrator replacement**
   - `BaseAgentAdapter.replaceOrchestrator(newOrchestrator)`
   - Properly destroy old one first
   - Update instance reference

**Pseudocode Flow**:
```
replaceOrchestrator(newOrchestrator):
  1. if (this.sessionOrchestrator):
       await this.sessionOrchestrator.destroy()
  2. this.sessionOrchestrator = newOrchestrator
```

---

## Phase 3: Refactor handleSessionTransition()

### Current Flow (Wrong)
```
handleSessionTransition():
  1. prepareForExit()
  2. Find new session file
  3. Update correlation
  4. Reset sync state
  5. onSessionTransition callback (duplicate END metric)
  6. markSessionComplete()
```

### New Flow (Correct - Scenario 2 + Scenario 1)

**Step 1: End Old Session (Scenario 2)**
```
1. Call endSession(0, {
     beforeCleanup: async () => {
       // Call onSessionEnd hook to send END metric
       await executeOnSessionEnd(adapter, lifecycle, agentName, 0, env)
     },
     cleanup: async () => {
       // Trigger immediate sync via proxy cleanup
       await cleanupProxy()
     }
   })
```

**Step 2: Start New Session (Scenario 1)**
```
2. Create new SessionOrchestrator
   - New sessionId (UUID)
   - Same agentName, provider, project
   - Same working directory
   - New startTime

3. Call onSessionStart hook (sends START metric)
   await executeOnSessionStart(adapter, lifecycle, agentName, newSessionId, env)

4. Initialize new orchestrator
   await newOrchestrator.beforeAgentSpawn()  // Baseline snapshot

5. Wait for new agent session file to appear
   Use transitionTimestamp to filter candidates

6. Correlate new orchestrator with new agent session file
   await newOrchestrator.afterAgentSpawn()

7. Start monitoring new agent session
   await newOrchestrator.startIncrementalMonitoring()

8. Replace orchestrator in adapter
   adapter.replaceOrchestrator(newOrchestrator)
```

**Key Changes**:
- NO custom transition callback logic
- Reuse `executeOnSessionEnd()` for END metric
- Reuse `executeOnSessionStart()` for START metric
- Call `cleanup()` for immediate sync
- Create completely new orchestrator (new session ID)

---

## Phase 4: Remove Duplicated Code

### Delete: Transition Callback Logic

**File**: `BaseAgentAdapter.ts` lines 87-113

**Remove**:
```
onSessionTransition: async (event) => {
  // ... logging ...
  // ❌ DELETE: Direct handler.sendSessionEnd() call
  // ❌ DELETE: All END metric sending logic
}
```

**Replace with**:
```
onSessionTransition: null  // Not needed - using lifecycle hooks instead
```

**Rationale**: END metrics now sent via standard `executeOnSessionEnd()` hook in Phase 3, Step 1

---

## Phase 5: Update BaseAgentAdapter Integration

### Changes to Child Exit Handler

**File**: `BaseAgentAdapter.ts` lines 457-499

**Current**:
```
child.on('exit', async (code) => {
  // Phase 1
  await prepareForExit()
  await executeOnSessionEnd(...)
  await cleanup()

  // Phase 2
  await markSessionComplete(code)
  await executeAfterRun(...)
})
```

**Update to use new `endSession()` method**:
```
child.on('exit', async (code) => {
  // Use extracted method
  await this.sessionOrchestrator.endSession(code, {
    beforeCleanup: async () => {
      await executeOnSessionEnd(this, this.metadata.lifecycle, this.metadata.name, code, env)
    },
    cleanup: async () => {
      await cleanup()
    }
  })

  await executeAfterRun(...)
})
```

**Benefit**: Same stop flow used for both normal exit and transition

---

## Phase 6: Handle Environment State

### Problem
Lifecycle handlers stored in `process.env.__SSO_LIFECYCLE_HANDLER` from old session

### Solution
Create new handler for new session in `executeOnSessionStart()`

**Flow**:
```
Old session:
  - onSessionStart creates handler → stored in env.__SSO_LIFECYCLE_HANDLER
  - onSessionEnd uses handler → sends END metric
  - Handler cleaned up

New session:
  - onSessionStart creates NEW handler → stored in env.__SSO_LIFECYCLE_HANDLER
  - Replaces old handler reference
  - New handler tracks new sessionId
```

**No Code Changes Needed**: Existing `onSessionStart` hook already creates handler and stores it in env

---

## Phase 7: Update SessionStore for Multiple Sessions

### Current Behavior
One file per CodeMie session: `~/.codemie/metrics/sessions/{sessionId}.json`

### After Fix
Multiple files per process:
```
~/.codemie/metrics/sessions/
  ├── c316ee15.json  (old session, status: completed)
  └── NEW-UUID.json  (new session, status: active)
```

### Consideration
**Question**: Should old session file be updated to `status: "transitioned"` instead of `"completed"`?

**Options**:
- A) Keep `"completed"` (current) - simple, but ambiguous
- B) Add `"transitioned"` status - clearer, but adds new state
- C) Add `transitionedTo: "NEW-UUID"` field - provides link between sessions

**Recommendation**: Option C
- Maintains audit trail
- Allows tracking session chains
- Keeps `status: "completed"` for consistency

**Implementation**:
```
Old session file:
{
  "sessionId": "c316ee15",
  "status": "completed",
  "endTime": 1768135047792,
  "transitionedTo": "NEW-UUID",  // Added field
  "correlation": {
    "agentSessionId": "7a276c6b"  // OLD agent session
  }
}

New session file:
{
  "sessionId": "NEW-UUID",
  "status": "active",
  "startTime": 1768135047800,
  "transitionedFrom": "c316ee15",  // Added field
  "correlation": {
    "agentSessionId": "79ee2d1b"  // NEW agent session
  }
}
```

---

## Phase 8: Update Periodic Sync Logic

### Current Issue
Periodic sync (`SSOSessionSyncPlugin`) runs every 2 minutes on THE session orchestrator

### After Fix
Need to sync correct (active) session after transition

### Solution
**Option A**: Update periodic sync to use current orchestrator reference
```
// In SSOSessionSyncPlugin
setInterval(() => {
  const currentOrchestrator = adapter.sessionOrchestrator  // Gets latest
  await processSession(currentOrchestrator.getSession())
}, 120000)
```

**Option B**: Stop periodic sync on old orchestrator, start on new
```
// Old orchestrator
oldOrchestrator.stopPeriodicSync()

// New orchestrator
newOrchestrator.startPeriodicSync()
```

**Recommendation**: Option A (simpler, already references adapter's current orchestrator)

---

## Phase 9: Update Logging

### Add Transition Context

**Location**: `SessionOrchestrator.ts` - `handleSessionTransition()`

**Additional Logs Needed**:
```
1. "[SessionOrchestrator] Ending old session: {oldSessionId}"
2. "[SessionOrchestrator] OLD session END metric sent"
3. "[SessionOrchestrator] OLD session sync complete"
4. "[SessionOrchestrator] OLD session marked completed"
5. "[SessionOrchestrator] Creating new session: {newSessionId}"
6. "[SessionOrchestrator] NEW session START metric sent"
7. "[SessionOrchestrator] NEW session correlated with agent file: {agentSessionId}"
8. "[SessionOrchestrator] NEW session monitoring started"
9. "[SessionOrchestrator] ✓ Transition complete: {oldSessionId} → {newSessionId}"
```

**Prefix**: All logs should maintain CodeMie session context
- During old session end: `[{oldSessionId}]`
- During new session start: `[{newSessionId}]`

---

## Phase 10: Testing Strategy

### Test Cases

**Test 1: Normal Agent Exit**
```
Start agent → send message → exit agent
Verify:
- One session file created
- START metric sent
- END metric sent
- Session status: completed
- All deltas synced
```

**Test 2: Single /clear**
```
Start agent → send message → /clear → verify
Verify:
- Two session files created (old, new)
- Old session: status completed, has transitionedTo
- New session: status active, has transitionedFrom
- OLD session END metric sent
- NEW session START metric sent
- Old session deltas synced immediately
- New session monitoring active
```

**Test 3: Multiple /clear**
```
Start agent → msg1 → /clear → msg2 → /clear → msg3 → exit
Verify:
- Three session files created
- Each session: proper status, transition links
- END metrics for sessions 1, 2, 3
- START metrics for sessions 1, 2, 3
- All deltas synced
- Proper session chain: s1 → s2 → s3
```

**Test 4: /clear Without Activity**
```
Start agent → /clear immediately (no messages) → verify
Verify:
- Two session files
- No deltas to sync (empty)
- Metrics still sent (START/END)
- Transition successful
```

**Test 5: Rapid /clear**
```
Start agent → /clear → /clear → /clear (rapid succession)
Verify:
- All transitions complete successfully
- No race conditions
- Proper session chain
- All metrics sent
```

---

## Implementation Order

1. **Phase 1**: Extract `endSession()` method
2. **Phase 6**: Verify environment state handling (may need no changes)
3. **Phase 2**: Add `destroy()` and `replaceOrchestrator()`
4. **Phase 3**: Refactor `handleSessionTransition()` to use extracted methods
5. **Phase 4**: Remove duplicated callback code
6. **Phase 5**: Update `BaseAgentAdapter` exit handler
7. **Phase 7**: Add transition tracking fields to session store
8. **Phase 8**: Verify periodic sync works with orchestrator replacement
9. **Phase 9**: Add comprehensive logging
10. **Phase 10**: Test all scenarios

---

## Rollback Plan

If issues arise:

1. **Immediate**: Revert to correlation update approach (current behavior)
2. **Log Analysis**: Check which phase failed
3. **Incremental Rollback**: Revert phases one at a time
4. **Feature Flag**: Add `ENABLE_SESSION_TRANSITION_V2` env var for gradual rollout

---

## Success Criteria

✅ **No Code Duplication**
- END metric logic exists in ONE place: `executeOnSessionEnd()` hook
- Stop logic exists in ONE place: `endSession()` method
- Start logic reuses existing orchestrator initialization

✅ **Scenario 2 Compliance**
- `prepareForExit()` called ✓
- `executeOnSessionEnd()` called (END metric) ✓
- `cleanup()` called (immediate sync) ✓
- `markSessionComplete()` called ✓

✅ **Scenario 3 Compliance**
- Executes complete Scenario 2 for old session ✓
- Executes complete Scenario 1 for new session ✓
- Agent process continues running ✓

✅ **Proper Session State**
- Old session: `status: "completed"`, has `transitionedTo`
- New session: `status: "active"`, has `transitionedFrom`
- Separate session files with proper IDs

✅ **Metrics Sent Correctly**
- START metric when session begins
- END metric when session ends (including via /clear)
- Immediate sync on transition (not waiting 2 minutes)

✅ **Logging Clear**
- All steps logged with session context
- Transition chain visible in logs
- Easy to debug issues

---

## Risk Assessment

### Low Risk
- Phase 1, 2: Extracting methods (isolated changes)
- Phase 4: Removing code (simplification)
- Phase 9: Adding logs (observability)

### Medium Risk
- Phase 3: Refactoring transition (core logic change)
- Phase 5: Updating exit handler (affects all exits)
- Phase 7: Session store changes (schema change)

### High Risk
- Phase 8: Periodic sync with orchestrator replacement (race conditions possible)

### Mitigation
- Comprehensive testing (Phase 10)
- Gradual rollout with feature flag
- Monitor logs closely after deployment
- Have rollback plan ready

---

## Estimated Complexity

**Lines of Code Changed**: ~300-400 lines
**Files Modified**: 3 core files
- `SessionOrchestrator.ts` (~150 lines)
- `BaseAgentAdapter.ts` (~100 lines)
- `SessionStore.ts` (~50 lines)

**New Tests**: 5 integration tests (Phase 10)

**Time Estimate**:
- Implementation: 4-6 hours
- Testing: 2-3 hours
- Review & Refinement: 1-2 hours
- **Total**: ~7-11 hours

---

## Future Considerations

### Potential Enhancements (Not in Scope)
1. Session transition history in separate log file
2. Metrics dashboard showing session chains
3. Automatic cleanup of old session files
4. Session transition analytics (avg transitions per hour, etc.)
5. Recovery mechanism if transition fails mid-process

### Technical Debt to Address Later
1. Consider separating SessionOrchestrator into smaller classes
2. Add state machine for session lifecycle
3. Formalize transition event system
4. Add transaction support for session store operations
