import chalk from 'chalk';

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
