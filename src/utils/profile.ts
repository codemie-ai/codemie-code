import chalk from 'chalk';
import { formatErrorWithExplanation, type ErrorContext } from './error-context.js';
import { logger } from './logger.js';

/**
 * Format a field with consistent padding and styling
 */
function formatField(label: string, value: string, color = chalk.cyan): string {
  const padding = 13 - label.length;
  const spaces = ' '.repeat(Math.max(0, padding));
  return color(`  ${label}:${spaces}`) + chalk.white(value);
}

/**
 * Get SSO authentication status for display
 * Checks if credentials exist AND match the provided base URL
 */
export async function getSSOAuthStatus(baseUrl: string): Promise<string[]> {
  const lines: string[] = [];
  const { CredentialStore } = await import('./credential-store.js');
  const store = CredentialStore.getInstance();

  const credentials = await store.retrieveSSOCredentials();
  if (!credentials) {
    lines.push(formatField('Auth Status', 'Not authenticated', chalk.yellow));
  } else {
    // Check if credentials are for the current profile's URL
    const normalizeUrl = (url: string) => url.replace(/\/+$/, ''); // Remove trailing slashes
    const storedUrl = normalizeUrl(credentials.apiUrl);
    const currentUrl = normalizeUrl(baseUrl);

    if (storedUrl !== currentUrl) {
      // Credentials exist but for a different URL
      lines.push(formatField('Auth Status', 'Wrong URL', chalk.yellow));
      lines.push(formatField('Stored for', credentials.apiUrl, chalk.dim));
      lines.push(formatField('Current URL', baseUrl, chalk.dim));
    } else {
      // Credentials match the current URL - check expiration
      const isExpired = credentials.expiresAt && Date.now() > credentials.expiresAt;
      const status = isExpired ? 'Expired' : 'Valid';
      const statusColor = isExpired ? chalk.red : chalk.green;
      lines.push(formatField('Auth Status', status, statusColor));

      if (credentials.expiresAt && !isExpired) {
        const expiresIn = Math.max(0, credentials.expiresAt - Date.now());
        const hours = Math.floor(expiresIn / (1000 * 60 * 60));
        const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60));
        lines.push(formatField('Expires in', `${hours}h ${minutes}m`));
      }
    }
  }

  return lines;
}

/**
 * Render execution context (runtime information)
 */
export function renderExecutionContext(config: {
  agent?: string;
  cliVersion?: string;
  sessionId?: string;
}): string {
  const outputLines: string[] = [];

  if (config.agent) {
    outputLines.push(formatField('Agent', config.agent));
  }
  if (config.cliVersion) {
    outputLines.push(formatField('CLI Version', config.cliVersion));
  }
  if (config.sessionId) {
    outputLines.push(formatField('Session', config.sessionId));
  }

  return outputLines.join('\n');
}

/**
 * Renders the CodeMie ASCII logo with configuration details
 */
export async function renderProfileInfo(config: {
  profile?: string;
  provider?: string;
  baseUrl?: string;
  apiUrl?: string; // API URL for auth validation (SSO only)
  model?: string;
  timeout?: number;
  debug?: boolean;
  showAuthStatus?: boolean;
}): Promise<string> {
  const outputLines: string[] = [];

  // Profile configuration
  if (config.profile) {
    outputLines.push(formatField('Profile', config.profile));
  }
  if (config.provider) {
    outputLines.push(formatField('Provider', config.provider));
  }
  if (config.baseUrl) {
    // Determine label based on provider
    const urlLabel = config.provider === 'ai-run-sso' ? 'CodeMie URL' : 'Base URL';
    outputLines.push(formatField(urlLabel, config.baseUrl));
  }
  if (config.model) {
    outputLines.push(formatField('Model', config.model));
  }

  // SSO credential status for ai-run-sso profiles
  // Use apiUrl for validation if provided, otherwise fallback to baseUrl
  if (config.showAuthStatus && config.provider === 'ai-run-sso') {
    const validationUrl = config.apiUrl || config.baseUrl;
    if (validationUrl) {
      const authStatusLines = await getSSOAuthStatus(validationUrl);
      outputLines.push(...authStatusLines);
    }
  }

  // Timeout
  if (config.timeout !== undefined) {
    outputLines.push(formatField('Timeout', `${config.timeout}s`));
  }

  // Debug
  if (config.debug !== undefined) {
    outputLines.push(formatField('Debug', config.debug ? 'Yes' : 'No'));
  }

  outputLines.push(''); // Empty line for spacing

  return outputLines.join('\n');
}

