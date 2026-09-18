// src/agents/plugins/codex/index.ts
// Phase 1 exports (Core Plugin)
export { CodexPlugin, CodexPluginMetadata } from './codex.plugin.js';

// Phase 2 exports (Session Analytics)
export { CodexSessionAdapter } from './codex.session.js';
export {
  getCodexHomePath,
  getCodexSessionsPath,
  getCodexSessionDayPath,
  getCodexDiscoverySessionRoots,
} from './codex.paths.js';
export type { CodexDiscoveryRoot } from './codex.paths.js';

// Session-prompt helpers (public boundary for CLI-layer consumers)
export { isCodexInjectedUserText } from './session/codex-user-prompt.js';

// Types
export type {
  CodexRolloutRecord,
  CodexSessionMeta,
  CodexTurnContext,
  CodexResponseItem,
  CodexEventMsg,
  CodexResponseItemMessage,
  CodexContentBlock,
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
