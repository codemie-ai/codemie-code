
import type { ProviderHealthCheck, HealthCheckResult, HealthCheckDetail } from '../../core/types.js';
import { HTTPClient } from '../../core/base/http-client.js';


export class FCCHealthCheck implements ProviderHealthCheck {
  private httpClient: HTTPClient;

  constructor() {
    this.httpClient = new HTTPClient();
  }


  supports(provider: string): boolean {
    return provider === 'fcc';
  }

  async check(config: { baseUrl?: string; authToken?: string; [key: string]: unknown }): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let isHealthy = true;
    let errorMessage: string | undefined;

    const baseUrl = (config as any).fccServerUrl || config.baseUrl;
    const apiKey = (config as any).fccLiteLLMKey;

    try {
      const connectivityResult = await this.checkConnectivity(baseUrl);
      details.push(connectivityResult);
      if (connectivityResult.status === 'error') {
        isHealthy = false;
        errorMessage = connectivityResult.message;
      }

      if (apiKey) {
        const authResult = await this.checkAuthentication(baseUrl, apiKey);
        details.push(authResult);
        if (authResult.status === 'error') {
          isHealthy = false;
          errorMessage = authResult.message;
        }
      }

      const modelsResult = await this.checkModels(baseUrl, apiKey);
      details.push(modelsResult);

      return {
        provider: 'fcc',
        status: isHealthy ? 'healthy' : 'unhealthy',
        message: isHealthy
          ? 'FCC gateway is accessible and responding'
          : `FCC health check failed: ${errorMessage}`,
        details
      };
    } catch (error: any) {
      return {
        provider: 'fcc',
        status: 'unreachable',
        message: `Health check failed: ${error.message}`,
        remediation: 'Ensure you have network access to the FCC gateway and valid credentials'
      };
    }
  }

  /**
   * Check connectivity to FCC server
   */
  private async checkConnectivity(baseUrl?: string): Promise<HealthCheckDetail> {
    if (!baseUrl) {
      return {
        status: 'error',
        message: 'FCC server URL is not configured'
      };
    }

    try {
      const response = await this.httpClient.getRaw(`${baseUrl}/health`);

      if (response.statusCode === 200) {
        return {
          status: 'ok',
          message: 'Successfully connected to FCC gateway'
        };
      }

      return {
        status: 'warning',
        message: `Unexpected status code: ${response.statusCode}`
      };
    } catch (error: any) {
      return {
        status: 'error',
        message: `Connection failed: ${error.message}`
      };
    }
  }

  /**
   * Check authentication with FCC API
   */
  private async checkAuthentication(baseUrl: string | undefined, apiKey: string): Promise<HealthCheckDetail> {
    if (!baseUrl) {
      return {
        status: 'error',
        message: 'FCC server URL is not configured'
      };
    }

    try {
      const response = await this.httpClient.get(`${baseUrl}/v1/models`, {
        'Authorization': `Bearer ${apiKey}`
      });

      if (response.status === 200) {
        return {
          status: 'ok',
          message: 'API key is valid'
        };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          status: 'error',
          message: 'Invalid API key or insufficient permissions'
        };
      }

      return {
        status: 'warning',
        message: `Authentication check returned status: ${response.status}`
      };
    } catch (error: any) {
      return {
        status: 'error',
        message: `Authentication failed: ${error.message}`
      };
    }
  }

  /**
   * Check model availability
   */
  private async checkModels(baseUrl: string | undefined, apiKey?: string): Promise<HealthCheckDetail> {
    if (!baseUrl) {
      return {
        status: 'error',
        message: 'FCC server URL is not configured'
      };
    }

    try {
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const response = await this.httpClient.get(`${baseUrl}/v1/models`, headers);

      if (response.status === 200 && response.data) {
        const data = response.data as any;
        const modelCount = Array.isArray(data.data) ? data.data.length : 0;
        return {
          status: modelCount > 0 ? 'ok' : 'warning',
          message: `Found ${modelCount} available model(s)`
        };
      }

      return {
        status: 'warning',
        message: 'Unable to retrieve model list'
      };
    } catch (error: any) {
      return {
        status: 'error',
        message: `Model check failed: ${error.message}`
      };
    }
  }
}