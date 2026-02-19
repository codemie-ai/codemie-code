# Example: Non-Jira Task Implementation

## Scenario

User wants to implement: "Improve error messages in the API to be more user-friendly"

No Jira Ticket - User-provided task description

## Tech Lead Workflow

### Phase 1: Requirement Gathering

**Tech Lead:**
```
I'll help you implement this task. Let me first understand the requirements better.

## Task Requirements

**Goal**: Improve error messages in API to be more user-friendly

Before we proceed, I need some clarification:
```

**Tech Lead uses AskUserQuestion:**
```json
{
  "questions": [
    {
      "question": "Which API endpoints should be improved?",
      "header": "Scope",
      "multiSelect": false,
      "options": [
        {
          "label": "All endpoints",
          "description": "Comprehensive improvement across entire API"
        },
        {
          "label": "Authentication endpoints",
          "description": "Focus on auth-related errors (login, signup, etc.)"
        },
        {
          "label": "User management endpoints",
          "description": "Focus on user CRUD operations"
        }
      ]
    },
    {
      "question": "What aspects should be improved?",
      "header": "Improvements",
      "multiSelect": true,
      "options": [
        {
          "label": "Error message clarity",
          "description": "Make messages more descriptive and actionable"
        },
        {
          "label": "Error codes",
          "description": "Add consistent error codes for client handling"
        },
        {
          "label": "Validation messages",
          "description": "Improve field validation error messages"
        }
      ]
    }
  ]
}
```

**User Responses:**
- Scope: Authentication endpoints
- Improvements: Error message clarity, Validation messages

**Tech Lead:**
```markdown
## Task Requirements (Finalized)

**Goal**: Improve error messages in authentication endpoints

**Acceptance Criteria**:
- Error messages are clear and actionable
- Validation messages specify which fields have issues
- Messages help users understand what went wrong and how to fix it
- Consistent tone and format across all auth endpoints

**Scope**: Authentication endpoints (login, signup, password reset, token refresh)

**Branch Name**: What would you like to name the feature branch?
Suggested: `feature/improve-auth-errors` or `task/improve-auth-errors`
```

**User:** "Let's use feature/improve-auth-errors"

### Phase 2: Technical Analysis

**Guide Consultation:**
```bash
Read .codemie/guides/api/rest-api-patterns.md
Read .codemie/guides/development/error-handling.md
Read .codemie/guides/development/security-patterns.md
```

**Codebase Exploration:**
```bash
# Find authentication routers
Glob pattern="*auth*.py" path="src/codemie/rest_api/routers/"

# Find existing error handling
Grep pattern="raise.*Exception|ValidationException|AuthenticationException"
     glob="*auth*.py"
     path="src/codemie/rest_api/routers/"
     output_mode="content" -n

# Check exception definitions
Read file_path="src/codemie/core/exceptions.py"
```

**Findings:**
- Auth endpoints in: `src/codemie/rest_api/routers/auth.py`
- Uses exceptions from: `codemie.core.exceptions`
- Current error messages are generic
- Validation uses Pydantic, but messages not customized

### Phase 3: Complexity Assessment

**Tech Lead:**
```markdown
## Implementation Analysis: Improve Auth Error Messages

### Complexity Rating: Medium

### Reasoning:
- **Multiple Components**: 4 authentication endpoints affected
- **Clear Requirements**: Well-defined goals after clarification
- **Pattern Enhancement**: Improving existing pattern, not creating new one
- **Moderate Scope**: 2-3 files (router, possibly service layer, tests)

### Clarity Assessment:
Clear - After clarification, requirements are well-defined and actionable

### Affected Components:
- **Auth Router**: `src/codemie/rest_api/routers/auth.py` - Update error messages in 4 endpoints
- **Auth Service**: `src/codemie/service/auth_service.py` - May need validation message improvements
- **Pydantic Models**: `src/codemie/models/auth.py` - Add custom validation messages
- **Tests**: `tests/rest_api/routers/test_auth.py` - Update test expectations for new messages
```

