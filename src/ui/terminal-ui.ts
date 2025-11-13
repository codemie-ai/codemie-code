import { Tip } from '../utils/tips';
import { AgentEvent } from '../code/agent-events';

// Suppress ALL console.error during blessed import to avoid terminal capability parsing errors
const originalConsoleError = console.error;
let suppressErrors = true;
console.error = function(...args: unknown[]) {
  if (suppressErrors) {
    // Suppress all errors during initial setup
    return;
  }
  originalConsoleError.apply(console, args);
};

// Import blessed with error suppression
import blessed from 'blessed';

// Re-enable console.error after a short delay
setTimeout(() => {
  suppressErrors = false;
}, 100);

export interface TerminalUIConfig {
  onSubmit: (message: string) => Promise<void>;
  onSubmitStream: (message: string, onEvent: (event: AgentEvent) => void, abortSignal?: AbortSignal) => Promise<void>;
  onSlashCommand: (command: string, args: string[]) => Promise<string>;
  onClear: () => void;
  onExit: () => void;
  workingDirectory: string;
  model: string;
  provider: string;
}

interface SlashCommand {
  command: string;
  description: string;
  aliases?: string[];
}

export class TerminalUI {
  private screen: blessed.Widgets.Screen;
  private contentBox: blessed.Widgets.BoxElement;
  private inputBox: blessed.Widgets.BoxElement;
  private tipBox: blessed.Widgets.BoxElement;
  private commandSuggestionBox: blessed.Widgets.BoxElement;
  private config: TerminalUIConfig;
  private isProcessing: boolean = false;
  private currentAbortController: AbortController | null = null;
  private tipRotationInterval: NodeJS.Timeout | null = null;
  private currentTipIndex: number = 0;
  private tips: Tip[] = [];
  private shownTips: Set<number> = new Set();
  private availableCommands: SlashCommand[] = [
    { command: '/doctor', description: 'Diagnose and verify your CodeMie installation and settings' },
    { command: '/list', description: 'List all available agents and their status' },
    { command: '/clear', description: 'Clear conversation history and free up context', aliases: ['reset', 'new'] },
    { command: '/exit', description: 'Exit the REPL', aliases: ['quit'] },
    { command: '/help', description: 'Show help information' },
    { command: '/install', description: 'Install an agent (e.g., /install claude)' },
    { command: '/uninstall', description: 'Uninstall an agent' },
    { command: '/run', description: 'Run a specific agent' },
  ];
  private filteredCommands: SlashCommand[] = [];
  private selectedCommandIndex: number = 0;
  private isSuggestionsVisible: boolean = false;
  private currentStreamingContent: string = '';
  private currentToolCallContent: string[] = [];
  private currentStreamingLineCount: number = 0;
  private baseContentLines: string[] = [];
  private isCancelling: boolean = false;
  private currentContent: string = '';

  constructor(config: TerminalUIConfig) {
    this.config = config;
    this.screen = this.createScreen();
    this.contentBox = this.createContentBox();
    this.inputBox = this.createInputBox();
    this.tipBox = this.createTipBox();
    this.commandSuggestionBox = this.createCommandSuggestionBox();

    this.setupLayout();
    this.setupKeyBindings();
    this.setupInputHandlers();
    this.screen.render();
  }

