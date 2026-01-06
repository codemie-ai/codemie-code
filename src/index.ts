// Main exports for CodeMie package

// Agents
export { AgentRegistry } from './agents/registry.js';
export type { AgentAdapter } from './agents/registry.js';

// Utils
export { logger } from './utils/logger.js';
export { exec } from './utils/processes.js';
export * from './utils/errors.js';

// Environment
export { EnvManager } from './env/manager.js';
