// src/agents/plugins/codex/index.ts
// Phase 1 exports (Core Plugin)
export { CodexPlugin, CodexPluginMetadata } from './codex.plugin.js';

// Phase 2 exports (Session Analytics)
export { CodexSessionAdapter } from './codex.session.js';
export {
  getCodexHomePath,
  getCodexSessionsPath,
  getCodexSessionDayPath,
} from './codex.paths.js';

// Types
export type {
  CodexRolloutRecord,
  CodexSessionMeta,
  CodexTurnContext,
  CodexResponseItem,
  CodexEventMsg,
  CodexSessionMetadata,
} from './codex-message-types.js';

// Type guards
export {
  validateCodexMetadata,
  hasCodexMetadata,
} from './codex-message-types.js';

// Discovery types
export type {
  SessionDiscoveryOptions,
  SessionDescriptor,
} from '../../core/session/discovery-types.js';
