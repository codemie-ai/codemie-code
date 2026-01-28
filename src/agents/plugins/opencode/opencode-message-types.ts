/**
 * OpenCode Session metadata
 *
 * Source: packages/opencode/src/session/index.ts (Session.Info)
 * Storage path: storage/session/{projectID}/{sessionID}.json
 *
 * VALIDATED against real OpenCode storage (v1.1.36)
 */
export interface OpenCodeSession {
  id: string;
  title?: string;
  // REQUIRED for cwd filtering per tech spec ADR-003
  // This is the project directory where the session was created
  directory: string;
  // OpenCode uses numeric timestamps, NOT ISO strings
  time: {
    created: number;  // Unix timestamp (ms)
    updated: number;  // Unix timestamp (ms)
  };
  // Optional fields from Session.Info that may be useful
  projectID?: string;  // Git root commit hash or 'global'
  slug?: string;       // Human-readable session slug
  version?: string;    // OpenCode version
}

/**
 * Token tracking structure
 *
 * Source: packages/opencode/src/session/message-v2.ts
 */
export interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning?: number;
  cache?: {
    read: number;
    write: number;
  };
}

/**
 * OpenCode Message (MessageV2 format)
 *
 * Source: packages/opencode/src/session/message-v2.ts
 * Storage path: storage/message/{sessionID}/{messageID}.json
 *
 * Note: This is a discriminated union in OpenCode (MessageV2.Info = User | Assistant)
 */
export interface OpenCodeMessageBase {
  id: string;
  sessionID: string;  // Uppercase D per OpenCode convention
  role: 'user' | 'assistant';
  // Numeric timestamp
  time: {
    created: number;  // Unix timestamp (ms)
  };
}

/**
 * User message
 *
 * User messages can have agent context and model selection
 */
export interface OpenCodeUserMessage extends OpenCodeMessageBase {
  role: 'user';
  // User messages can have agent context
  agent?: string;
  // Model info for user-initiated model selection
  model?: {
    providerID?: string;
    modelID?: string;
  };
}

/**
 * Assistant message with tokens and cost
 */
export interface OpenCodeAssistantMessage extends OpenCodeMessageBase {
  role: 'assistant';
  // These fields are on assistant messages
  providerID?: string;
  modelID?: string;
  path?: string[];
  tokens?: OpenCodeTokens;
  cost?: number;
  // Legacy: agent field (may still exist in some sessions)
  agent?: string;
}

/**
 * Union type for messages
 */
export type OpenCodeMessage = OpenCodeUserMessage | OpenCodeAssistantMessage;

/**
 * Type guard for assistant messages
 */
export function isAssistantMessage(msg: OpenCodeMessage): msg is OpenCodeAssistantMessage {
  return msg.role === 'assistant';
}

/**
 * Base part interface
 *
 * Source: packages/opencode/src/session/message-v2.ts
 * Storage path: storage/part/{messageID}/{partID}.json
 */
interface OpenCodePartBase {
  id: string;
  messageID: string;  // Uppercase D per OpenCode convention
  sessionID: string;  // Also present in part files
  type: string;
}

/**
 * Text part
 */
export interface OpenCodeTextPart extends OpenCodePartBase {
  type: 'text';
  text: string;
}

/**
 * Tool use part
 *
 * CORRECTED: input is inside state, not at top level (validated from real data)
 */
export interface OpenCodeToolPart extends OpenCodePartBase {
  type: 'tool';
  callID: string;
  tool: string;  // Tool name
  state: {
    status: 'pending' | 'running' | 'completed' | 'error';
    input?: Record<string, unknown>;  // Tool input parameters
    output?: string;
    error?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: {
      start?: number;
      end?: number;
    };
  };
}

/**
 * File part
 */
export interface OpenCodeFilePart extends OpenCodePartBase {
  type: 'file';
  mime: string;
  url?: string;
  source?: 'local' | 'remote';
  filename?: string;
}

