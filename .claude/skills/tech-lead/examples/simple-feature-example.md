# Example: Simple Feature Implementation

## Scenario

User wants to implement: "Add logging to user authentication endpoint"

Jira Ticket: EPMCDME-10500

**Ticket Description:**
```
As a developer, I want comprehensive logging in the user authentication
endpoint so that we can debug login issues more effectively.

Acceptance Criteria:
- Log successful authentication attempts
- Log failed authentication attempts with reason
- Include user ID and timestamp
- Use appropriate log levels
```

## Tech Lead Workflow

### Phase 1: Requirement Gathering

**Tech Lead:**
```
To begin, provide the Jira ticket ID (e.g., EPMCDME-12345) to analyze
and implement.
```

**User:** "EPMCDME-10500"

**Tech Lead Actions:**
1. Uses brianna skill: `Skill(skill="brianna", args="get EPMCDME-10500 fields: description,summary")`
2. Receives ticket details

### Phase 2: Technical Analysis

**Guide Consultation:**
```bash
Read .codemie/guides/development/logging-patterns.md
Read .codemie/guides/api/rest-api-patterns.md
```

**Codebase Exploration:**
```bash
# Find authentication endpoint
Grep pattern="def.*auth" glob="*.py" path="src/codemie/rest_api/"

# Check existing logging patterns
Grep pattern="logger\.(info|error|debug)" glob="*.py" output_mode="content" -n
```

**Findings:**
- Auth endpoint in: `src/codemie/rest_api/routers/auth.py`
- Logging pattern established: F-string format, no `extra` parameter
- Logger imported from: `codemie.core.logging`

### Phase 3: Complexity Assessment

**Tech Lead:**
```markdown
## Implementation Analysis: EPMCDME-10500

### Complexity Rating: Simple

### Reasoning:
- **Single Component**: Only API layer affected, one endpoint file
- **Clear Requirements**: All acceptance criteria well-defined with examples
- **Established Pattern**: Logging patterns documented and used throughout codebase
- **Minimal Scope**: Single file modification (~10 lines added)

### Clarity Assessment:
Clear - Requirements specify exactly what to log, when, and at what level

### Affected Components:
- **Authentication Router**: `src/codemie/rest_api/routers/auth.py` - Add logging statements
```

### Phase 4: Recommendation

**Tech Lead:**
```markdown
### Recommendation

This feature is Simple complexity and can be implemented directly.

**Suggested Approach:**
1. Create feature branch: `EPMCDME-10500`
2. Add logging after successful authentication (INFO level)
3. Add logging for failed authentication (WARNING level)
4. Include user_id and timestamp using f-strings
5. Follow logging pattern: `logger.info(f"User {user_id} authenticated at {timestamp}")`

Ready to proceed? I'll create the feature branch and start implementation.
```

**User:** "Yes, let's start"

### Phase 5: Implementation

**Branch Creation:**
```bash
# Check current state
git branch --show-current
# Output: main

# Create feature branch
git checkout -b EPMCDME-10500

# Verify
git branch --show-current
# Output: EPMCDME-10500
```

**Code Implementation:**

Read the file first:
```bash
Read file_path="src/codemie/rest_api/routers/auth.py"
```

Edit to add logging:
```python
# Before (line 45):
async def authenticate_user(credentials: AuthCredentials):
    user = await auth_service.validate_credentials(credentials)
    if user:
        return {"token": create_token(user.id)}
    raise AuthenticationException("Invalid credentials")

# After:
async def authenticate_user(credentials: AuthCredentials):
    user = await auth_service.validate_credentials(credentials)
    if user:
        logger.info(f"User authenticated successfully: user_id={user.id} timestamp={datetime.now()}")
        return {"token": create_token(user.id)}

    logger.warning(f"Authentication failed: username={credentials.username} timestamp={datetime.now()}")
    raise AuthenticationException("Invalid credentials")
```

**Testing:**
```bash
# Run linting
poetry run ruff check --fix src/codemie/rest_api/routers/auth.py

# Run tests
poetry run pytest tests/rest_api/routers/test_auth.py -v
```

**Commit:**
```bash
git add src/codemie/rest_api/routers/auth.py
git commit -m "EPMCDME-10500: Add logging to authentication endpoint

- Log successful authentication with user_id
- Log failed authentication attempts with username
- Include timestamps in all log messages
- Use appropriate log levels (INFO for success, WARNING for failures)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

git push -u origin EPMCDME-10500
```

## Outcome

**Time to Implementation:** ~10 minutes
**Files Changed:** 1
**Lines Added:** 4
**Complexity Accurate:** Yes - Simple assessment was correct
**User Satisfaction:** ✅ Quick, focused implementation following patterns

## Key Success Factors

1. **Quick Guide Lookup**: Logging pattern guide prevented anti-patterns
2. **Accurate Complexity**: Simple assessment meant no over-engineering
3. **Direct Implementation**: No specification phase needed
4. **Pattern Following**: Consistent with codebase standards
5. **Proper Branch**: Isolated work, clean commit history
