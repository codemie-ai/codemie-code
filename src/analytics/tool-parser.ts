/**
 * Tool result parser for analytics
 * Extracts detailed metrics from tool call results
 */

import type { CodeMetrics, CommandMetrics } from './types.js';

/**
 * Parse tool result content to extract metrics
 */
export interface ToolResultMetrics {
  success: boolean;
  errorMessage?: string;
  linesAdded?: number;
  linesRemoved?: number;
  filesCreated?: number;
  filesModified?: number;
  filesDeleted?: number;
  filesRead?: number;
  bytesRead?: number;
  bytesWritten?: number;
  charactersWritten?: number;
  exitCode?: number;
  commandType?: string;
}

/**
 * Parse file operation results (Read, Write, Edit)
 */
export function parseFileOperationResult(
  toolName: string,
  content: string,
  isError: boolean
): ToolResultMetrics {
  const metrics: ToolResultMetrics = {
    success: !isError,
  };

  if (isError) {
    metrics.errorMessage = content.substring(0, 500);
    return metrics;
  }

  // Normalize tool name for comparison
  const normalizedToolName = toolName.toLowerCase();

  // Parse Read tool results
  if (normalizedToolName.includes('read')) {
    metrics.filesRead = 1;
    metrics.bytesRead = content.length;
  }

  // Parse Write tool results
  else if (normalizedToolName.includes('write')) {
    metrics.filesCreated = 1;
    metrics.bytesWritten = content.length;
    metrics.charactersWritten = content.length;

    // Count lines written
    const lines = content.split('\n').length;
    metrics.linesAdded = lines;
  }

  // Parse Edit tool results
  else if (normalizedToolName.includes('edit')) {
    metrics.filesModified = 1;

    // Try to extract diff information from result
    const diffMatch = content.match(/(\d+)\s*lines?\s*added.*?(\d+)\s*lines?\s*removed/i);
    if (diffMatch) {
      metrics.linesAdded = parseInt(diffMatch[1], 10);
      metrics.linesRemoved = parseInt(diffMatch[2], 10);
    } else {
      // Fallback: estimate from content length
      const contentLength = content.length;
      metrics.bytesWritten = contentLength;

      // Try to parse success message patterns
      const successMatch = content.match(/successfully\s+(?:edited|modified|updated)/i);
      if (successMatch) {
        metrics.filesModified = 1;
      }
    }
  }

  return metrics;
}

/**
 * Parse Anthropic tool result content
 * Anthropic format: {type: "tool_result", content: "...", is_error: false}
 */
export function parseAnthropicToolResult(
  toolName: string,
  content: unknown,
  isError: boolean
): ToolResultMetrics {
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);

  const metrics: ToolResultMetrics = {
    success: !isError,
  };

  if (isError) {
    metrics.errorMessage = contentStr.substring(0, 500);
    return metrics;
  }

  // Try to parse structured content
  let structuredContent: any = null;
  try {
    structuredContent = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    // Content is plain text, parse as string
    return parseFileOperationResult(toolName, contentStr, isError);
  }

  // Parse structured tool results
  if (structuredContent && typeof structuredContent === 'object') {
    // File operation results
    if (structuredContent.filePath || structuredContent.file_path) {
      metrics.filesModified = 1;
    }

    if (structuredContent.linesAdded !== undefined) {
      metrics.linesAdded = structuredContent.linesAdded;
    }
    if (structuredContent.linesRemoved !== undefined) {
      metrics.linesRemoved = structuredContent.linesRemoved;
    }
    if (structuredContent.bytesWritten !== undefined) {
      metrics.bytesWritten = structuredContent.bytesWritten;
    }
    if (structuredContent.bytesRead !== undefined) {
      metrics.bytesRead = structuredContent.bytesRead;
    }

    // Command execution results
    if (structuredContent.exitCode !== undefined || structuredContent.exit_code !== undefined) {
      metrics.exitCode = structuredContent.exitCode ?? structuredContent.exit_code;
      metrics.success = metrics.exitCode === 0;
    }
    if (structuredContent.commandType || structuredContent.command_type) {
      metrics.commandType = structuredContent.commandType ?? structuredContent.command_type;
    }
  }

  // Fallback to text parsing if no structured data
  if (!metrics.linesAdded && !metrics.bytesWritten && !metrics.exitCode) {
    return parseFileOperationResult(toolName, contentStr, isError);
  }

  return metrics;
}

/**
 * Parse OpenAI tool result content
 * OpenAI format: {role: "tool", content: "..."}
 */
export function parseOpenAIToolResult(
  toolName: string,
  content: string
): ToolResultMetrics {
  // OpenAI doesn't have explicit error flag, detect from content
  const isError = content.toLowerCase().includes('error') ||
                  content.toLowerCase().includes('failed') ||
                  content.toLowerCase().includes('exception');

  return parseFileOperationResult(toolName, content, isError);
}

/**
 * Parse Gemini tool result content
 * Gemini format: {functionResponse: {name: "...", response: {...}}}
 */
