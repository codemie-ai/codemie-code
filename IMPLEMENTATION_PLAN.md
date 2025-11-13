# 🎯 **FINAL DETAILED IMPLEMENTATION PLAN**

# CodeMie Native Coding Agent - Production Implementation Plan

## 📋 **Executive Summary**

Implement a native Node.js coding agent for CodeMie using the latest LangChain v1.0+ ecosystem, featuring:
- **LangGraph v1.0.2** ReAct agent with streaming
- **Modern Clack UI** for terminal interactions
- **Comprehensive system tools** (filesystem, commands, Git)
- **Full integration** with existing CodeMie CLI infrastructure
- **Production-ready** architecture with TypeScript

---

## 🛠️ **Technology Stack (Latest Versions)**

```json
{
  "name": "@codemieai/code-agent",
  "version": "1.0.0",
  "type": "module",
  "engines": { "node": ">=24.0.0" },
  "dependencies": {
    "@langchain/core": "^1.0.4",
    "@langchain/langgraph": "^1.0.2",
    "@langchain/openai": "^1.1.0",
    "@langchain/anthropic": "^1.0.0",
    "zod": "^4.1.12",
    "@clack/prompts": "^0.11.0",
    "@clack/core": "^0.5.0",
    "chalk": "^5.3.0",
    "commander": "^11.1.0",
    "dotenv": "^16.3.1"
  }
}
```

---

## 📁 **Complete Project Structure**

```
src/agents/adapters/
└── codemie-code.ts                 # Main agent adapter (integrates with registry)

src/agents/codemie-code/
├── index.ts                        # Main entry point
├── agent.ts                        # LangGraph ReAct agent implementation
├── config.ts                       # Configuration management
├── prompts.ts                      # System prompts
├── streaming/
│   ├── events.ts                   # Event type definitions
│   ├── formatter.ts                # Output formatting
│   └── ui.ts                       # Clack terminal UI
├── tools/
│   ├── index.ts                    # Tool registry
│   ├── filesystem.ts               # File operations
│   ├── command.ts                  # Shell execution
│   ├── git.ts                      # Git operations
│   └── security.ts                 # Path validation & sandboxing
└── types.ts                       # TypeScript definitions
```

---

## 🚀 **PHASE 1: Foundation & Setup (Days 1-2)**

### **Day 1: Project Structure & Dependencies**

#### **Task 1.1: Initialize Project Structure**
```bash
# Create directory structure
mkdir -p src/agents/codemie-code/{streaming,tools}
touch src/agents/codemie-code/{index,agent,config,prompts,types}.ts
touch src/agents/codemie-code/streaming/{events,formatter,ui}.ts
touch src/agents/codemie-code/tools/{index,filesystem,command,git,security}.ts
```

#### **Task 1.2: Install Latest Dependencies**
```bash
npm install @langchain/core@^1.0.4 @langchain/langgraph@^1.0.2 \
  @langchain/openai@^1.1.0 @langchain/anthropic@^1.0.0 \
  zod@^4.1.12 @clack/prompts@^0.11.0 @clack/core@^0.5.0
```

#### **Task 1.3: TypeScript Configuration**
```json
// tsconfig.json updates
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "node",
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "strict": true
  }
}
```

### **Day 2: Core Types & Configuration**

#### **Task 2.1: Define Core Types (`src/agents/codemie-code/types.ts`)**
```typescript
export interface CodeMieConfig {
  baseUrl: string;
  authToken: string;
  model: string;
  provider: 'openai' | 'anthropic' | 'azure' | 'bedrock' | 'litellm';
  timeout: number;
  workingDirectory: string;
  debug: boolean;
}

export interface AgentEvent {
  type: 'thinking_start' | 'thinking_end' | 'content_chunk' |
        'tool_call_start' | 'tool_call_result' | 'complete' | 'error';
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
  result?: string;
  error?: string;
}

export type EventCallback = (event: AgentEvent) => void;
```

#### **Task 2.2: Configuration Management (`src/agents/codemie-code/config.ts`)**
```typescript
import { loadAIConfig, detectProvider } from '../../utils/env-mapper.js';
import type { CodeMieConfig } from './types.js';

export function loadCodeMieConfig(workingDir?: string): CodeMieConfig {
  const aiConfig = loadAIConfig();
  const provider = detectProvider(aiConfig.model);

  return {
    baseUrl: aiConfig.baseUrl,
    authToken: aiConfig.authToken,
    model: aiConfig.model,
    provider,
    timeout: aiConfig.timeout || 300,
    workingDirectory: workingDir || process.cwd(),
    debug: process.env.CODEMIE_DEBUG === 'true'
  };
}
```

---

## 🤖 **PHASE 2: Core Agent Implementation (Days 3-4)**

### **Day 3: LangGraph Agent Core**

#### **Task 3.1: System Prompts (`src/agents/codemie-code/prompts.ts`)**
```typescript
export const SYSTEM_PROMPT = `You are CodeMie, an advanced AI coding assistant designed to help developers with various programming tasks.

CAPABILITIES:
- Read, write, and modify files in the project directory
- Execute shell commands for building, testing, and development tasks
- Perform Git operations (status, diff, add, commit, log)
- Analyze code structure and provide recommendations
- Help with debugging, refactoring, and code optimization

