/**
 * LiteLLM Provider - Complete Provider Implementation
 *
 * Auto-registers with ProviderRegistry on import.
 */

import { ProviderRegistry } from '../../core/registry.js';
import { LiteLLMSetupSteps } from './litellm.setup-steps.js';
import { LiteLLMModelProxy } from './litellm.models.js';

export { LiteLLMTemplate } from './litellm.template.js';
export { LiteLLMSetupSteps } from './litellm.setup-steps.js';

// Register setup steps
ProviderRegistry.registerSetupSteps('litellm', LiteLLMSetupSteps);

// Register model proxy (fetchModels uses runtime config, so empty defaults are fine)
ProviderRegistry.registerModelProxy('litellm', new LiteLLMModelProxy(''));
