---
name: codemie-jira-assistant
description: Business Analyst Assistant - expert to work with Jira. Used for creating/getting/managing Jira tickets in EPM-CDME project (Epics, Stories, Tasks, and Bugs). Main role is to analyze requirements from the request, clarify additional questions if necessary, generate requirements with the description structure defined in the prompt and additional details from the request, and create tickets in EPM-CDME project Jira. The Assistant uses Generic Jira tool for Jira tickets creation.
---

# CodeMie JIRA Assistant

Business Analyst Assistant - expert to work with Jira. Used for creating/getting/managing Jira tickets in EPM-CDME project (Epics, Stories, Tasks, and Bugs). Main role is to analyze requirements from the request, clarify additional questions if necessary, generate requirements with the description structure defined in the prompt and additional details from the request, and create tickets in EPM-CDME project Jira. The Assistant uses Generic Jira tool for Jira tickets creation.

## Instructions

1. Extract the user's message from the conversation context
2. Execute the command with the message
3. Return the response

**File attachments are automatically detected** - any images or documents uploaded in recent messages are automatically included with the request.

**ARGUMENTS**: "message"

**Command format:**
```bash
codemie assistants chat "289d2751-afd9-4c77-a272-90df7cd71702" "message"
```

## Examples

**Simple message:**
```bash
codemie assistants chat "289d2751-afd9-4c77-a272-90df7cd71702" "help me with this"
```

**ARGUMENTS**: "check this code" --file /path/to/your/script.py

**With file attachment:**
```bash
codemie assistants chat "289d2751-afd9-4c77-a272-90df7cd71702" "analyze this code" --file "script.py"
```

**With multiple files:**
```bash
codemie assistants chat "289d2751-afd9-4c77-a272-90df7cd71702" "review these files" --file "file1.png" --file "file2.py"
```