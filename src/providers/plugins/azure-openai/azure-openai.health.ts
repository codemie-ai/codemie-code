/**
 * Azure OpenAI Health Check Implementation
 *
 * Validates Azure OpenAI endpoint availability and deployment discovery.
 */

import type { CodeMieConfigOptions } from '../../../env/types.js';
import type { HealthCheckResult, ModelInfo } from '../../core/types.js';
import { BaseHealthCheck } from '../../core/base/BaseHealthCheck.js';
import { ProviderRegistry } from '../../core/registry.js';
import { AzureOpenAITemplate } from './azure-openai.template.js';
import { AzureOpenAIModelProxy } from './azure-openai.models.js';

export class AzureOpenAIHealthCheck extends BaseHealthCheck {
  private modelProxy: AzureOpenAIModelProxy;
  private azureApiVersion = '2024-06-01';
  private azureDeployment?: string;
  private azureApiKey?: string;
  // Tracks the effective endpoint after check() is called (not the constructor default).
  private activeBaseUrl: string;

  constructor(baseUrl: string = AzureOpenAITemplate.defaultBaseUrl) {
    super({
      provider: 'azure-openai',
      baseUrl,
      timeout: 10000
    });
    this.activeBaseUrl = baseUrl;
    this.modelProxy = new AzureOpenAIModelProxy(baseUrl);
  }

  supports(provider: string): boolean {
    return provider === 'azure-openai';
  }

  async check(config: CodeMieConfigOptions): Promise<HealthCheckResult> {
    this.azureApiVersion = config.azureApiVersion || '2024-06-01';
    this.azureDeployment = config.azureDeployment || config.model;
    this.azureApiKey = config.apiKey;
    // Always use the runtime endpoint from config, NOT this.config.baseUrl which
    // is frozen to the constructor default (the auto-registered singleton is created
    // without an endpoint, so this.config.baseUrl would be the placeholder URL).
    this.activeBaseUrl = config.baseUrl || AzureOpenAITemplate.defaultBaseUrl;
    this.modelProxy = new AzureOpenAIModelProxy(
      this.activeBaseUrl,
      config.apiKey,
      this.azureApiVersion
    );
    return super.check(config);
  }

  protected async ping(): Promise<void> {
    const models = await this.listModels();
    if (models.length === 0) {
      throw new Error('No Azure OpenAI deployments found. Verify that at least one deployment exists and that the API version matches the resource.');
    }
  }

  protected async getVersion(): Promise<string | undefined> {
    return `api-version: ${this.azureApiVersion}`;
  }

  async listModels(): Promise<ModelInfo[]> {
    // Use this.activeBaseUrl (set in check()) rather than this.config.baseUrl
    // which is frozen to the placeholder URL from the auto-registered singleton.
    return this.modelProxy.fetchModels({
      provider: 'azure-openai',
      baseUrl: this.activeBaseUrl,
      apiKey: this.azureApiKey,
      model: this.azureDeployment || 'temp',
      timeout: 300,
      azureApiVersion: this.azureApiVersion
    } as CodeMieConfigOptions);
  }

  protected getUnreachableResult(): HealthCheckResult {
    const endpoint = this.activeBaseUrl || AzureOpenAITemplate.defaultBaseUrl;
    const apiVersion = this.azureApiVersion;
    return {
      provider: 'azure-openai',
      status: 'unreachable',
      message: 'Cannot connect to Azure OpenAI',
      remediation: `Check Azure OpenAI configuration:\n  1. Verify the resource endpoint is correct: ${endpoint}\n  2. Verify the API key is valid\n  3. Verify the deployment exists and is accessible\n  4. Ensure the API version is supported: ${apiVersion}\n  5. Ensure the deployment name matches the Azure OpenAI Studio deployment\n\nSetup Azure OpenAI:\n  - Create a resource in Azure Portal\n  - Deploy a model in Azure OpenAI Studio\n  - Configure endpoint, key, API version, and deployment name in CodeMie`
    };
  }

  protected getHealthyMessage(models: ModelInfo[]): string {
    return models.length > 0
      ? `Azure OpenAI is accessible with ${models.length} deployment(s) available${this.azureDeployment ? ` (active: ${this.azureDeployment})` : ''}`
      : 'Azure OpenAI is accessible';
  }

  protected getNoModelsRemediation(): string {
    return 'Create a deployment in Azure OpenAI Studio and try again.';
  }
}

ProviderRegistry.registerHealthCheck('azure-openai', new AzureOpenAIHealthCheck());
