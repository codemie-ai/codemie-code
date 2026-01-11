# Session Transition Implementation Checklist

## Pre-Implementation Setup

### ☐ Preparation
- [ ] Read `SESSION_TRANSITION_ANALYSIS.md` completely
- [ ] Read `SESSION_TRANSITION_FIX_PLAN.md` completely
- [ ] Create feature branch: `git checkout -b fix/session-transition-refactor`
- [ ] Ensure working directory is clean: `git status`
- [ ] Run baseline tests: `npm test`
- [ ] Note baseline test results: _____ tests passing

### ☐ Backup Current Implementation
- [ ] Create backup of key files:
  ```bash
  cp src/agents/core/session/SessionOrchestrator.ts src/agents/core/session/SessionOrchestrator.ts.backup
  cp src/agents/core/BaseAgentAdapter.ts src/agents/core/BaseAgentAdapter.ts.backup
  cp src/agents/core/session/SessionStore.ts src/agents/core/session/SessionStore.ts.backup
  ```

---

## Phase 1: Extract Common "Stop Session" Logic

### ☐ Step 1.1: Add endSession() Method to SessionOrchestrator

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: Add new method after `markSessionComplete()` (around line 600)

```typescript
/**
 * End session with full stop flow
 * Provides hooks for lifecycle callbacks to be injected by caller
 */
async endSession(
  exitCode: number,
  options?: {
    beforeCleanup?: () => Promise<void>;
    cleanup?: () => Promise<void>;
  }
): Promise<void> {
  // Phase 1: Collect final deltas and stop monitoring
  logger.info('[SessionOrchestrator] Ending session - collecting final metrics');
  await this.prepareForExit();

  // Phase 2: Allow caller to inject lifecycle hooks (e.g., onSessionEnd)
  if (options?.beforeCleanup) {
    logger.debug('[SessionOrchestrator] Executing beforeCleanup callback');
    await options.beforeCleanup();
  }

  // Phase 3: Trigger immediate sync (if cleanup provided)
  if (options?.cleanup) {
    logger.debug('[SessionOrchestrator] Executing cleanup callback');
    await options.cleanup();
  }

  // Phase 4: Mark session as completed
  logger.info('[SessionOrchestrator] Marking session complete');
  await this.markSessionComplete(exitCode);
}
```

**Checklist**:
- [ ] Method added to `SessionOrchestrator` class
- [ ] JSDoc comment explains purpose
- [ ] Parameters documented
- [ ] Logging added for each phase
- [ ] Build succeeds: `npm run build`
- [ ] No TypeScript errors

### ☐ Step 1.2: Verify Compilation
- [ ] Run: `npm run build`
- [ ] No compilation errors
- [ ] No new linting warnings: `npm run lint`

---

## Phase 2: Add Orchestrator Lifecycle Methods

### ☐ Step 2.1: Add destroy() Method to SessionOrchestrator

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: Add after `stopMonitoring()` method (around line 550)

```typescript
/**
 * Destroy orchestrator and clean up resources
 * Called before replacing orchestrator during transition
 */
async destroy(): Promise<void> {
  logger.info('[SessionOrchestrator] Destroying orchestrator');

  // Stop monitoring if active
  if (this.monitoring.isActive) {
    await this.stopMonitoring();
  }

  // Clear any pending timers
  if (this.periodicCheckTimer) {
    clearInterval(this.periodicCheckTimer);
    this.periodicCheckTimer = undefined;
  }

  logger.debug('[SessionOrchestrator] Orchestrator destroyed');
}
```

**Checklist**:
- [ ] Method added to `SessionOrchestrator` class
- [ ] Stops monitoring if active
- [ ] Clears periodic check timer
- [ ] Logging added
- [ ] Build succeeds: `npm run build`

### ☐ Step 2.2: Add replaceOrchestrator() to BaseAgentAdapter

**File**: `src/agents/core/BaseAgentAdapter.ts`

**Action**: Add method after constructor (around line 120)

```typescript
/**
 * Replace session orchestrator with new one
 * Used during session transition to track new session
 */
async replaceOrchestrator(newOrchestrator: SessionOrchestrator): Promise<void> {
  const { logger } = await import('../../utils/logger.js');

  // Destroy old orchestrator if exists
  if (this.sessionOrchestrator) {
    logger.debug(`[${this.metadata.name}] Destroying old orchestrator`);
    await this.sessionOrchestrator.destroy();
  }

  // Set new orchestrator
  this.sessionOrchestrator = newOrchestrator;
  logger.info(`[${this.metadata.name}] Orchestrator replaced with new session: ${newOrchestrator.getSession().sessionId}`);
}
```

