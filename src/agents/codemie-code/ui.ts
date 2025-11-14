import { intro, outro, text, spinner, note, isCancel } from '@clack/prompts';
import chalk from 'chalk';
import { CodeMieAgent } from './agent.js';
import { ExecutionStep } from './types.js';
import { formatToolMetadata } from './toolMetadata.js';
import { formatCost, formatTokens, formatTokenUsageSummary } from './tokenUtils.js';
import { hasClipboardImage, getClipboardImage, type ClipboardImage } from '../../utils/clipboard.js';

/**
 * Terminal UI interface for CodeMie Agent using Clack
 */
export class CodeMieTerminalUI {
  private agent: CodeMieAgent;
  private currentSpinner?: any;

  constructor(agent: CodeMieAgent) {
    this.agent = agent;
  }

  /**
   * Start interactive terminal session
   */
  async startInteractive(): Promise<void> {
    // Welcome message
    intro(chalk.cyan('🤖 CodeMie Native Agent'));

    const config = this.agent.getConfig();
    if (config) {
      // Use displayProvider for user-facing output, or fall back to normalized provider
      const displayProvider = config.displayProvider || config.provider;
      note(
        `Provider: ${chalk.yellow(displayProvider)}\n` +
        `Model: ${chalk.cyan(config.model)}\n` +
        `Working Directory: ${chalk.dim(config.workingDirectory)}`,
        'Configuration'
      );
    }

    console.log(chalk.dim('Type /help for commands, /exit to quit'));
    console.log(chalk.dim('Enter = send, Shift+Enter = new line, Cmd+V = paste text'));
    console.log(chalk.dim('📸 Tab = insert clipboard image • Multiple images supported\n'));

    // Main interaction loop
    while (true) {
      const input = await this.getMultilineInput();

      if (input === null) {
        outro(chalk.dim('Goodbye! 👋'));
        break;
      }

      const trimmed = input.text.trim();

      // Handle special commands
      if (trimmed.startsWith('/')) {
        const handled = await this.handleCommand(trimmed);
        if (handled === 'exit') break;
        continue;
      }

      if (trimmed === '') continue;

      // Execute the task with streaming UI
      await this.executeTaskWithUI(trimmed, input.images);
    }
  }