/**
 * Reasoning part (for o1-style models)
 */
export interface OpenCodeReasoningPart extends OpenCodePartBase {
  type: 'reasoning';
  text: string;
}

/**
 * Step finish part (contains token info and cost)
 *
 * tokens and cost are REQUIRED per OpenCode source
 */
export interface OpenCodeStepFinishPart extends OpenCodePartBase {
  type: 'step-finish';
  tokens: OpenCodeTokens;  // REQUIRED
  cost: number;            // REQUIRED
  reason?: string;         // Finish reason (e.g., "tool-calls", "stop")
  snapshot?: string;       // Snapshot hash
}

/**
 * Patch part (diff/file changes)
 */
export interface OpenCodePatchPart extends OpenCodePartBase {
  type: 'patch';
  file?: string;
  patch?: string;
}

/**
 * Step start part
 */
export interface OpenCodeStepStartPart extends OpenCodePartBase {
  type: 'step-start';
}

/**
 * Discriminated union of all part types
 */
export type OpenCodePart =
  | OpenCodeTextPart
  | OpenCodeToolPart
  | OpenCodeFilePart
  | OpenCodeReasoningPart
  | OpenCodeStepFinishPart
  | OpenCodePatchPart
  | OpenCodeStepStartPart;

// Type guards for safe narrowing
export function isTextPart(part: OpenCodePart): part is OpenCodeTextPart {
  return part.type === 'text';
}

export function isToolPart(part: OpenCodePart): part is OpenCodeToolPart {
  return part.type === 'tool';
}

export function isFilePart(part: OpenCodePart): part is OpenCodeFilePart {
  return part.type === 'file';
}

export function isReasoningPart(part: OpenCodePart): part is OpenCodeReasoningPart {
  return part.type === 'reasoning';
}

export function isStepFinishPart(part: OpenCodePart): part is OpenCodeStepFinishPart {
  return part.type === 'step-finish';
}

export function isPatchPart(part: OpenCodePart): part is OpenCodePatchPart {
  return part.type === 'patch';
}

export function isStepStartPart(part: OpenCodePart): part is OpenCodeStepStartPart {
  return part.type === 'step-start';
}

/**
 * OpenCode extends ParsedSession.metadata with these additional fields.
 * Per tech spec ADR-1.
 *
 * Access pattern (within OpenCode plugin boundary only):
 *   validateOpenCodeMetadata(session.metadata);
 *   const { storagePath, openCodeSessionId } = session.metadata as OpenCodeMetadata;
 */
export interface OpenCodeMetadata {
  projectPath?: string;
  createdAt?: string;
  updatedAt?: string;
  storagePath: string;
  openCodeSessionId: string;
  openCodeVersion?: string;  // Track OpenCode version for compatibility
}

/**
 * Runtime validation for OpenCode metadata extension (per tech spec ADR-1, Review 10 M4).
 * Call before accessing OpenCode-specific fields.
 *
 * @throws Error if metadata is missing required fields
 */
export function validateOpenCodeMetadata(
  metadata: unknown
): asserts metadata is OpenCodeMetadata {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('Metadata must be an object');
  }
  const m = metadata as Record<string, unknown>;
  if (!m.storagePath || typeof m.storagePath !== 'string') {
    throw new Error('Missing or invalid storagePath in metadata');
  }
  if (!m.openCodeSessionId || typeof m.openCodeSessionId !== 'string') {
    throw new Error('Missing or invalid openCodeSessionId in metadata');
  }
}

/**
 * Check if metadata has OpenCode-specific fields (non-throwing version)
 */
export function hasOpenCodeMetadata(metadata: unknown): metadata is OpenCodeMetadata {
  if (!metadata || typeof metadata !== 'object') return false;
  const m = metadata as Record<string, unknown>;
  return (
    typeof m.storagePath === 'string' &&
    m.storagePath.length > 0 &&
    typeof m.openCodeSessionId === 'string' &&
    m.openCodeSessionId.length > 0
  );
}