**Checklist**:
- [ ] Method added to `BaseAgentAdapter` class
- [ ] Destroys old orchestrator before replacing
- [ ] Updates instance variable
- [ ] Logging added
- [ ] Import `SessionOrchestrator` type if needed
- [ ] Build succeeds: `npm run build`

### ☐ Step 2.3: Add getSession() Helper to SessionOrchestrator

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: Add getter method (around line 200)

```typescript
/**
 * Get current session metadata
 */
getSession(): Session {
  if (!this.session) {
    throw new Error('Session not initialized');
  }
  return this.session;
}
```

**Checklist**:
- [ ] Getter method added
- [ ] Returns session or throws error
- [ ] Build succeeds: `npm run build`

### ☐ Step 2.4: Verify Phase 2
- [ ] Run: `npm run build`
- [ ] No compilation errors
- [ ] Run: `npm run lint`
- [ ] No new warnings

---

## Phase 3: Refactor handleSessionTransition()

### ☐ Step 3.1: Update Method Signature

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: Update `handleSessionTransition()` method (line 628)

**Add parameter for lifecycle execution**:
```typescript
private async handleSessionTransition(
  transitionTimestamp: number,
  lifecycleCallbacks: {
    executeOnSessionEnd: (exitCode: number) => Promise<void>;
    executeOnSessionStart: (sessionId: string) => Promise<void>;
  }
): Promise<void> {
```

**Checklist**:
- [ ] Parameter added to method signature
- [ ] JSDoc updated to document parameters

### ☐ Step 3.2: Implement "End Old Session" Flow

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: Replace lines 634-637 in `handleSessionTransition()`

**Remove**:
```typescript
// Phase 1: End old session (collect final deltas and stop monitoring)
// Note: We call prepareForExit() but DON'T call markSessionComplete() yet
logger.info(`[SessionOrchestrator] Collecting final metrics for ${oldAgentSessionId}`);
await this.prepareForExit();
```

**Replace with**:
```typescript
// ========================================
// STEP 1: End Old Session (Scenario 2)
// ========================================
logger.info(`[SessionOrchestrator] Ending old session: ${oldAgentSessionId}`);

// Use extracted endSession() method
await this.endSession(0, {
  beforeCleanup: async () => {
    // Send END metric via standard lifecycle hook
    logger.info(`[SessionOrchestrator] Sending END metric for old session`);
    await lifecycleCallbacks.executeOnSessionEnd(0);
    logger.info(`[SessionOrchestrator] END metric sent for old session`);
  },
  cleanup: async () => {
    // Trigger immediate sync
    logger.info(`[SessionOrchestrator] Triggering final sync for old session`);
    // Note: Cleanup will be passed from BaseAgentAdapter
  }
});

logger.info(`[SessionOrchestrator] Old session ended and marked completed`);
```

**Checklist**:
- [ ] Old code removed
- [ ] New code using `endSession()` added
- [ ] Lifecycle hooks called via callbacks
- [ ] Comprehensive logging added

### ☐ Step 3.3: Implement "Start New Session" Flow

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: Replace lines 639-723 (entire Phase 2 section)

**Remove**: All correlation update logic (lines 639-723)

