# Specification Review Checklist

## Overview

This checklist provides systematic criteria for reviewing technical specifications. Use this to ensure comprehensive coverage of all critical aspects.

---

## 1. Jira Ticket Alignment

### Critical Checks

- [ ] **Acceptance Criteria Coverage**: All acceptance criteria from Jira ticket addressed in spec
- [ ] **Goal Alignment**: Spec solves the problem described in ticket summary
- [ ] **Scenario Coverage**: All usage scenarios from ticket are included
- [ ] **Affected Areas**: Spec covers all areas mentioned in ticket

### Questions to Answer

1. Does the spec address every acceptance criterion?
2. Is the spec solving the same problem as the ticket?
3. Are all user-facing scenarios covered?
4. Is anything from the ticket missing in the spec?

### Red Flags (Must Report)

- ❌ Missing acceptance criterion
- ❌ Spec addresses different feature than ticket describes
- ❌ Key scenarios omitted
- ❌ Incomplete solution for ticket requirements

---

## 2. Architecture Compliance

### Critical Checks

Based on `.codemie/guides/architecture/architecture.md`:

- [ ] **5-Layer Architecture**: Follows CLI → Registry → Plugin → Core → Utils flow
- [ ] **No Layer Skipping**: Each layer only communicates with adjacent layers
- [ ] **Dependency Direction**: Upper layers depend on lower layers only
- [ ] **Plugin Isolation**: Plugins don't depend on other plugins
- [ ] **Core Independence**: Core layer doesn't depend on Plugin layer
- [ ] **Registry Usage**: New plugins registered in appropriate registry
- [ ] **Business Logic Placement**: Business logic not in CLI layer

### Questions to Answer

1. Which layers are affected by this spec?
2. Are dependencies pointing in the correct direction?
3. Are new plugins properly registered?
4. Is business logic properly separated from presentation?

### Red Flags (Must Report)

- ❌ CLI directly calls Plugin (skips Registry)
- ❌ Core depends on Plugin (dependency inversion violation)
- ❌ Plugin A imports from Plugin B (coupling)
- ❌ Business logic in CLI command handlers
- ❌ Missing registry registration
- ❌ Circular dependencies between layers

### Example Violations

**BAD**: CLI command instantiates plugin directly
```
Command → new ClaudePlugin()  // WRONG: Skips registry
```

**GOOD**: CLI uses registry
```
Command → AgentRegistry.getAgent('claude')  // CORRECT
```

---

## 3. Security Compliance

### Critical Checks

Based on `.codemie/guides/security/security-practices.md`:

- [ ] **Credential Storage**: Uses CredentialStore, no hardcoded credentials
- [ ] **Input Validation**: User input validated before use
- [ ] **Data Sanitization**: Sensitive data sanitized before logging
- [ ] **Path Security**: File paths validated with security utilities
- [ ] **Environment Variables**: Secrets from env vars, not config files
- [ ] **No Secret Logging**: API keys, tokens not logged even in debug mode

### Questions to Answer

1. How are credentials stored and retrieved?
2. Is user input validated before processing?
3. Are file paths validated for security?
4. Could sensitive data be logged?

### Red Flags (Must Report)

- ❌ Hardcoded API keys, tokens, passwords
- ❌ Credentials in configuration files
- ❌ No input validation for user-provided data
- ❌ File paths not validated (path traversal risk)
- ❌ Sensitive data logged without sanitization
- ❌ Secrets passed in CLI arguments (visible in process list)

### Example Violations

**BAD**: Hardcoded credential
```
apiKey: "sk-abc123..."  // WRONG: Hardcoded secret
```

**GOOD**: Credential from secure storage
```
const apiKey = await CredentialStore.getInstance().retrieve('openai');  // CORRECT
```

---

## 4. Error Handling Compliance

### Critical Checks

Based on `.codemie/guides/development/development-practices.md`:

- [ ] **Specific Exceptions**: Uses custom error classes from `src/utils/errors.ts`
- [ ] **Error Context**: Errors include context for debugging
- [ ] **Error Propagation**: Clear error propagation strategy
- [ ] **User Messaging**: Error messages formatted for end users
- [ ] **No Swallowing**: Errors not silently caught without action

### Questions to Answer

1. What error classes are used?
2. How is error context provided?
3. How do errors propagate through layers?
4. Are error messages user-friendly?

### Red Flags (Must Report)

- ❌ Using generic `Error` instead of specific classes
- ❌ Empty catch blocks (swallowing errors)
- ❌ Missing error context (sessionId, agentName, etc.)
- ❌ No error propagation strategy defined
- ❌ Raw technical errors shown to users

### Example Violations

**BAD**: Generic error
```
throw new Error('Agent failed');  // WRONG: Generic error, no context
```

**GOOD**: Specific error with context
```
throw new AgentExecutionError('Agent failed', { agentName, sessionId });  // CORRECT
```

---

## 5. Testing Strategy

### Critical Checks

Based on `.codemie/guides/testing/testing-patterns.md`:

- [ ] **Testing Approach**: Clear strategy for unit vs integration tests
- [ ] **Mocking Strategy**: Proper mocking approach defined (dynamic imports if needed)
- [ ] **Test Isolation**: Tests don't share state
- [ ] **Coverage Scope**: Critical paths identified for testing
- [ ] **External Dependencies**: Strategy for mocking external services

### Questions to Answer