### Phase 4: Recommendation

**Tech Lead:**
```markdown
### Recommendation

This task is Medium complexity and can be implemented directly.

**Suggested Approach:**
1. Create feature branch: `feature/improve-auth-errors`
2. Review existing error messages in auth router
3. Define clear, actionable error message templates
4. Update error handling in each endpoint:
   - Login: "Invalid email or password. Please check your credentials and try again."
   - Signup: Specific field validation (e.g., "Password must be at least 8 characters")
   - Password Reset: Clear status messages for each step
   - Token Refresh: Explain why token is invalid
5. Add custom Pydantic validators with friendly messages
6. Update tests to match new error messages
7. Test manually with common error scenarios

**Key Patterns to Follow:**
- Use `ValidationException` for validation errors
- Use `AuthenticationException` for auth failures
- Keep messages user-friendly (no technical jargon)
- Never expose sensitive information (e.g., "user exists" vs "user doesn't exist")
- Follow security pattern: Don't reveal whether email exists

Ready to proceed? I'll create the feature branch and start implementation.
```

**User:** "Yes, let's do it"

### Phase 5: Implementation

**Branch Creation:**
```bash
# Check current state
git branch --show-current
# Output: main

# Update main first
git pull origin main

# Create feature branch
git checkout -b feature/improve-auth-errors

# Verify
git branch --show-current
# Output: feature/improve-auth-errors

# Push branch
git push -u origin feature/improve-auth-errors
```

**Code Implementation:**

**Step 1: Define Error Message Templates**

Create constants for consistency:
```python
# In src/codemie/rest_api/routers/auth.py (at top)

# Error message templates
ERROR_MESSAGES = {
    "invalid_credentials": "Invalid email or password. Please check your credentials and try again.",
    "account_locked": "Your account has been temporarily locked due to multiple failed login attempts. Please try again in 15 minutes or reset your password.",
    "email_exists": "An account with this email already exists. Please log in or use a different email.",
    "weak_password": "Password must be at least 8 characters and include uppercase, lowercase, and numbers.",
    "invalid_token": "Your session has expired. Please log in again.",
    "token_expired": "This link has expired. Please request a new password reset link.",
}
```

**Step 2: Update Login Endpoint**

```python
# Before
@router.post("/login")
async def login(credentials: LoginCredentials):
    user = await auth_service.authenticate(credentials)
    if not user:
        raise AuthenticationException("Authentication failed")
    return {"token": create_token(user.id)}

# After
@router.post("/login")
async def login(credentials: LoginCredentials):
    try:
        user = await auth_service.authenticate(credentials)
    except AccountLockedException:
        raise AuthenticationException(ERROR_MESSAGES["account_locked"])
    except InvalidCredentialsException:
        raise AuthenticationException(ERROR_MESSAGES["invalid_credentials"])

    return {"token": create_token(user.id)}
```

**Step 3: Update Signup Endpoint with Custom Validators**

```python
# In src/codemie/models/auth.py
from pydantic import BaseModel, EmailStr, field_validator

class SignupRequest(BaseModel):
    email: EmailStr
    password: str
    name: str

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters long")
        if not any(c.isupper() for c in v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not any(c.islower() for c in v):
            raise ValueError("Password must contain at least one lowercase letter")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one number")
        return v

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if len(v.strip()) < 2:
            raise ValueError("Name must be at least 2 characters long")
        return v.strip()
```

**Step 4: Update Router to Use Custom Messages**

```python
# In router
@router.post("/signup")
async def signup(request: SignupRequest):
    try:
        user = await auth_service.create_user(request)
        return {"message": "Account created successfully", "user_id": user.id}
    except UserAlreadyExistsException:
        raise ValidationException(ERROR_MESSAGES["email_exists"])
```

**Step 5: Update Tests**

