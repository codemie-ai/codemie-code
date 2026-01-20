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
 * Initialize CodeMieClient with SSO authentication
 *
 * @param workingDir - Working directory for config loading
 * @returns Initialized CodeMieClient instance
 * @throws ConfigurationError if setup is incomplete or credentials are invalid
 */
export async function initializeCodeMieClient(
  workingDir: string = process.cwd()
): Promise<CodeMieClient> {
  const spinner = ora('Loading configuration...').start();

  // 1. Load configuration
  let config: CodeMieConfigOptions;
  try {
    config = await ConfigLoader.load(workingDir);
  } catch {
    spinner.fail(chalk.red('Failed to load configuration'));
    throw new ConfigurationError(
      'No configuration found. Please run "codemie setup" first.'
    );
  }

  // 2. Get stored SSO credentials
  spinner.text = 'Retrieving authentication credentials...';
  const ssoAuth = new CodeMieSSO();
  const credentials = await ssoAuth.getStoredCredentials(config.baseUrl);

  if (!credentials?.cookies || !credentials.apiUrl) {
    spinner.fail(chalk.red('No valid SSO credentials found'));
    throw new ConfigurationError(
      'SSO authentication required. Please run "codemie setup" with SSO provider first.'
    );
  }

  logger.debug('Retrieved SSO credentials', {
    apiUrl: credentials.apiUrl,
    hasCookies: !!credentials.cookies
  });

  // 3. Initialize CodeMie SDK client with cookies
  spinner.text = 'Initializing SDK...';

  let client: CodeMieClient;
  try {
    client = new CodeMieClient({
      codemie_api_domain: credentials.apiUrl,
      cookies: credentials.cookies,
      verify_ssl: false
    });

    logger.debug('CodeMieClient created with cookies', { apiUrl: credentials.apiUrl });
    spinner.succeed(chalk.green('Connected to CodeMie'));
  } catch (error) {
    spinner.fail(chalk.red('Failed to initialize SDK'));
    logger.error('SDK initialization failed', { error });
    throw new ConfigurationError(
      'Failed to initialize CodeMie SDK. Please verify your setup.'
    );
  }

  return client;
}

/**
 * Get config and client together
 * Convenience function that returns both config and initialized client
 *
 * @param workingDir - Working directory for config loading
 * @returns Object containing config and client
 */
export async function getConfigAndClient(
  workingDir: string = process.cwd()
): Promise<{ config: CodeMieConfigOptions; client: CodeMieClient }> {
  const spinner = ora('Loading configuration...').start();

  // 1. Load configuration
  let config: CodeMieConfigOptions;
  try {
    config = await ConfigLoader.load(workingDir);
    spinner.succeed();
  } catch {
    spinner.fail(chalk.red('Failed to load configuration'));
    throw new ConfigurationError(
      'No configuration found. Please run "codemie setup" first.'
    );
  }

  // 2. Initialize client (with its own spinner management)
  const client = await initializeCodeMieClient(workingDir);

  return { config, client };
}