  private createScreen(): blessed.Widgets.Screen {
    const screenOptions: Record<string, unknown> = {
      smartCSR: true,
      fullUnicode: true, // Enable full unicode for emoji support
      dockBorders: true,
      title: 'CodeMie Code Assistant',
      warnings: false, // Suppress terminfo warnings
      forceUnicode: true, // Force unicode support for better emoji rendering
      autoPadding: true,
      ignoreLocked: ['C-c'],
      // Enable mouse support for better text selection
      sendFocus: true,
      useBCE: false, // Disable BCE to avoid terminal capability issues
      // Disable cursor color and other advanced features that cause issues
      cursor: {
        artificial: false,
        shape: 'line',
        blink: true,
        color: null
      },
      // Terminal detection options
      terminal: 'xterm-256color',
      dump: false,
      debug: false
    };

    const screen = blessed.screen(screenOptions);

    // Suppress error output for terminal capabilities
    screen.on('warning', () => {
      // Silently ignore warnings
    });

    // Disable problematic terminal capabilities after screen creation
    if (screen.program && (screen.program as unknown as Record<string, unknown>).setupColors) {
      try {
        // Override setupColors to prevent underline color issues
        const originalSetupColors = (screen.program as unknown as Record<string, unknown>).setupColors as () => void;
        (screen.program as unknown as Record<string, unknown>).setupColors = function() {
          try {
            originalSetupColors();
          } catch {
            // Ignore color setup errors
          }
        };
      } catch {
        // Ignore if setupColors doesn't exist
      }
    }

    // Suppress all console.error calls that might be terminal capability related
    // This catches errors from blessed's terminfo parser (like Setulc)
    if (screen.program) {
      const originalError = console.error;
      console.error = function(...args: unknown[]) {
        // Check if it's a terminal capability error
        const errorStr = args.join(' ');
        if (errorStr.includes('Error on xterm') ||
            errorStr.includes('Setulc') ||
            errorStr.includes('stack.pop') ||
            errorStr.includes('terminfo')) {
          // Silently ignore terminal capability errors
          return;
        }
        // Pass through other errors
        originalError.apply(console, args);
      };
    }

    return screen;
  }

