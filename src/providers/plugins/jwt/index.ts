/**
 * JWT Bearer Authorization Provider
 *
 * Export provider template and setup steps.
 * Auto-registers when imported.
 */

import { ProviderRegistry } from '../../core/registry.js';
import { JWTBearerSetupSteps } from './jwt.setup-steps.js';

export { JWTTemplate } from './jwt.template.js';
export { JWTBearerSetupSteps } from './jwt.setup-steps.js';
export { JWTModelProxy } from './jwt.models.js';

// Register setup steps (model proxy auto-registers in jwt.models.ts)
ProviderRegistry.registerSetupSteps('bearer-auth', JWTBearerSetupSteps);
