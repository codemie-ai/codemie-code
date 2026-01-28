/**
 * Claude Code Skill Template
 *
 * Template for generating skill markdown files
 */

import type { Assistant } from 'codemie-sdk';

/**
 * Generate skill markdown content
 */
export function createSkillMarkdown(assistant: Assistant): string {
  const skillSlug = assistant.slug!;
  const description = assistant.description || `Interact with ${assistant.name} assistant`;

  return `---
name: ${skillSlug}
description: ${description}
---

# ${assistant.name}

## What I Do

${description}

## Instructions

When the user invokes this skill:

1. **Send the message to the assistant**: Use the following bash command to send the user's message to the CodeMie assistant:
   \`\`\`bash
   codemie assistants chat "${assistant.id}" "$USER_MESSAGE"
   \`\`\`

2. **Return the response**: The command will return the assistant's response. Present this response to the user exactly as received, without any modifications or additional formatting.

## Example Usage

User invokes: \`/${skillSlug} "your question here"\`

You should:
\`\`\`bash
codemie assistants chat "${assistant.id}" "your question here"
\`\`\`

Then return the assistant's response directly to the user.
`;
}
