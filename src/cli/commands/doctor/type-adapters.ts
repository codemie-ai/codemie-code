/**
 * Type Adapters for Doctor Command
 *
 * Adapts provider types to doctor display format.
 * Enriches output with provider metadata for better diagnostics.
 */

import type {
  HealthCheckResult as ProviderHealthCheckResult,
  HealthCheckDetail as ProviderHealthCheckDetail
} from '../../../providers/core/types.js';
import type {
  HealthCheckResult as DoctorHealthCheckResult,
  HealthCheckDetail as DoctorHealthCheckDetail
} from './types.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';

/**
 * Convert provider HealthCheckDetail to doctor format
 */
export function adaptProviderDetail(
  detail: ProviderHealthCheckDetail
): DoctorHealthCheckDetail {
  return {
    status: detail.status === 'warning' ? 'warn' : detail.status,
    message: detail.message,
    hint: detail.hint
  };
}

/**
 * Convert provider HealthCheckResult to doctor format
 * Enriches with provider template metadata for better diagnostics
 */
export function adaptProviderResult(
  result: ProviderHealthCheckResult
): DoctorHealthCheckResult {
  const details: DoctorHealthCheckDetail[] = [];
  const template = ProviderRegistry.getProvider(result.provider);

  // Add main status message
  if (result.status === 'healthy') {
    details.push({
      status: 'ok',
      message: result.message
    });

    // Add version if available (skip for SSO which uses generic version)
    if (result.version && result.version !== 'sso-v1') {
      details.push({
        status: 'info',
        message: `Version: ${result.version}`
      });
    }
  } else if (result.status === 'unhealthy') {
    details.push({
      status: 'warn',
      message: result.message,
      hint: result.remediation
    });
  } else {
    // unreachable
    details.push({
      status: 'error',
      message: result.message,
      hint: result.remediation
    });

    // Add setup instructions from template if available
    if (template && template.setupInstructions && !result.remediation) {
      details.push({
        status: 'info',
        message: 'Setup instructions available',
        hint: `Run: codemie setup ${template.name}`
      });
    }
  }

  // Add detailed checks if available
  if (result.details) {
    details.push(...result.details.map(adaptProviderDetail));
  }

  // Use display name from template if available
  const providerDisplayName = template?.displayName ||
    result.provider.charAt(0).toUpperCase() + result.provider.slice(1);

  return {
    name: `${providerDisplayName} Provider`,
    success: result.status === 'healthy',
    details
  };
}
