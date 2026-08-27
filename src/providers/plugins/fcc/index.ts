/**
 * FCC Provider
 *
 * Auto-registers with ProviderRegistry on import.
 *
 * FCC provider routes requests through a corporate LiteLLM gateway with SSO authentication.
 *
 * @packageDocumentation
 */

import { ProviderRegistry } from '../../core/registry.js';
import { FCCProvider } from './fcc.template.js';
import { FCCSetupSteps } from './fcc.setup-steps.js';
import { FCCModelProxy } from './fcc.models.js';
import { FCCHealthCheck as FCCHealthCheckClass } from './fcc.health.js';

// Export public API
export { FCCProvider, FCCProvider as FCC } from './fcc.template.js';
export { FCCSetupSteps } from './fcc.setup-steps.js';
export { FCCModelProxy } from './fcc.models.js';
export { FCCHealthCheck as FCCHealthCheckClass } from './fcc.health.js';
export { validateFCCCredentials, getFCCCredentialsFromEnv } from './fcc.auth.js';
export type { FCCCredentials } from './fcc.auth.js';

// Register setup steps
ProviderRegistry.registerSetupSteps('fcc', FCCSetupSteps);

// Register model proxy
ProviderRegistry.registerModelProxy('fcc', FCCModelProxy);

// Register health check
ProviderRegistry.registerHealthCheck('fcc', new FCCHealthCheckClass());