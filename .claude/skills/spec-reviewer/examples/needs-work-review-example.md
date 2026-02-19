# Example: NEEDS WORK Specification Review

## Scenario

User submits a specification that contains critical violations of design principles and missing requirements.

---

## User Request

```
Review this specification for EPMCDME-11000:

Technical Specification: LiteLLM Provider Integration

Overview:
Add LiteLLM provider to support 100+ LLM providers through unified proxy interface.

Implementation:
- Create command in src/cli/commands/litellm.ts
- Command will directly instantiate LiteLLMClient
- Check if litellm package is installed
- If not, run: exec('npm install -g litellm')
- Store API keys in config file: ~/.codemie/litellm-config.json

Usage:
- User runs: codemie litellm "your prompt here"
- Command reads API key from config file
- Makes fetch() call to LiteLLM API endpoint
- Returns response to user

Configuration:
{
  "providers": {
    "openai": {
      "apiKey": "sk-...",
      "baseUrl": "https://api.openai.com"
    },
    "anthropic": {
      "apiKey": "sk-ant-...",
      "baseUrl": "https://api.anthropic.com"
    }
  }
}

Error Handling:
- If API call fails, show error message to user
- Log errors with console.log for debugging
```

---

## Review Process

### Step 1: Fetch Jira Ticket

```
Ticket EPMCDME-11000:
Summary: Integrate LiteLLM for Multi-Provider Support

Acceptance Criteria:
- [ ] Users can configure multiple LLM providers
- [ ] Provider switching without re-authentication
- [ ] Secure credential storage (encrypted)
- [ ] Session analytics for usage tracking
- [ ] Retry logic for transient failures
```

### Step 2: Load Applicable Guides

- ✅ `.codemie/guides/architecture/architecture.md`
- ✅ `.codemie/guides/security/security-practices.md`
- ✅ `.codemie/guides/development/development-practices.md`
- ✅ `.codemie/guides/integration/external-integrations.md`

### Step 3: Review Against Jira Ticket

| Acceptance Criterion | Addressed in Spec | Status |
|---------------------|-------------------|--------|
| Configure multiple providers | Configuration section present | ✅ |
| Provider switching | Not mentioned | ❌ |
| Secure credential storage (encrypted) | Config file with plaintext keys | ❌ |
| Session analytics | Not mentioned | ❌ |
| Retry logic | Not mentioned | ❌ |

**3 of 5 acceptance criteria NOT addressed.**

### Step 4: Review Against Design Principles

#### Architecture Violations ❌

1. **Layer Skipping**: CLI command directly instantiates LiteLLMClient
   - Reference: `.codemie/guides/architecture/architecture.md:66-87`
   - Should use ProviderRegistry

2. **Business Logic in CLI**: Command contains provider initialization logic
   - Reference: `.codemie/guides/architecture/architecture.md:94-112`
   - Should delegate to Provider plugin

#### Security Violations ❌

1. **Hardcoded Credentials**: API keys stored in plaintext config file
   - Reference: `.codemie/guides/security/security-practices.md` (Credential Storage)
   - Should use CredentialStore with encryption

2. **Missing Input Validation**: User prompt not validated before use
   - Reference: `.codemie/guides/security/security-practices.md` (Input Validation)

#### Error Handling Violations ❌

1. **Generic Error Handling**: No specific error classes
   - Reference: `.codemie/guides/development/development-practices.md` (Error Handling)
   - Should use ProviderError, AuthenticationError, etc.

2. **console.log for Errors**: Using console.log instead of logger
   - Reference: `.codemie/guides/development/development-practices.md` (Logging)
   - Should use logger.error() with context

#### Integration Violations ❌

1. **Direct External Coupling**: Using fetch() directly without abstraction
   - Reference: `.codemie/guides/integration/external-integrations.md` (Provider Pattern)
   - Should create LiteLLMProvider implementing ProviderAdapter

2. **No Error Handling Strategy**: API failures not properly handled
   - Reference: `.codemie/guides/integration/external-integrations.md` (Error Handling)
   - Missing retry logic, timeout handling

3. **No Timeout Strategy**: fetch() calls without timeouts
   - Reference: `.codemie/guides/integration/external-integrations.md` (Timeout Handling)
   - May hang indefinitely

### Step 5: Clarity Assessment
- ❌ Vague error handling ("show error message")
- ❌ Missing session management details
- ❌ No interface definitions
- ❌ Unclear provider abstraction

---

## Review Output