GUIDELINES:
- Always explain what you're doing before taking actions
- Ask for confirmation before making significant changes
- Provide clear, concise explanations of your reasoning
- Follow best practices for the programming language being used
- Be security-conscious when executing commands or modifying files

CURRENT WORKING DIRECTORY: {workingDirectory}

You have access to the following tools:`;
```

#### **Task 3.2: LangGraph Agent (`src/agents/codemie-code/agent.ts`)**
```typescript
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { StructuredTool } from '@langchain/core/tools';
import type { CodeMieConfig, EventCallback, AgentEvent } from './types.js';
import { SYSTEM_PROMPT } from './prompts.js';

export class CodeMieAgent {
  private agent: any;
  private config: CodeMieConfig;

  constructor(config: CodeMieConfig, tools: StructuredTool[]) {
    this.config = config;
    const llm = this.createLLM();

    this.agent = createReactAgent({
      llm,
      tools,
      messageModifier: SYSTEM_PROMPT.replace('{workingDirectory}', config.workingDirectory)
    });
  }

  private createLLM() {
    const commonConfig = {
      temperature: 0.7,
      maxTokens: 4096,
      timeout: this.config.timeout * 1000
    };

    switch (this.config.provider) {
      case 'anthropic':
        return new ChatAnthropic({
          model: this.config.model,
          apiKey: this.config.authToken,
          baseURL: this.config.baseUrl,
          ...commonConfig
        });

      default:
        return new ChatOpenAI({
          model: this.config.model,
          apiKey: this.config.authToken,
          configuration: { baseURL: this.config.baseUrl },
          ...commonConfig
        });
    }
  }

  async chatStream(message: string, onEvent: EventCallback): Promise<void> {
    try {
      onEvent({ type: 'thinking_start' });

      const stream = await this.agent.stream(
        { messages: [{ role: 'user', content: message }] },
        {
          streamMode: 'updates',
          recursionLimit: 50
        }
      );

      for await (const chunk of stream) {
        this.processStreamChunk(chunk, onEvent);
      }

      onEvent({ type: 'thinking_end' });
      onEvent({ type: 'complete' });

    } catch (error) {
      onEvent({ type: 'error', error: error.message });
      throw error;
    }
  }

  private processStreamChunk(chunk: any, onEvent: EventCallback) {
    // Handle agent node updates (LLM responses)
    if (chunk.agent?.messages) {
      const lastMessage = chunk.agent.messages.at(-1);

      if (lastMessage?.content) {
        onEvent({
          type: 'content_chunk',
          content: lastMessage.content
        });
      }

      if (lastMessage?.tool_calls?.length) {
        for (const toolCall of lastMessage.tool_calls) {
          onEvent({
            type: 'tool_call_start',
            toolName: toolCall.name,
            toolArgs: toolCall.args
          });
        }
      }
    }

    // Handle tool node updates (tool execution results)
    if (chunk.tools?.messages) {
      for (const toolMessage of chunk.tools.messages) {
        onEvent({
          type: 'tool_call_result',
          toolName: toolMessage.name || 'unknown',
          result: toolMessage.content
        });
      }
    }
  }
}
```

### **Day 4: Agent Integration & Testing**

#### **Task 4.1: Main Entry Point (`src/agents/codemie-code/index.ts`)**
```typescript
import { CodeMieAgent } from './agent.js';
import { loadCodeMieConfig } from './config.js';
import { createSystemTools } from './tools/index.js';
import { ModernInteractiveCLI } from './streaming/ui.js';
import type { CodeMieConfig } from './types.js';

export class CodeMieCode {
  private agent: CodeMieAgent | null = null;
  private config: CodeMieConfig;
  private ui: ModernInteractiveCLI;

  constructor(workingDir?: string) {
    this.config = loadCodeMieConfig(workingDir);
    this.ui = new ModernInteractiveCLI();
  }

  async initialize(): Promise<void> {
    const tools = await createSystemTools(this.config);
    this.agent = new CodeMieAgent(this.config, tools);
  }

  async startInteractive(): Promise<void> {
    if (!this.agent) {
      throw new Error('Agent not initialized. Call initialize() first.');
    }

    await this.ui.start(this.agent, this.config);
  }

  async executeTask(task: string): Promise<string> {
    if (!this.agent) {
      throw new Error('Agent not initialized. Call initialize() first.');
    }

    return new Promise((resolve, reject) => {
      let response = '';

      this.agent!.chatStream(task, (event) => {
        switch (event.type) {
          case 'content_chunk':
            response += event.content;
            break;
          case 'complete':
            resolve(response);
            break;
          case 'error':
            reject(new Error(event.error));
            break;
        }
      });
    });
  }
}
```

---

## ⏱️ **FINAL TIMELINE SUMMARY**

| Phase | Days | Deliverables |
|-------|------|-------------|
| **Phase 1** | 1-2 | Project setup, dependencies, configuration |
| **Phase 2** | 3-4 | LangGraph agent core, streaming implementation |
| **Phase 3** | 5-6 | System tools (filesystem, commands, Git) |
| **Phase 4** | 7-8 | Modern Clack UI, agent adapter integration |
| **Phase 5** | 9-10 | Testing, documentation, final polish |

**Total: 10 days** for a production-ready, modern coding agent with the latest LangChain v1.0+ ecosystem.

This implementation plan provides a **complete, actionable roadmap** for building a native CodeMie coding agent that leverages the latest technologies while maintaining full compatibility with the existing infrastructure.