**Replace with**:
```typescript
// ========================================
// STEP 2: Start New Session (Scenario 1)
// ========================================
const { randomUUID } = await import('crypto');
const newSessionId = randomUUID();
logger.info(`[SessionOrchestrator] Creating new session: ${newSessionId}`);

// Create new orchestrator for new session
const newOrchestrator = await SessionOrchestrator.create({
  sessionId: newSessionId,
  agentName: this.agentName,
  provider: this.session!.provider,
  project: this.session!.project,
  workingDirectory: this.workingDirectory,
  metricsAdapter: this.metricsAdapter,
  lifecycleAdapter: this.lifecycleAdapter,
  onSessionTransition: this.onSessionTransition // Pass same callback
});

// Send START metric for new session
logger.info(`[SessionOrchestrator] Sending START metric for new session`);
await lifecycleCallbacks.executeOnSessionStart(newSessionId);
logger.info(`[SessionOrchestrator] START metric sent for new session`);

// Initialize new orchestrator (baseline snapshot)
logger.info(`[SessionOrchestrator] Initializing new orchestrator`);
await newOrchestrator.beforeAgentSpawn();

// Find and correlate new agent session file
logger.info(`[SessionOrchestrator] Searching for new agent session file...`);
logger.debug(`[SessionOrchestrator] Transition at: ${new Date(transitionTimestamp).toISOString()}`);

// Helper function to get candidates (same as before)
const { dirname } = await import('path');
const currentDir = dirname(oldSessionFile);

const getCandidates = async (): Promise<FileInfo[]> => {
  const snapshot = await newOrchestrator.snapshotter.snapshot(currentDir);

  const candidates = snapshot.files.filter(f =>
    f.createdAt >= transitionTimestamp - 200 &&
    f.path !== oldSessionFile
  );

  if (candidates.length > 0) {
    logger.debug(`[SessionOrchestrator] Found ${candidates.length} candidate(s)`);
  }

  return candidates;
};

// Get initial candidates
const initialCandidates = await getCandidates();

// Correlate new orchestrator with new agent session file
const correlation = await newOrchestrator.correlator.correlateWithRetry(
  {
    sessionId: newSessionId,
    agentName: this.agentName,
    workingDirectory: this.workingDirectory,
    newFiles: initialCandidates,
    agentPlugin: this.metricsAdapter
  },
  getCandidates
);

if (correlation.status !== 'matched') {
  logger.error(`[SessionOrchestrator] Failed to find new session after ${correlation.retryCount} retries`);
  throw new Error('Failed to correlate new session after transition');
}

const newAgentSessionId = correlation.agentSessionId!;
logger.info(`[SessionOrchestrator] New session correlated with agent file: ${newAgentSessionId}`);

// Update new orchestrator's correlation
newOrchestrator.session!.correlation = correlation;
await newOrchestrator.store.saveSession(newOrchestrator.session!);

// Start monitoring new agent session
logger.info(`[SessionOrchestrator] Starting monitoring for new session`);
await newOrchestrator.startIncrementalMonitoring();

// ========================================
// STEP 3: Complete Transition
// ========================================
logger.info(
  `[SessionOrchestrator] ✓ Transition complete: ` +
  `${oldAgentSessionId} (${this.sessionId}) → ${newAgentSessionId} (${newSessionId})`
);

// Return new orchestrator so caller can replace it
return newOrchestrator;
```

**Checklist**:
- [ ] Old correlation update code removed
- [ ] New session creation added
- [ ] START metric sent via callback
- [ ] New orchestrator initialized
- [ ] Correlation performed
- [ ] Monitoring started
- [ ] Comprehensive logging added
- [ ] Returns new orchestrator

### ☐ Step 3.4: Update Method Return Type

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: Change return type of `handleSessionTransition()`

**Change from**:
```typescript
private async handleSessionTransition(...): Promise<void> {
```

**Change to**:
```typescript
private async handleSessionTransition(...): Promise<SessionOrchestrator> {
```

**Checklist**:
- [ ] Return type updated to `Promise<SessionOrchestrator>`
- [ ] Method returns `newOrchestrator` at end

### ☐ Step 3.5: Update handleLifecycleEvent() Caller

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: Find where `handleSessionTransition()` is called (in `handleLifecycleEvent()`)

**Change from**:
```typescript
await this.handleSessionTransition(event.timestamp);
```

**Change to**:
```typescript
// Note: We'll need access to lifecycle callbacks and adapter
// This will be fixed in Phase 5
// For now, add TODO comment:
// TODO: Update in Phase 5 to pass lifecycle callbacks and handle orchestrator replacement
await this.handleSessionTransition(event.timestamp, {
  executeOnSessionEnd: async () => { /* TODO */ },
  executeOnSessionStart: async () => { /* TODO */ }
});
```

**Checklist**:
- [ ] TODO comment added
- [ ] Temporary callbacks added (will be fixed in Phase 5)

### ☐ Step 3.6: Build and Verify Phase 3
- [ ] Run: `npm run build`
- [ ] Fix any TypeScript errors
- [ ] Run: `npm run lint`
- [ ] Fix any linting issues

---

## Phase 4: Remove Duplicated Callback Code

### ☐ Step 4.1: Remove Transition Callback Logic

**File**: `src/agents/core/BaseAgentAdapter.ts`

**Action**: Find `onSessionTransition` callback (lines 87-113)

**Remove entire callback body**:
```typescript
// Lines 95-110 - DELETE ALL OF THIS
// Send END metrics for old agent session
// Access the lifecycle handler stored in env during onSessionStart
const env = process.env as any;
const handler = env.__SSO_LIFECYCLE_HANDLER;
if (handler) {
  logger.info(`[${this.metadata.name}] Sending END metric for old session: ${event.oldSessionId}`);
  try {
    // Send session end with exit code 0 (transition is successful)
    await handler.sendSessionEnd(0);
    logger.info(`[${this.metadata.name}] END metric sent for old session`);
  } catch (error) {
    logger.error(`[${this.metadata.name}] Failed to send END metric:`, error);
  }
} else {
  logger.debug(`[${this.metadata.name}] No lifecycle handler available for END metric`);
}
```

