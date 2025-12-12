import chalk from 'chalk';
import gradient from 'gradient-string';

/**
 * CodeMie CLI ASCII Logo with aligned column layout
 *
 * Displays the AI/Run CodeMie CLI logo with configuration details
 */

const LOGO_ASCII = String.raw`
  ██████╗ ██████╗ ██████╗ ███████╗███╗   ███╗██╗███████╗     ██████╗██╗     ██╗
 ██╔════╝██╔═══██╗██╔══██╗██╔════╝████╗ ████║██║██╔════╝    ██╔════╝██║     ██║
 ██║     ██║   ██║██║  ██║█████╗  ██╔████╔██║██║█████╗      ██║     ██║     ██║
 ██║     ██║   ██║██║  ██║██╔══╝  ██║╚██╔╝██║██║██╔══╝      ██║     ██║     ██║
 ╚██████╗╚██████╔╝██████╔╝███████╗██║ ╚═╝ ██║██║███████╗    ╚██████╗███████╗██║
  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝     ╚═╝╚═╝╚══════╝     ╚═════╝╚══════╝╚═╝
`;

/**
 * Renders the CodeMie ASCII logo with configuration details
 */
export function renderCodeMieLogo(config: {
  profile?: string;
  provider?: string;
  model?: string;
  agent?: string;
  cliVersion?: string;
  sessionId?: string;
}): string {
  const codeMieGradient = gradient([
    '#ff00ff', // Bright magenta
    '#cc00ff', // Purple-magenta
    '#9933ff', // Purple
    '#6666ff', // Blue-purple
    '#00ccff'  // Cyan
  ]);

  // Build complete output with logo and info
  const outputLines: string[] = [];
  outputLines.push(''); // Empty line for spacing

  // Add ASCII logo
  outputLines.push(LOGO_ASCII);
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

  // Apply gradient to entire output
  return codeMieGradient(outputLines.join('\n'));
}

/**
 * Compact version for narrow terminals
 */
export function renderCompactLogo(config: {
  profile?: string;
  provider?: string;
  model?: string;
  agent?: string;
}): string {
  const codeMieGradient = gradient([
    '#ff00ff', // Bright magenta
    '#cc00ff', // Purple-magenta
    '#9933ff', // Purple
    '#6666ff', // Blue-purple
    '#00ccff'  // Cyan
  ]);

  const compactAscii = `
   ╔════════════════════╗
   ║  AI/Run CodeMie    ║
   ║       CLI          ║
   ╚════════════════════╝`;

  const output: string[] = [];
  output.push('');
  output.push(codeMieGradient(compactAscii));
  output.push('');
  if (config.profile && config.provider) {
    output.push(chalk.white(`${config.profile} │ ${config.provider}`));
  }
  if (config.model) {
    output.push(chalk.white(`Model: ${config.model}`));
  }
  output.push('');

  return output.join('\n');
}