```python
# In tests/rest_api/routers/test_auth.py

def test_login_invalid_credentials():
    response = client.post("/auth/login", json={
        "email": "wrong@example.com",
        "password": "wrongpass"
    })
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid email or password. Please check your credentials and try again."

def test_signup_weak_password():
    response = client.post("/auth/signup", json={
        "email": "newuser@example.com",
        "password": "weak",
        "name": "Test User"
    })
    assert response.status_code == 422
    assert "at least 8 characters" in response.json()["detail"][0]["msg"]
```

**Commit Changes:**
```bash
# Stage changes
git add src/codemie/rest_api/routers/auth.py
git add src/codemie/models/auth.py
git add src/codemie/service/auth_service.py
git add tests/rest_api/routers/test_auth.py

# Commit
git commit -m "feature/improve-auth-errors: Improve authentication error messages

- Add clear, actionable error messages for all auth endpoints
- Implement custom Pydantic validators with user-friendly messages
- Update login errors to explain authentication failures
- Add specific validation messages for signup (password strength, email format)
- Follow security pattern: Don't reveal whether user exists
- Update tests to match new error message expectations

Affected endpoints:
- POST /auth/login
- POST /auth/signup
- POST /auth/password-reset
- POST /auth/token-refresh

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

# Push
git push origin feature/improve-auth-errors
```

**Testing:**
```bash
# Run linting
poetry run ruff check --fix src/codemie/

# Run tests
poetry run pytest tests/rest_api/routers/test_auth.py -v

# Manual testing
poetry run uvicorn codemie.rest_api.main:app --reload
# Test in browser at http://localhost:8080/docs
```

### Phase 6: Create Pull Request (Optional)

**Tech Lead:**
```markdown
Implementation complete! Error messages are now:
- Clear and actionable
- User-friendly (no technical jargon)
- Consistent across all auth endpoints
- Security-conscious (don't reveal sensitive info)

**Changes Summary:**
- 4 files modified
- 75 lines added
- Improved user experience for authentication errors
- All tests passing ✅

Would you like me to create a pull request for review?
```

**User:** "Yes, create the PR"

```bash
gh pr create --title "Improve authentication error messages" --body "$(cat <<'EOF'
## Summary
- Add clear, actionable error messages to all authentication endpoints
- Implement custom Pydantic validators with user-friendly messages
- Follow security best practices (don't reveal user existence)

## Changes
- **Login**: Clear message for invalid credentials
- **Signup**: Specific validation messages for each field
- **Password Reset**: Descriptive status messages
- **Token Refresh**: Explain token invalidity

## Test Plan
- [x] Unit tests updated and passing
- [x] Manual testing completed
- [x] Linting passes
- [x] Security review completed

## Examples

**Before**: "Authentication failed"
**After**: "Invalid email or password. Please check your credentials and try again."

**Before**: "Validation error"
**After**: "Password must be at least 8 characters and include uppercase, lowercase, and numbers."

🤖 Generated with Claude Code
EOF
)"
```

## Outcome

**Time to Implementation:** ~1.5 hours
**Files Changed:** 4
**Lines Added:** 75
**Complexity Accurate:** Yes - Medium assessment was appropriate
**User Satisfaction:** ✅ Improved UX, clear messages, security maintained

## Key Success Factors

1. **Clarifying Questions**: Narrowed scope from "all API" to "auth endpoints"
2. **Structured Requirements**: Documented finalized requirements clearly
3. **Proper Branch Naming**: Feature branch with descriptive name
4. **Pattern Following**: Used existing exception types and patterns
5. **Security Awareness**: Followed security guide (don't reveal user existence)
6. **Comprehensive Testing**: Updated tests to match new behavior
7. **Clear Commits**: Descriptive commit message with context

## Comparison: Without Tech Lead Skill

**Without structured approach:**
- ❌ Might improve all endpoints (scope creep)
- ❌ Inconsistent message formats
- ❌ Might reveal sensitive information
- ❌ Forgotten test updates
- ❌ Unclear commit message

**With Tech Lead Skill:**
- ✅ Scoped correctly through clarification
- ✅ Consistent message templates
- ✅ Security patterns followed
- ✅ Tests updated proactively
- ✅ Comprehensive documentation