1. What testing approach is proposed?
2. How will dependencies be mocked?
3. Are tests isolated from each other?
4. What are the critical paths to test?

### Red Flags (Must Report)

- ❌ No testing strategy for complex features
- ❌ Static imports for modules that need mocking
- ❌ Shared state between tests
- ❌ Mixing unit and integration test concerns
- ❌ No strategy for mocking external services

### Example Violations

**BAD**: Static import for module needing mocks
```
import { exec } from 'src/utils/processes.ts';  // WRONG: Can't mock with beforeEach
```

**GOOD**: Dynamic import after mock setup
```
vi.mock('src/utils/processes.ts');  // Set up mock
const { exec } = await import('src/utils/processes.ts');  // CORRECT: Dynamic import
```

---

## 6. Integration Compliance

### Critical Checks

Based on `.codemie/guides/integration/external-integrations.md`:

- [ ] **Provider Abstraction**: External services accessed via provider interface
- [ ] **Error Handling**: Network/service failures handled gracefully
- [ ] **Retry Strategy**: Retry logic for transient failures
- [ ] **Timeout Strategy**: Timeouts defined for external calls
- [ ] **Configuration**: Service URLs/endpoints configurable, not hardcoded

### Questions to Answer

1. How are external services integrated?
2. What happens if external service fails?
3. Are there retries for transient failures?
4. Are timeouts configured?

### Red Flags (Must Report)

- ❌ Direct integration without provider abstraction
- ❌ No error handling for external service failures
- ❌ Missing retry strategy for transient failures
- ❌ No timeout strategy (potential hangs)
- ❌ Hardcoded service URLs

### Example Violations

**BAD**: Direct API call without abstraction
```
fetch('https://api.openai.com/...')  // WRONG: Direct coupling, no error handling
```

**GOOD**: Provider abstraction
```
const provider = ProviderRegistry.getProvider('openai');  // CORRECT: Abstraction
await provider.chat(...)  // Error handling in provider
```

---

## 7. Logging Compliance

### Critical Checks

Based on `.codemie/guides/development/development-practices.md`:

- [ ] **Logger Usage**: Uses `logger` from `src/utils/logger.ts`, not `console.log`
- [ ] **Log Levels**: Appropriate log levels (debug, info, error, success)
- [ ] **Session Context**: Session and agent context set
- [ ] **Data Sanitization**: Sensitive data sanitized before logging
- [ ] **Debug vs Info**: Debug for internal details, info for user feedback

### Questions to Answer

1. What logging approach is used?
2. Are sensitive data sanitized?
3. Is session context included?
4. Are log levels appropriate?

### Red Flags (Must Report)

- ❌ Using `console.log` for application logging
- ❌ Logging sensitive data (tokens, passwords, keys)
- ❌ Missing session context in logs
- ❌ Wrong log level (e.g., debug for user messages)

---

## 8. Clarity and Focus

### Critical Checks

- [ ] **Component Responsibilities**: Clear roles for each component
- [ ] **Interface Definitions**: Key interfaces and contracts defined
- [ ] **Success Criteria**: Validation approach specified
- [ ] **Focus**: Single cohesive feature, not multiple unrelated features
- [ ] **Completeness**: No critical implementation details missing

### Questions to Answer

1. Are component responsibilities clear?
2. Are interfaces well-defined?
3. How will success be validated?
4. Is the spec focused on one feature?

### Red Flags (Must Report)

- ❌ Vague or ambiguous key implementation details
- ❌ Multiple disconnected features bundled together
- ❌ Missing critical interfaces or contracts
- ❌ Unclear component responsibilities
- ❌ No validation or success criteria

---

## Review Workflow Summary

### Step-by-Step Process

1. **Load Jira Ticket** → Verify alignment (Section 1)
2. **Load Architecture Guide** → Check architecture compliance (Section 2)
3. **Load Security Guide** → Check security compliance (Section 3)
4. **Load Development Guide** → Check error handling and logging (Section 4, 7)
5. **Load Testing Guide** → Check testing strategy (Section 5)
6. **Load Integration Guide** → Check external integrations (Section 6)
7. **Review Clarity** → Check focus and completeness (Section 8)

### Verdict Decision Tree

```
Start Review
    │
    ├─ Jira Alignment Issues? ──YES→ NEEDS WORK
    │   NO ↓
    ├─ Architecture Violations? ──YES→ NEEDS WORK
    │   NO ↓
    ├─ Security Violations? ──YES→ NEEDS WORK
    │   NO ↓
    ├─ Error Handling Issues? ──YES→ NEEDS WORK
    │   NO ↓
    ├─ Testing Strategy Missing? ──YES→ NEEDS WORK (if complex feature)
    │   NO ↓
    ├─ Integration Issues? ──YES→ NEEDS WORK
    │   NO ↓
    ├─ Clarity/Focus Problems? ──YES→ NEEDS WORK
    │   NO ↓
    └─ All Clear → APPROVED ✅
```

---

## Remember

### Report Only Critical Issues

- ✅ Design principle violations
- ✅ Security risks
- ✅ Missing requirements
- ✅ Unclear key implementation details

### Don't Report Minor Issues

- ❌ Formatting preferences
- ❌ Minor typos
- ❌ Nice-to-have additions
- ❌ Style preferences

### Feedback Format

For each critical issue:
1. **Violation**: What is wrong
2. **Principle**: Which design principle violated
3. **Reference**: Guide path and section
4. **Impact**: Why it matters
