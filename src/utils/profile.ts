import chalk from 'chalk';
import { formatErrorWithExplanation, type ErrorContext } from './errors.js';
import { logger } from './logger.js';

/**
 * Authentication status for display
 */
export interface AuthStatusDisplay {
  authenticated: boolean;
  expiresAt?: number;
  apiUrl?: string;
}

/**
 * Renders the CodeMie profile information in a unified table format
 */
export function renderProfileInfo(config: {
  profile?: string;
  provider?: string;
  model?: string;
  codeMieUrl?: string;
  authStatus?: AuthStatusDisplay;
  agent?: string;
  cliVersion?: string;
  sessionId?: string;
  isActive?: boolean;
}): string {
  // Build complete output with logo and info
  const outputLines: string[] = [];
  outputLines.push(''); // Empty line for spacing

  // Helper to format a row with colored label and value
  const formatRow = (label: string, value: string, valueColor?: (text: string) => string) => {
    const colorFn = valueColor || chalk.white;
    return chalk.cyan(label.padEnd(13) + '│ ') + colorFn(value);
  };

  // Configuration details
  if (config.cliVersion) {
    outputLines.push(formatRow('CLI Version', config.cliVersion));
  }
  if (config.profile) {
    // Highlight active profile with explicit "Active" label in green bold
    if (config.isActive) {
      outputLines.push(chalk.cyan('Profile'.padEnd(13) + '│ ') + chalk.white(config.profile) + ' ' + chalk.green.bold('(Active)'));
    } else {
      outputLines.push(formatRow('Profile', config.profile));
    }
  }
  if (config.provider) {
    outputLines.push(formatRow('Provider', config.provider));
  }
  if (config.model) {
    outputLines.push(formatRow('Model', config.model));
  }
  if (config.codeMieUrl) {
    outputLines.push(formatRow('CodeMie URL', config.codeMieUrl));
  }

  // Auth status inline
  if (config.authStatus) {
    const { authenticated, expiresAt, apiUrl } = config.authStatus;

    if (authenticated) {
      let statusText = '✓ Authenticated';
      let isExpired = false;

      if (expiresAt) {
        const expiresIn = Math.max(0, expiresAt - Date.now());
        const hours = Math.floor(expiresIn / (1000 * 60 * 60));
        const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60));

        if (expiresIn > 0) {
          statusText += ` (expires in ${hours}h ${minutes}m)`;
        } else {
          statusText = '✗ Expired';
          isExpired = true;
        }
      }

      if (apiUrl) {
        outputLines.push(formatRow('Auth Status', statusText, isExpired ? chalk.red : chalk.green));
        outputLines.push(formatRow('API URL', apiUrl));
      } else {
        outputLines.push(formatRow('Auth Status', statusText, isExpired ? chalk.red : chalk.green));
      }
    } else {
      outputLines.push(formatRow('Auth Status', '✗ Not authenticated', chalk.red));
    }
  }

  if (config.agent) {
    outputLines.push(formatRow('Agent', config.agent));
  }
  if (config.sessionId) {
    outputLines.push(formatRow('Session', config.sessionId));
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

