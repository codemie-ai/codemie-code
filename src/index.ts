// Main exports for CodeMie package

// Re-export API for external consumers (VSCode plugins, etc.)
export * from './api/index.js';

// Legacy exports (for backward compatibility)
export { AgentRegistry } from './agents/registry.js';
export type { AgentAdapter } from './agents/registry.js';
export { logger } from './utils/logger.js';
export { exec } from './utils/processes.js';
export * from './utils/errors.js';
export { EnvManager } from './env/manager.js';