**Replace with simple logging**:
```typescript
onSessionTransition: async (event, newOrchestrator) => {
  const { logger } = await import('../../utils/logger.js');
  const newSessionId = event.newSessionFile.split('/').pop()?.replace('.jsonl', '') || 'unknown';
  logger.info(
    `[${this.metadata.name}] Session transition completed: ` +
    `${event.oldSessionId} → ${newSessionId}`
  );

  // Replace orchestrator
  await this.replaceOrchestrator(newOrchestrator);
}
```

**Checklist**:
- [ ] Duplicate END metric code removed
- [ ] Callback simplified to logging only
- [ ] Orchestrator replacement added
- [ ] Build succeeds: `npm run build`

### ☐ Step 4.2: Update SessionTransitionEvent Type

**File**: `src/agents/core/session/types.ts`

**Action**: Update interface to include new orchestrator

**Find**:
```typescript
export interface SessionTransitionEvent {
  oldSessionId: string;
  newSessionFile: string;
  transitionTimestamp: number;
}
```

**Update to**:
```typescript
export interface SessionTransitionEvent {
  oldSessionId: string;
  newSessionFile: string;
  transitionTimestamp: number;
  newOrchestrator: SessionOrchestrator; // New field
}
```

**Checklist**:
- [ ] Interface updated
- [ ] Import `SessionOrchestrator` type if needed
- [ ] Build succeeds

### ☐ Step 4.3: Verify Phase 4
- [ ] Run: `npm run build`
- [ ] No compilation errors
- [ ] Run: `npm run lint`
- [ ] No warnings

---

## Phase 5: Update BaseAdapterIntegration

### ☐ Step 5.1: Update handleLifecycleEvent() to Pass Callbacks

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: Update the call to `handleSessionTransition()` in `handleLifecycleEvent()`

**Locate**: The TODO comment we added in Step 3.5

**Replace**:
```typescript
// TODO: Update in Phase 5 to pass lifecycle callbacks and handle orchestrator replacement
await this.handleSessionTransition(event.timestamp, {
  executeOnSessionEnd: async () => { /* TODO */ },
  executeOnSessionStart: async () => { /* TODO */ }
});
```

**With**:
```typescript
// Execute transition with lifecycle callbacks
const newOrchestrator = await this.handleSessionTransition(
  event.timestamp,
  {
    executeOnSessionEnd: async (exitCode: number) => {
      // Call onSessionEnd hook via callback if provided
      if (this.onLifecycleEvent) {
        await this.onLifecycleEvent('sessionEnd', exitCode);
      }
    },
    executeOnSessionStart: async (sessionId: string) => {
      // Call onSessionStart hook via callback if provided
      if (this.onLifecycleEvent) {
        await this.onLifecycleEvent('sessionStart', sessionId);
      }
    }
  }
);

// Trigger transition callback to replace orchestrator in adapter
if (this.onSessionTransition) {
  await this.onSessionTransition({
    oldSessionId: event.agentSessionId,
    newSessionFile: newOrchestrator.getSession().correlation.agentSessionFile!,
    transitionTimestamp: event.timestamp,
    newOrchestrator
  });
}
```

**Checklist**:
- [ ] TODO removed
- [ ] Lifecycle callbacks implemented
- [ ] Calls `onLifecycleEvent` if provided
- [ ] Calls `onSessionTransition` with new orchestrator
- [ ] Stores returned orchestrator

### ☐ Step 5.2: Add onLifecycleEvent Callback to SessionOrchestrator

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: Add new optional callback parameter to constructor

**Find constructor parameters** (around line 100):
```typescript
private constructor(
  private sessionId: string,
  private agentName: string,
  // ... other parameters
  private onSessionTransition?: (event: SessionTransitionEvent) => Promise<void>
) {
```

**Add new parameter**:
```typescript
private constructor(
  private sessionId: string,
  private agentName: string,
  // ... other parameters
  private onSessionTransition?: (event: SessionTransitionEvent) => Promise<void>,
  private onLifecycleEvent?: (event: 'sessionStart' | 'sessionEnd', data: any) => Promise<void>
) {
```

**Checklist**:
- [ ] Parameter added to constructor
- [ ] Type defined properly

### ☐ Step 5.3: Update SessionOrchestrator.create() Method

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: Update `create()` static method to accept new parameter

**Find**:
```typescript
static async create(config: {
  sessionId: string;
  agentName: string;
  // ...
  onSessionTransition?: (event: SessionTransitionEvent) => Promise<void>;
}): Promise<SessionOrchestrator> {
```

**Add new field**:
```typescript
static async create(config: {
  sessionId: string;
  agentName: string;
  // ...
  onSessionTransition?: (event: SessionTransitionEvent) => Promise<void>;
  onLifecycleEvent?: (event: 'sessionStart' | 'sessionEnd', data: any) => Promise<void>;
}): Promise<SessionOrchestrator> {
```