  /**
   * Get input from user with Shift+Enter multiline support and image pasting
   */
  private async getMultilineInput(): Promise<{ text: string; images: ClipboardImage[] } | null> {
    return new Promise((resolve) => {
      if (!process.stdin.setRawMode) {
        // Fallback for environments without raw mode
        resolve(this.getFallbackInput());
        return;
      }

      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      let lines: string[] = [];
      let currentLine = '';
      let isFirstLine = true;
      let escapeSequence = '';
      let images: ClipboardImage[] = [];
      let imageCounter = 0;

      const writePrompt = () => {
        const prompt = isFirstLine ? '> ' : '... ';
        process.stdout.write(prompt);
      };

      const cleanup = () => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeAllListeners('data');
      };

      writePrompt();

      process.stdin.on('data', (key: Buffer) => {
        const data = key.toString('utf8');

        // Handle escape sequences
        if (data.startsWith('\x1b')) {
          escapeSequence += data;
          // Wait for complete escape sequence (timeout after short delay)
          setTimeout(() => {
            escapeSequence = '';
          }, 10);
          return;
        }

        // Check for Shift+Enter patterns on macOS
        // Shift+Enter in macOS Terminal typically sends: \r\n or \n\r
        if (data === '\r\n' || data === '\n\r' || (escapeSequence && data === '\r')) {
          // This is Shift+Enter - add line and continue
          lines.push(currentLine);
          currentLine = '';
          isFirstLine = false;
          process.stdout.write('\n');
          writePrompt();
          escapeSequence = '';
          return;
        }

        // Regular Enter - send message
        if (data === '\r' || data === '\n') {
          if (currentLine.trim() === '' && lines.length === 0) {
            // Empty input, continue asking
            writePrompt();
            return;
          }

          // Send the message
          if (currentLine.trim() !== '') {
            lines.push(currentLine);
          }

          process.stdout.write('\n');
          cleanup();
          resolve({
            text: lines.join('\n'),
            images: images
          });
          return;
        }

        // Ctrl+C
        if (data === '\u0003') {
          cleanup();
          resolve(null);
          return;
        }

        // Ctrl+I - Insert image from clipboard
        if (data === '\u0009') {
          // Check if there's an image in clipboard
          hasClipboardImage().then(hasImage => {
            if (hasImage) {
              getClipboardImage().then(clipboardImage => {
                if (clipboardImage) {
                  imageCounter++;
                  images.push(clipboardImage);

                  // Insert visual indicator in current line
                  const imageIndicator = chalk.blue(`[Image #${imageCounter}]`);
                  currentLine += imageIndicator;
                  process.stdout.write(imageIndicator);

                  console.log(chalk.green(`\n📸 Image #${imageCounter} added from clipboard (${clipboardImage.mimeType})`));
                  writePrompt();
                  process.stdout.write(currentLine);
                }
              });
            } else {
              console.log(chalk.yellow('\n⚠️  No image found in clipboard'));
              writePrompt();
              process.stdout.write(currentLine);
            }
          }).catch(() => {
            console.log(chalk.red('\n❌ Error accessing clipboard'));
            writePrompt();
            process.stdout.write(currentLine);
          });
          return;
        }

        // Backspace
        if (data === '\u007F' || data === '\b') {
          if (currentLine.length > 0) {
            currentLine = currentLine.slice(0, -1);
            process.stdout.write('\b \b');
          }
          return;
        }

        // Handle clipboard paste (Cmd+V on macOS, Ctrl+V on Windows/Linux)
        // Pasted content can be multiple characters, so handle any printable text
        if (data.length > 1 || (data.length === 1 && (data.charCodeAt(0) >= 32 || data === '\t'))) {
          // Filter out non-printable characters except tabs
          const printableData = data.split('').filter(char =>
            char.charCodeAt(0) >= 32 || char === '\t'
          ).join('');

          if (printableData.length > 0) {
            currentLine += printableData;
            process.stdout.write(printableData);
          }
        }

        escapeSequence = '';
      });
    });
  }

  /**
   * Fallback input method for environments without raw mode
   */
  private async getFallbackInput(): Promise<{ text: string; images: ClipboardImage[] } | null> {
    const input = await text({
      message: '>',
      placeholder: 'Type your message... (Tab to insert clipboard image)'
    });

    if (isCancel(input)) {
      return null;
    }

    const textInput = input === undefined || input === null ? '' : String(input);

    // In fallback mode, we can't handle interactive image insertion
    // So just return text with empty images array
    return {
      text: textInput,
      images: []
    };
  }


  /**
   * Handle special commands
   */
  private async handleCommand(command: string): Promise<string | void> {
    const [cmd] = command.slice(1).split(' ');

    switch (cmd) {
      case 'help':
        note(
          `${chalk.cyan('/help')} - Show this help message\n` +
          `${chalk.cyan('/clear')} - Clear conversation history\n` +
          `${chalk.cyan('/stats')} - Show agent statistics\n` +
          `${chalk.cyan('/config')} - Show configuration\n` +
          `${chalk.cyan('/health')} - Run health check\n` +
          `${chalk.cyan('/exit')} - Exit the agent\n\n` +
          `${chalk.yellow('Input Controls:')}\n` +
          `- ${chalk.cyan('Enter')} - Send message\n` +
          `- ${chalk.cyan('Shift+Enter')} - New line (multiline input)\n` +
          `- ${chalk.cyan('Cmd+V / Ctrl+V')} - Paste text from clipboard\n` +
          `- ${chalk.cyan('Tab')} - Insert image from clipboard\n` +
          `- ${chalk.cyan('Ctrl+C')} - Cancel current input\n\n` +
          `${chalk.yellow('Image Support:')}\n` +
          `- Copy image/screenshot to clipboard\n` +
          `- Press ${chalk.cyan('Tab')} to insert as ${chalk.blue('[Image #N]')}\n` +
          `- Multiple images supported per message\n` +
          `- AI analyzes both text and all images`,
          'Available Commands'
        );
        break;

      case 'clear':
        this.agent.clearHistory();
        note('Conversation history cleared', 'History');
        break;

      case 'stats':
        await this.showStats();
        break;

      case 'config':
        await this.showConfig();
        break;

      case 'health':
        await this.runHealthCheck();
        break;

      case 'exit':
        outro(chalk.dim('Goodbye! 👋'));
        return 'exit';

      default:
        note(chalk.red(`Unknown command: ${command}\nType /help for available commands`), 'Error');
        break;
    }
  }

  /**
   * Execute task with modern UI feedback
   */
  private async executeTaskWithUI(task: string, images: ClipboardImage[] = []): Promise<void> {
    let hasStarted = false;
    let toolCallCount = 0;

    try {
      // Show image summary if any images were provided
      if (images.length > 0) {
        const imageTypes = images.map(img => img.mimeType).join(', ');
        note(chalk.green(`📸 ${images.length} image${images.length > 1 ? 's' : ''} included: ${imageTypes}`), 'Image Input');
      }

      // Start streaming with visual feedback
      await this.agent.chatStream(task, (event) => {
        switch (event.type) {
          case 'thinking_start':
            // Show "Thinking..." spinner when the agent starts processing
            if (!this.currentSpinner) {
              this.currentSpinner = spinner();
            }
            this.currentSpinner.start(chalk.dim('Thinking...'));
            break;

          case 'content_chunk':
            if (!hasStarted) {
              // Stop any existing spinner and start response
              if (this.currentSpinner) {
                this.currentSpinner.stop();
                this.currentSpinner = undefined;
              }
              console.log(chalk.cyan('\nCodeMie Thoughts:'));
              hasStarted = true;
            }

            process.stdout.write(event.content || '');
            break;

          case 'tool_call_start':
            toolCallCount++;
            if (!this.currentSpinner) {
              this.currentSpinner = spinner();
            }
            this.currentSpinner.start(chalk.yellow(`Using ${event.toolName}...`));
            break;

          case 'tool_call_result':
            if (this.currentSpinner) {
              // Use enhanced metadata if available, otherwise fall back to basic message
              const message = event.toolMetadata
                ? formatToolMetadata(event.toolName || 'tool', event.toolMetadata)
                : `✓ ${event.toolName} completed`;

              this.currentSpinner.stop(chalk.green(message));

              // Show additional details if available and not an error (but avoid duplication)
              if (event.toolMetadata && event.toolMetadata.success && this.shouldShowDetails(event.toolName || '')) {
                this.showToolDetails(event.toolName || '', event.toolMetadata);
              }

              this.currentSpinner = undefined;
            }
            break;

          case 'complete':
            if (this.currentSpinner) {
              this.currentSpinner.stop();
              this.currentSpinner = undefined;
            }
            if (hasStarted) {
              console.log('\n'); // Add spacing after response
            }

            // Show detailed task summary
            this.showTaskSummary(toolCallCount);
            break;

          case 'error':
            if (this.currentSpinner) {
              this.currentSpinner.stop();
              this.currentSpinner = undefined;
            }
            note(chalk.red(`Error: ${event.error}`), 'Error');
            break;
        }
      }, images);

    } catch (error) {
      if (this.currentSpinner) {
        this.currentSpinner.stop();
        this.currentSpinner = undefined;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      note(chalk.red(`Execution failed: ${errorMessage}`), 'Error');
    } finally {
      // Cleanup complete
    }
  }

  /**
   * Show agent statistics
   */
  private async showStats(): Promise<void> {
    const stats = this.agent.getStats();

    if (!stats) {
      note('No statistics available', 'Stats');
      return;
    }

    const statsText = [
      `${chalk.yellow('Token Usage:')}`,
      `  Input: ${chalk.cyan(formatTokens(stats.inputTokens))}`,
      `  Output: ${chalk.cyan(formatTokens(stats.outputTokens))}${stats.cachedTokens > 0 ? ` + ${chalk.green(formatTokens(stats.cachedTokens))} cached` : ''}`,
      `  Total: ${chalk.cyan(formatTokens(stats.totalTokens))}`,
      `  Cost: ${chalk.green(formatCost(stats.estimatedTotalCost))}`,
      '',
      `${chalk.yellow('Execution Stats:')}`,
      `  LLM Calls: ${chalk.cyan(stats.llmCalls)}`,
      `  Tool Calls: ${chalk.cyan(stats.toolCalls)} (${chalk.green(stats.successfulTools)} success, ${chalk.red(stats.failedTools)} failed)`,
      `  Total Steps: ${chalk.cyan(stats.executionSteps.length)}`,
      `  Duration: ${chalk.dim(stats.executionTime + 'ms')}`
    ].join('\n');

    note(statsText, 'Agent Statistics');

    // Show detailed step breakdown if available
    if (stats.executionSteps.length > 0) {
      this.showExecutionSteps(stats.executionSteps);
    }
  }

  /**
   * Show current configuration
   */
  private async showConfig(): Promise<void> {
    const config = this.agent.getConfig();

    if (!config) {
      note('No configuration available', 'Config');
      return;
    }

    // Use displayProvider for user-facing output, or fall back to normalized provider
    const displayProvider = config.displayProvider || config.provider;
    const configText = [
      `Provider: ${chalk.yellow(displayProvider)}`,
      `Model: ${chalk.cyan(config.model)}`,
      `Base URL: ${chalk.dim(config.baseUrl)}`,
      `Working Directory: ${chalk.dim(config.workingDirectory)}`,
      `Debug Mode: ${config.debug ? chalk.green('enabled') : chalk.dim('disabled')}`,
      `Timeout: ${chalk.dim(config.timeout + 'ms')}`
    ].join('\n');

    note(configText, 'Configuration');
  }

  /**
   * Run health check with UI feedback
   */
  private async runHealthCheck(): Promise<void> {
    const healthSpinner = spinner();
    healthSpinner.start('Running health check...');

    try {
      const health = await this.agent.healthCheck();

      if (health.status === 'healthy') {
        healthSpinner.stop(chalk.green('✓ System is healthy'));

        const healthText = [
          `Status: ${chalk.green('Healthy')}`,
          `Provider: ${chalk.yellow(health.provider)}`,
          `Model: ${chalk.cyan(health.model)}`,
          `Tools: ${chalk.cyan(health.toolCount)}`
        ].join('\n');

        note(healthText, 'Health Check');
      } else {
        healthSpinner.stop(chalk.red('✗ System is unhealthy'));
        note(chalk.red(health.error || 'Unknown error'), 'Health Check Failed');
      }
    } catch (error) {
      healthSpinner.stop(chalk.red('✗ Health check failed'));
      note(chalk.red(error instanceof Error ? error.message : String(error)), 'Error');
    }
  }

  /**
   * Format uptime duration
   */
  private formatUptime(uptimeMs: number): string {
    const seconds = Math.floor(uptimeMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Execute a single task with minimal UI (for non-interactive mode)
   */
  async executeSingleTask(task: string, images: ClipboardImage[] = []): Promise<string> {
    const taskSpinner = spinner();

    let response = '';
    let toolCallCount = 0;
    let hasStarted = false;

    try {
      await this.agent.chatStream(task, (event) => {
        switch (event.type) {
          case 'thinking_start':
            // Show "Thinking..." when the agent starts processing
            taskSpinner.start(chalk.dim('Thinking...'));
            break;

          case 'content_chunk':
            if (!hasStarted) {
              // Switch from "Thinking..." to "Processing task..." when content starts
              taskSpinner.message(chalk.dim('Processing task...'));
              hasStarted = true;
            }
            response += event.content || '';
            break;

          case 'tool_call_start':
            toolCallCount++;
            taskSpinner.message(chalk.yellow(`Using ${event.toolName}...`));
            break;

          case 'tool_call_result':
            // Show enhanced tool info in single task mode too
            if (event.toolMetadata) {
              const message = formatToolMetadata(event.toolName || 'tool', event.toolMetadata);
              taskSpinner.message(chalk.green(message));
            } else {
              taskSpinner.message(chalk.dim('Processing task...'));
            }
            break;

          case 'complete':
            taskSpinner.stop();
            break;

          case 'error':
            taskSpinner.stop(chalk.red(`Error: ${event.error}`));
            break;
        }
      }, images);

      // Show success message with token usage
      const stats = this.agent.getStats();
      const summaryParts: string[] = [];

      if (toolCallCount > 0) {
        summaryParts.push(`Used ${toolCallCount} tool${toolCallCount > 1 ? 's' : ''}`);
      }

      if (stats.totalTokens > 0) {
        summaryParts.push(`${formatTokens(stats.totalTokens)} tokens`);
      }

      if (stats.estimatedTotalCost > 0) {
        summaryParts.push(`${formatCost(stats.estimatedTotalCost)}`);
      }

      if (summaryParts.length > 0) {
        console.log(chalk.dim(`${summaryParts.join(' • ')}\n`));
      }

      return response;
    } catch (error) {
      taskSpinner.stop(chalk.red('Task failed'));
      throw error;
    }
  }

  /**
   * Show a welcome message for single task execution
   */
  showTaskWelcome(task: string): void {
    intro(chalk.cyan('🤖 CodeMie Native Agent'));
    note(chalk.dim(`Task: ${task}`), 'Executing');
  }

  /**
   * Show task completion message
   */
  showTaskComplete(): void {
    outro(chalk.green('Task completed successfully'));
  }

  /**
   * Show error message
   */
  showError(error: string): void {
    outro(chalk.red(`Error: ${error}`));
  }

  /**
   * Check if we should show detailed information for a tool
   */
  private shouldShowDetails(toolName: string): boolean {
    // Show details for these tools when they have interesting information
    return ['read_file', 'list_directory', 'execute_command'].includes(toolName);
  }

  /**
   * Show additional tool details
   */
  private showToolDetails(toolName: string, metadata: any): void {
    if (!metadata || !metadata.success) return;

    let details = '';

    switch (toolName) {
      case 'read_file':
        if (metadata.contentPreview) {
          details = chalk.dim(`Preview:\n${metadata.contentPreview}`);
        }
        break;

      case 'list_directory':
        if (metadata.contentPreview && metadata.contentPreview !== 'Empty directory') {
          // Parse the content preview and format each item on a new line
          const preview = metadata.contentPreview;
          if (preview.includes(' +') && preview.includes(' more')) {
            // Extract items and remaining count: "item1, item2, item3 +15 more"
            const [itemsStr, remainingStr] = preview.split(' +');
            const items = itemsStr.split(', ');

            // Format with each item on a new line
            const formattedItems = items.map(item => `  ${item}`).join('\n');
            details = chalk.dim(`${formattedItems}\n  +${remainingStr}`);
          } else {
            // Fallback for simple lists without truncation
            const items = preview.split(', ');
            details = chalk.dim(items.map(item => `  ${item}`).join('\n'));
          }
        }
        break;

      case 'execute_command':
        if (metadata.outputPreview && metadata.outputPreview !== 'No output') {
          details = chalk.dim(`Output:\n${metadata.outputPreview}`);
        }
        break;
    }

    if (details) {
      console.log(chalk.dim('  ' + details.replace(/\n/g, '\n  ')));
    }
  }

  /**
   * Show task completion summary with token usage
   */
  private showTaskSummary(toolCallCount: number): void {
    const stats = this.agent.getStats();

    const summaryParts: string[] = [];

    if (toolCallCount > 0) {
      summaryParts.push(`Used ${toolCallCount} tool${toolCallCount > 1 ? 's' : ''}`);
    }

    if (stats.totalTokens > 0) {
      summaryParts.push(`${formatTokens(stats.totalTokens)} tokens (${formatTokens(stats.inputTokens)} in, ${formatTokens(stats.outputTokens)} out)`);
    }

    if (stats.estimatedTotalCost > 0) {
      summaryParts.push(`${formatCost(stats.estimatedTotalCost)} estimated cost`);
    }

    if (summaryParts.length > 0) {
      note(summaryParts.join(' • '), 'Task Summary');
    }
  }

  /**
   * Show detailed execution steps breakdown
   */
  private showExecutionSteps(steps: ExecutionStep[]): void {
    const stepLines: string[] = [];

    stepLines.push(chalk.yellow('Execution Steps:'));

    for (const step of steps) {
      const duration = step.duration ? `${step.duration}ms` : 'ongoing';

      if (step.type === 'llm_call') {
        const tokenInfo = step.tokenUsage
          ? ` (${formatTokenUsageSummary(step.tokenUsage)})`
          : '';

        // Create descriptive label based on LLM context
        let llmLabel = 'LLM Call';
        if (step.llmContext === 'initial_input') {
          llmLabel = 'Processing Input';
        } else if (step.llmContext === 'processing_tool_result') {
          llmLabel = 'Processing Tool Output';
        } else if (step.llmContext === 'final_response') {
          llmLabel = 'Final Reasoning';
        }

        stepLines.push(`  ${chalk.cyan(`${step.stepNumber}.`)} ${llmLabel} - ${chalk.dim(duration)}${tokenInfo}`);
      } else {
        const success = step.toolSuccess !== undefined
          ? (step.toolSuccess ? chalk.green('✓') : chalk.red('✗'))
          : chalk.yellow('?');
        stepLines.push(`  ${chalk.cyan(`${step.stepNumber}.`)} ${success} ${step.toolName} - ${chalk.dim(duration)}`);
      }
    }

    note(stepLines.join('\n'), 'Step Details');
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    if (this.currentSpinner) {
      this.currentSpinner.stop();
      this.currentSpinner = undefined;
    }
  }
}