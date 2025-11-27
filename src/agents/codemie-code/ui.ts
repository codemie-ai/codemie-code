import { intro, outro, text, spinner, note, isCancel } from '@clack/prompts';
import chalk from 'chalk';
import { CodeMieAgent } from './agent.js';
import { ExecutionStep, TodoUpdateEvent } from './types.js';
import { formatToolMetadata } from './toolMetadata.js';
import { formatCost, formatTokens, formatTokenUsageSummary } from './tokenUtils.js';
import { hasClipboardImage, getClipboardImage, type ClipboardImage } from '../../utils/clipboard.js';
import { TodoPanel } from './ui/todoPanel.js';
import { ProgressTracker, getProgressTracker } from './ui/progressTracker.js';
import { TodoStateManager } from './tools/planning.js';
import { logger } from '../../utils/logger.js';

/**
 * Terminal UI interface for CodeMie Agent using Clack
 */
export class CodeMieTerminalUI {
  private agent: CodeMieAgent;
  private currentSpinner?: any;
  private todoPanel: TodoPanel;
  private progressTracker: ProgressTracker;
  private planMode = false;
  private activePlanningPhase: string | null = null;

  constructor(agent: CodeMieAgent) {
    this.agent = agent;
    this.todoPanel = new TodoPanel({
      showProgress: true,
      compact: false
    });
    this.progressTracker = getProgressTracker({
      realTimeUpdates: true,
      showCelebrations: true,
      compact: true
    });

    // Register for todo update events
    TodoStateManager.addEventCallback(this.handleTodoUpdate.bind(this));
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
      console.log(chalk.cyan('◇  Configuration'));
      console.log(`   Provider: ${chalk.yellow(displayProvider)}`);
      console.log(`   Model: ${chalk.cyan(config.model)}`);
      console.log(`   Working Directory: ${chalk.white(config.workingDirectory)}`);
      console.log(`   Mode: ${this.planMode ? chalk.green('Plan Mode') : chalk.yellow('Direct Mode')}`);
      console.log('');
    }

    console.log(chalk.white('Type /help for commands, /exit to quit'));
    console.log(chalk.white('Enter = send, Shift+Enter = new line, Cmd+V = paste text'));
    console.log(chalk.white('📸 Tab = insert clipboard image • Multiple images supported'));
    console.log(chalk.white('💡 Press Ctrl+H for hotkeys, Ctrl+P to toggle plan mode\n'));

    // Main interaction loop
    while (true) {
      const input = await this.getMultilineInput();

      if (input === null) {
        outro(chalk.white('Goodbye! 👋'));
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

      // Execute the task with streaming UI (respecting current mode)
      await this.executeTaskWithCurrentMode(trimmed, input.images);
    }
  }