**Update constructor call** (inside `create()` method):
```typescript
const orchestrator = new SessionOrchestrator(
  config.sessionId,
  config.agentName,
  // ... other parameters
  config.onSessionTransition,
  config.onLifecycleEvent // Add this
);
```

**Checklist**:
- [ ] Parameter added to config type
- [ ] Passed to constructor
- [ ] Build succeeds

### ☐ Step 5.4: Update BaseAgentAdapter to Provide Lifecycle Callback

**File**: `src/agents/core/BaseAgentAdapter.ts`

**Action**: Update `SessionOrchestrator.create()` call in `spawnAgent()`

**Find** (around line 300):
```typescript
this.sessionOrchestrator = await SessionOrchestrator.create({
  sessionId,
  agentName: this.metadata.name,
  // ...
  onSessionTransition: async (event) => { /* ... */ }
});
```

**Add lifecycle callback**:
```typescript
this.sessionOrchestrator = await SessionOrchestrator.create({
  sessionId,
  agentName: this.metadata.name,
  // ...
  onSessionTransition: async (event, newOrchestrator) => {
    // ... existing code
  },
  onLifecycleEvent: async (eventType, data) => {
    if (eventType === 'sessionStart') {
      await executeOnSessionStart(
        this,
        this.metadata.lifecycle,
        this.metadata.name,
        data, // sessionId
        env
      );
    } else if (eventType === 'sessionEnd') {
      await executeOnSessionEnd(
        this,
        this.metadata.lifecycle,
        this.metadata.name,
        data, // exitCode
        env
      );
    }
  }
});
```

**Checklist**:
- [ ] Callback added
- [ ] Calls `executeOnSessionStart` for start events
- [ ] Calls `executeOnSessionEnd` for end events
- [ ] Build succeeds

### ☐ Step 5.5: Update child.on('exit') Handler

**File**: `src/agents/core/BaseAgentAdapter.ts`

**Action**: Refactor exit handler to use `endSession()` (lines 457-499)

**Find**:
```typescript
child.on('exit', async (code) => {
  // ... signal cleanup ...

  // Phase 1: Prepare metrics for exit
  if (this.sessionOrchestrator && code !== null) {
    await this.sessionOrchestrator.prepareForExit();
  }

  // Lifecycle hook: session end
  if (code !== null) {
    await executeOnSessionEnd(this, this.metadata.lifecycle, this.metadata.name, code, env);
  }

  // Clean up proxy
  await cleanup();

  // Phase 2: Mark session as completed
  if (this.sessionOrchestrator && code !== null) {
    await this.sessionOrchestrator.markSessionComplete(code);
  }

  // ... rest ...
});
```

**Replace with**:
```typescript
child.on('exit', async (code) => {
  // ... signal cleanup (keep as-is) ...

  // Show shutting down message
  console.log('');
  console.log(chalk.yellow('Shutting down...'));

  // Grace period (keep as-is)
  if (this.proxy) {
    const gracePeriodMs = 2000;
    logger.debug(`[${this.displayName}] Waiting ${gracePeriodMs}ms grace period...`);
    await new Promise(resolve => setTimeout(resolve, gracePeriodMs));
  }

  // Use extracted endSession() method
  if (this.sessionOrchestrator && code !== null) {
    await this.sessionOrchestrator.endSession(code, {
      beforeCleanup: async () => {
        // Lifecycle hook: session end
        await executeOnSessionEnd(this, this.metadata.lifecycle, this.metadata.name, code, env);
      },
      cleanup: async () => {
        // Clean up proxy (triggers final sync)
        await cleanup();
      }
    });
  }

  // Lifecycle hook: afterRun
  if (code !== null) {
    await executeAfterRun(this, this.metadata.lifecycle, this.metadata.name, code, env);
  }

  // ... rest (keep as-is) ...
});
```

**Checklist**:
- [ ] Old code replaced with `endSession()` call
- [ ] Lifecycle hooks passed via callbacks
- [ ] `cleanup()` called via callback
- [ ] Build succeeds

### ☐ Step 5.6: Verify Phase 5
- [ ] Run: `npm run build`
- [ ] No compilation errors
- [ ] Run: `npm run lint`
- [ ] No warnings
- [ ] Test normal exit still works (manual test)

---

## Phase 6: Verify Environment State Handling

### ☐ Step 6.1: Review onSessionStart Hook

**File**: `src/providers/plugins/sso/sso.template.ts`

**Action**: Review lines 70-100 to verify handler creation

**Verify**:
- [ ] `onSessionStart` creates new handler
- [ ] Handler stored in `env.__SSO_LIFECYCLE_HANDLER`
- [ ] Each call creates fresh handler with new session ID
- [ ] No code changes needed (already correct)