```markdown
## Specification Review: NEEDS WORK ⚠️

**Jira Ticket**: EPMCDME-11000
**Specification**: Technical Specification: LiteLLM Provider Integration

### Verdict
This specification **REQUIRES ADDITIONAL WORK** before implementation.

### Critical Issues

#### 1. Architecture Violation - Layer Skipping
**Violation**: CLI command directly instantiates LiteLLMClient instead of using provider registry.
**Principle**: 5-layer architecture requires CLI → Registry → Plugin flow
**Reference**: `.codemie/guides/architecture/architecture.md:66-87` (5-Layer Architecture)
**Impact**: Breaks plugin isolation, violates Open/Closed principle, makes testing difficult. Cannot swap provider implementations without changing CLI code.

#### 2. Architecture Violation - Business Logic in CLI
**Violation**: Command contains provider initialization and configuration logic.
**Principle**: CLI layer handles only user interaction, delegates business logic to lower layers
**Reference**: `.codemie/guides/architecture/architecture.md:94-112` (CLI Layer Responsibilities)
**Impact**: Logic duplication across commands, difficult to test independently, violates separation of concerns.

#### 3. Security Violation - Hardcoded Credentials
**Violation**: API keys stored in plaintext configuration file (~/.codemie/litellm-config.json).
**Principle**: Credentials must be encrypted at rest, use CredentialStore
**Reference**: `.codemie/guides/security/security-practices.md` (Credential Storage section)
**Impact**: **CRITICAL SECURITY RISK** - Credentials exposed in filesystem, no encryption, easy credential theft, violates security best practices.

#### 4. Security Violation - Missing Input Validation
**Violation**: User prompt not validated or sanitized before processing.
**Principle**: All user input must be validated before use
**Reference**: `.codemie/guides/security/security-practices.md` (Input Validation section)
**Impact**: Potential injection attacks, security vulnerability, no input sanitization.

#### 5. Error Handling Violation - Generic Error Handling
**Violation**: No specific error classes defined, generic error messages shown.
**Principle**: Use domain-specific error classes from src/utils/errors.ts
**Reference**: `.codemie/guides/development/development-practices.md` (Error Handling section)
**Impact**: Poor error handling, difficult debugging, no structured error propagation, poor user experience.

#### 6. Error Handling Violation - console.log Usage
**Violation**: Spec proposes console.log for error logging.
**Principle**: Use logger from src/utils/logger.ts with appropriate levels
**Reference**: `.codemie/guides/development/development-practices.md` (Logging section)
**Impact**: No log level control, cannot disable debug logs, no session context, clutters user output.

#### 7. Integration Violation - Direct External Coupling
**Violation**: Using fetch() directly to call LiteLLM API without provider abstraction.
**Principle**: External services must be accessed via provider interface
**Reference**: `.codemie/guides/integration/external-integrations.md` (Provider Pattern section)
**Impact**: No abstraction layer, hard to swap implementations, error handling duplicated, testing difficult.

#### 8. Integration Violation - Missing Error Handling Strategy
**Violation**: No strategy for handling API failures, network errors, or timeouts.
**Principle**: External service calls require comprehensive error handling and retry logic
**Reference**: `.codemie/guides/integration/external-integrations.md` (Error Handling section)
**Impact**: Poor resilience, service failures break system, no user feedback on transient errors, no retry mechanism.

#### 9. Integration Violation - No Timeout Strategy
**Violation**: fetch() calls without timeout configuration.
**Principle**: All external calls must have timeouts to prevent hangs
**Reference**: `.codemie/guides/integration/external-integrations.md` (Timeout Handling section)
**Impact**: May hang indefinitely on slow/unresponsive services, resource leaks, poor user experience.

### Jira Ticket Alignment

❌ **Missing Acceptance Criteria**:
- **Provider switching**: Not addressed in spec
- **Secure credential storage (encrypted)**: Config file uses plaintext (violates requirement)
- **Session analytics**: Not mentioned
- **Retry logic**: Not mentioned

Only 1 of 5 acceptance criteria properly addressed.

### Recommendations

**Architecture**:
1. Create LiteLLMProvider class implementing ProviderAdapter interface
2. Register provider in ProviderRegistry initialization
3. CLI command uses ProviderRegistry.getProvider('litellm')
4. Move all provider logic out of CLI layer

**Security**:
1. Use CredentialStore.getInstance() for all credential storage
2. Remove plaintext API keys from configuration files
3. Implement credential encryption at rest
4. Add input validation for all user-provided data

**Error Handling**:
1. Define specific error classes: ProviderError, LiteLLMError, AuthenticationError
2. Include error context: { provider, sessionId, model }
3. Use logger.error() with createErrorContext()
4. Format errors with formatErrorForUser() for end users

**Integration**:
1. Implement provider abstraction following existing provider patterns
2. Add retry logic for transient failures (429, 503 status codes)
3. Configure timeouts for all external calls (e.g., 30s initial, 5s streaming)
4. Handle network errors gracefully with user-friendly messages

**Missing Requirements**:
1. Add provider switching mechanism (select active provider)
2. Implement SessionAdapter for usage analytics
3. Define session tracking strategy
4. Add retry configuration (max retries, backoff strategy)

### Next Steps
Address all critical issues above, then resubmit specification for review. Focus on:
- Architecture compliance (provider registry pattern)
- Security (CredentialStore, no plaintext keys)
- Complete acceptance criteria coverage
```

---

## Key Takeaways

This specification was **REJECTED** because it:

1. **Architecture Violations**: CLI directly instantiates client, business logic in wrong layer
2. **Security Risks**: Plaintext credentials in config file (CRITICAL)
3. **Missing Requirements**: 3 of 5 acceptance criteria not addressed
4. **Poor Integration**: Direct coupling, no error handling, no timeouts
5. **Generic Errors**: No specific error classes or proper logging

**9 critical issues** identified → Requires revision before implementation.

---

## After Revision

After addressing critical issues, revised spec should:
- Use ProviderRegistry pattern
- Store credentials in CredentialStore (encrypted)
- Implement all 5 acceptance criteria
- Define specific error classes
- Add retry and timeout strategies
- Use provider abstraction layer
- Include session analytics

Then resubmit for review → Likely APPROVED if all issues addressed.
