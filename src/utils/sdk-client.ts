/**
 * CodeMie SDK Client Utilities
 *
 * Shared utilities for initializing and working with CodeMieClient
 */

import ora from 'ora';
import chalk from 'chalk';
import { CodeMieClient } from 'codemie-sdk';
import type { CodeMieConfigOptions } from '../env/types.js';
import { getPlatformUrl } from '../providers/core/codemie-auth-helpers.js';
import { resolveSSOAuth, toSdkAuthOptions } from '../providers/plugins/sso/auth/index.js';
import { ConfigLoader } from './config.js';
import { ConfigurationError } from './errors.js';
import { logger } from './logger.js';
import { applySystemProxyEnvironment } from './system-proxy.js';

/**
 * Get authenticated CodeMieClient instance
 *
 * @param quiet - Suppress spinner and status messages
 * @returns Initialized CodeMieClient instance
 * @throws ConfigurationError if setup is incomplete or credentials are invalid
 */
export async function getCodemieClient(quiet = false): Promise<CodeMieClient> {
  let spinner;
  if (!quiet) {
    spinner = ora('Loading configuration...').start();
  }

  // 1. Load configuration
  let config: CodeMieConfigOptions;
  try {
    config = await ConfigLoader.load();
  } catch {
    if (spinner) {
      spinner.fail(chalk.red('Failed to load configuration'));
    }
    throw new ConfigurationError(
      'No configuration found. Please run "codemie setup" first.'
    );
  }

  // 2. Get stored SSO credentials
  if (spinner) {
    spinner.text = 'Retrieving authentication credentials...';
  }

  // Profile baseUrl is tried first, workspace codeMieUrl is the fallback
  const credentialLookupUrl = getPlatformUrl(config);

  logger.debug('Attempting to retrieve SSO credentials', {
    baseUrl: config.baseUrl,
    credentialLookupUrl,
    hasBaseUrl: !!config.baseUrl
  });

  const auth = await resolveSSOAuth(config);

  logger.debug('SSO credentials retrieval result', {
    hasCredentials: !!auth,
    authType: auth?.type,
    hasApiUrl: !!auth?.apiUrl
  });

  if (!auth || !auth.apiUrl) {
    if (spinner) {
      spinner.fail(chalk.red('No valid SSO credentials found'));
    }
    logger.error('SSO credentials not found or incomplete', {
      credentials: auth ? 'exists but incomplete' : 'not found',
      baseUrl: config.baseUrl
    });
    throw new ConfigurationError(
      'SSO authentication required. Please run "codemie setup" with SSO provider first.'
    );
  }

  logger.debug('Retrieved SSO credentials', {
    apiUrl: auth.apiUrl,
    authType: auth.type
  });

  // 3. Initialize CodeMie SDK client with the resolved credential (toSdkAuthOptions maps cookies
  // to the SDK's `cookies` option and a JWT to its `jwt_token` option).
  if (spinner) {
    spinner.text = 'Initializing SDK...';
  }

  // The SDK talks over axios, which resolves proxies from the environment per
  // request; on Windows the corporate proxy lives in Internet Settings only.
  await applySystemProxyEnvironment(auth.apiUrl);

  try {
    const client = new CodeMieClient({
      codemie_api_domain: auth.apiUrl,
      ...toSdkAuthOptions(auth),
      verify_ssl: process.env.CODEMIE_INSECURE !== '1'
    });

    logger.debug('CodeMieClient created', { apiUrl: auth.apiUrl, authType: auth.type });
    if (spinner) {
      spinner.succeed(chalk.green('Connected to CodeMie'));
    }

    return client;
  } catch (error) {
    if (spinner) {
      spinner.fail(chalk.red('Failed to initialize SDK'));
    }
    logger.error('SDK initialization failed', { error });
    throw new ConfigurationError(
      'Failed to initialize CodeMie SDK. Please verify your setup.'
    );
  }
}
