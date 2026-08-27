
 

import { ProviderRegistry } from '../../core/registry.js';
import { FCCProvider } from './fcc.template.js';
import { FCCSetupSteps } from './fcc.setup-steps.js';
import { FCCModelProxy } from './fcc.models.js';
import { FCCHealthCheck as FCCHealthCheckClass } from './fcc.health.js';

export { FCCProvider, FCCProvider as FCC } from './fcc.template.js';
export { FCCSetupSteps } from './fcc.setup-steps.js';
export { FCCModelProxy } from './fcc.models.js';
export { FCCHealthCheck as FCCHealthCheckClass } from './fcc.health.js';
export { validateFCCCredentials, getFCCCredentialsFromEnv } from './fcc.auth.js';
export type { FCCCredentials } from './fcc.auth.js';

ProviderRegistry.registerSetupSteps('fcc', FCCSetupSteps);

ProviderRegistry.registerModelProxy('fcc', FCCModelProxy);

ProviderRegistry.registerHealthCheck('fcc', new FCCHealthCheckClass());