### ☐ Step 6.2: Verify Phase 6
- [ ] Environment handling confirmed correct
- [ ] No changes needed

---

## Phase 7: Update SessionStore for Multiple Sessions

### ☐ Step 7.1: Add Transition Fields to Session Type

**File**: `src/agents/core/session/types.ts`

**Action**: Update `Session` interface (around line 50)

**Find**:
```typescript
export interface Session {
  sessionId: string;
  agentName: string;
  provider: string;
  project?: string;
  startTime: number;
  workingDirectory: string;
  gitBranch?: string;
  status: SessionStatus;
  correlation: CorrelationResult;
  monitoring: {
    isActive: boolean;
    changeCount: number;
  };
  sync?: SyncState;
  endTime?: number;
}
```

**Add new fields**:
```typescript
export interface Session {
  sessionId: string;
  agentName: string;
  provider: string;
  project?: string;
  startTime: number;
  workingDirectory: string;
  gitBranch?: string;
  status: SessionStatus;
  correlation: CorrelationResult;
  monitoring: {
    isActive: boolean;
    changeCount: number;
  };
  sync?: SyncState;
  endTime?: number;
  transitionedFrom?: string; // NEW: Previous session ID if this is a transition
  transitionedTo?: string;   // NEW: Next session ID if this session transitioned
}
```

**Checklist**:
- [ ] Fields added to interface
- [ ] Both optional (marked with `?`)
- [ ] Build succeeds

### ☐ Step 7.2: Update markSessionComplete() to Set Transition Fields

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: Add transition field when marking old session complete

**This will be done automatically in `handleSessionTransition()` before calling `endSession()`**

**Add before calling `endSession()`**:
```typescript
// Mark old session with transition link
this.session!.transitionedTo = newSessionId;
await this.store.saveSession(this.session!);
```

**Checklist**:
- [ ] Code added to set `transitionedTo` field
- [ ] Session saved before calling `endSession()`

### ☐ Step 7.3: Set transitionedFrom in New Session

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: In `handleSessionTransition()`, after creating new orchestrator

**Add after new orchestrator creation**:
```typescript
// Link new session back to old session
newOrchestrator.session!.transitionedFrom = this.sessionId;
await newOrchestrator.store.saveSession(newOrchestrator.session!);
```

**Checklist**:
- [ ] Code added to set `transitionedFrom` field
- [ ] New session saved with link
- [ ] Build succeeds

### ☐ Step 7.4: Verify Phase 7
- [ ] Run: `npm run build`
- [ ] No compilation errors
- [ ] Session type includes new fields

---

## Phase 8: Verify Periodic Sync Logic

### ☐ Step 8.1: Review Periodic Sync Implementation

**File**: `src/providers/plugins/sso/session/sync/sso.session-sync.plugin.ts`

**Action**: Verify periodic sync uses current orchestrator reference

**Locate** (around line 100):
```typescript
setInterval(async () => {
  // Check implementation
}, this.syncIntervalMs);
```

**Verify**:
- [ ] Sync reads from adapter's current orchestrator
- [ ] No hardcoded orchestrator references
- [ ] Works correctly after orchestrator replacement

### ☐ Step 8.2: Manual Test Periodic Sync
- [ ] Start agent
- [ ] Execute `/clear`
- [ ] Wait for next periodic sync (2 minutes)
- [ ] Verify new session data synced
- [ ] Check logs show correct session ID

### ☐ Step 8.3: Verify Phase 8
- [ ] Periodic sync confirmed working
- [ ] No code changes needed (already uses adapter reference)

---

## Phase 9: Add Comprehensive Logging

### ☐ Step 9.1: Verify Logging in handleSessionTransition()

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: Verify all key steps are logged (already added in Phase 3)

**Required logs**:
- [ ] "Ending old session: {oldSessionId}"
- [ ] "Sending END metric for old session"
- [ ] "END metric sent for old session"
- [ ] "Triggering final sync for old session"
- [ ] "Old session ended and marked completed"
- [ ] "Creating new session: {newSessionId}"
- [ ] "Sending START metric for new session"
- [ ] "START metric sent for new session"
- [ ] "Initializing new orchestrator"
- [ ] "New session correlated with agent file: {agentSessionId}"
- [ ] "Starting monitoring for new session"
- [ ] "✓ Transition complete: {oldId} ({oldSession}) → {newId} ({newSession})"

### ☐ Step 9.2: Add Summary Logging

**File**: `src/agents/core/session/SessionOrchestrator.ts`

**Action**: After transition complete, add summary

