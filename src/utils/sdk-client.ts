/**
 * CodeMie SDK Client Utilities
 *
 * Shared utilities for initializing and working with CodeMieClient
 */

import ora from 'ora';
import chalk from 'chalk';
import { CodeMieClient } from 'codemie-sdk';
import type { CodeMieConfigOptions } from '../env/types.js';
import { CodeMieSSO } from '../providers/plugins/sso/sso.auth.js';
import { ConfigLoader } from './config.js';
import { ConfigurationError } from './errors.js';
import { logger } from './logger.js';

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
  const ssoAuth = new CodeMieSSO();

  // Use codeMieUrl for credential lookup, not baseUrl (which may be proxied)
  const credentialLookupUrl = config.codeMieUrl || config.baseUrl;

  logger.debug('Attempting to retrieve SSO credentials', {
    baseUrl: config.baseUrl,
    credentialLookupUrl,
    hasBaseUrl: !!config.baseUrl
  });

  const credentials = await ssoAuth.getStoredCredentials(credentialLookupUrl);

  logger.debug('SSO credentials retrieval result', {
    hasCredentials: !!credentials,
    hasCookies: !!credentials?.cookies,
    hasApiUrl: !!credentials?.apiUrl
  });

  if (!credentials?.cookies || !credentials.apiUrl) {
    if (spinner) {
      spinner.fail(chalk.red('No valid SSO credentials found'));
    }
    logger.error('SSO credentials not found or incomplete', {
      credentials: credentials ? 'exists but incomplete' : 'not found',
      baseUrl: config.baseUrl
    });
    throw new ConfigurationError(
      'SSO authentication required. Please run "codemie setup" with SSO provider first.'
    );
  }

  logger.debug('Retrieved SSO credentials', {
    apiUrl: credentials.apiUrl,
    hasCookies: !!credentials.cookies
  });

  // 3. Initialize CodeMie SDK client with cookies
  if (spinner) {
    spinner.text = 'Initializing SDK...';
  }

  try {
    const client = new CodeMieClient({
      codemie_api_domain: credentials.apiUrl,
      cookies: credentials.cookies,
      verify_ssl: false
    });

    logger.debug('CodeMieClient created with cookies', { apiUrl: credentials.apiUrl });
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

