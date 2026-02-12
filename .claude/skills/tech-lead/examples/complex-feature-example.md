# Example: Complex Feature Implementation

## Scenario

User wants to implement: "Integrate with external document analysis service"

Jira Ticket: EPMCDME-10750

**Ticket Description:**
```
As a user, I want to analyze external documents (PDFs, Word docs) using
a third-party AI service so that I can extract insights without manual review.

Acceptance Criteria:
- Support PDF and DOCX uploads
- Integrate with external AI service API
- Store analysis results
- Handle rate limits and errors
- Secure credential management
```

## Tech Lead Workflow

### Phase 1: Requirement Gathering

**Tech Lead:**
```
To begin, provide the Jira ticket ID (e.g., EPMCDME-12345) to analyze
and implement.
```

**User:** "EPMCDME-10750"

**Tech Lead Actions:**
1. Uses brianna skill: `Skill(skill="brianna", args="get EPMCDME-10750 fields: description,summary")`
2. Receives ticket details

### Phase 2: Technical Analysis

**Guide Consultation:**
```bash
Read .codemie/guides/api/rest-api-patterns.md
Read .codemie/guides/architecture/service-layer-patterns.md
Read .codemie/guides/integration/cloud-integrations.md
Read .codemie/guides/development/security-patterns.md
Read .codemie/guides/development/error-handling.md
```

**Codebase Exploration:**
```bash
# Find similar integrations
Glob pattern="*integration*.py" path="src/codemie/integration/"

# Check existing document handling
Grep pattern="class.*Document" glob="*.py" path="src/codemie/"

# Find credential management patterns
Grep pattern="get_secret|KMS|credentials" glob="*.py" output_mode="content"
```

**Findings:**
- No existing document analysis service
- Similar integration pattern exists for Confluence
- AWS Secrets Manager used for credentials
- File upload handling exists in datasource layer
- Rate limiting not implemented anywhere

### Phase 3: Complexity Assessment

**Tech Lead:**
```markdown
## Implementation Analysis: EPMCDME-10750

### Complexity Rating: Complex

### Reasoning:
- **Multi-Layer Impact**: Requires API, Service, Repository, Integration, and Configuration layers
- **External Dependency**: New third-party service with authentication and rate limits
- **Security Critical**: Credential management, file upload validation, data privacy
- **Missing Patterns**: No existing rate limiting or circuit breaker implementation
- **Extensive Changes**: Estimated 15+ files across multiple subsystems

### Clarity Assessment:
Partially Clear - Core requirements defined, but several technical decisions needed:
- Which AI service provider? (multiple options available)
- Where to store analysis results? (database vs file system)
- How to handle large files? (chunking, async processing)
- What retry strategy? (exponential backoff, circuit breaker)

### Affected Components:
- **REST API**: `src/codemie/rest_api/routers/` - New document upload endpoint
- **Service Layer**: `src/codemie/service/` - Document analysis service
- **Integration**: `src/codemie/integration/` - External AI service client
- **Repository**: `src/codemie/repository/` - Analysis result storage
- **Models**: `src/codemie/models/` - Document and analysis models
- **Configuration**: `config/` - Service credentials and settings
- **Security**: `src/codemie/core/security/` - Credential management
- **Error Handling**: `src/codemie/core/exceptions.py` - New exception types
- **Tests**: `tests/` - Unit and integration tests for all layers

### Risk Factors:
- External API reliability and uptime
- Rate limiting and quota management
- Large file handling and memory usage
- Security: credential leakage, malicious uploads
- Cost: per-request pricing from external service
```

### Phase 4: Clarifying Questions

**Tech Lead uses AskUserQuestion:**
```json
{
  "questions": [
    {
      "question": "Which AI document analysis service should be integrated?",
      "header": "AI Service",
      "multiSelect": false,
      "options": [
        {
          "label": "AWS Textract",
          "description": "AWS native service, already have AWS credentials set up"
        },
        {
          "label": "Azure Document Intelligence",
          "description": "Azure service, would need new Azure setup"
        },
        {
          "label": "Google Document AI",
          "description": "Google service, would need new GCP setup"
        }
      ]
    },
    {
      "question": "Where should analysis results be stored?",
      "header": "Storage",
      "multiSelect": false,
      "options": [
        {
          "label": "PostgreSQL database",
          "description": "Structured storage, easy querying, version control"
        },
        {
          "label": "S3 bucket",
          "description": "File-based storage, good for large results, cheaper"
        },
        {
          "label": "Elasticsearch",
          "description": "Searchable storage, good for analytics, already in use"
        }
      ]
    },
    {
      "question": "How should large files be handled?",
      "header": "File Handling",
      "multiSelect": false,
      "options": [
        {
          "label": "Synchronous processing",
          "description": "Simple, but blocks API during analysis"
        },
        {
          "label": "Asynchronous processing",
          "description": "Complex, requires job queue, non-blocking"
        },
        {
          "label": "File size limits only",
          "description": "Reject files above threshold, keep implementation simple"
        }
      ]
    }
  ]
}
```