**Add at end of `handleSessionTransition()`**:
```typescript
// Log summary
logger.info('='.repeat(60));
logger.info(`[SessionOrchestrator] Session Transition Summary:`);
logger.info(`  Old CodeMie Session: ${this.sessionId}`);
logger.info(`  Old Agent Session:   ${oldAgentSessionId}`);
logger.info(`  New CodeMie Session: ${newSessionId}`);
logger.info(`  New Agent Session:   ${newAgentSessionId}`);
logger.info('='.repeat(60));
```

**Checklist**:
- [ ] Summary logging added
- [ ] Shows both session IDs clearly
- [ ] Build succeeds

### ☐ Step 9.3: Verify Phase 9
- [ ] All required logs present
- [ ] Log levels appropriate (INFO for key steps, DEBUG for details)
- [ ] Build succeeds

---

## Phase 10: Testing

### ☐ Step 10.1: Test 1 - Normal Agent Exit

**Steps**:
```bash
# 1. Build
npm run build && npm link

# 2. Run agent
codemie-claude "Write a hello world function"

# 3. Wait for response, then Ctrl+C to exit
```

**Verify**:
- [ ] Session created
- [ ] START metric in logs: `[SSO] Sending session start metric`
- [ ] Agent correlated: `[SessionCorrelator] Session matched:`
- [ ] Response received
- [ ] END metric in logs: `[SSO] Sending session end metric`
- [ ] Final sync in logs: `[metrics] Successfully synced`
- [ ] Session file shows `status: "completed"`
- [ ] Session file has `endTime`
- [ ] No `transitionedTo` field (normal exit)

**Log findings**:
- Session ID: _________________
- START metric: [ ] Yes [ ] No
- END metric: [ ] Yes [ ] No
- Final sync: [ ] Yes [ ] No
- Status correct: [ ] Yes [ ] No

### ☐ Step 10.2: Test 2 - Single /clear

**Steps**:
```bash
# 1. Run agent
codemie-claude "hi"

# 2. Wait for response

# 3. In Claude, type: /clear

# 4. Verify transition happened

# 5. Exit agent (Ctrl+C)
```

**Verify**:
- [ ] Initial session created
- [ ] Initial START metric logged
- [ ] `/clear` detected: `Session end detected`
- [ ] OLD session END metric: `Sending END metric for old session`
- [ ] OLD session sync: `Triggering final sync`
- [ ] NEW session created: `Creating new session:`
- [ ] NEW session START metric: `START metric sent for new session`
- [ ] NEW session correlated: `New session correlated with agent file`
- [ ] Transition complete: `✓ Transition complete:`
- [ ] Two session files exist
- [ ] Old session: `status: "completed"`, has `transitionedTo`
- [ ] New session: `status: "active"`, has `transitionedFrom`

**Log findings**:
- Old session ID: _________________
- New session ID: _________________
- Transition link correct: [ ] Yes [ ] No
- END metric for old: [ ] Yes [ ] No
- START metric for new: [ ] Yes [ ] No
- Immediate sync: [ ] Yes [ ] No

### ☐ Step 10.3: Test 3 - Multiple /clear

**Steps**:
```bash
# 1. Run agent
codemie-claude "test message 1"

# 2. Execute /clear

# 3. In new session: "test message 2"

# 4. Execute /clear again

# 5. In third session: "test message 3"

# 6. Exit
```

**Verify**:
- [ ] Three session files created
- [ ] Session 1: `transitionedTo` = Session 2 ID
- [ ] Session 2: `transitionedFrom` = Session 1 ID, `transitionedTo` = Session 3 ID
- [ ] Session 3: `transitionedFrom` = Session 2 ID, no `transitionedTo`
- [ ] All sessions have proper status
- [ ] All transitions logged correctly
- [ ] All metrics sent (3 START, 3 END)

**Log findings**:
- Session 1 ID: _________________
- Session 2 ID: _________________
- Session 3 ID: _________________
- Chain correct: [ ] Yes [ ] No
- All metrics sent: [ ] Yes [ ] No

### ☐ Step 10.4: Test 4 - /clear Without Activity

**Steps**:
```bash
# 1. Run agent
codemie-claude "hi"

# 2. Immediately execute /clear (no waiting)

# 3. Exit
```

**Verify**:
- [ ] Two sessions created
- [ ] Empty deltas file for first session (no activity)
- [ ] Transition completed successfully
- [ ] No errors in logs
- [ ] Metrics sent correctly

**Log findings**:
- Handled empty session: [ ] Yes [ ] No
- No errors: [ ] Yes [ ] No

### ☐ Step 10.5: Test 5 - Rapid /clear

**Steps**:
```bash
# 1. Run agent
codemie-claude "start"

# 2. Execute /clear

# 3. Immediately execute /clear again (rapid)

# 4. Immediately execute /clear again (rapid)

# 5. Exit
```

