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

// Register setup steps
ProviderRegistry.registerSetupSteps('bearer-auth', JWTBearerSetupSteps);