export function parseGeminiToolResult(
  toolName: string,
  response: unknown
): ToolResultMetrics {
  const responseStr = JSON.stringify(response);
  const isError = responseStr.toLowerCase().includes('error');

  const metrics: ToolResultMetrics = {
    success: !isError,
  };

  if (isError) {
    metrics.errorMessage = responseStr.substring(0, 500);
    return metrics;
  }

  // Try to parse structured response
  if (response && typeof response === 'object') {
    const resp = response as Record<string, any>;

    // File operation results
    if (resp.linesAdded !== undefined) {
      metrics.linesAdded = resp.linesAdded;
    }
    if (resp.linesRemoved !== undefined) {
      metrics.linesRemoved = resp.linesRemoved;
    }
    if (resp.bytesWritten !== undefined) {
      metrics.bytesWritten = resp.bytesWritten;
    }
    if (resp.bytesRead !== undefined) {
      metrics.bytesRead = resp.bytesRead;
    }
    if (resp.filesCreated !== undefined) {
      metrics.filesCreated = resp.filesCreated;
    }
    if (resp.filesModified !== undefined) {
      metrics.filesModified = resp.filesModified;
    }

    // Command results
    if (resp.exitCode !== undefined) {
      metrics.exitCode = resp.exitCode;
      metrics.success = resp.exitCode === 0;
    }
    if (resp.commandType !== undefined) {
      metrics.commandType = resp.commandType;
    }
  }

  // Fallback to text parsing
  if (!metrics.linesAdded && !metrics.bytesWritten && !metrics.exitCode) {
    return parseFileOperationResult(toolName, responseStr, isError);
  }

  return metrics;
}

/**
 * Detect command type from command string
 */
export function detectCommandType(command: string): string {
  const cmd = command.trim().toLowerCase();

  // Git commands
  if (cmd.startsWith('git ')) {
    const gitCmd = cmd.split(' ')[1];
    return `git_${gitCmd}`;
  }

  // npm/yarn/pnpm commands
  if (cmd.startsWith('npm ') || cmd.startsWith('yarn ') || cmd.startsWith('pnpm ')) {
    return 'package_manager';
  }

  // File operations
  if (cmd.startsWith('cat ') || cmd.startsWith('head ') || cmd.startsWith('tail ')) {
    return 'file_read';
  }
  if (cmd.startsWith('echo ') || cmd.startsWith('touch ')) {
    return 'file_write';
  }
  if (cmd.startsWith('rm ') || cmd.startsWith('rmdir ')) {
    return 'file_delete';
  }
  if (cmd.startsWith('cp ') || cmd.startsWith('mv ')) {
    return 'file_move';
  }
  if (cmd.startsWith('mkdir ')) {
    return 'directory_create';
  }

  // Directory operations
  if (cmd.startsWith('ls ') || cmd.startsWith('find ') || cmd.startsWith('tree ')) {
    return 'directory_list';
  }
  if (cmd.startsWith('cd ')) {
    return 'directory_change';
  }

  // Build tools
  if (cmd.startsWith('make ') || cmd.startsWith('cmake ') || cmd.startsWith('gradle ')) {
    return 'build';
  }

  // Test runners
  if (cmd.includes('test') || cmd.includes('jest') || cmd.includes('pytest') || cmd.includes('mocha')) {
    return 'test';
  }

  // Linters
  if (cmd.includes('lint') || cmd.includes('eslint') || cmd.includes('prettier')) {
    return 'lint';
  }

  return 'other';
}

/**
 * Parse bash/command execution result
 */
export function parseBashResult(
  command: string,
  output: string,
  exitCode?: number
): ToolResultMetrics {
  const metrics: ToolResultMetrics = {
    success: exitCode === 0 || exitCode === undefined,
    exitCode,
    commandType: detectCommandType(command),
  };

  // If command failed, extract error
  if (exitCode !== 0) {
    metrics.errorMessage = output.substring(0, 500);
  }

  return metrics;
}

/**
 * Initialize empty code metrics
 */
export function createEmptyCodeMetrics(): CodeMetrics {
  return {
    linesAdded: 0,
    linesRemoved: 0,
    linesModified: 0,
    filesCreated: 0,
    filesModified: 0,
    filesDeleted: 0,
    filesRead: 0,
    totalCharactersWritten: 0,
    totalBytesRead: 0,
    totalBytesWritten: 0,
  };
}

/**
 * Initialize empty command metrics
 */
export function createEmptyCommandMetrics(): CommandMetrics {
  return {
    totalCommands: 0,
    successfulCommands: 0,
    failedCommands: 0,
    commandsByType: {},
  };
}

/**
 * Merge tool result metrics into code metrics
 */
export function mergeCodeMetrics(
  codeMetrics: CodeMetrics,
  toolMetrics: ToolResultMetrics
): void {
  if (toolMetrics.linesAdded) {
    codeMetrics.linesAdded += toolMetrics.linesAdded;
  }
  if (toolMetrics.linesRemoved) {
    codeMetrics.linesRemoved += toolMetrics.linesRemoved;
  }
  if (toolMetrics.filesCreated) {
    codeMetrics.filesCreated += toolMetrics.filesCreated;
  }
  if (toolMetrics.filesModified) {
    codeMetrics.filesModified += toolMetrics.filesModified;
  }
  if (toolMetrics.filesDeleted) {
    codeMetrics.filesDeleted += toolMetrics.filesDeleted;
  }
  if (toolMetrics.filesRead) {
    codeMetrics.filesRead += toolMetrics.filesRead;
  }
  if (toolMetrics.bytesRead) {
    codeMetrics.totalBytesRead += toolMetrics.bytesRead;
  }
  if (toolMetrics.bytesWritten) {
    codeMetrics.totalBytesWritten += toolMetrics.bytesWritten;
  }
  if (toolMetrics.charactersWritten) {
    codeMetrics.totalCharactersWritten += toolMetrics.charactersWritten;
  }
}

/**
 * Merge tool result metrics into command metrics
 */
export function mergeCommandMetrics(
  commandMetrics: CommandMetrics,
  toolMetrics: ToolResultMetrics
): void {
  if (toolMetrics.commandType) {
    commandMetrics.totalCommands++;

    if (toolMetrics.success) {
      commandMetrics.successfulCommands++;
    } else {
      commandMetrics.failedCommands++;
    }

    // Track by command type
    const type = toolMetrics.commandType;
    commandMetrics.commandsByType[type] = (commandMetrics.commandsByType[type] || 0) + 1;
  }
}