**Verify**:
- [ ] All transitions completed
- [ ] No race conditions
- [ ] No crashes
- [ ] Proper session chain (4 sessions)
- [ ] All metrics sent

**Log findings**:
- All transitions successful: [ ] Yes [ ] No
- No race conditions: [ ] Yes [ ] No
- Session count: ____

### ☐ Step 10.6: Run Automated Tests

**Steps**:
```bash
# Run test suite
npm test

# Run specific integration tests if available
npm test -- session-transition
```

**Verify**:
- [ ] All existing tests pass
- [ ] No regressions
- [ ] Test count: ____ passing

### ☐ Step 10.7: Test Summary

**Overall Results**:
- [ ] Test 1 (Normal exit): ✅ Pass ❌ Fail
- [ ] Test 2 (Single /clear): ✅ Pass ❌ Fail
- [ ] Test 3 (Multiple /clear): ✅ Pass ❌ Fail
- [ ] Test 4 (/clear no activity): ✅ Pass ❌ Fail
- [ ] Test 5 (Rapid /clear): ✅ Pass ❌ Fail
- [ ] Automated tests: ✅ Pass ❌ Fail

**Issues Found**: _____________________________________________

---

## Post-Implementation

### ☐ Code Quality Checks
- [ ] Run full lint: `npm run lint`
- [ ] Fix all warnings
- [ ] Run full test suite: `npm test`
- [ ] All tests passing

### ☐ Documentation Updates
- [ ] Update `SESSION_TRANSITION_FIX_PLAN.md` with "IMPLEMENTED" status
- [ ] Update `SESSION_TRANSITION_ANALYSIS.md` with "RESOLVED" status
- [ ] Create `SESSION_TRANSITION_IMPLEMENTATION_NOTES.md` with any learnings

### ☐ Git Commit
- [ ] Stage all changes: `git add -A`
- [ ] Commit with clear message:
  ```bash
  git commit -m "refactor(session): implement proper session transition flow

  - Extract endSession() method to eliminate duplication
  - Add orchestrator lifecycle methods (destroy, replace)
  - Refactor handleSessionTransition() to follow Scenario 2 + Scenario 1
  - Remove duplicate END metric code from transition callback
  - Add session transition tracking (transitionedFrom/To fields)
  - Comprehensive logging for all transition steps
  - Immediate sync during transition (no 2-minute wait)
  - Create separate sessions for each agent session

  Closes #XXX"
  ```
- [ ] Push to feature branch: `git push origin fix/session-transition-refactor`

### ☐ Cleanup
- [ ] Remove backup files:
  ```bash
  rm src/agents/core/session/SessionOrchestrator.ts.backup
  rm src/agents/core/BaseAgentAdapter.ts.backup
  rm src/agents/core/session/SessionStore.ts.backup
  ```

### ☐ Create Pull Request
- [ ] Create PR on GitHub/GitLab
- [ ] Link to analysis and plan documents
- [ ] Include test results
- [ ] Request review

---

## Rollback Procedure (If Needed)

### ☐ Quick Rollback
```bash
# If issues found during testing:
git checkout main
git branch -D fix/session-transition-refactor
git checkout -b fix/session-transition-refactor

# Restore backups
cp src/agents/core/session/SessionOrchestrator.ts.backup src/agents/core/session/SessionOrchestrator.ts
cp src/agents/core/BaseAgentAdapter.ts.backup src/agents/core/BaseAgentAdapter.ts
cp src/agents/core/session/SessionStore.ts.backup src/agents/core/session/SessionStore.ts

# Rebuild
npm run build
npm test
```

---

## Success Criteria Verification

### ☐ Final Verification
- [ ] ✅ No code duplication (END/START logic in one place each)
- [ ] ✅ Scenario 2 compliance (prepareForExit → onSessionEnd → cleanup → markComplete)
- [ ] ✅ Scenario 3 compliance (complete stop + complete start flow)
- [ ] ✅ Proper session state (old: completed, new: active)
- [ ] ✅ Metrics sent correctly (START for each session, END for each session)
- [ ] ✅ Immediate sync (cleanup called during transition)
- [ ] ✅ Logging clear (all steps visible, session IDs tracked)
- [ ] ✅ All tests passing
- [ ] ✅ No regressions in normal flows

### ☐ Sign-Off
- [ ] Implementation complete
- [ ] All tests passing
- [ ] Code reviewed
- [ ] Documentation updated
- [ ] Ready for merge

**Completed by**: ________________
**Date**: ________________
**Total time**: _______ hours

---

## Notes and Issues

**Issues encountered**:



**Decisions made**:



**Future improvements**:
