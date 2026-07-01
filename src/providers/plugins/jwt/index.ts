/**
 * JWT Bearer Authorization Provider
 *
 * Export provider template and setup steps.
 * Auto-registers when imported.
 */

import { ProviderRegistry } from '@/providers/core/registry.js';
import { ProviderName } from '@/providers/core/types.js';
import { JWTBearerSetupSteps } from './jwt.setup-steps.js';

export { JWTTemplate } from './jwt.template.js';
export { JWTBearerSetupSteps } from './jwt.setup-steps.js';
export { JWTModelProxy } from './jwt.models.js';
export { resolveJwtToken, resolveJwtTokenEnvVar, JWT_TOKEN_DEFAULT_ENV_VAR } from './jwt.utils.js';

// Register setup steps (model proxy auto-registers in jwt.models.ts)
ProviderRegistry.registerSetupSteps(ProviderName.BEARER_AUTH, JWTBearerSetupSteps);
