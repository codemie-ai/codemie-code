# Critical Violation Examples

## Overview

This document provides concrete examples of critical violations for each review category. Use these as reference when identifying issues in specifications.

---

## Architecture Violations

### 1. Layer Skipping

**Violation**: CLI command directly instantiates plugin without using registry.

**Spec Example (WRONG)**:
```
ExecuteCommand will create a new instance of ClaudePlugin
and call its execute() method directly.
```

**Why Critical**:
- Breaks plugin isolation
- Makes testing difficult (can't mock registry)
- Violates Open/Closed principle
- Hard to swap implementations

**Correct Approach**:
```
ExecuteCommand will call AgentRegistry.getAgent('claude')
to retrieve the plugin adapter, then call execute().
```

**Reference**: `.codemie/guides/architecture/architecture.md:66-87` (5-Layer Architecture)

---

### 2. Reverse Dependency

**Violation**: Core layer imports from Plugin layer.

**Spec Example (WRONG)**:
```
BaseAgentAdapter (in core/) will import from ClaudePlugin
to access shared configuration.
```

**Why Critical**:
- Dependency inversion violation
- Core becomes coupled to specific implementations
- Prevents adding new plugins without changing core
- Circular dependency risk

**Correct Approach**:
```
ClaudePlugin extends BaseAgentAdapter and provides
configuration via constructor or methods. Core never
imports from Plugin.
```

**Reference**: `.codemie/guides/architecture/architecture.md:242-248` (Communication Rules)

---

### 3. Plugin Coupling

**Violation**: One plugin directly depends on another plugin.

**Spec Example (WRONG)**:
```
GeminiPlugin will import utilities from ClaudePlugin
for shared prompt formatting.
```

**Why Critical**:
- Plugins should be isolated
- Prevents independent development/testing
- Creates fragile coupling
- Violates plugin architecture

**Correct Approach**:
```
Shared prompt formatting utilities moved to src/utils/prompts.ts.
Both GeminiPlugin and ClaudePlugin import from utils.
```

**Reference**: `.codemie/guides/architecture/architecture.md:254-274` (Module Boundaries)

---

### 4. Business Logic in CLI

**Violation**: CLI command contains business logic instead of delegating to lower layers.

**Spec Example (WRONG)**:
```
InstallCommand will check if agent is already installed
by directly reading ~/.codemie/agents/ directory and
parsing package.json files.
```

**Why Critical**:
- CLI should only handle user interaction
- Business logic duplicated across commands
- Hard to test logic independently
- Violates separation of concerns

**Correct Approach**:
```
InstallCommand calls adapter.isInstalled() method.
The adapter plugin contains installation checking logic.
```

**Reference**: `.codemie/guides/architecture/architecture.md:94-112` (CLI Layer)

---

## Security Violations

### 1. Hardcoded Credentials

**Violation**: API key or token hardcoded in specification.

**Spec Example (WRONG)**:
```
Configuration:
  openai:
    apiKey: "sk-proj-abc123..."
    baseUrl: "https://api.openai.com"
```

**Why Critical**:
- Credentials exposed in version control
- Cannot rotate credentials easily
- Security breach risk
- Violates zero-trust principle

**Correct Approach**:
```
Credentials retrieved from CredentialStore:
const store = CredentialStore.getInstance();
const apiKey = await store.retrieve('openai');
```

**Reference**: `.codemie/guides/security/security-practices.md` (Credential Storage)

---

### 2. Missing Input Validation

**Violation**: User input used without validation.

**Spec Example (WRONG)**:
```
The command will accept a file path from user and
directly read the file using fs.readFile(userPath).
```

**Why Critical**:
- Path traversal vulnerability
- Can read arbitrary files
- No sanitization
- Security risk

**Correct Approach**:
```
User input validated with security utilities:
- Validate path is within allowed directories
- Sanitize path to prevent traversal
- Use validatePath() from src/utils/security.ts
```

**Reference**: `.codemie/guides/security/security-practices.md` (Input Validation)

---

### 3. Logging Sensitive Data

**Violation**: Credentials or tokens logged without sanitization.

**Spec Example (WRONG)**:
```
Debug logging will include full request payload:
logger.debug('API request', { headers, body, apiKey });
```

**Why Critical**:
- Credentials leaked in log files
- Violates privacy/security
- Debug logs may be shared publicly
- Credential exposure

**Correct Approach**:
```
Sanitize before logging:
logger.debug('API request', ...sanitizeLogArgs({ headers, body }));
// apiKey automatically removed by sanitizer
```

**Reference**: `.codemie/guides/security/security-practices.md` (Data Sanitization)

---

## Error Handling Violations

### 1. Generic Error Classes

**Violation**: Using generic Error instead of specific error classes.

**Spec Example (WRONG)**:
```
If agent is not found in registry, throw:
throw new Error('Agent not found: ' + agentName);
```

**Why Critical**:
- No structured error handling
- Cannot catch specific errors
- Poor user experience
- Difficult debugging

**Correct Approach**:
```
Use specific error class:
throw new AgentNotFoundError(agentName);
// From src/utils/errors.ts
```

**Reference**: `.codemie/guides/development/development-practices.md` (Error Handling)

---

### 2. Missing Error Context

**Violation**: Errors thrown without context for debugging.

**Spec Example (WRONG)**:
```
catch (error) {
  throw new AgentExecutionError('Execution failed');
}
```

**Why Critical**:
- No debugging information
- Cannot trace error source
- Poor error reporting
- User cannot troubleshoot

**Correct Approach**:
```
catch (error) {
  const context = createErrorContext(error, {
    agentName,
    sessionId,
    command: args.join(' ')
  });
  throw new AgentExecutionError('Execution failed', context);
}
```

**Reference**: `.codemie/guides/development/development-practices.md` (Error Context)

---

### 3. Swallowing Errors

**Violation**: Catching errors without handling or logging.

**Spec Example (WRONG)**:
```
try {
  await adapter.install();
} catch (error) {
  // Ignore installation errors
}
```

**Why Critical**:
- Silent failures
- No visibility into problems
- Cannot debug issues
- Poor reliability

**Correct Approach**:
```
try {
  await adapter.install();
} catch (error) {
  const context = createErrorContext(error, { agentName });
  logger.error('Installation failed', context);
  throw new AgentInstallationError(agentName, context);
}
```

**Reference**: `.codemie/guides/development/development-practices.md` (Error Propagation)

---

## Testing Violations

### 1. Static Imports for Mocking

**Violation**: Using static imports for modules that need mocking in tests.

**Spec Example (WRONG)**:
```
// In plugin implementation
import { exec } from 'src/utils/processes.ts';

// Tests cannot properly mock exec with beforeEach
```

**Why Critical**:
- Mocks don't work correctly
- Tests become brittle
- Cannot isolate units
- Shared state between tests

**Correct Approach**:
```
// In test setup
vi.mock('src/utils/processes.ts', () => ({
  exec: vi.fn()
}));

// Then dynamically import after mock setup
const { exec } = await import('src/utils/processes.ts');
```

**Reference**: `.codemie/guides/testing/testing-patterns.md` (Dynamic Imports)

---

### 2. No Testing Strategy

**Violation**: Complex feature with no testing approach defined.

**Spec Example (WRONG)**:
```
Implementation will add new agent with LangGraph integration,
session management, and analytics. [No testing section]
```

**Why Critical**:
- No quality assurance plan
- Unknown test coverage
- May deploy untested code
- Regression risk

**Correct Approach**:
```
Testing Strategy:
- Unit tests: Agent adapter methods (install, execute, isInstalled)
- Integration tests: Full agent workflow with mocked LangGraph
- Mock external dependencies with vi.mock
- Test error scenarios and edge cases
```

**Reference**: `.codemie/guides/testing/testing-patterns.md` (Testing Strategy)

---

## Integration Violations

### 1. Direct External Coupling

**Violation**: Direct integration without provider abstraction.

**Spec Example (WRONG)**:
```
Implementation will use fetch() to call OpenAI API directly:
const response = await fetch('https://api.openai.com/v1/chat', {
  headers: { 'Authorization': `Bearer ${apiKey}` }
});
```

**Why Critical**:
- No abstraction layer
- Hard to swap providers
- Error handling duplicated
- Testing difficult

**Correct Approach**:
```
Use provider abstraction:
const provider = ProviderRegistry.getProvider('openai');
const response = await provider.chat(messages);
// Provider handles auth, retries, errors
```

**Reference**: `.codemie/guides/integration/external-integrations.md` (Provider Pattern)

---

### 2. No Error Handling for External Services

**Violation**: External service calls without error handling.

**Spec Example (WRONG)**:
```
Agent will call external LLM API. If call succeeds,
process response. [No mention of failure handling]
```

**Why Critical**:
- Network failures unhandled
- Service outages break system
- Poor user experience
- No resilience

**Correct Approach**:
```
External service error handling:
- Catch network errors (timeout, connection refused)
- Retry transient failures (429, 503)
- Log errors with context
- Provide user-friendly error messages
- Implement circuit breaker for repeated failures
```

**Reference**: `.codemie/guides/integration/external-integrations.md` (Error Handling)

---

### 3. Missing Timeout Strategy

**Violation**: External calls without timeouts.

**Spec Example (WRONG)**:
```
Agent will make streaming API call to LLM provider.
Response will be processed as chunks arrive.
[No timeout mentioned]
```

**Why Critical**:
- May hang indefinitely
- No recovery mechanism
- Resource leaks
- Poor user experience

**Correct Approach**:
```
Timeout strategy:
- Set request timeout (e.g., 30s for initial response)
- Set streaming timeout (e.g., 5s between chunks)
- Abort request on timeout
- Log timeout errors
- Provide timeout configuration option
```

**Reference**: `.codemie/guides/integration/external-integrations.md` (Timeout Handling)

---

## Logging Violations

### 1. Using console.log

**Violation**: Using console.log instead of logger.

**Spec Example (WRONG)**:
```
For debugging, implementation will use:
console.log('Agent executing:', agentName);
```

**Why Critical**:
- No log level control
- Cannot disable debug logs
- No session context
- Clutters user output

**Correct Approach**:
```
Use logger with appropriate level:
logger.debug('Agent executing', { agentName });
// Controlled by CODEMIE_DEBUG, includes session context
```

**Reference**: `.codemie/guides/development/development-practices.md` (Logging)

---

### 2. Wrong Log Level

**Violation**: Using debug level for user-facing messages.

**Spec Example (WRONG)**:
```
Display success message with:
logger.debug('Installation complete!');
```

**Why Critical**:
- User won't see message (debug file-only)
- Wrong abstraction level
- Confusing for users

**Correct Approach**:
```
Use appropriate level for user feedback:
logger.success('Installation complete!');
// Or logger.info() for informational messages
```

**Reference**: `.codemie/guides/development/development-practices.md` (Log Levels)

---

## Clarity Violations

### 1. Vague Implementation Details

**Violation**: Key implementation details are ambiguous.

**Spec Example (WRONG)**:
```
Agent will handle errors appropriately and provide
good user experience. Session management will be
implemented properly.
```

**Why Critical**:
- No concrete guidance
- Multiple interpretations possible
- Cannot validate implementation
- Risk of missing requirements

**Correct Approach**:
```
Error handling:
- Use AgentExecutionError for agent failures
- Include error context: { agentName, sessionId, command }
- Log errors with logger.error()
- Format user messages with formatErrorForUser()

Session management:
- Generate sessionId using generateSessionId()
- Set session context: logger.setSessionId(sessionId)
- Track session in analytics adapter
- Clean up session resources on exit
```

**Reference**: Common sense specification practice

---

### 2. Multiple Unrelated Features

**Violation**: Spec bundles disconnected features together.

**Spec Example (WRONG)**:
```
This spec will implement:
1. New Gemini agent plugin
2. Credential store refactoring
3. Update CLI help text
4. Add workflow templates
```

**Why Critical**:
- Loss of focus
- Hard to review
- Complex testing
- Should be separate tasks

**Correct Approach**:
```
Single focused spec:
"This spec implements the Gemini agent plugin,
including plugin adapter, registry integration,
and session analytics."

Other features should be separate specs.
```

**Reference**: Single Responsibility Principle

---

### 3. Missing Interface Definitions

**Violation**: Key interfaces or contracts not defined.

**Spec Example (WRONG)**:
```
New provider plugin will implement required methods
for LLM interaction. [No interface specified]
```

**Why Critical**:
- Unclear contract
- May miss required methods
- Integration problems
- Cannot verify completeness

**Correct Approach**:
```
Provider interface (src/providers/core/types.ts):

interface ProviderAdapter {
  name: string;
  chat(messages: Message[]): Promise<Response>;
  stream(messages: Message[]): AsyncIterator<Chunk>;
  isConfigured(): Promise<boolean>;
}

Plugin must implement all methods.
```

**Reference**: Interface-based design principle

---

## Jira Alignment Violations

### 1. Missing Acceptance Criterion

**Violation**: Ticket acceptance criterion not addressed in spec.

**Ticket AC**:
```
- [ ] Agent supports batch mode processing
- [ ] Agent supports streaming mode
- [ ] Session analytics captured
```

**Spec (WRONG)**:
```
Agent will support streaming mode and capture analytics.
[Batch mode not mentioned]
```

**Why Critical**:
- Incomplete implementation
- Ticket cannot be marked done
- Missing functionality
- Rework required

**Correct Approach**:
```
Spec addresses all ACs:
1. Streaming mode: Implemented via stream() method
2. Batch mode: Implemented via chat() method
3. Analytics: SessionAdapter tracks usage
```

**Reference**: Requirements traceability

---

### 2. Wrong Problem Being Solved

**Violation**: Spec solves different problem than ticket describes.

**Ticket Goal**:
```
Add Gemini agent to provide Google AI integration
for users who prefer Gemini over Claude.
```

**Spec (WRONG)**:
```
This spec adds a general-purpose LLM proxy that
can route requests to multiple providers including
Gemini, with load balancing and failover.
```

**Why Critical**:
- Over-engineering
- Solving wrong problem
- Scope creep
- Wasted effort

**Correct Approach**:
```
Spec focused on ticket goal:
Add GeminiPlugin implementing AgentAdapter interface,
allowing users to run 'codemie execute gemini' for
Google AI integration.
```

**Reference**: Requirements alignment

---

## Summary

### Critical Violation Categories

1. **Architecture**: Layer violations, coupling, dependency issues
2. **Security**: Credentials, validation, sanitization
3. **Error Handling**: Generic errors, missing context, swallowing
4. **Testing**: Static imports, missing strategy
5. **Integration**: Direct coupling, no error handling, no timeouts
6. **Logging**: console.log, wrong levels
7. **Clarity**: Vague details, multiple features, missing interfaces
8. **Jira Alignment**: Missing ACs, wrong problem

### When to Report

Report if violation:
- ✅ Breaks design principle
- ✅ Creates security risk
- ✅ Makes testing impossible
- ✅ Causes poor user experience
- ✅ Misses ticket requirements

### When NOT to Report

Don't report if:
- ❌ Minor style issue
- ❌ Alternative valid approach
- ❌ Nice-to-have improvement
- ❌ Personal preference