/**
 * Display a non-blocking warning message after profile info
 *
 * @param title - Warning title (e.g., "Metrics Collection Failed")
 * @param error - The error that occurred
 * @param sessionContext - Optional session context for error details
 * @param options - Display options
 *
 * @example
 * ```typescript
 * console.log(renderProfileInfo(config));
 * displayWarningMessage('Metrics Collection Failed', error, { sessionId, agent: 'claude' });
 * ```
 */
export function displayWarningMessage(
  title: string,
  error: unknown,
  sessionContext?: ErrorContext['session'],
  options: {
    showInProduction?: boolean;
    severity?: 'warning' | 'error' | 'info';
  } = {}
): void {
  const { showInProduction = true, severity = 'warning' } = options;

  // Skip display in production if specified
  if (!showInProduction && process.env.NODE_ENV === 'production') {
    return;
  }

  // Format the complete error message with explanation
  const errorMessage = formatErrorWithExplanation(error, sessionContext);

  // Get log file path
  const logFilePath = logger.getLogFilePath();

  // Box drawing characters
  const lines: string[] = [];
  lines.push(''); // Spacing

  // Title with icon
  const icon = severity === 'error' ? '🚨' : severity === 'info' ? 'ℹ️' : '⚠️';
  const color = severity === 'error' ? chalk.red : severity === 'info' ? chalk.cyan : chalk.yellow;

  lines.push(color.bold(`${icon} ${title}`));
  lines.push(color('─'.repeat(60)));

  // Error message (split by lines for proper formatting)
  const messageLines = errorMessage.split('\n');
  messageLines.forEach(line => {
    lines.push(color(line));
  });

  lines.push(color('─'.repeat(60)));

  // Log file information
  if (logFilePath) {
    lines.push('');
    lines.push(color.bold('📋 Check Logs for Details (run this command):'));
    lines.push(color(`   tail -100 ${logFilePath}`));
  }

  // Contact support
  lines.push('');
  lines.push(color.bold('📧 Need Help?'));
  lines.push(color('   Contact CodeMie team at: https://github.com/codemie-ai/codemie-code/issues'));
  if (logFilePath) {
    lines.push(color.dim('   Please include the log file above when reporting this issue.'));
  }

  lines.push('');
  lines.push(color('─'.repeat(60)));
  lines.push(color.dim('Note: This warning does not prevent the agent from starting.'));
  lines.push(''); // Spacing

  // Output to stderr so it doesn't interfere with agent output
  console.error(lines.join('\n'));
}

/**
 * Display a simple info message after profile info
 *
 * @param message - Message to display
 * @param details - Optional additional details
 *
 * @example
 * ```typescript
 * displayInfoMessage('Metrics collection is disabled for this provider', {
 *   provider: 'openai',
 *   reason: 'Not supported'
 * });
 * ```
 */
export function displayInfoMessage(
  message: string,
  details?: Record<string, string>
): void {
  const lines: string[] = [];
  lines.push(''); // Spacing
  lines.push(chalk.cyan('ℹ️  ' + message));

  if (details) {
    Object.entries(details).forEach(([key, value]) => {
      lines.push(chalk.cyan.dim(`   ${key}: ${value}`));
    });
  }

  lines.push(''); // Spacing

  console.error(lines.join('\n'));
}
