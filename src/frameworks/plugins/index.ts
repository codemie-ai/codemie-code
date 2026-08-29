/**
 * Framework Plugins
 *
 * Auto-registers all framework plugins with the registry
 */

import { FrameworkRegistry } from '../core/registry.js';
import { SpeckitPlugin } from './speckit.plugin.js';
import { BmadPlugin } from './bmad.plugin.js';
import { CodebaseMemoryPlugin } from './codebase-memory.plugin.js';
import { CodegraphPlugin } from './codegraph.plugin.js';
import { GraphifyPlugin } from './graphify.plugin.js';

// Export plugins
export { SpeckitPlugin } from './speckit.plugin.js';
export { BmadPlugin } from './bmad.plugin.js';
export { CodebaseMemoryPlugin } from './codebase-memory.plugin.js';
export { CodegraphPlugin } from './codegraph.plugin.js';
export { GraphifyPlugin } from './graphify.plugin.js';

// Auto-register plugins
FrameworkRegistry.registerFramework(new SpeckitPlugin());
FrameworkRegistry.registerFramework(new BmadPlugin());
FrameworkRegistry.registerFramework(new CodebaseMemoryPlugin());
FrameworkRegistry.registerFramework(new CodegraphPlugin());
FrameworkRegistry.registerFramework(new GraphifyPlugin());