  /**
   * Get input from user with Shift+Enter multiline support and image pasting
   */
  private async getMultilineInput(): Promise<{ text: string; images: ClipboardImage[] } | null> {
    return new Promise((resolve) => {
      if (!process.stdin.setRawMode) {
        // Fallback for environments without raw mode
        this.getFallbackInput().then(resolve).catch(() => resolve(null));
        return;
      }

      let cleanupDone = false;

      const performCleanup = () => {
        if (cleanupDone) return;
        cleanupDone = true;

        try {
          if (process.stdin.setRawMode) {
            process.stdin.setRawMode(false);
          }
          process.stdin.pause();
          process.stdin.removeAllListeners('data');
          process.stdin.removeAllListeners('error');
        } catch {
          // Ignore cleanup errors
        }
      };

      // Set up error handling first
      process.stdin.once('error', (error) => {
        performCleanup();
        const config = this.agent.getConfig();
        if (config?.debug) {
          logger.debug('Stdin error:', error);
        }
        resolve(null);
      });

      try {
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
          try {
            const prompt = isFirstLine ? '> ' : '... ';
            process.stdout.write(prompt);
          } catch {
            // Ignore prompt write errors
          }
        };

        writePrompt();

        process.stdin.on('data', (key: Buffer) => {
          if (cleanupDone) return; // Prevent processing after cleanup

          try {
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
            performCleanup();
            resolve({
              text: lines.join('\n'),
              images: images
            });
            return;
        }

            // Ctrl+C
            if (data === '\u0003') {
              performCleanup();
              resolve(null);
              return;
            }

        // Hotkeys for mode switching
        // Ctrl+P - Toggle plan mode
        if (data === '\u0010') {
          this.handleHotkey('toggle-plan-mode');
          // Mode change notification is handled in showModeChangeNotification()
          writePrompt();
          process.stdout.write(currentLine);
          return;
        }

        // Ctrl+H - Show hotkey help
        if (data === '\u0008') {
          this.showHotkeyHelp();
          writePrompt();
          process.stdout.write(currentLine);
          return;
        }

        // Ctrl+T - Show current todos
        if (data === '\u0014') {
          this.handleHotkey('show-todos');
          writePrompt();
          process.stdout.write(currentLine);
          return;
        }

        // Ctrl+S - Show current mode status (changed from Ctrl+M to avoid Enter conflict)
        if (data === '\u0013') {
          this.showModeStatus();
          writePrompt();
          process.stdout.write(currentLine);
          return;
        }

        // Alt+M - Show mode status (Alt key sequences start with \x1b)
        if (data === 'm' && escapeSequence.includes('\x1b')) {
          this.showModeStatus();
          writePrompt();
          process.stdout.write(currentLine);
          escapeSequence = '';
          return;
        }

        // Ctrl+I - Insert image from clipboard (Tab key)
        if (data === '\u0009') {
          // Check if there's an image in clipboard
          hasClipboardImage().then(hasImage => {
            if (hasImage) {
              getClipboardImage().then(clipboardImage => {
                if (clipboardImage) {
                  imageCounter++;
                  images.push(clipboardImage);

                  // Insert visual indicator in current line
                  const imageIndicator = chalk.blueBright(`[Image #${imageCounter}]`);
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
            console.log(chalk.rgb(255, 120, 120)('\n❌ Error accessing clipboard'));
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
          } catch (error) {
            // Handle data processing errors gracefully
            const config = this.agent.getConfig();
            if (config?.debug) {
              logger.debug('Input processing error:', error);
            }
            // Continue processing - don't crash on single key errors
          }
        });

      } catch (error) {
        performCleanup();
        const config = this.agent.getConfig();
        if (config?.debug) {
          logger.debug('Input setup error:', error);
        }
        resolve(null);
      }
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
          `${chalk.cyan('/todos')} - Show current todo list and progress\n` +
          `${chalk.cyan('/config')} - Show configuration\n` +
          `${chalk.cyan('/health')} - Run health check\n` +
          `${chalk.cyan('/exit')} - Exit the agent\n\n` +
          `${chalk.yellow('Hotkeys:')}\n` +
          `- ${chalk.cyan('Ctrl+P')} - Toggle plan mode on/off\n` +
          `- ${chalk.cyan('Ctrl+H')} - Show detailed hotkey help\n` +
          `- ${chalk.cyan('Ctrl+T')} - Show current todo list\n` +
          `- ${chalk.cyan('Ctrl+S')} - Show current mode status\n\n` +
          `${chalk.yellow('Input Controls:')}\n` +
          `- ${chalk.cyan('Enter')} - Send message\n` +
          `- ${chalk.cyan('Shift+Enter')} - New line (multiline input)\n` +
          `- ${chalk.cyan('Cmd+V / Ctrl+V')} - Paste text from clipboard\n` +
          `- ${chalk.cyan('Tab')} - Insert image from clipboard\n` +
          `- ${chalk.cyan('Ctrl+C')} - Cancel current input\n\n` +
          `${chalk.yellow('Image Support:')}\n` +
          `- Copy image/screenshot to clipboard\n` +
          `- Press ${chalk.cyan('Tab')} to insert as ${chalk.blueBright('[Image #N]')}\n` +
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

      case 'todos':
        await this.showTodos();
        break;

      case 'config':
        await this.showConfig();
        break;

      case 'health':
        await this.runHealthCheck();
        break;

      case 'exit':
        outro(chalk.white('Goodbye! 👋'));
        return 'exit';

      default:
        note(chalk.rgb(255, 120, 120)(`Unknown command: ${command}\nType /help for available commands`), 'Error');
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
            this.currentSpinner.start(chalk.white('Thinking...'));
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

          case 'tool_call_progress':
            if (this.currentSpinner && event.toolProgress) {
              const { percentage, operation, details } = event.toolProgress;
              const progressBar = this.createToolProgressBar(percentage);
              let message = `${operation} ${Math.round(percentage)}% ${progressBar}`;

              if (details) {
                message += ` (${details})`;
              }

              this.currentSpinner.message(chalk.cyan(message));
            }
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
      `  Duration: ${chalk.white(stats.executionTime + 'ms')}`
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
      `Base URL: ${chalk.white(config.baseUrl)}`,
      `Working Directory: ${chalk.white(config.workingDirectory)}`,
      `Debug Mode: ${config.debug ? chalk.green('enabled') : chalk.white('disabled')}`,
      `Timeout: ${chalk.white(config.timeout + 'ms')}`
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
            taskSpinner.start(chalk.white('Thinking...'));
            break;

          case 'content_chunk':
            if (!hasStarted) {
              // Switch from "Thinking..." to "Processing task..." when content starts
              taskSpinner.message(chalk.white('Processing task...'));
              hasStarted = true;
            }
            response += event.content || '';
            break;

          case 'tool_call_start':
            toolCallCount++;
            taskSpinner.message(chalk.yellow(`Using ${event.toolName}...`));
            break;

          case 'tool_call_progress':
            if (event.toolProgress) {
              const { percentage, operation, details } = event.toolProgress;
              const progressBar = this.createToolProgressBar(percentage);
              let message = `${operation} ${Math.round(percentage)}% ${progressBar}`;

              if (details) {
                message += ` (${details})`;
              }

              taskSpinner.message(chalk.cyan(message));
            }
            break;

          case 'tool_call_result':
            // Show enhanced tool info in single task mode too
            if (event.toolMetadata) {
              const message = formatToolMetadata(event.toolName || 'tool', event.toolMetadata);
              taskSpinner.message(chalk.green(message));
            } else {
              taskSpinner.message(chalk.white('Processing task...'));
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
        console.log(chalk.white(`${summaryParts.join(' • ')}\n`));
      }

      return response;
    } catch (error) {
      taskSpinner.stop(chalk.red('Task failed'));
      throw error;
    }
  }

  /**
   * Execute a task with planning mode and UI streaming (for plan mode)
   */
  async executePlanningTask(task: string, _images: any[] = [], planOnly = false): Promise<string> {
    const planSpinner = spinner();
    this.currentSpinner = planSpinner; // Store reference to stop when progress starts
    planSpinner.start(chalk.blueBright('📋 Starting planning phase...'));

    try {
      // Import PlanMode
      const { PlanMode } = await import('./modes/planMode.js');
      const planMode = new PlanMode(this.agent, {
        requirePlanning: true,
        enforceSequential: true,
        showPlanningFeedback: true
      });

      // Create a UI-connected event callback that handles both planning and streaming events
      const uiEventCallback = (event: any) => {
        // Handle planning-specific events
        this.handleStreamingEvent(event);

        // Handle regular streaming events too
        switch (event.type) {
          case 'thinking_start':
            planSpinner.message(chalk.white('Thinking...'));
            break;

          case 'content_chunk':
            // For planning phase, we might not want to show content chunks immediately
            break;

          case 'tool_call_start':
            planSpinner.message(chalk.yellow(`Using ${event.toolName}...`));
            break;

          case 'tool_call_progress':
            if (event.toolProgress) {
              const { percentage, operation, details } = event.toolProgress;
              const progressBar = this.createToolProgressBar(percentage);
              let message = `${operation} ${Math.round(percentage)}% ${progressBar}`;

              if (details) {
                message += ` (${details})`;
              }

              planSpinner.message(chalk.cyan(message));
            }
            break;

          case 'tool_call_result':
            if (event.toolMetadata) {
              const message = formatToolMetadata(event.toolName || 'tool', event.toolMetadata);
              planSpinner.message(chalk.green(message));
            } else {
              planSpinner.message(chalk.white('Processing...'));
            }
            break;

          case 'complete':
            planSpinner.stop();
            break;

          case 'error':
            planSpinner.stop(chalk.red(`Error: ${event.error}`));
            break;
        }
      };

      if (planOnly) {
        // Only generate plan, don't execute
        const planningResult = await (planMode as any).planningPhase(task, uiEventCallback);

        planSpinner.stop();

        if (!planningResult.success) {
          throw new Error(`Planning failed: ${planningResult.error}`);
        }

        return `📋 Plan generated successfully with ${planningResult.todos.length} steps:\n\n` +
               planningResult.todos.map((todo: any, i: number) =>
                 `${i + 1}. ${todo.content}`
               ).join('\n') +
               `\n\nQuality Score: ${planningResult.qualityScore}/100\n` +
               (planningResult.suggestions.length > 0 ?
                 `\nSuggestions:\n${planningResult.suggestions.map((s: string) => `• ${s}`).join('\n')}` : '') +
               `\n\n🎯 **Plan-only mode**: Plan created. Use --plan flag (without --plan-only) to execute this plan.`;
      }

      // Full planning + execution
      const result = await planMode.executePlannedTask(task, uiEventCallback);

      planSpinner.stop();

      // Show success message with token usage
      const stats = this.agent.getStats();
      const summaryParts: string[] = [];

      if (stats.totalTokens > 0) {
        summaryParts.push(`${formatTokens(stats.totalTokens)} tokens`);
      }

      if (stats.estimatedTotalCost > 0) {
        summaryParts.push(`${formatCost(stats.estimatedTotalCost)}`);
      }

      if (summaryParts.length > 0) {
        console.log(chalk.white(`${summaryParts.join(' • ')}\n`));
      }

      return result;

    } catch (error) {
      planSpinner.stop(chalk.red('Planning failed'));
      throw error;
    }
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
          details = chalk.white(`Preview:\n${metadata.contentPreview}`);
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
            details = chalk.white(`${formattedItems}\n  +${remainingStr}`);
          } else {
            // Fallback for simple lists without truncation
            const items = preview.split(', ');
            details = chalk.white(items.map(item => `  ${item}`).join('\n'));
          }
        }
        break;

      case 'execute_command':
        if (metadata.outputPreview && metadata.outputPreview !== 'No output') {
          details = chalk.white(`Output:\n${metadata.outputPreview}`);
        }
        break;
    }

    if (details) {
      console.log(chalk.white('  ' + details.replace(/\n/g, '\n  ')));
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

        stepLines.push(`  ${chalk.cyan(`${step.stepNumber}.`)} ${llmLabel} - ${chalk.white(duration)}${tokenInfo}`);
      } else {
        const success = step.toolSuccess !== undefined
          ? (step.toolSuccess ? chalk.green('✓') : chalk.red('✗'))
          : chalk.yellow('?');
        stepLines.push(`  ${chalk.cyan(`${step.stepNumber}.`)} ${success} ${step.toolName} - ${chalk.white(duration)}`);
      }
    }

    note(stepLines.join('\n'), 'Step Details');
  }

  /**
   * Handle todo update events
   */
  private handleTodoUpdate(event: TodoUpdateEvent): void {
    // Update internal state
    this.todoPanel.update(event.todos);

    // Only show progress tracker updates when NOT in active planning phase
    // This prevents duplicate progress displays during context-aware planning
    if (!this.activePlanningPhase) {
      this.progressTracker.updateTodos(event.todos, event);

      // Show visual feedback based on change type
      if (event.changeType === 'create' && event.todos.length > 0) {
        this.progressTracker.showPlanningComplete(event.todos.length);
      }
    } else {
      // During planning phase, update internal state but suppress visual feedback
      this.progressTracker.updateTodos(event.todos, event, true);
    }
  }

  /**
   * Enable plan mode for structured planning
   */
  enablePlanMode(): void {
    this.planMode = true;
    // Remove redundant messages - UI will show plan mode status in the configuration display
  }

  /**
   * Disable plan mode
   */
  disablePlanMode(): void {
    this.planMode = false;
    this.progressTracker.stop();
  }

  /**
   * Show current todo status
   */
  private async showTodos(): Promise<void> {
    const _todos = this.todoPanel.getTodos();

    if (_todos.length === 0) {
      note('No todos found. Use a planning task to create todos automatically.', '📋 Todo Status');
      return;
    }

    const todoDisplay = this.todoPanel.render();
    note(todoDisplay, '📋 Current Todo List');
  }

  /**
   * Show planning phase welcome
   */
  showPlanningWelcome(): void {
    if (this.planMode) {
      console.log(chalk.cyan('💡 Plan mode features: structured planning, progress tracking, sequential execution'));
      console.log('');
    }
  }

  /**
   * Show task welcome with planning context
   */
  showTaskWelcome(task: string): void {
    intro(chalk.cyan('🤖 CodeMie Native Agent'));

    if (this.planMode) {
      console.log(chalk.cyan('◇  Task Execution'));
      console.log(`   Task: ${chalk.yellow(task)}`);
      console.log(`   Mode: ${chalk.cyan('Plan Mode')} - Structured planning enabled`);
      console.log('');
      this.showPlanningWelcome();
    } else {
      console.log(chalk.cyan('◇  Task Execution'));
      console.log(`   Task: ${chalk.yellow(task)}`);
      console.log('');
    }
  }

  /**
   * Show task completion with todo summary
   */
  showTaskComplete(): void {
    const _todos = this.todoPanel.getTodos();
    const progressInfo = this.todoPanel.getProgressInfo();

    if (progressInfo && progressInfo.total > 0) {
      const stats = {
        tasksCompleted: progressInfo.completed,
        totalTime: undefined // Could track this if needed
      };
      this.progressTracker.showOverallCompletion(stats);

      // Show final todo status if relevant
      if (progressInfo.completed === progressInfo.total) {
        note('All planned tasks completed successfully! 🎉', '✅ Task Complete');
      } else if (progressInfo.completed > 0) {
        note(
          `Completed ${progressInfo.completed}/${progressInfo.total} planned tasks`,
          '📊 Progress Summary'
        );
      }
    } else {
      outro(chalk.green('✅ Task completed!'));
    }
  }

  /**
   * Show error with todo context
   */
  showError(error: string): void {
    const _todos = this.todoPanel.getTodos();
    const progressInfo = this.todoPanel.getProgressInfo();

    let contextInfo = '';
    if (progressInfo?.currentTodo) {
      contextInfo = `\n📍 Error occurred while working on: ${progressInfo.currentTodo.content}`;
    }

    note(chalk.rgb(255, 120, 120)(`❌ ${error}${contextInfo}`), 'Error');
  }

  /**
   * Execute task respecting current mode settings
   */
  private async executeTaskWithCurrentMode(task: string, images: ClipboardImage[] = []): Promise<void> {
    if (this.planMode) {
      // Use plan mode execution with confirmation
      try {
        const { PlanMode } = await import('./modes/planMode.js');
        const planMode = new PlanMode(this.agent, {
          requirePlanning: true,
          enforceSequential: true,
          showPlanningFeedback: true
        });

        // First, create the plan only - using UI-integrated planning
        const planningResult = await (planMode as any).planningPhase(task, (event: any) => {
          // Handle planning-specific events with UI integration
          this.handleStreamingEvent(event);

          // Handle regular streaming events for spinner updates
          switch (event.type) {
            case 'thinking_start':
              // Already handled in handleStreamingEvent
              break;
            case 'tool_call_start':
              // Already handled in handleStreamingEvent
              break;
            case 'tool_call_result':
              // Already handled in handleStreamingEvent
              break;
          }
        });

        if (!planningResult.success) {
          this.showError(`Planning failed: ${planningResult.error}`);
          return;
        }

        // Show the plan to the user with proper formatting
        const formattedPlan = this.formatPlanForDisplay(planningResult.todos, planningResult.qualityScore);
        note(formattedPlan, 'Planning Complete');

        // Ask for confirmation
        const shouldExecute = await text({
          message: 'Execute this plan?',
          placeholder: 'Type "yes" to execute, or "no" to cancel',
          validate: (value) => {
            const normalized = value.toLowerCase().trim();
            if (!['yes', 'y', 'no', 'n'].includes(normalized)) {
              return 'Please type "yes" or "no"';
            }
          }
        });

        if (isCancel(shouldExecute)) {
          note('Plan execution cancelled by user', 'Cancelled');
          return;
        }

        const response = (shouldExecute as string).toLowerCase().trim();
        if (['yes', 'y'].includes(response)) {
          // Execute the plan
          await planMode.executePlannedTask(task, (event) => {
            this.handleStreamingEvent(event);
          });
        } else {
          note('Plan execution cancelled by user', 'Cancelled');
        }
      } catch (error) {
        this.showError(error instanceof Error ? error.message : String(error));
      }
    } else {
      // Use direct execution
      await this.executeTaskWithUI(task, images);
    }
  }

  /**
   * Handle streaming events from plan mode execution
   */
  private handleStreamingEvent(event: any): void {
    switch (event.type) {
      case 'planning_start':
        this.activePlanningPhase = event.planningInfo?.phase || 'planning';
        // Don't duplicate the planning start message - handled by spinner
        break;

      case 'planning_complete':
        this.activePlanningPhase = null;
        console.log(chalk.green(`📋 Plan created with ${event.planningInfo?.totalSteps || 0} steps`));
        break;

      case 'planning_progress':
        this.handlePlanningProgress(event.planningProgress);
        break;

      case 'planning_tool_call':
        this.handlePlanningToolCall(event.planningToolCall);
        break;

      case 'content_chunk':
        if (event.content) {
          process.stdout.write(event.content);
        }
        break;

      case 'todo_update':
        // Todo updates are handled automatically by the TodoStateManager
        // During planning phase, we suppress duplicate visual feedback
        break;

      case 'error':
        this.activePlanningPhase = null;
        this.showError(event.error || 'Unknown error');
        break;

      default:
        // Handle other event types silently
        break;
    }
  }

  /**
   * Handle planning progress streaming events
   */
  private currentPhase: string = '';
  private currentTool: string = '';
  private currentToolCall: string = '';

  private handlePlanningProgress(progressInfo: any): void {
    if (!progressInfo) return;

    // Keep the spinner running and use it to display progress updates
    const phaseNames = {
      'context_gathering': 'Discovery',
      'task_analysis': 'Analysis',
      'plan_generation': 'Planning',
      'plan_validation': 'Validation'
    };

    this.currentPhase = phaseNames[progressInfo.phase as keyof typeof phaseNames] || 'Planning';
    this.updateGlobalProgress(progressInfo.overallProgress || 0);
  }

  /**
   * Handle planning tool call events
   */
  private handlePlanningToolCall(toolInfo: any): void {
    if (!toolInfo) return;

    const toolNames = {
      'list_directory': 'Exploring',
      'read_file': 'Reading',
      'execute_command': 'Executing',
      'llm_analysis': 'Analyzing',
      'llm_plan_generation': 'Generating Plan',
      'plan_validation': 'Validating',
      'analyze_dependencies': 'Dependencies'
    };

    this.currentTool = toolNames[toolInfo.toolName as keyof typeof toolNames] || 'Tool';

    // Format tool call details with arguments
    this.currentToolCall = this.formatToolCall(toolInfo.toolName, toolInfo.args);

    // Update progress with current tool info
    this.updateGlobalProgress();
  }

  /**
   * Format tool call with arguments for display
   */
  private formatToolCall(toolName: string, args?: Record<string, any>): string {
    if (!args || Object.keys(args).length === 0) {
      return toolName;
    }

    // Extract key arguments for concise display
    const formatArg = (key: string, value: any): string => {
      if (typeof value === 'string') {
        // Truncate long strings and show just the relevant part
        if (key === 'path' || key === 'directory') {
          // Show just the last part of paths
          const parts = value.split('/');
          return parts[parts.length - 1] || value;
        }
        if (key === 'command') {
          // Show first word of commands
          return value.split(' ')[0];
        }
        if (value.length > 20) {
          return value.substring(0, 17) + '...';
        }
        return value;
      }
      if (Array.isArray(value)) {
        return `[${value.length} items]`;
      }
      if (typeof value === 'object') {
        return '{...}';
      }
      return String(value);
    };

    // Pick the most relevant arguments to show
    const relevantKeys = ['path', 'directory', 'file', 'command', 'query', 'pattern'];
    const argsToShow: string[] = [];

    for (const key of relevantKeys) {
      if (key in args) {
        argsToShow.push(formatArg(key, args[key]));
        if (argsToShow.length >= 2) break; // Show max 2 args
      }
    }

    // If no relevant keys found, show first few keys
    if (argsToShow.length === 0) {
      const keys = Object.keys(args).slice(0, 2);
      for (const key of keys) {
        argsToShow.push(formatArg(key, args[key]));
      }
    }

    return argsToShow.length > 0 ? `${toolName} (${argsToShow.join(', ')})` : toolName;
  }

  /**
   * Update global progress display
   */
  private currentProgress: number = 0;

  private updateGlobalProgress(progress?: number): void {
    if (progress !== undefined) {
      this.currentProgress = progress;
    }

    const progressBar = this.createProgressBar(this.currentProgress);
    let displayText = `Progress ${Math.round(this.currentProgress)}% ${progressBar}`;

    // Show tool call details if available, otherwise fall back to tool name or phase
    // This provides detailed info like "(Discovery, calling list_dir (src))"
    if (this.currentToolCall) {
      displayText += ` (${this.currentPhase}, calling ${this.currentToolCall})`;
    } else if (this.currentTool) {
      displayText += ` (${this.currentTool})`;
    } else if (this.currentPhase) {
      displayText += ` (${this.currentPhase})`;
    }

    // Use clack-style spinner update for reliable real-time display
    if (this.currentSpinner) {
      this.currentSpinner.message(displayText);
    } else {
      // Fallback to direct output if no spinner
      process.stdout.write('\r' + displayText);
    }

    // Only add newline when planning is completely finished (100%)
    if (this.currentProgress >= 100) {
      if (this.currentSpinner) {
        this.currentSpinner.stop(displayText);
        this.currentSpinner = undefined;
      } else {
        process.stdout.write('\n');
      }
      this.currentPhase = '';
      this.currentTool = '';
      this.currentToolCall = '';
    }
  }

  /**
   * Create a simple progress bar
   */
  private createProgressBar(percentage: number, width: number = 20): string {
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;

    const filledBar = chalk.cyan('█'.repeat(filled));
    const emptyBar = chalk.white('░'.repeat(empty));

    return `[${filledBar}${emptyBar}]`;
  }

  /**
   * Create a tool progress bar (smaller for inline use)
   */
  private createToolProgressBar(percentage: number, width: number = 12): string {
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;

    const filledBar = chalk.green('█'.repeat(filled));
    const emptyBar = chalk.white('░'.repeat(empty));

    return `[${filledBar}${emptyBar}]`;
  }

  /**
   * Handle hotkey actions
   */
  private handleHotkey(action: string): void {
    switch (action) {
      case 'toggle-plan-mode':
        this.togglePlanMode();
        break;

      case 'show-todos':
        this.showTodosHotkey();
        break;

      case 'show-help':
        this.showHotkeyHelp();
        break;

      case 'show-status':
        this.showModeStatus();
        break;

      default:
        console.log(chalk.red(`\n❌ Unknown hotkey action: ${action}`));
        break;
    }
  }

  /**
   * Toggle plan mode on/off
   */
  private togglePlanMode(): void {
    const wasEnabled = this.planMode;

    if (this.planMode) {
      this.disablePlanMode();
    } else {
      this.enablePlanMode();
    }

    // Show enhanced visual feedback
    this.showModeChangeNotification(wasEnabled, this.planMode);
  }

  /**
   * Show enhanced visual feedback for mode changes
   */
  private showModeChangeNotification(wasEnabled: boolean, nowEnabled: boolean): void {
    const modeIcon = nowEnabled ? '📋' : '⚡';
    const statusText = nowEnabled ? 'enabled' : 'disabled';

    // Simple, concise mode change message
    console.log(chalk.blueBright(`\n${modeIcon} Plan mode ${statusText}`));

    // Start progress tracking when plan mode is enabled (but don't show 0/0 progress yet)
    if (nowEnabled) {
      this.progressTracker.start();
    }
  }

  /**
   * Show todos via hotkey (non-blocking)
   */
  private showTodosHotkey(): void {
    const _todos = this.todoPanel.getTodos();

    if (_todos.length === 0) {
      console.log(chalk.white('\n📋 No todos found'));
    } else {
      const todoDisplay = this.todoPanel.render();
      console.log(`\n${todoDisplay}`);
    }
  }

  /**
   * Show hotkey help
   */
  private showHotkeyHelp(): void {
    const helpText = `
${chalk.bold.cyan('🔥 Interactive Mode Hotkeys')}

Mode Control:
  ${chalk.yellow('Ctrl+P')}   Toggle plan mode on/off
  ${chalk.yellow('Ctrl+S')}   Show current mode status

Todo Management:
  ${chalk.yellow('Ctrl+T')}   Show current todo list and progress

General:
  ${chalk.yellow('Ctrl+H')}   Show this help
  ${chalk.yellow('Tab')}      Insert image from clipboard
  ${chalk.yellow('Ctrl+C')}   Cancel input / Exit

Input Controls:
  ${chalk.yellow('Enter')}         Send message
  ${chalk.yellow('Shift+Enter')}   New line (multiline input)

Chat Commands:
  ${chalk.yellow('/help')}     Show chat commands
  ${chalk.yellow('/todos')}    Show detailed todo information
  ${chalk.yellow('/stats')}    Show agent statistics
  ${chalk.yellow('/exit')}     Exit the session
`;

    console.log(helpText);
  }

  /**
   * Show current mode status
   */
  private showModeStatus(): void {
    const _todos = this.todoPanel.getTodos();
    const progressInfo = this.todoPanel.getProgressInfo();

    let statusText = chalk.bold.blueBright('\n📊 Current Status\n');

    // Mode information
    statusText += `Mode: ${this.planMode ?
      chalk.green('Plan Mode (structured todos)') :
      chalk.yellow('Direct Mode (immediate execution)')}\n`;

    // Todo information
    if (progressInfo && progressInfo.total > 0) {
      statusText += `Todos: ${progressInfo.completed}/${progressInfo.total} completed (${progressInfo.percentage}%)\n`;

      if (progressInfo.currentTodo) {
        statusText += `Current: ${chalk.cyan(progressInfo.currentTodo.content)}\n`;
      }
    } else {
      statusText += 'Todos: None active\n';
    }

    // Agent status
    const agentStats = this.agent.getStats();
    if (agentStats) {
      statusText += `Session: ${agentStats.toolCalls} tool calls, ${agentStats.llmCalls} LLM calls\n`;
    }

    console.log(statusText);
  }


  /**
   * Format plan for display with proper text wrapping
   */
  private formatPlanForDisplay(todos: any[], qualityScore: number): string {
    const maxWidth = Math.min(process.stdout.columns - 10, 100); // Leave some margin

    let formatted = `📋 **Plan Created** (${todos.length} steps):\n\n`;

    todos.forEach((todo, index) => {
      const stepNumber = `${index + 1}. `;
      const content = todo.content;

      // Wrap long lines properly
      const wrappedContent = this.wrapText(content, maxWidth - stepNumber.length);
      const lines = wrappedContent.split('\n');

      // First line with step number
      formatted += stepNumber + lines[0] + '\n';

      // Subsequent lines indented to align with content
      for (let i = 1; i < lines.length; i++) {
        formatted += ' '.repeat(stepNumber.length) + lines[i] + '\n';
      }

      // Add spacing between steps
      if (index < todos.length - 1) {
        formatted += '\n';
      }
    });

    formatted += `\n\nQuality Score: ${qualityScore}/100`;

    return formatted;
  }

  /**
   * Wrap text to specified width
   */
  private wrapText(text: string, maxWidth: number): string {
    if (text.length <= maxWidth) {
      return text;
    }

    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      // If adding this word would exceed the width
      if (currentLine.length + word.length + 1 > maxWidth) {
        if (currentLine) {
          lines.push(currentLine.trim());
          currentLine = word;
        } else {
          // Single word is longer than maxWidth, force break
          lines.push(word);
        }
      } else {
        if (currentLine) {
          currentLine += ' ' + word;
        } else {
          currentLine = word;
        }
      }
    }

    if (currentLine) {
      lines.push(currentLine.trim());
    }

    return lines.join('\n');
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    if (this.currentSpinner) {
      this.currentSpinner.stop();
      this.currentSpinner = undefined;
    }

    // Clean up todo tracking
    this.progressTracker.stop();
    TodoStateManager.removeEventCallback(this.handleTodoUpdate.bind(this));
  }
}