**User Responses:**
- AI Service: AWS Textract (leverage existing AWS setup)
- Storage: PostgreSQL database (structured, fits existing patterns)
- File Handling: Asynchronous processing (better UX, worth the complexity)

### Phase 5: Recommendation

**Tech Lead:**
```markdown
### Recommendation

This feature is Complex and would benefit from architectural planning before implementation.

**Architectural Decisions Required:**
1. Job queue system (Celery? AWS SQS? Redis Queue?)
2. Rate limiting strategy (token bucket? sliding window?)
3. Circuit breaker implementation (failsafe pattern)
4. File storage during processing (temporary S3? local disk?)
5. Result schema design (flexible JSON? strict tables?)
6. Error recovery and retry mechanism
7. Monitoring and observability hooks

**Suggested Next Steps:**

**Option 1: Use Solution Architect Skill (Recommended)**
```
Use solution-architect skill to create a detailed specification covering:
- System architecture diagram
- Data flow and state management
- Interface contracts
- Security considerations
- Error handling strategy
- Implementation milestones
```

This will provide:
- Comprehensive specification document
- Risk mitigation strategies
- Phased implementation plan
- Clear interface definitions

**Option 2: Proceed with High-Level Plan**
If you're comfortable with complexity, I can:
1. Create feature branch: `EPMCDME-10750`
2. Start with core integration layer
3. Iterate through layers incrementally
4. Add async processing last

However, this approach may require rework as architectural questions arise.

**Which approach do you prefer?**
```

**User:** "Let's use the solution architect skill first"

### Phase 6: Solution Architect Handoff

**Tech Lead:**
```markdown
Excellent choice. I'll invoke the solution-architect skill to create a
comprehensive specification.

**Context being passed:**
- Jira ticket: EPMCDME-10750
- Complexity assessment: Complex
- Technical decisions: AWS Textract, PostgreSQL, Async processing
- Affected components: [list from assessment]
- Risk factors: [list from assessment]
```

**Tech Lead uses Skill tool:**
```
Skill(skill="solution-architect", args="Create specification for EPMCDME-10750:
External document analysis integration. Context: AWS Textract integration with
async processing and PostgreSQL storage. Complex feature affecting API, Service,
Integration, Repository layers. Key concerns: rate limiting, credential security,
async job management, error recovery.")
```

**Solution Architect Output:**
(Solution architect skill creates detailed specification with architecture diagrams,
interface definitions, implementation phases, etc.)

### Phase 7: Post-Specification Implementation

After solution architect completes specification:

**Tech Lead:**
```markdown
Specification complete. Ready to start implementation following the approved design.

**Implementation will proceed in phases:**
1. Phase 1: Core integration layer with AWS Textract client
2. Phase 2: Job queue and async processing infrastructure
3. Phase 3: API and service layer endpoints
4. Phase 4: Repository and data persistence
5. Phase 5: Error handling and rate limiting
6. Phase 6: Testing and monitoring

**Creating feature branch:**
```

**Branch Creation:**
```bash
git checkout main
git pull origin main
git checkout -b EPMCDME-10750
git push -u origin EPMCDME-10750
```

**Tech Lead:**
```markdown
Feature branch created: EPMCDME-10750

Starting Phase 1: Core integration layer
Following specification section 3.2...

[Proceeds with implementation following detailed spec]
```

## Outcome

**Time to Specification:** ~45 minutes (solution architect)
**Time to Implementation:** ~3-5 days (complex feature)
**Files Changed:** 18
**Lines Added:** ~1,200
**New Dependencies:** 3 (boto3 for AWS, celery for async, rate-limiter library)
**Complexity Accurate:** Yes - Complex assessment prevented premature implementation

## Key Success Factors

1. **Early Complexity Detection**: Identified as Complex before wasting time on incomplete implementation
2. **Clarifying Questions**: Resolved ambiguities before design phase
3. **Specification First**: Solution architect provided clear roadmap
4. **Risk Mitigation**: Security and rate limiting addressed in design
5. **Phased Approach**: Incremental implementation reduced risk
6. **Proper Branch**: Isolated complex work from main branch

## Comparison: Without Tech Lead Skill

**If user jumped straight into implementation:**
- ❌ Missed credential security pattern
- ❌ Implemented synchronous processing (bad UX)
- ❌ No rate limiting (API abuse risk)
- ❌ Incomplete error handling
- ❌ Would require significant refactoring
- ❌ Estimated 2-3x time wasted on rework

**With Tech Lead Skill:**
- ✅ Comprehensive specification first
- ✅ All architectural decisions made upfront
- ✅ Security and resilience patterns applied
- ✅ Clear implementation roadmap
- ✅ Phased delivery possible
- ✅ Clean, well-architected solution
