/**
 * AWS Bedrock Provider - Complete Provider Implementation
 *
 * All Bedrock-related code in one place for easy maintenance.
 * Auto-registers with ProviderRegistry on import.
 */

export { BedrockTemplate } from './bedrock.template.js';
export { BedrockHealthCheck } from './bedrock.health.js';
export { BedrockModelProxy } from './bedrock.models.js';
export { BedrockSetupSteps } from './bedrock.setup-steps.js';
