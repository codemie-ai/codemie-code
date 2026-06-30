---
name: codemie-onboarding
description: This is smart CodeMie assistant which can help you with onboarding process.
CodeMie can answer to all you questions about capabilities, usage and so on.
---

# AI/Run FAQ

This is smart CodeMie assistant which can help you with onboarding process.
CodeMie can answer to all you questions about capabilities, usage and so on.

## Instructions

1. Extract the user's message from the conversation context
2. Execute the command with the message
3. Return the response

**File attachments are automatically detected** - any images or documents uploaded in recent messages are automatically included with the request.

**ARGUMENTS**: "message"

**Command format:**
```bash
codemie assistants chat "05959338-06de-477d-9cc3-08369f858057" "message"
```

## Examples

**Simple message:**
```bash
codemie assistants chat "05959338-06de-477d-9cc3-08369f858057" "help me with this"
```

**ARGUMENTS**: "check this code" --file /path/to/your/script.py

**With file attachment:**
```bash
codemie assistants chat "05959338-06de-477d-9cc3-08369f858057" "analyze this code" --file "script.py"
```

**With multiple files:**
```bash
codemie assistants chat "05959338-06de-477d-9cc3-08369f858057" "review these files" --file "file1.png" --file "file2.py"
```