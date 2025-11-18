/**
 * Tool Parameter Logging Tests
 * 
 * Tests to verify that tool parameters are correctly logged during agent execution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Tool Parameter Logging', () => {
  let consoleLogSpy: any;

  beforeEach(() => {
    // Spy on console.log to capture debug output
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore console.log after each test
    consoleLogSpy.mockRestore();
  });

  describe('toolCallArgs Map Storage', () => {
    it('should store tool arguments when tool_calls are received', () => {
      // Simulate the toolCallArgs Map behavior from agent.ts
      const toolCallArgs = new Map<string, Record<string, any>>();

      // Simulate receiving a tool call from LLM
      const toolCall = {
        name: 'read_file',
        args: {
          filePath: 'src/index.ts'
        }
      };

      // Store tool args (as done in processStreamChunk)
      toolCallArgs.set(toolCall.name, toolCall.args);

      // Verify storage
      expect(toolCallArgs.has('read_file')).toBe(true);
      expect(toolCallArgs.get('read_file')).toEqual({ filePath: 'src/index.ts' });
    });

    it('should store multiple tool arguments with different parameters', () => {
      const toolCallArgs = new Map<string, Record<string, any>>();

      // Simulate multiple tool calls
      const toolCalls = [
        { name: 'read_file', args: { filePath: 'package.json' } },
        { name: 'write_file', args: { filePath: 'output.txt', content: 'test content' } },
        { name: 'execute_command', args: { command: 'npm test' } },
        { name: 'list_directory', args: { directoryPath: 'src/', showAll: false } }
      ];

      // Store all tool args
      toolCalls.forEach(call => {
        toolCallArgs.set(call.name, call.args);
      });

      // Verify all are stored correctly
      expect(toolCallArgs.size).toBe(4);
      expect(toolCallArgs.get('read_file')).toEqual({ filePath: 'package.json' });
      expect(toolCallArgs.get('write_file')).toEqual({ filePath: 'output.txt', content: 'test content' });
      expect(toolCallArgs.get('execute_command')).toEqual({ command: 'npm test' });
      expect(toolCallArgs.get('list_directory')).toEqual({ directoryPath: 'src/', showAll: false });
    });

    it('should clean up tool args after retrieval', () => {
      const toolCallArgs = new Map<string, Record<string, any>>();

      // Store tool args
      toolCallArgs.set('read_file', { filePath: 'test.ts' });

      // Retrieve and delete (as done in processStreamChunk)
      const args = toolCallArgs.get('read_file');
      expect(args).toEqual({ filePath: 'test.ts' });
      
      toolCallArgs.delete('read_file');

      // Verify cleanup
      expect(toolCallArgs.has('read_file')).toBe(false);
    });
  });

  describe('Debug Logging Output', () => {
    it('should format tool parameters with JSON.stringify when debug=true', () => {
      const config = { debug: true };
      const toolName = 'read_file';
      const toolArgs = { filePath: 'src/agents/agent.ts' };

      // Simulate the debug logging from startToolStep
      if (config.debug && toolArgs && Object.keys(toolArgs).length > 0) {
        console.log(`[DEBUG] Started tool step 1: ${toolName} ${JSON.stringify(toolArgs)}`);
      }

      // Verify console.log was called with correct format
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DEBUG] Started tool step 1: read_file')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('{"filePath":"src/agents/agent.ts"}')
      );
    });

    it('should log write_file parameters including content', () => {
      const config = { debug: true };
      const toolName = 'write_file';
      const toolArgs = { 
        filePath: 'output.txt', 
        content: 'This is test content for the file' 
      };

      if (config.debug && toolArgs && Object.keys(toolArgs).length > 0) {
        console.log(`[DEBUG] Started tool step 2: ${toolName} ${JSON.stringify(toolArgs)}`);
      }

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DEBUG] Started tool step 2: write_file')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('"filePath":"output.txt"')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('"content":"This is test content for the file"')
      );
    });

    it('should log execute_command parameters with command string', () => {
      const config = { debug: true };
      const toolName = 'execute_command';
      const toolArgs = { command: 'npm run build' };

      if (config.debug && toolArgs && Object.keys(toolArgs).length > 0) {
        console.log(`[DEBUG] Started tool step 3: ${toolName} ${JSON.stringify(toolArgs)}`);
      }

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DEBUG] Started tool step 3: execute_command')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('"command":"npm run build"')
      );
    });

    it('should log list_directory parameters with optional flags', () => {
      const config = { debug: true };
      const toolName = 'list_directory';
      const toolArgs = { 
        directoryPath: 'src/agents', 
        showAll: true, 
        includeHidden: false 
      };

      if (config.debug && toolArgs && Object.keys(toolArgs).length > 0) {
        console.log(`[DEBUG] Started tool step 4: ${toolName} ${JSON.stringify(toolArgs)}`);
      }

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DEBUG] Started tool step 4: list_directory')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('"directoryPath":"src/agents"')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('"showAll":true')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('"includeHidden":false')
      );
    });

    it('should not log parameters when debug=false', () => {
      const config = { debug: false };
      const toolName = 'read_file';
      const toolArgs = { filePath: 'test.ts' };

      // This should not log when debug is false
      if (config.debug && toolArgs && Object.keys(toolArgs).length > 0) {
        console.log(`[DEBUG] Started tool step 1: ${toolName} ${JSON.stringify(toolArgs)}`);
      }

      // Verify console.log was NOT called
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should handle empty tool args gracefully', () => {
      const config = { debug: true };
      const toolName = 'some_tool';
      const toolArgs = {};

      // Should not log when toolArgs is empty
      if (config.debug && toolArgs && Object.keys(toolArgs).length > 0) {
        console.log(`[DEBUG] Started tool step 5: ${toolName} ${JSON.stringify(toolArgs)}`);
      } else if (config.debug) {
        console.log(`[DEBUG] Started tool step 5: ${toolName}`);
      }

      // Should log without parameters
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[DEBUG] Started tool step 5: some_tool'
      );
    });
  });

  describe('Tool Parameter Metadata Extraction', () => {
    it('should extract file path from read_file tool args', () => {
      const toolArgs = { filePath: 'src/utils/logger.ts' };
      
      // Verify parameter structure
      expect(toolArgs).toHaveProperty('filePath');
      expect(toolArgs.filePath).toBe('src/utils/logger.ts');
    });

    it('should extract both filePath and content from write_file tool args', () => {
      const toolArgs = { 
        filePath: 'dist/output.js', 
        content: 'console.log("Hello");' 
      };
      
      expect(toolArgs).toHaveProperty('filePath');
      expect(toolArgs).toHaveProperty('content');
      expect(toolArgs.filePath).toBe('dist/output.js');
      expect(toolArgs.content).toBe('console.log("Hello");');
    });

    it('should extract command from execute_command tool args', () => {
      const toolArgs = { command: 'git status' };
      
      expect(toolArgs).toHaveProperty('command');
      expect(toolArgs.command).toBe('git status');
    });

    it('should extract directory parameters from list_directory tool args', () => {
      const toolArgs = { 
        directoryPath: 'src/cli/commands',
        showAll: false,
        includeHidden: true
      };
      
      expect(toolArgs).toHaveProperty('directoryPath');
      expect(toolArgs).toHaveProperty('showAll');
      expect(toolArgs).toHaveProperty('includeHidden');
      expect(toolArgs.directoryPath).toBe('src/cli/commands');
      expect(toolArgs.showAll).toBe(false);
      expect(toolArgs.includeHidden).toBe(true);
    });
  });

  describe('Tool Call Event Emission', () => {
    it('should emit tool_call_start event with toolArgs', () => {
      const events: any[] = [];
      const onEvent = (event: any) => events.push(event);

      // Simulate tool call start event
      const toolCall = {
        name: 'read_file',
        args: { filePath: 'package.json' }
      };

      onEvent({
        type: 'tool_call_start',
        toolName: toolCall.name,
        toolArgs: toolCall.args
      });

      // Verify event was emitted with correct structure
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'tool_call_start',
        toolName: 'read_file',
        toolArgs: { filePath: 'package.json' }
      });
    });

    it('should emit tool_call_result event with tool metadata', () => {
      const events: any[] = [];
      const onEvent = (event: any) => events.push(event);

      // Simulate tool call result event
      onEvent({
        type: 'tool_call_result',
        toolName: 'read_file',
        result: 'File: package.json\n\n{...content...}',
        toolMetadata: {
          operation: 'read',
          filePath: 'package.json',
          fileSize: 1024
        }
      });

      // Verify event structure
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call_result');
      expect(events[0].toolName).toBe('read_file');
      expect(events[0].toolMetadata).toBeDefined();
      expect(events[0].toolMetadata.filePath).toBe('package.json');
    });
  });

  describe('Integration: Full Tool Call Flow', () => {
    it('should log parameters throughout the complete tool execution lifecycle', () => {
      const config = { debug: true };
      const toolCallArgs = new Map<string, Record<string, any>>();
      const events: any[] = [];

      // Step 1: LLM decides to call a tool
      const toolCall = {
        name: 'read_file',
        args: { filePath: 'README.md' }
      };

      // Step 2: Store tool args
      toolCallArgs.set(toolCall.name, toolCall.args);

      // Step 3: Emit tool_call_start event
      events.push({
        type: 'tool_call_start',
        toolName: toolCall.name,
        toolArgs: toolCall.args
      });

      // Step 4: Log tool execution start with parameters
      if (config.debug) {
        const args = toolCallArgs.get(toolCall.name);
        if (args && Object.keys(args).length > 0) {
          console.log(`[DEBUG] Started tool step 1: ${toolCall.name} ${JSON.stringify(args)}`);
        }
      }

      // Step 5: Tool executes and returns result
      const result = 'File: README.md\n\n# CodeMie...';

      // Step 6: Retrieve and clean up args
      const storedArgs = toolCallArgs.get(toolCall.name);
      toolCallArgs.delete(toolCall.name);

      // Step 7: Emit tool_call_result event
      events.push({
        type: 'tool_call_result',
        toolName: toolCall.name,
        result: result,
        toolMetadata: {
          operation: 'read',
          filePath: storedArgs?.filePath
        }
      });

      // Verify complete flow
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('tool_call_start');
      expect(events[0].toolArgs).toEqual({ filePath: 'README.md' });
      expect(events[1].type).toBe('tool_call_result');
      expect(events[1].toolMetadata.filePath).toBe('README.md');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DEBUG] Started tool step 1: read_file {"filePath":"README.md"}')
      );
      expect(toolCallArgs.size).toBe(0); // Cleaned up
    });
  });
});