  private createContentBox(): blessed.Widgets.BoxElement {
    const boxOptions: Record<string, unknown> = {
      top: 0,
      left: 0,
      width: '100%',
      bottom: 7, // Reserve space for input (3 lines) + tips (4 lines with borders)
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '|',
        style: {
          fg: 'cyan'
        }
      },
      keys: true,
      vi: true,
      mouse: true,
      tags: true,
      border: 'line',
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: 'cyan'
        }
      },
      label: ' CodeMie Code ',
      // Enable text selection by allowing mouse events to pass through
      clickable: true,
      input: false,
      // Enable word wrapping to prevent text cutoff
      wrap: true,
      wordWrap: true
    };
    return blessed.box(boxOptions);
  }

  private createInputBox(): blessed.Widgets.BoxElement {
    // Use a simple box instead of textarea - just display the prompt
    const inputOptions: Record<string, unknown> = {
      bottom: 4,
      left: 0,
      width: '100%',
      height: 3,
      border: 'line',
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: 'green'
        }
      },
      label: ' You ',
      tags: true,
      content: '{white-fg}> {/white-fg}',
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '|',
        style: {
          fg: 'cyan'
        }
      }
    };

    const box = blessed.box(inputOptions);

    // Track input text
    let inputText = '';

    // Update display with multiline support and dynamic height
    const updateDisplay = () => {
      // Split into lines and add "> " only to first line, "  " to continuation lines
      const lines = inputText.split('\n');
      const formattedLines = lines.map((line, index) => {
        const prefix = index === 0 ? '> ' : '  ';
        return '{white-fg}' + prefix + this.escapeForBlessed(line) + '{/white-fg}';
      });

      box.setContent(formattedLines.join('\n'));

      // Dynamically adjust height based on number of lines (min 3, max 10)
      const lineCount = lines.length;
      const newHeight = Math.min(Math.max(lineCount + 2, 3), 10 + 2); // +2 for borders

      if ((box as unknown as Record<string, unknown>).height !== newHeight) {
        (box as unknown as Record<string, unknown>).height = newHeight;
        // Need to reposition dependent elements (tip box position stays same at bottom: 0)
        this.screen.render();
      }

      // Auto-scroll to bottom if content exceeds box height
      box.setScrollPerc(100);
      this.screen.render();
    };

    // Store methods and data for getting/clearing input
    (box as unknown as Record<string, unknown>).getInputText = () => inputText;
    (box as unknown as Record<string, unknown>).clearInputText = () => {
      inputText = '';
      (box as unknown as Record<string, unknown>).inputText = inputText;
      // Reset height to minimum when cleared
      (box as unknown as Record<string, unknown>).height = 3;
      updateDisplay();
    };
    (box as unknown as Record<string, unknown>).addNewline = () => {
      inputText += '\n';
      (box as unknown as Record<string, unknown>).inputText = inputText;
      updateDisplay();
    };
    (box as unknown as Record<string, unknown>).setInputText = (text: string) => {
      inputText = text;
      (box as unknown as Record<string, unknown>).inputText = inputText;
      // Reset height when setting new text (usually for autocomplete)
      (box as unknown as Record<string, unknown>).height = 3;
      updateDisplay();
    };

    // Store inputText directly on box for external access
    (box as unknown as Record<string, unknown>).inputText = inputText;

    // Listen to screen keypresses when box is focused
    box.on('focus', () => {
      (box as unknown as Record<string, unknown>)._inputFocused = true;
    });

    box.on('blur', () => {
      (box as unknown as Record<string, unknown>)._inputFocused = false;
    });

    // Capture input at screen level
    (this.screen as any).on('keypress', (ch: unknown, key: Record<string, unknown>) => {
      if (!(box as unknown as Record<string, unknown>)._inputFocused) return;
      if (!key) return;

      // Handle input
      if (key.full === 'backspace') {
        if (inputText.length > 0) {
          inputText = inputText.slice(0, -1);
          (box as unknown as Record<string, unknown>).inputText = inputText; // Keep in sync
          updateDisplay();
        }
      } else if (key.full === 'enter' || key.full === 'return') {
        // Let the key handler deal with this (shift+enter handled elsewhere)
        return;
      } else if (ch && typeof ch === 'string' && ch.length === 1 && !key.ctrl && !key.meta) {
        inputText += ch;
        (box as unknown as Record<string, unknown>).inputText = inputText; // Keep in sync
        updateDisplay();
      }
    });

    // Make it focusable
    (box as unknown as Record<string, unknown>).clickable = true;
    (box as unknown as Record<string, unknown>).keyable = true;
    (box as unknown as Record<string, unknown>).keys = true;
    (box as unknown as Record<string, unknown>).input = true;

    return box as blessed.Widgets.BoxElement;
  }

  private createTipBox(): blessed.Widgets.BoxElement {
    const tipOptions: Record<string, unknown> = {
      bottom: 0,
      left: 0,
      width: '100%',
      height: 4,
      tags: true,
      border: 'line',
      style: {
        fg: 'cyan',
        border: {
          fg: 'cyan'
        }
      },
      label: ' Tip '
    };
    return blessed.box(tipOptions);
  }

  private createCommandSuggestionBox(): blessed.Widgets.BoxElement {
    const suggestionOptions: Record<string, unknown> = {
      bottom: 7,
      left: 0,
      width: '100%',
      height: 'shrink',
      tags: true,
      border: 'line',
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: 'yellow'
        }
      },
      label: ' Available Commands ',
      hidden: true,
      scrollable: true,
      alwaysScroll: true
    };
    return blessed.box(suggestionOptions);
  }

  private setupLayout(): void {
    this.screen.append(this.contentBox);
    this.screen.append(this.inputBox);
    this.screen.append(this.tipBox);
    this.screen.append(this.commandSuggestionBox);

    // Show welcome message
    this.appendToContent('{cyan-fg}========================================{/cyan-fg}');
    this.appendToContent('{cyan-fg}       CodeMie Code Assistant          {/cyan-fg}');
    this.appendToContent('{cyan-fg}========================================{/cyan-fg}');
    this.appendToContent('');
    this.appendToContent(`{white-fg}Working directory: ${this.config.workingDirectory}{/white-fg}`);
    this.appendToContent(`{white-fg}Model: ${this.config.model} (${this.config.provider}){/white-fg}`);
    this.appendToContent('');
    this.appendToContent('{gray-fg}Press Enter to send, Shift+Enter for new line{/gray-fg}');
    this.appendToContent('{gray-fg}Use /command for CLI commands (e.g., /doctor, /list){/gray-fg}');
    this.appendToContent('{gray-fg}Press Esc to cancel execution, Ctrl+C or "q" to quit{/gray-fg}');
    this.appendToContent('');

    // Focus input by default
    this.inputBox.focus();
  }

  private setupKeyBindings(): void {
    // Ctrl+C to exit - use both screen and inputBox
    const exitHandler = () => {
      this.destroy();
      this.config.onExit();
    };

    this.screen.key(['C-c', 'q'], exitHandler);
    this.inputBox.key(['C-c'], exitHandler);

    // Esc to cancel agent execution
    this.screen.key(['escape'], () => {
      if (this.isProcessing && this.currentAbortController && !this.isCancelling) {
        this.isCancelling = true;
        this.appendToContent('');
        this.appendToContent('{yellow-fg}Cancelling execution...{/yellow-fg}');
        this.currentAbortController.abort();
      }
    });

    // Enter to submit
    this.inputBox.key(['enter'], async () => {
      await this.handleSubmit();
    });

    // Shift+Enter for newline (multiline support)
    this.inputBox.key(['S-enter'], () => {
      // Add newline using the built-in method
      const box = this.inputBox as unknown as Record<string, unknown>;
      (box.addNewline as () => void)();
    });

    // Arrow keys for command navigation when suggestions are visible
    this.inputBox.key(['up'], () => {
      if (this.isSuggestionsVisible && this.filteredCommands.length > 0) {
        this.selectedCommandIndex = Math.max(0, this.selectedCommandIndex - 1);
        this.updateCommandSuggestions();
      }
    });

    this.inputBox.key(['down'], () => {
      if (this.isSuggestionsVisible && this.filteredCommands.length > 0) {
        this.selectedCommandIndex = Math.min(this.filteredCommands.length - 1, this.selectedCommandIndex + 1);
        this.updateCommandSuggestions();
      }
    });

    // Tab for autocomplete
    this.inputBox.key(['tab'], () => {
      if (this.isSuggestionsVisible && this.filteredCommands.length > 0) {
        const selectedCommand = this.filteredCommands[this.selectedCommandIndex];
        if (selectedCommand) {
          // Set the input text using our custom method
          const newText = selectedCommand.command + ' ';
          const box = this.inputBox as unknown as Record<string, unknown>;
          (box.setInputText as (text: string) => void)(newText);

          this.hideCommandSuggestions();
        }
        return false; // Prevent default tab behavior
      }
    });

    // Scroll content with arrow keys when not focused on input
    this.screen.key(['up'], () => {
      if (this.screen.focused !== this.inputBox) {
        this.contentBox.scroll(-1);
        this.screen.render();
      }
    });

    this.screen.key(['down'], () => {
      if (this.screen.focused !== this.inputBox) {
        this.contentBox.scroll(1);
        this.screen.render();
      }
    });

    // Page up/down for faster scrolling
    this.screen.key(['pageup'], () => {
      this.contentBox.scroll(-10);
      this.screen.render();
    });

    this.screen.key(['pagedown'], () => {
      this.contentBox.scroll(10);
      this.screen.render();
    });

    // Ctrl+Tab to switch focus between content and input (tab is used for autocomplete)
    this.screen.key(['C-tab'], () => {
      if (this.screen.focused === this.inputBox) {
        this.contentBox.focus();
      } else {
        this.inputBox.focus();
      }
      this.screen.render();
    });
  }

  private setupInputHandlers(): void {
    // Watch for input changes to show command suggestions
    this.inputBox.on('keypress', () => {
      // Use setImmediate to get the updated value after keypress
      setImmediate(() => {
        // Get the actual input text from our custom method
        const box = this.inputBox as unknown as Record<string, unknown>;
        const currentValue = (box.getInputText as () => string)() || '';

        if (currentValue.startsWith('/') && !currentValue.includes('\n')) {
          // Show command suggestions
          this.showCommandSuggestions(currentValue);
        } else {
          // Hide suggestions
          this.hideCommandSuggestions();
        }
      });
    });
  }

  private showCommandSuggestions(input: string): void {
    const searchTerm = input.slice(1).toLowerCase();

    // Filter commands based on search term
    this.filteredCommands = this.availableCommands.filter(cmd => {
      const cmdName = cmd.command.slice(1);
      return cmdName.startsWith(searchTerm) || searchTerm === '';
    });

    // Reset selection if out of bounds
    if (this.selectedCommandIndex >= this.filteredCommands.length) {
      this.selectedCommandIndex = 0;
    }

    if (this.filteredCommands.length > 0) {
      this.isSuggestionsVisible = true;
      this.updateCommandSuggestions();
    } else {
      this.hideCommandSuggestions();
    }
  }

  private updateCommandSuggestions(): void {
    if (!this.isSuggestionsVisible || this.filteredCommands.length === 0) return;

    const separator = '{gray-fg}' + '─'.repeat(140) + '{/gray-fg}';

    // Calculate column widths
    const commandColWidth = 30;

    let suggestions = '';
    this.filteredCommands.forEach((cmd, index) => {
      const isSelected = index === this.selectedCommandIndex;
      const bgColor = isSelected ? '{black-bg}{white-fg}' : '';
      const endColor = isSelected ? '{/white-fg}{/black-bg}' : '';

      // Format command with aliases
      const aliasText = cmd.aliases ? ` {gray-fg}(${cmd.aliases.join(', ')}){/gray-fg}` : '';
      const commandText = `{yellow-fg}${cmd.command}{/yellow-fg}${aliasText}`;

      // Calculate padding to align descriptions
      // Note: We need to account for the actual visible length without tags
      const visibleCmdLength = cmd.command.length + (cmd.aliases ? ` (${cmd.aliases.join(', ')})`.length : 0);
      const padding = Math.max(0, commandColWidth - visibleCmdLength);

      suggestions += `${bgColor}  ${commandText}${' '.repeat(padding)}${cmd.description}${endColor}\n`;
    });

    this.commandSuggestionBox.setContent(separator + '\n' + suggestions + separator);
    this.commandSuggestionBox.show();

    // Adjust height based on number of matching commands
    const lines = this.filteredCommands.length;
    (this.commandSuggestionBox as unknown as Record<string, unknown>).height = Math.min(lines + 3, 15);

    this.screen.render();
  }

  private hideCommandSuggestions(): void {
    if (!this.commandSuggestionBox.hidden) {
      this.isSuggestionsVisible = false;
      this.selectedCommandIndex = 0;
      this.filteredCommands = [];
      this.commandSuggestionBox.hide();
      this.screen.render();
    }
  }

  private async handleSubmit(): Promise<void> {
    if (this.isProcessing) return;

    // Get message from our custom input method
    const box = this.inputBox as unknown as Record<string, unknown>;
    const message = ((box.getInputText as () => string)() || '').trim();

    if (!message) return;

    // Hide command suggestions
    this.hideCommandSuggestions();

    // Handle special commands
    if (message.toLowerCase() === 'exit') {
      this.destroy();
      this.config.onExit();
      return;
    }

    if (message.toLowerCase() === 'clear' || message.toLowerCase() === '/clear') {
      this.config.onClear();
      this.clearContent();
      const box1 = this.inputBox as unknown as Record<string, unknown>;
      (box1.clearInputText as () => void)();
      this.screen.render();
      return;
    }

    // Clear input and reset prompt
    const box2 = this.inputBox as unknown as Record<string, unknown>;
    (box2.clearInputText as () => void)();

    // Show user message
    this.appendToContent('');
    this.appendToContent(`{white-fg}> ${this.escapeForBlessed(message)}{/white-fg}`);
    this.appendToContent('');

    // Handle slash commands
    if (message.startsWith('/')) {
      const parts = message.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);

      this.appendToContent(`{yellow-fg}Running command:{/yellow-fg} {white-fg}/${command} ${args.join(' ')}{/white-fg}`);
      this.appendToContent('');

      this.isProcessing = true;
      this.screen.render();

      try {
        const result = await this.config.onSlashCommand(command, args);
        this.appendToContent(`{cyan-fg}Output:{/cyan-fg}`);

        // Split result into lines and append each with proper formatting
        const lines = result.split('\n');
        for (const line of lines) {
          this.appendToContent(`{white-fg}${this.escapeForBlessed(line)}{/white-fg}`);
        }
        this.appendToContent('');
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.appendToContent(`{red-fg}Error:{/red-fg} {white-fg}${this.escapeForBlessed(errorMessage)}{/white-fg}`);
        this.appendToContent('');
        this.appendToContent('{gray-fg}You can continue using the assistant or try the command again with correct arguments.{/gray-fg}');
        this.appendToContent('');
      } finally {
        // Ensure state is always restored, even if an error occurred
        this.isProcessing = false;

        // Use setImmediate to ensure focus happens after all other processing
        setImmediate(() => {
          this.inputBox.focus();
          this.screen.render();
        });
      }
      return;
    }

    this.isProcessing = true;

    // Create AbortController for cancellation
    this.currentAbortController = new AbortController();

    this.screen.render();

    try {
      // Use streaming if available
      if (this.config.onSubmitStream) {
        await this.config.onSubmitStream(message, (event: AgentEvent) => {
          try {
            switch (event.type) {
              case 'thinking_start':
                this.showThinking();
                break;
              case 'thinking_end':
                this.hideThinking();
                break;
              case 'content_chunk':
                if (this.currentStreamingContent === '') {
                  // First chunk - hide thinking and start streaming response
                  this.hideThinking();
                  this.startStreamingResponse();
                }
                this.appendStreamChunk(event.content);
                break;
              case 'tool_call_start':
                // Hide thinking indicator when tool execution starts
                this.hideThinking();
                // End any current streaming content before showing tool call
                if (this.currentStreamingContent !== '') {
                  this.endStreamingResponse();
                }
                this.showToolCallStart(event.toolName, event.toolArgs);
                break;
              case 'tool_call_result':
                this.showToolCallResult(event.toolName, event.result);
                break;
              case 'tool_call_error':
                this.showToolCallError(event.toolName, event.error);
                break;
              case 'cancelled':
                this.endStreamingResponse();
                // Replace the "Cancelling execution..." line with "Execution cancelled."
                this.removeLastLine(); // Remove empty line
                this.removeLastLine(); // Remove "Cancelling execution..."
                this.appendToContent('{yellow-fg}Execution cancelled.{/yellow-fg}');
                this.appendToContent('');
                break;
              case 'complete':
                this.endStreamingResponse();
                break;
              case 'error':
                this.showError(event.error);
                break;
            }
          } catch (err: unknown) {
            // Catch any errors in event handling to prevent breaking the flow
            console.error('Error handling event:', err);
          }
        }, this.currentAbortController.signal);
      } else {
        // Fallback to non-streaming
        this.appendToContent('{cyan-fg}Assistant:{/cyan-fg} {gray-fg}(thinking...){/gray-fg}');
        await this.config.onSubmit(message);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Silently ignore cancellation errors - already handled via 'cancelled' event
      if (errorMessage === 'Execution cancelled by user') {
        // Don't return early - fall through to finally block for proper cleanup
      } else {
        // Ensure error is displayed to user
        this.showError(errorMessage || 'An error occurred');
      }
    } finally {
      // ALWAYS reset processing state, even if there was an error
      this.isProcessing = false;
      this.currentAbortController = null;
      this.isCancelling = false;

      // Use setImmediate to ensure focus happens after all rendering is complete
      setImmediate(() => {
        this.inputBox.focus();
        this.screen.render();
      });
    }
  }

  public appendToContent(text: string): void {
    this.contentBox.pushLine(text);
    this.contentBox.setScrollPerc(100); // Auto-scroll to bottom
    this.screen.render();
  }

  public removeLastLine(): void {
    const lines = this.contentBox.getLines();
    if (lines.length > 0) {
      this.contentBox.deleteBottom();
      this.screen.render();
    }
  }

  public clearContent(): void {
    this.contentBox.setContent('');
    this.appendToContent('{yellow-fg}Conversation history cleared.{/yellow-fg}');
    this.appendToContent('');
  }

  public showAssistantResponse(response: string): void {
    // Remove the "thinking..." line
    this.removeLastLine();

    // Show assistant response
    this.appendToContent(`{cyan-fg}Assistant:{/cyan-fg} {white-fg}${this.escapeForBlessed(response)}{/white-fg}`);
    this.appendToContent('');
  }

  public showError(error: string): void {
    // Remove the "thinking..." line
    this.removeLastLine();

    this.appendToContent(`{red-fg}Error:{/red-fg} {white-fg}${this.escapeForBlessed(error)}{/white-fg}`);
    this.appendToContent('');
    this.appendToContent('{yellow-fg}Note: You can continue the conversation or type "exit" to quit.{/yellow-fg}');
    this.appendToContent('');
  }

  private escapeForBlessed(text: string): string {
    // Escape blessed tags
    return text
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}');
  }

  private shortenFilePath(path: string): string {
    // Check if this looks like a file path (contains / or \)
    if (!path.includes('/') && !path.includes('\\')) {
      return path;
    }

    // Split by both forward and back slashes
    const parts = path.split(/[/\\]/);

    // If path has 2 or fewer parts, return as is
    if (parts.length <= 2) {
      return path;
    }

    // Return last 2 parts (parent dir + filename)
    return parts.slice(-2).join('/');
  }

  private shortenAllPathsInText(text: string): string {
    // Match absolute paths (starting with / or drive letter on Windows)
    // Pattern: /path/to/file or C:\path\to\file
    const pathPattern = /(?:^|[\s(,["'])([/\\][\w\-./\\]+[\w\-.]|[A-Z]:[/\\][\w\-./\\]+[\w\-.])/g;

    return text.replace(pathPattern, (match, path) => {
      const before = match[0] !== '/' && match[0] !== '\\' && !/[A-Z]:/.test(match.slice(0, 2)) ? match[0] : '';
      const shortened = this.shortenFilePath(path.trim());
      return before + shortened;
    });
  }

  private formatToolArg(key: string, value: unknown): string {
    let strValue: string;

    if (typeof value === 'string') {
      // Check if it's a file path and shorten it
      strValue = this.shortenFilePath(value);
    } else {
      strValue = JSON.stringify(value);
    }

    return strValue;
  }

  public setTips(tips: Tip[]): void {
    this.tips = tips;
    if (tips.length > 0) {
      this.showRandomTip();
      this.startTipRotation();
    }
  }

  private getRandomTip(): Tip | null {
    if (this.tips.length === 0) return null;

    const availableTips = this.tips
      .map((tip, index) => ({ tip, index }))
      .filter(({ index }) => !this.shownTips.has(index));

    // Reset if all tips shown
    if (availableTips.length === 0) {
      this.shownTips.clear();
      return this.getRandomTip();
    }

    const selected = availableTips[Math.floor(Math.random() * availableTips.length)];
    this.shownTips.add(selected.index);
    this.currentTipIndex = selected.index;

    return selected.tip;
  }

  private showRandomTip(): void {
    const tip = this.getRandomTip();
    if (tip) {
      let tipText = `{cyan-fg}[Tip]{/cyan-fg} ${this.escapeForBlessed(tip.message)}`;
      if (tip.command) {
        tipText += `\n{gray-fg}  =>{/gray-fg} {yellow-fg}${this.escapeForBlessed(tip.command)}{/yellow-fg}`;
      }
      this.tipBox.setContent(tipText);
      this.screen.render();
    }
  }

  private startTipRotation(intervalMs: number = 15000): void {
    if (this.tipRotationInterval) {
      clearInterval(this.tipRotationInterval);
    }

    this.tipRotationInterval = setInterval(() => {
      if (!this.isProcessing) {
        this.showRandomTip();
      }
    }, intervalMs);
  }

  public render(): void {
    this.screen.render();
  }

  // Streaming-specific methods
  public startStreamingResponse(): void {
    this.currentStreamingContent = '';
    this.currentToolCallContent = [];
    this.currentStreamingLineCount = 0;
    // Store current content state
    this.baseContentLines = this.contentBox.getLines().slice();
  }

  public appendStreamChunk(chunk: string): void {
    this.currentStreamingContent += chunk;

    // Rebuild content from base + streaming
    const allLines = [...this.baseContentLines];

    // Split streaming content into logical lines
    const streamingLines = this.currentStreamingContent.split('\n');

    // Add first line with green dot
    allLines.push(`{green-fg}⏺{/green-fg} {white-fg}${this.escapeForBlessed(streamingLines[0])}{/white-fg}`);

    // Add continuation lines without the dot
    for (let i = 1; i < streamingLines.length; i++) {
      allLines.push(`{white-fg}${this.escapeForBlessed(streamingLines[i])}{/white-fg}`);
    }

    // Replace entire content
    this.contentBox.setContent(allLines.join('\n'));
    this.contentBox.setScrollPerc(100); // Auto-scroll to bottom
    this.screen.render();
  }

  public showThinking(): void {
    this.appendToContent(`{gray-fg}(thinking...){/gray-fg}`);
  }

  public hideThinking(): void {
    this.removeLastLine();
  }

  public showToolCallStart(toolName: string, toolArgs: Record<string, unknown>): void {
    // Format tool call as: ⏺ ToolName with only file path (hide large content args and null values)
    // Extract file path if present (and not null/undefined)
    let fileInfo = '';
    if (toolArgs.file_path && toolArgs.file_path !== null && toolArgs.file_path !== undefined) {
      fileInfo = `(${this.shortenFilePath(String(toolArgs.file_path))})`;
    } else if (toolArgs.path && toolArgs.path !== null && toolArgs.path !== undefined) {
      fileInfo = `(${this.shortenFilePath(String(toolArgs.path))})`;
    } else if (toolArgs.notebook_path && toolArgs.notebook_path !== null && toolArgs.notebook_path !== undefined) {
      fileInfo = `(${this.shortenFilePath(String(toolArgs.notebook_path))})`;
    }

    const toolMessage = `{green-fg}⏺{/green-fg} {white-fg}${this.escapeForBlessed(toolName)}${fileInfo ? ' ' + this.escapeForBlessed(fileInfo) : ''}{/white-fg}`;
    this.appendToContent(toolMessage);
    this.currentToolCallContent.push(toolMessage);
  }

  public showToolCallResult(toolName: string, result: string): void {
    // Format result with indentation: ⎿ first line\n   continuation...
    // Shorten all file paths in the result
    const shortenedResult = this.shortenAllPathsInText(result);
    const lines = shortenedResult.split('\n');
    const maxLines = 3;
    const displayLines = lines.slice(0, maxLines);
    const hiddenLines = Math.max(0, lines.length - maxLines);

    let resultMessage = '  {gray-fg}⎿{/gray-fg}  ' + this.escapeForBlessed(displayLines[0] || '');

    for (let i = 1; i < displayLines.length; i++) {
      resultMessage += '\n     ' + this.escapeForBlessed(displayLines[i]);
    }

    if (hiddenLines > 0) {
      resultMessage += `\n     {gray-fg}… +${hiddenLines} lines (ctrl+o to expand){/gray-fg}`;
    }

    this.appendToContent(resultMessage);
    this.appendToContent('');
    this.currentToolCallContent.push(resultMessage);
  }

  public showToolCallError(toolName: string, error: string): void {
    // Format error with red dot
    const errorMessage = `{red-fg}⏺ Error in ${this.escapeForBlessed(toolName)}{/red-fg}\n  {gray-fg}⎿{/gray-fg}  {red-fg}${this.escapeForBlessed(error)}{/red-fg}`;
    this.appendToContent(errorMessage);
    this.appendToContent('');
    this.currentToolCallContent.push(errorMessage);
  }

  public endStreamingResponse(): void {
    // Finalize the streaming content by adding it properly
    if (this.currentStreamingContent) {
      // The content is already displayed, just need to update base
      this.baseContentLines = this.contentBox.getLines().slice();
    }
    // Add a blank line after the response
    this.appendToContent('');
    this.currentStreamingContent = '';
    this.currentToolCallContent = [];
    this.currentStreamingLineCount = 0;
  }

  public destroy(): void {
    try {
      if (this.tipRotationInterval) {
        clearInterval(this.tipRotationInterval);
        this.tipRotationInterval = null;
      }

      // Hide all widgets before destroying
      this.commandSuggestionBox.hide();
      this.tipBox.hide();
      this.inputBox.hide();
      this.contentBox.hide();

      // Reset terminal state
      if (this.screen) {
        this.screen.program.clear();
        this.screen.program.disableMouse();
        this.screen.program.showCursor();
        this.screen.program.normalBuffer();

        // Destroy the screen (suppress any errors)
        try {
          this.screen.destroy();
        } catch {
          // Ignore terminfo errors on cleanup
        }
      }
    } catch {
      // Silently handle any cleanup errors
    }
  }
}
