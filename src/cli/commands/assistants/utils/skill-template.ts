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
  const modelInfo = assistant.llm_model_type || '';

  // Build system prompt section if exists
  const systemPromptSection = assistant.system_prompt ? `

## Who I Am

${assistant.system_prompt}
` : '';

  return `---
name: ${skillSlug}
description: Chat with ${assistant.name}${modelInfo ? ` (${modelInfo})` : ''}
disable-model-invocation: true
allowed-tools: Bash(codemie:*)
argument-hint: "[your message]"
---

# ${assistant.name} Assistant

**Description:** ${description}${modelInfo ? `\n**Model:** ${modelInfo}` : ''}
${systemPromptSection}

## How to Use Me

You can ask me anything by typing:

\`\`\`
/${skillSlug} "your question or request here"
\`\`\`

I'll process your message and provide a helpful response based on my capabilities and context.

## What I Do

${description}

I'm here to assist you with your questions and tasks. Feel free to interact with me naturally!

---

**Technical Implementation**

This assistant is powered by the CodeMie platform. When you send me a message, it's processed by the backend API and I respond with relevant information.

IMPORTANT!: Return the assistant's response exactly as received without any modifications, explanations, or additional formatting.

Message: $ARGUMENTS

\\\`\\\`\\\`bash
codemie assistants chat "${assistant.id}" "$ARGUMENTS"
\\\`\\\`\\\`
`;
}
