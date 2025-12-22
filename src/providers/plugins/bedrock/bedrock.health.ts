/**
 * AWS Bedrock Health Check Implementation
 *
 * Validates AWS Bedrock availability and functionality.
 * Uses BaseHealthCheck for common patterns.
 */

import type { ModelInfo } from '../../core/types.js';
import { BaseHealthCheck } from '../../core/base/BaseHealthCheck.js';
import { ProviderRegistry } from '../../core/registry.js';
import { BedrockTemplate } from './bedrock.template.js';
import { BedrockModelProxy } from './bedrock.models.js';

/**
 * Health check implementation for AWS Bedrock
 */
export class BedrockHealthCheck extends BaseHealthCheck {
  private modelProxy: BedrockModelProxy | null = null;

  constructor(
    baseUrl: string = BedrockTemplate.defaultBaseUrl,
    private accessKeyId?: string,
    private secretAccessKey?: string,
    private profile?: string,
    private region: string = 'us-east-1'
  ) {
    super({
      provider: 'bedrock',
      baseUrl,
      timeout: 10000 // Bedrock may take longer
    });
  }

  /**
   * Override check() to extract AWS credentials from config before running health check
   */
  async check(config: import('../../../env/types.js').CodeMieConfigOptions): Promise<import('../../core/types.js').HealthCheckResult> {
    // Extract AWS credentials from config
    const awsRegion = config.awsRegion || 'us-east-1';
    const awsProfile = config.awsProfile;
    const awsSecretAccessKey = config.awsSecretAccessKey;

    // Extract access key ID from apiKey (when not using profile)
    let accessKeyId: string | undefined;
    if (config.apiKey && config.apiKey !== 'aws-profile') {
      accessKeyId = config.apiKey;
    }

    // Update instance credentials
    this.region = awsRegion;
    this.profile = awsProfile;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = awsSecretAccessKey;

    // Reset model proxy to force re-initialization with new credentials
    this.modelProxy = null;

    // Call base check() which will use updated credentials
    return super.check(config);
  }

  /**
   * Initialize model proxy with credentials
   */
  private initModelProxy(): void {
    if (!this.modelProxy) {
      this.modelProxy = new BedrockModelProxy(
        this.config.baseUrl,
        this.accessKeyId,
        this.secretAccessKey,
        this.profile,
        this.region
      );
    }
  }

  /**
   * Ping Bedrock by listing models
   */
  protected async ping(): Promise<void> {
    this.initModelProxy();

    // For Bedrock, we test connectivity by trying to list models
    // This validates both connectivity and credentials
    const models = await this.listModels();

    if (models.length === 0) {
      throw new Error('No models available - check model access in AWS Console');
    }
  }

  /**
   * Get Bedrock version (not applicable, returns region instead)
   */
  protected async getVersion(): Promise<string | undefined> {
    return `Region: ${this.region}`;
  }

  /**
   * List available models
   */
  async listModels(): Promise<ModelInfo[]> {
    this.initModelProxy();

    try {
      return await this.modelProxy!.fetchModels({
        provider: 'bedrock',
        baseUrl: this.config.baseUrl,
        apiKey: this.accessKeyId || '',
        model: 'temp',
        timeout: 300
      });
    } catch (error) {
      throw new Error(`Failed to list models: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Custom unreachable message with setup instructions
   */
  protected getUnreachableResult() {
    return {
      provider: 'bedrock',
      status: 'unreachable' as const,
      message: 'Cannot connect to AWS Bedrock',
      remediation: `Check AWS Bedrock configuration:
  1. Verify AWS credentials are valid
  2. Check region is correct (currently: ${this.region})
  3. Ensure Bedrock is available in your region
  4. Verify IAM permissions for Bedrock access

Setup Bedrock:
  - Configure credentials: aws configure --profile your-profile
  - Or use: codemie setup
  - Request model access: AWS Console → Bedrock → Model Access`
    };
  }

  /**
   * Custom healthy message
   */
  protected getHealthyMessage(models: ModelInfo[]): string {
    const popularModels = models.filter(m => m.popular).length;
    return `AWS Bedrock is accessible with ${models.length} model(s) available` +
      (popularModels > 0 ? ` (${popularModels} recommended)` : '');
  }

  /**
   * Custom no-models remediation
   */
  protected getNoModelsRemediation(): string {
    return `Request model access:
  1. Go to AWS Console → Bedrock → Model Access
  2. Request access to Claude 3.5 Sonnet and other models
  3. Wait for approval (usually instant for Claude models)`;
  }
}

// Auto-register health check (will be re-instantiated with actual credentials)
ProviderRegistry.registerHealthCheck('bedrock', new BedrockHealthCheck());
