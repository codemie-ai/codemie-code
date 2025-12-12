/**
 * AWS Bedrock Model Fetcher
 *
 * Fetches available models from AWS Bedrock API.
 * Supports both AWS profile and direct credentials.
 */

import type { ProviderModelFetcher, ModelInfo } from '../../core/types.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';
import { ProviderRegistry } from '../../core/registry.js';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';

/**
 * Bedrock Model Proxy - Fetches models from AWS Bedrock
 */
export class BedrockModelProxy implements ProviderModelFetcher {
  private client: BedrockRuntimeClient;

  constructor(
    private baseUrl: string,
    private accessKeyId?: string,
    private secretAccessKey?: string,
    private profile?: string,
    private region: string = 'us-east-1'
  ) {
    // Bedrock client will be initialized lazily in fetchModels
    // to avoid credential loading errors during construction
    this.client = null as any;
  }

  supports(provider: string): boolean {
    return provider === 'bedrock';
  }

  /**
   * Fetch available models from Bedrock
   */
  async fetchModels(_config: CodeMieConfigOptions): Promise<ModelInfo[]> {
    try {
      const {
        BedrockClient,
        ListInferenceProfilesCommand
      } = await import('@aws-sdk/client-bedrock');

      const clientConfig: any = {
        region: this.region
      };

      if (this.profile) {
        // Use AWS profile - fromIni returns a credential provider function
        // that the SDK will call when needed
        clientConfig.credentials = fromIni({
          profile: this.profile
        });
      } else if (this.accessKeyId && this.secretAccessKey) {
        // Use direct credentials
        clientConfig.credentials = {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey
        };
      } else {
        // Try to use default credentials chain (environment variables, default profile, etc.)
        // SDK will handle this automatically if no credentials are specified
      }

      const bedrockClient = new BedrockClient(clientConfig);

      // Fetch inference profiles (cross-region)
      const profilesResponse = await bedrockClient.send(new ListInferenceProfilesCommand({}));

      const models: ModelInfo[] = [];

      // Add inference profiles
      if (profilesResponse.inferenceProfileSummaries) {
        models.push(...profilesResponse.inferenceProfileSummaries
          .filter(profile => {
            // Filter for profiles with valid ID
            return profile.inferenceProfileId;
          })
          .map(profile => ({
            id: profile.inferenceProfileId!,
            name: profile.inferenceProfileName || profile.inferenceProfileId!
          })));
      }

      if (models.length === 0) {
        throw new Error('No inference profiles found');
      }

      // Sort by name
      models.sort((a, b) => a.name.localeCompare(b.name));

      return models;
    } catch (error) {
      throw new Error(`Failed to fetch Bedrock models: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

}

// Auto-register model proxy
ProviderRegistry.registerModelProxy('bedrock', new BedrockModelProxy('', undefined, undefined, undefined, 'us-east-1'));
