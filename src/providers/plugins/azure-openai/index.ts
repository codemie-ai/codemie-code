/**
 * Azure OpenAI Provider - Complete Provider Implementation
 *
 * Auto-registers with ProviderRegistry on import.
 */

export { AzureOpenAITemplate } from './azure-openai.template.js';
export { AzureOpenAISetupSteps } from './azure-openai.setup-steps.js';
export { AzureOpenAIModelProxy } from './azure-openai.models.js';
export { AzureOpenAIHealthCheck } from './azure-openai.health.js';

// Auto-register setup steps
import { ProviderRegistry } from '../../core/registry.js';
import { AzureOpenAITemplate } from './azure-openai.template.js';
import { AzureOpenAISetupSteps } from './azure-openai.setup-steps.js';

ProviderRegistry.registerProviderSetup(AzureOpenAITemplate, AzureOpenAISetupSteps);
