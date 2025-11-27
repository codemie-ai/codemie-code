/**
 * System Tools Registry for CodeMie Native Agent
 *
 * Creates and manages system tools available to the LangGraph ReAct agent
 */

import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { CodeMieConfig } from '../types.js';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { filterDirectoryEntries, createFilterConfig, DEFAULT_FILTER_CONFIG, generateFilterStats } from '../filters.js';
import { logger } from '../../../utils/logger.js';

const execAsync = promisify(exec);

/**
 * Basic file read tool - reads file contents
 */
class ReadFileTool extends StructuredTool {
  name = 'read_file';
  description = 'Read the contents of a file from the filesystem';

  schema = z.object({
    filePath: z.string().describe('Path to the file to read'),
  });

  private workingDirectory: string;

  constructor(workingDirectory: string) {
    super();
    this.workingDirectory = workingDirectory;
  }

  async _call({ filePath }: z.infer<typeof this.schema>): Promise<string> {
    try {
      // Resolve path relative to working directory
      const resolvedPath = path.resolve(this.workingDirectory, filePath);

      // Basic security check - ensure we're not escaping working directory
      if (!resolvedPath.startsWith(this.workingDirectory)) {
        throw new Error('Access denied: Path is outside working directory');
      }

      // Emit progress: starting file read
      emitToolProgress(this.name, {
        percentage: 10,
        operation: `Reading ${path.basename(filePath)}...`,
        details: `Opening file: ${filePath}`
      });

      // Check file stats for progress estimation
      const stats = await fs.stat(resolvedPath);
      const fileSize = stats.size;

      // Emit progress: file opened
      emitToolProgress(this.name, {
        percentage: 30,
        operation: `Reading ${path.basename(filePath)}...`,
        details: `File size: ${this.formatFileSize(fileSize)}`
      });

      // For large files, simulate progress by reading in chunks
      if (fileSize > 50000) { // 50KB threshold for showing progress
        let content = '';
        const chunkSize = 8192; // 8KB chunks
        const totalChunks = Math.ceil(fileSize / chunkSize);

        const fileHandle = await fs.open(resolvedPath, 'r');
        const buffer = Buffer.alloc(chunkSize);

        try {
          for (let i = 0; i < totalChunks; i++) {
            const { bytesRead } = await fileHandle.read(buffer, 0, chunkSize, i * chunkSize);
            content += buffer.subarray(0, bytesRead).toString('utf-8');

            const progress = Math.min(30 + Math.round((i + 1) / totalChunks * 60), 90);
            emitToolProgress(this.name, {
              percentage: progress,
              operation: `Reading ${path.basename(filePath)}...`,
              details: `${Math.round((i + 1) / totalChunks * 100)}% complete`
            });

            // Small delay for large files to show progress
            if (i % 10 === 0) {
              await new Promise(resolve => setTimeout(resolve, 1));
            }
          }
        } finally {
          await fileHandle.close();
        }

        // Final progress
        emitToolProgress(this.name, {
            percentage: 100,
            operation: `Completed reading ${path.basename(filePath)}`,
            details: `Read ${this.formatFileSize(fileSize)}`
          });

        return `File: ${filePath}\n\n${content}`;
      } else {
        // For small files, read normally but still show progress
        const content = await fs.readFile(resolvedPath, 'utf-8');

        emitToolProgress(this.name, {
            percentage: 100,
            operation: `Completed reading ${path.basename(filePath)}`,
            details: `Read ${this.formatFileSize(fileSize)}`
          });

        return `File: ${filePath}\n\n${content}`;
      }
    } catch (error) {
      return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

/**
 * Basic file write tool - writes content to a file
 */
class WriteFileTool extends StructuredTool {
  name = 'write_file';
  description = 'Write content to a file in the filesystem';

  schema = z.object({
    filePath: z.string().describe('Path to the file to write'),
    content: z.string().describe('Content to write to the file'),
  });

  private workingDirectory: string;

  constructor(workingDirectory: string) {
    super();
    this.workingDirectory = workingDirectory;
  }

  async _call({ filePath, content }: z.infer<typeof this.schema>): Promise<string> {
    try {
      // Resolve path relative to working directory
      const resolvedPath = path.resolve(this.workingDirectory, filePath);

      // Basic security check - ensure we're not escaping working directory
      if (!resolvedPath.startsWith(this.workingDirectory)) {
        throw new Error('Access denied: Path is outside working directory');
      }

      // Ensure directory exists
      const dir = path.dirname(resolvedPath);
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(resolvedPath, content, 'utf-8');
      return `Successfully wrote ${content.length} characters to ${filePath}`;
    } catch (error) {
      return `Error writing file: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

/**
 * Basic command execution tool - runs shell commands
 */
class ExecuteCommandTool extends StructuredTool {
  name = 'execute_command';
  description = 'Execute a shell command in the working directory';

  schema = z.object({
    command: z.string().describe('Shell command to execute'),
  });

  private workingDirectory: string;

  constructor(workingDirectory: string) {
    super();
    this.workingDirectory = workingDirectory;
  }

  async _call({ command }: z.infer<typeof this.schema>): Promise<string> {
    try {
      // Basic security checks
      const dangerousCommands = ['rm -rf', 'sudo', 'chmod +x', 'curl', 'wget'];
      if (dangerousCommands.some(cmd => command.toLowerCase().includes(cmd))) {
        return `Error: Command rejected for security reasons: ${command}`;
      }

      // Emit progress: command starting
      emitToolProgress(this.name, {
          percentage: 10,
          operation: `Executing command...`,
          details: command.length > 50 ? `${command.substring(0, 47)}...` : command
        });

      // Start timer for progress estimation
      const startTime = Date.now();
      let progressInterval: NodeJS.Timeout | undefined;

      // For long-running commands, simulate progress
      const estimatedTime = this.estimateCommandTime(command);
      if (estimatedTime > 2000) { // Only show progress for commands estimated > 2s
        progressInterval = setInterval(() => {
          const elapsed = Date.now() - startTime;
          const progress = Math.min(10 + Math.round((elapsed / estimatedTime) * 80), 90);

          emitToolProgress(this.name, {
            percentage: progress,
            operation: `Executing command...`,
            details: `Running for ${Math.round(elapsed / 1000)}s`,
            estimatedTimeRemaining: Math.max(0, estimatedTime - elapsed)
          });
        }, 1000);
      }

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: this.workingDirectory,
          timeout: 30000, // 30 second timeout
          maxBuffer: 1024 * 1024 // 1MB output limit
        });

        // Clear interval and emit completion
        if (progressInterval) {
          clearInterval(progressInterval);
        }

        const executionTime = Date.now() - startTime;
        emitToolProgress(this.name, {
            percentage: 100,
            operation: `Command completed`,
            details: `Finished in ${executionTime}ms`
          });

        let result = '';
        if (stdout) result += `STDOUT:\n${stdout}\n`;
        if (stderr) result += `STDERR:\n${stderr}\n`;

        return result || 'Command executed successfully (no output)';
      } catch (error) {
        if (progressInterval) {
          clearInterval(progressInterval);
        }
        throw error;
      }
    } catch (error) {
      return `Error executing command: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private estimateCommandTime(command: string): number {
    // Simple heuristics for command execution time estimation
    const lowerCommand = command.toLowerCase();

    if (lowerCommand.includes('npm install') || lowerCommand.includes('yarn install')) {
      return 15000; // 15s for package installs
    }
    if (lowerCommand.includes('npm run build') || lowerCommand.includes('yarn build')) {
      return 10000; // 10s for builds
    }
    if (lowerCommand.includes('git clone') || lowerCommand.includes('git pull')) {
      return 8000; // 8s for git operations
    }
    if (lowerCommand.includes('find') || lowerCommand.includes('grep -r')) {
      return 5000; // 5s for search operations
    }
    if (lowerCommand.includes('tar') || lowerCommand.includes('zip') || lowerCommand.includes('unzip')) {
      return 6000; // 6s for compression operations
    }

    return 2000; // Default 2s
  }
}

/**
 * Directory listing tool - lists files and directories with intelligent filtering
 */
class ListDirectoryTool extends StructuredTool {
  name = 'list_directory';
  description = 'List files and directories in a given path, automatically filtering out common ignore patterns (node_modules, .git, build artifacts, etc.)';

  schema = z.object({
    directoryPath: z.string().optional().describe('Directory path to list (defaults to working directory)'),
    showAll: z.boolean().optional().describe('Show all files including normally filtered ones (default: false)'),
    includeHidden: z.boolean().optional().describe('Include hidden files and directories (default: false)'),
  });

  private workingDirectory: string;
  private filterConfig: any;

  constructor(workingDirectory: string, filterConfig?: any) {
    super();
    this.workingDirectory = workingDirectory;
    this.filterConfig = filterConfig || DEFAULT_FILTER_CONFIG;
  }

  async _call({ directoryPath, showAll = false, includeHidden = false }: z.infer<typeof this.schema>): Promise<string> {
    try {
      const targetPath = directoryPath
        ? path.resolve(this.workingDirectory, directoryPath)
        : this.workingDirectory;

      // Security check
      if (!targetPath.startsWith(this.workingDirectory)) {
        throw new Error('Access denied: Path is outside working directory');
      }

      const entries = await fs.readdir(targetPath, { withFileTypes: true });

      // Convert to our format for filtering
      let directoryEntries = entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory()
      }));

      // Filter hidden files if not requested
      if (!includeHidden) {
        directoryEntries = directoryEntries.filter(entry => !entry.name.startsWith('.'));
      }

      // Store original count for statistics
      const originalEntries = [...directoryEntries];

      // Apply filtering if not showAll
      let filteredEntries = directoryEntries;
      let filterStats;

      if (!showAll) {
        const filterConfig = createFilterConfig({
          ...this.filterConfig,
          enabled: true
        });

        filteredEntries = filterDirectoryEntries(directoryEntries, filterConfig, directoryPath || '');
        filterStats = generateFilterStats(originalEntries, filteredEntries, filterConfig);
      }

      // Separate into files and directories
      const files: string[] = [];
      const directories: string[] = [];

      for (const entry of filteredEntries) {
        if (entry.isDirectory) {
          directories.push(`${entry.name}/`);
        } else {
          files.push(entry.name);
        }
      }

      // Build result string
      let result = `Directory: ${directoryPath || '.'}\n\n`;

      if (directories.length > 0) {
        result += 'Directories:\n';
        result += directories.map(dir => `  ${dir}`).join('\n') + '\n\n';
      }

      if (files.length > 0) {
        result += 'Files:\n';
        result += files.map(file => `  ${file}`).join('\n');
      }

      if (directories.length === 0 && files.length === 0) {
        result += 'Directory is empty';
      }

      // Add filtering summary if filtering was applied
      if (!showAll && filterStats && filterStats.ignoredEntries > 0) {
        result += `\n\n--- Filtered out ${filterStats.ignoredEntries} items ---`;
        result += `\nShowing ${filterStats.filteredEntries} of ${filterStats.totalEntries} total items`;
        result += `\nUse showAll: true to see all items`;
      }

      return result;
    } catch (error) {
      return `Error listing directory: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

/**
 * Tool event callback type for progress reporting
 */
export type ToolEventCallback = (event: {
  type: 'tool_call_progress';
  toolName: string;
  progress: {
    percentage: number;
    operation: string;
    details?: string;
    estimatedTimeRemaining?: number;
  };
}) => void;

/**
 * Global tool event emitter - set during chatStream
 */
let globalToolEventCallback: ToolEventCallback | null = null;

/**
 * Set the global tool event callback for the current execution
 */
export function setGlobalToolEventCallback(callback: ToolEventCallback | null): void {
  globalToolEventCallback = callback;
}

/**
 * Emit a tool progress event using the global callback
 */
export function emitToolProgress(toolName: string, progress: {
  percentage: number;
  operation: string;
  details?: string;
  estimatedTimeRemaining?: number;
}): void {
  if (globalToolEventCallback) {
    globalToolEventCallback({
      type: 'tool_call_progress',
      toolName,
      progress
    });
  }
}

/**
 * Create system tools available to the CodeMie agent
 */
export async function createSystemTools(config: CodeMieConfig): Promise<StructuredTool[]> {
  const tools: StructuredTool[] = [];

  try {
    // Basic file system tools
    tools.push(new ReadFileTool(config.workingDirectory));
    tools.push(new WriteFileTool(config.workingDirectory));
    tools.push(new ListDirectoryTool(config.workingDirectory, config.directoryFilters));

    // Command execution tool
    tools.push(new ExecuteCommandTool(config.workingDirectory));

    // Planning and todo tools
    try {
      const { planningTools, initializeTodoStorage } = await import('./planning.js');

      // Initialize todo storage for this working directory
      initializeTodoStorage(config.workingDirectory, config.debug);

      tools.push(...planningTools);

      if (config.debug) {
        logger.debug(`Added ${planningTools.length} planning tools`);
        logger.debug(`Initialized todo storage for: ${config.workingDirectory}`);
      }
    } catch (error) {
      if (config.debug) {
        logger.debug('Planning tools not available:', error);
      }
    }

    if (config.debug) {
      logger.debug(`Created ${tools.length} total system tools`);
    }

    return tools;
  } catch (error) {
    if (config.debug) {
      logger.debug('Error creating system tools:', error);
    }

    // Return empty array on error to allow agent to function
    return [];
  }
}

/**
 * Get available tool names and descriptions
 */
export function getToolSummary(): Array<{ name: string; description: string }> {
  return [
    { name: 'read_file', description: 'Read the contents of a file from the filesystem' },
    { name: 'write_file', description: 'Write content to a file in the filesystem' },
    { name: 'list_directory', description: 'List files and directories in a given path, automatically filtering out common ignore patterns (node_modules, .git, build artifacts, etc.)' },
    { name: 'execute_command', description: 'Execute a shell command in the working directory' },
    { name: 'write_todos', description: 'Create or update a structured todo list for planning and progress tracking' },
    { name: 'update_todo_status', description: 'Update the status of a specific todo by index' },
    { name: 'append_todo', description: 'Add a new todo item to the existing list' },
    { name: 'clear_todos', description: 'Clear all todos from the list' },
    { name: 'show_todos', description: 'Display the current todo list with progress information' }
  ];
}