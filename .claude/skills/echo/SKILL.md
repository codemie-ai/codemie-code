---
name: echo
description: Echo back the provided text. Simple skill for testing and demonstration purposes. Invokable with /echo <text>.

# Allowed Tools
allowed-tools:
  - "Bash(echo*)"

# Hooks
hooks:
  Stop:
    - type: command
      command: |
        #!/bin/bash
        # Verify echo was executed
        if [ -n "$ECHO_OUTPUT" ]; then
          echo "✓ Echo completed: $ECHO_OUTPUT"
          exit 0
        else
          echo "❌ No output generated"
          exit 2
        fi
      timeout: 5
---

# /echo - Echo Text Skill

## Overview

This skill echoes back any text provided to it. It's a simple demonstration skill that shows the basic structure of CodeMie skills and can be used for testing purposes.

## Quick Start

```bash
# Basic usage
/echo Hello, World!
# Output: Hello, World!

# Echo multiple words
/echo This is a test message
# Output: This is a test message

# Echo with special characters
/echo "Special characters: !@#$%"
# Output: Special characters: !@#$%
```

## Current Context (Dynamic)

**Current directory:** !`pwd`

**Current time:** !`date`

## Core Workflow

### Step 1: Parse Input

Extract the text to echo from the user's message. The text comes after the `/echo` command.

**Example:**
- Input: `/echo Hello, World!`
- Text to echo: `Hello, World!`

### Step 2: Echo the Text

Use the bash `echo` command to output the text:

```bash
# Echo the provided text
TEXT="<user-provided-text>"
echo "$TEXT"

# Export for stop hook validation
export ECHO_OUTPUT="$TEXT"
```

### Step 3: Report Results

Display the echoed text to the user:

```
✓ Echo output:

<echoed-text>
```

## Usage Examples

### Example 1: Simple Message

**Input:**
```
/echo Hello from CodeMie!
```

**Output:**
```
✓ Echo output:

Hello from CodeMie!
```

### Example 2: Multi-line Text

**Input:**
```
/echo Line 1
Line 2
Line 3
```

**Output:**
```
✓ Echo output:

Line 1
Line 2
Line 3
```

### Example 3: Variables and Expressions

**Input:**
```
/echo Current user: $(whoami)
```

**Output:**
```
✓ Echo output:

Current user: <username>
```

## Best Practices

1. **Quote special characters** - Use quotes for text with special shell characters
2. **Keep it simple** - This skill is designed for straightforward text echoing
3. **Use for testing** - Great for testing the skills system functionality
4. **Combine with other commands** - Can be used to verify skill invocation patterns

## Requirements

- Bash shell (available on all Unix-like systems)
- No special permissions required

## Notes

- This is a demonstration skill showing the minimal skill structure
- The skill uses only the `echo` command, which is safe and universally available
- The stop hook validates that output was generated
- Can be extended to support more complex text processing if needed

---

**This skill demonstrates the basic CodeMie skill structure and can serve as a template for creating new skills.**
