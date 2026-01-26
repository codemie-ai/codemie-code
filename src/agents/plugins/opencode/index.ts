// Phase 1 exports (Core Plugin)
export { OpenCodePlugin, OpenCodePluginMetadata } from './opencode.plugin.js';
export {
  OPENCODE_MODEL_CONFIGS,
  getModelConfig,
  type OpenCodeModelConfig
} from './opencode-model-configs.js';

// Phase 2 exports (Session Analytics)
export { OpenCodeSessionAdapter } from './opencode.session.js';
// FIXED (GPT-5.10/5.11): Export canonical function names, not deprecated alias
export {
  getOpenCodeStoragePath,
  getOpenCodeSessionsPath,
  getOpenCodeMessagesPath,
  getOpenCodePartsPath,
  // Deprecated alias for backward compatibility (if external code depends on it)
  getSessionStoragePath
} from './opencode.paths.js';
// Export types if needed externally
export type {
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodePart,
  OpenCodeTokens
} from './opencode-message-types.js';
// Export type guards for external use
export {
  isTextPart,
  isToolPart,
  isFilePart,
  isReasoningPart,
  isStepFinishPart,
  isAssistantMessage
} from './opencode-message-types.js';
// Export discovery types for external use
export type {
  SessionDiscoveryOptions,
  SessionDescriptor
} from '../../core/session/discovery-types.js';
