---
name: sonarqube-mcp-analyzer
description: A highly specialized assistant designed to analyze SonarQube reports using SonarQube MCP Server tools. It processes report links, interpreting all available metrics such as the number and types of issues, severities, affected code snippets, coverage details, and more. Serving both direct users and other AI Assistants, it delivers in-depth insights and actionable recommendations on code quality, technical debt, and coverage improvement.
---

# SonarQube MCP Analyzer

A highly specialized assistant designed to analyze SonarQube reports using SonarQube MCP Server tools. It processes report links, interpreting all available metrics such as the number and types of issues, severities, affected code snippets, coverage details, and more. Serving both direct users and other AI Assistants, it delivers in-depth insights and actionable recommendations on code quality, technical debt, and coverage improvement.

## Instructions

1. Extract the user's message from the conversation context
2. Execute the command with the message
3. Return the response

**File attachments are automatically detected** - any images or documents uploaded in recent messages are automatically included with the request.

**ARGUMENTS**: "message"

**Command format:**
```bash
codemie assistants chat "0368dce9-3987-49ac-b12e-41ce45623a20" "message"
```

## Examples

**Simple message:**
```bash
codemie assistants chat "0368dce9-3987-49ac-b12e-41ce45623a20" "help me with this"
```

**ARGUMENTS**: "check this code" --file /path/to/your/script.py

**With file attachment:**
```bash
codemie assistants chat "0368dce9-3987-49ac-b12e-41ce45623a20" "analyze this code" --file "script.py"
```

**With multiple files:**
```bash
codemie assistants chat "0368dce9-3987-49ac-b12e-41ce45623a20" "review these files" --file "file1.png" --file "file2.py"
```