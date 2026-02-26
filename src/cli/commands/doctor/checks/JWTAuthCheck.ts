/**
 * JWT Authentication health check
 */

import { CredentialStore } from '../../../../utils/security.js';
import { ConfigLoader } from '../../../../utils/config.js';
import { HealthCheck, HealthCheckResult, HealthCheckDetail, ProgressCallback } from '../types.js';

export class JWTAuthCheck implements HealthCheck {
  name = 'JWT Authentication';

  async run(onProgress?: ProgressCallback): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    try {
      onProgress?.('Checking JWT authentication');

      const config = await ConfigLoader.load();

      // Only check if profile uses JWT auth
      if (config.authMethod !== 'jwt') {
        details.push({
          status: 'info',
          message: 'Not using JWT authentication (skipped)'
        });
        return { name: this.name, success: true, details };
      }

      // Check 1: JWT token available (env var or credential store)
      onProgress?.('Checking JWT token presence');
      const tokenEnvVar = config.jwtConfig?.tokenEnvVar || 'CODEMIE_JWT_TOKEN';
      const envToken = process.env[tokenEnvVar];

      if (!envToken) {
        const store = CredentialStore.getInstance();
        const storedCreds = await store.retrieveJWTCredentials(config.baseUrl);

        if (!storedCreds) {
          details.push({
            status: 'error',
            message: `JWT token not found in ${tokenEnvVar} or credential store`,
            hint: `Set ${tokenEnvVar} or run: codemie setup`
          });
          success = false;
          return { name: this.name, success, details };
        }

        // Token found in credential store
        details.push({
          status: 'ok',
          message: 'JWT token found in credential store'
        });
      } else {
        // Token found in environment variable
        details.push({
          status: 'ok',
          message: `JWT token found in ${tokenEnvVar}`
        });
      }

      // Check 2: Token expiration (warn 7 days before expiry)
      onProgress?.('Checking JWT token expiration');
      const token = envToken || (await CredentialStore.getInstance()
        .retrieveJWTCredentials(config.baseUrl))?.token;

      if (token) {
        try {
          // Parse JWT payload to get expiration
          const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
          if (payload.exp) {
            const expiresAt = payload.exp * 1000; // Convert to milliseconds
            const daysUntilExpiry = (expiresAt - Date.now()) / (1000 * 60 * 60 * 24);
            const expiresDate = new Date(expiresAt);

            if (daysUntilExpiry < 0) {
              details.push({
                status: 'error',
                message: `JWT token expired on ${expiresDate.toISOString()}`,
                hint: 'Please provide a fresh token via codemie setup or update CODEMIE_JWT_TOKEN'
              });
              success = false;
            } else if (daysUntilExpiry < 7) {
              details.push({
                status: 'warn',
                message: `JWT token expires in ${Math.ceil(daysUntilExpiry)} days (${expiresDate.toISOString()})`,
                hint: 'Consider refreshing your token soon'
              });
            } else {
              details.push({
                status: 'ok',
                message: `JWT token expires on ${expiresDate.toISOString()}`
              });
            }
          } else {
            // Token has no expiration field
            details.push({
              status: 'info',
              message: 'JWT token has no expiration date'
            });
          }
        } catch {
          // Non-standard JWT - skip expiration check
          details.push({
            status: 'info',
            message: 'Could not parse JWT token expiration (non-standard format)'
          });
        }
      }

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      details.push({
        status: 'error',
        message: `JWT authentication check failed: ${errorMessage}`
      });
      success = false;
    }

    return { name: this.name, success, details };
  }
}
