/**
 * Framework Plugins
 *
 * Auto-registers all framework plugins with the registry
 */

import { FrameworkRegistry } from '../core/registry.js';
import { SpeckitPlugin } from './speckit.plugin.js';
import { BmadPlugin } from './bmad.plugin.js';

// Export plugins
export { SpeckitPlugin } from './speckit.plugin.js';
export { BmadPlugin } from './bmad.plugin.js';

// Auto-register plugins
FrameworkRegistry.registerFramework(new SpeckitPlugin());
FrameworkRegistry.registerFramework(new BmadPlugin());
