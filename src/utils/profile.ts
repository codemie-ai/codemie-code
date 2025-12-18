import chalk from 'chalk';
import { formatErrorWithExplanation, type ErrorContext } from './error-context.js';
import { logger } from './logger.js';

/**
 * Renders the CodeMie ASCII logo with configuration details
 */
export function renderProfileInfo(config: {
  profile?: string;
  provider?: string;
  model?: string;
  agent?: string;
  cliVersion?: string;
  sessionId?: string;
}): string {
  // Build complete output with logo and info
  const outputLines: string[] = [];
  outputLines.push(''); // Empty line for spacing

  // Configuration details
  if (config.cliVersion) {
    outputLines.push(`CLI Version  │ ${config.cliVersion}`);
  }
  if (config.profile) {
    outputLines.push(`Profile      │ ${config.profile}`);
  }
  if (config.provider) {
    outputLines.push(`Provider     │ ${config.provider}`);
  }
  if (config.model) {
    outputLines.push(`Model        │ ${config.model}`);
  }
  if (config.agent) {
    outputLines.push(`Agent        │ ${config.agent}`);
  }
  if (config.sessionId) {
    outputLines.push(`Session      │ ${config.sessionId}`);
  }

  outputLines.push(''); // Empty line for spacing

  // Apply cyan color to entire output
  return chalk.cyan(outputLines.join('\n'));
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
