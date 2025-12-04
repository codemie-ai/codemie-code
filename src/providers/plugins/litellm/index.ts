/**
 * LiteLLM Provider - Complete Provider Implementation
 *
 * Auto-registers with ProviderRegistry on import.
 */

import { ProviderRegistry } from '../../core/registry.js';
import { LiteLLMSetupSteps } from './litellm.setup-steps.js';

export { LiteLLMTemplate } from './litellm.template.js';
export { LiteLLMSetupSteps } from './litellm.setup-steps.js';

// Register setup steps
ProviderRegistry.registerSetupSteps('litellm', LiteLLMSetupSteps);
