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

      const content = await fs.readFile(resolvedPath, 'utf-8');
      return `File: ${filePath}\n\n${content}`;
    } catch (error) {
      return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
    }
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

      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workingDirectory,
        timeout: 30000, // 30 second timeout
        maxBuffer: 1024 * 1024 // 1MB output limit
      });

      let result = '';
      if (stdout) result += `STDOUT:\n${stdout}\n`;
      if (stderr) result += `STDERR:\n${stderr}\n`;

      return result || 'Command executed successfully (no output)';
    } catch (error) {
      return `Error executing command: ${error instanceof Error ? error.message : String(error)}`;
    }
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

    if (config.debug) {
      console.log(`[DEBUG] Created ${tools.length} system tools`);
    }

    return tools;
  } catch (error) {
    if (config.debug) {
      console.error('[DEBUG] Error creating system tools:', error);
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
    { name: 'execute_command', description: 'Execute a shell command in the working directory' }
  ];
}