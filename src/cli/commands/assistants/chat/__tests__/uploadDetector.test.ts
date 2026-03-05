/**
 * Unit tests for file upload detection from Claude session JSONL
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectFileUploadsFromSession, readFilesFromPaths } from '../uploadDetector.js';
import type { ClaudeMessage } from '@/agents/plugins/claude/claude-message-types.js';
import type { Session } from '@/agents/core/session/types.js';

// Mock dependencies
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn()
}));

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}));

vi.mock('@/agents/core/session/utils/jsonl-reader.js', () => ({
  readJSONL: vi.fn()
}));

vi.mock('@/agents/core/session/session-config.js', () => ({
  getSessionPath: vi.fn()
}));

vi.mock('chalk', () => ({
  default: {
    cyan: vi.fn((str) => str),
    dim: vi.fn((str) => str),
    green: vi.fn((str) => str),
    yellow: vi.fn((str) => str),
    red: vi.fn((str) => str)
  }
}));

// Import mocked modules
import { existsSync, readFileSync, statSync } from 'fs';
import { logger } from '@/utils/logger.js';
import { readJSONL } from '@/agents/core/session/utils/jsonl-reader.js';
import { getSessionPath } from '@/agents/core/session/session-config.js';

describe('fileResolver', () => {
  const mockSessionId = 'test-session-123';
  const mockSessionPath = '/mock/path/session.json';
  const mockAgentSessionFile = '/mock/path/agent-session.jsonl';

  // Mock console to suppress output during tests
  const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionPath).mockReturnValue(mockSessionPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('detectFileUploadsFromSession', () => {
    describe('error handling', () => {
      it('should return empty array when session metadata does not exist', async () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toEqual([]);
        expect(logger.debug).toHaveBeenCalledWith(
          '[uploadDetector] Session metadata file does not exist',
          { sessionPath: mockSessionPath }
        );
      });

      it('should return empty array when session metadata is invalid JSON', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue('invalid json');

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toEqual([]);
      });

      it('should return empty array when correlation is not matched', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'pending',
            agentSessionFile: null
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toEqual([]);
      });

      it('should return empty array when agentSessionFile does not exist', async () => {
        vi.mocked(existsSync)
          .mockReturnValueOnce(true) // session metadata exists
          .mockReturnValueOnce(false); // agent session file does not exist

        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toEqual([]);
      });

      it('should return empty array on JSONL read failure', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));
        vi.mocked(readJSONL).mockRejectedValue(new Error('JSONL read failed'));

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toEqual([]);
      });

      it('should return empty array when no user messages found', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const messages: ClaudeMessage[] = [
          {
            type: 'assistant',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'assistant',
              content: 'Hello'
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toEqual([]);
      });
    });

    describe('file detection', () => {
      it('should detect single image file with base64 data', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const messages: ClaudeMessage[] = [
          // Meta message with file name
          {
            type: 'user',
            uuid: 'meta-1',
            parentUuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            isMeta: true,
            message: {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '[Image: source: /path/to/screenshot.png]'
                }
              ]
            }
          } as ClaudeMessage,
          // User message with image
          {
            type: 'user',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:01Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Look at this image'
                },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: base64Data
                  }
                }
              ]
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          fileName: 'screenshot.png',
          data: base64Data,
          mediaType: 'image/png',
          type: 'image'
        });
        expect(result[0].sizeBytes).toBeGreaterThan(0);
      });

      it('should detect multiple files in same message', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const messages: ClaudeMessage[] = [
          // Meta message with multiple file names
          {
            type: 'user',
            uuid: 'meta-1',
            parentUuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            isMeta: true,
            message: {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '[Image: source: /path/to/image1.png]\n[Document: source: /path/to/doc.pdf]'
                }
              ]
            }
          } as ClaudeMessage,
          // User message with multiple attachments
          {
            type: 'user',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:01Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'base64-image-data'
                  }
                },
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: 'base64-pdf-data'
                  }
                }
              ]
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toHaveLength(2);
        expect(result[0].fileName).toBe('image1.png');
        expect(result[0].type).toBe('image');
        expect(result[0].sizeBytes).toBeGreaterThan(0);
        expect(result[1].fileName).toBe('doc.pdf');
        expect(result[1].type).toBe('document');
        expect(result[1].sizeBytes).toBeGreaterThan(0);
      });

      it('should only check last 2 user messages', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const messages: ClaudeMessage[] = [
          // Old user message (should be ignored)
          {
            type: 'user',
            uuid: 'msg-old',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'old-image-data'
                  }
                }
              ]
            }
          } as ClaudeMessage,
          // Recent user message 1
          {
            type: 'user',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:01Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'recent-image-1'
                  }
                }
              ]
            }
          } as ClaudeMessage,
          // Recent user message 2
          {
            type: 'user',
            uuid: 'msg-2',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:02Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'recent-image-2'
                  }
                }
              ]
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toHaveLength(2);
        expect(result[0].data).toBe('recent-image-2'); // Most recent first
        expect(result[0].sizeBytes).toBeGreaterThan(0);
        expect(result[1].data).toBe('recent-image-1');
        expect(result[1].sizeBytes).toBeGreaterThan(0);
      });

      it('should generate fallback filename when meta message is missing', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const messages: ClaudeMessage[] = [
          {
            type: 'user',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/jpeg',
                    data: 'base64-data'
                  }
                }
              ]
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toHaveLength(1);
        expect(result[0].fileName).toMatch(/^attachment_0_0_\d+$/);
        expect(result[0].sizeBytes).toBeGreaterThan(0);
      });

      it('should skip files without base64 data', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const messages: ClaudeMessage[] = [
          {
            type: 'user',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    // Missing data field
                  }
                }
              ]
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalledWith(
          '[uploadDetector] Missing base64 data for file',
          expect.any(Object)
        );
      });

      it('should use default media type when not provided', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const messages: ClaudeMessage[] = [
          {
            type: 'user',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    data: 'base64-data'
                    // No media_type provided
                  }
                }
              ]
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toHaveLength(1);
        expect(result[0].mediaType).toBe('application/octet-stream');
        expect(result[0].sizeBytes).toBeGreaterThan(0);
      });

      it('should skip files exceeding size limit', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        // Create a base64 string that decodes to > 100 MB
        // We'll mock this by creating a string that's large enough
        const largeBase64 = 'A'.repeat(140 * 1024 * 1024); // ~140 MB when decoded

        const messages: ClaudeMessage[] = [
          {
            type: 'user',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: largeBase64
                  }
                }
              ]
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalledWith(
          '[uploadDetector] File exceeds size limit, skipping',
          expect.objectContaining({
            limit: 100
          })
        );
      });

      it('should skip files with empty base64 data', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const messages: ClaudeMessage[] = [
          {
            type: 'user',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: '' // Empty string
                  }
                }
              ]
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalledWith(
          '[uploadDetector] Missing base64 data for file',
          expect.any(Object)
        );
      });

      it('should handle documents as well as images', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const messages: ClaudeMessage[] = [
          {
            type: 'user',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: 'base64-pdf-data'
                  }
                }
              ]
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('document');
        expect(result[0].mediaType).toBe('application/pdf');
        expect(result[0].sizeBytes).toBeGreaterThan(0);
      });
    });

    describe('quiet mode', () => {
      it('should not log to console in quiet mode', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const messages: ClaudeMessage[] = [
          {
            type: 'user',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'base64-data'
                  }
                }
              ]
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        consoleLogSpy.mockClear();
        await detectFileUploadsFromSession(mockSessionId, { quiet: true });

        expect(consoleLogSpy).not.toHaveBeenCalled();
      });

      it('should log to console when not in quiet mode', async () => {
        // Restore console.log for this test to verify actual calls
        consoleLogSpy.mockRestore();
        const tempConsoleLogSpy = vi.spyOn(console, 'log');

        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const messages: ClaudeMessage[] = [
          {
            type: 'user',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'base64-data'
                  }
                }
              ]
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        await detectFileUploadsFromSession(mockSessionId, { quiet: false });

        expect(tempConsoleLogSpy).toHaveBeenCalled();
        tempConsoleLogSpy.mockRestore();
      });
    });

    describe('edge cases', () => {
      it('should handle user message with string content instead of array', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const messages: ClaudeMessage[] = [
          {
            type: 'user',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'user',
              content: 'Plain text message' // String instead of array
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toEqual([]);
      });

      it('should handle empty messages array', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));
        vi.mocked(readJSONL).mockResolvedValue([]);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toEqual([]);
      });

      it('should handle mixed content with no attachments', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockSession: Session = {
          id: mockSessionId,
          correlation: {
            status: 'matched',
            agentSessionFile: mockAgentSessionFile
          }
        } as Session;
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockSession));

        const messages: ClaudeMessage[] = [
          {
            type: 'user',
            uuid: 'msg-1',
            sessionId: mockSessionId,
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Just a text message'
                }
              ]
            }
          } as ClaudeMessage
        ];
        vi.mocked(readJSONL).mockResolvedValue(messages);

        const result = await detectFileUploadsFromSession(mockSessionId);

        expect(result).toEqual([]);
      });
    });
  });

  describe('readFilesFromPaths', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('successful file reading', () => {
      it('should read a single file from disk', async () => {
        const filePath = '/path/to/test.png';
        const fileContent = Buffer.from('fake-png-content');

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(statSync).mockReturnValue({
          isFile: () => true,
          size: fileContent.length
        } as any);
        vi.mocked(readFileSync).mockReturnValue(fileContent);

        const result = await readFilesFromPaths([filePath]);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          fileName: 'test.png',
          data: fileContent.toString('base64'),
          mediaType: 'image/png',
          type: 'image',
          sizeBytes: fileContent.length
        });
      });

      it('should read multiple files from disk', async () => {
        const filePaths = ['/path/to/image.jpg', '/path/to/document.pdf'];
        const imageContent = Buffer.from('fake-jpg-content');
        const pdfContent = Buffer.from('fake-pdf-content');

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(statSync)
          .mockReturnValueOnce({
            isFile: () => true,
            size: imageContent.length
          } as any)
          .mockReturnValueOnce({
            isFile: () => true,
            size: pdfContent.length
          } as any);
        vi.mocked(readFileSync)
          .mockReturnValueOnce(imageContent)
          .mockReturnValueOnce(pdfContent);

        const result = await readFilesFromPaths(filePaths);

        expect(result).toHaveLength(2);
        expect(result[0].fileName).toBe('image.jpg');
        expect(result[0].mediaType).toBe('image/jpeg');
        expect(result[0].type).toBe('image');
        expect(result[1].fileName).toBe('document.pdf');
        expect(result[1].mediaType).toBe('application/pdf');
        expect(result[1].type).toBe('document');
      });

      it('should detect MIME types correctly', async () => {
        const testCases = [
          { path: '/test/file.py', expectedMime: 'application/octet-stream', expectedType: 'document' }, // mime-types doesn't have .py
          { path: '/test/file.js', expectedMime: 'text/javascript', expectedType: 'document' },
          { path: '/test/file.json', expectedMime: 'application/json', expectedType: 'document' },
          { path: '/test/file.png', expectedMime: 'image/png', expectedType: 'image' },
          { path: '/test/file.jpg', expectedMime: 'image/jpeg', expectedType: 'image' },
          { path: '/test/file.pdf', expectedMime: 'application/pdf', expectedType: 'document' }
        ];

        for (const testCase of testCases) {
          const fileContent = Buffer.from('test-content');

          vi.mocked(existsSync).mockReturnValue(true);
          vi.mocked(statSync).mockReturnValue({
            isFile: () => true,
            size: fileContent.length
          } as any);
          vi.mocked(readFileSync).mockReturnValue(fileContent);

          const result = await readFilesFromPaths([testCase.path]);

          expect(result).toHaveLength(1);
          expect(result[0].mediaType).toBe(testCase.expectedMime);
          expect(result[0].type).toBe(testCase.expectedType);
        }
      });

      it('should use default MIME type for unknown extensions', async () => {
        const filePath = '/path/to/file.unknown';
        const fileContent = Buffer.from('unknown-content');

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(statSync).mockReturnValue({
          isFile: () => true,
          size: fileContent.length
        } as any);
        vi.mocked(readFileSync).mockReturnValue(fileContent);

        const result = await readFilesFromPaths([filePath]);

        expect(result).toHaveLength(1);
        expect(result[0].mediaType).toBe('application/octet-stream');
        expect(result[0].type).toBe('document');
      });

      it('should handle relative paths', async () => {
        const filePath = './test.png';
        const fileContent = Buffer.from('content');

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(statSync).mockReturnValue({
          isFile: () => true,
          size: fileContent.length
        } as any);
        vi.mocked(readFileSync).mockReturnValue(fileContent);

        const result = await readFilesFromPaths([filePath]);

        expect(result).toHaveLength(1);
        expect(result[0].fileName).toBe('test.png');
      });
    });

    describe('error handling', () => {
      it('should return empty array for empty file paths', async () => {
        const result = await readFilesFromPaths([]);

        expect(result).toEqual([]);
        expect(existsSync).not.toHaveBeenCalled();
      });

      it('should skip files that do not exist', async () => {
        const filePath = '/path/to/nonexistent.png';

        vi.mocked(existsSync).mockReturnValue(false);

        const result = await readFilesFromPaths([filePath]);

        expect(result).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith(
          '[uploadDetector] File does not exist',
          expect.objectContaining({ filePath: expect.stringContaining('nonexistent.png') })
        );
      });

      it('should skip directories', async () => {
        const dirPath = '/path/to/directory';

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(statSync).mockReturnValue({
          isFile: () => false
        } as any);

        const result = await readFilesFromPaths([dirPath]);

        expect(result).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith(
          '[uploadDetector] Path is not a file',
          expect.objectContaining({ filePath: expect.stringContaining('directory') })
        );
      });

      it('should skip files exceeding size limit (100MB)', async () => {
        const filePath = '/path/to/large-file.bin';
        const largeSize = 101 * 1024 * 1024; // 101 MB

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(statSync).mockReturnValue({
          isFile: () => true,
          size: largeSize
        } as any);

        const result = await readFilesFromPaths([filePath]);

        expect(result).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith(
          '[uploadDetector] File exceeds size limit',
          expect.objectContaining({
            limit: 100
          })
        );
      });

      it('should handle read errors gracefully', async () => {
        const filePath = '/path/to/error.txt';

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(statSync).mockReturnValue({
          isFile: () => true,
          size: 100
        } as any);
        vi.mocked(readFileSync).mockImplementation(() => {
          throw new Error('Permission denied');
        });

        const result = await readFilesFromPaths([filePath]);

        expect(result).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith(
          '[uploadDetector] Failed to read file',
          expect.objectContaining({ filePath })
        );
      });

      it('should continue with valid files when some fail', async () => {
        const filePaths = [
          '/path/to/valid.png',
          '/path/to/nonexistent.jpg',
          '/path/to/another-valid.pdf'
        ];
        const validContent = Buffer.from('valid-content');

        vi.mocked(existsSync)
          .mockReturnValueOnce(true)  // valid.png exists
          .mockReturnValueOnce(false) // nonexistent.jpg doesn't exist
          .mockReturnValueOnce(true); // another-valid.pdf exists

        vi.mocked(statSync)
          .mockReturnValueOnce({
            isFile: () => true,
            size: validContent.length
          } as any)
          .mockReturnValueOnce({
            isFile: () => true,
            size: validContent.length
          } as any);

        vi.mocked(readFileSync)
          .mockReturnValueOnce(validContent)
          .mockReturnValueOnce(validContent);

        const result = await readFilesFromPaths(filePaths);

        expect(result).toHaveLength(2);
        expect(result[0].fileName).toBe('valid.png');
        expect(result[1].fileName).toBe('another-valid.pdf');
      });
    });

    describe('quiet mode', () => {
      it('should not log to console in quiet mode', async () => {
        const filePath = '/path/to/test.png';
        const fileContent = Buffer.from('content');

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(statSync).mockReturnValue({
          isFile: () => true,
          size: fileContent.length
        } as any);
        vi.mocked(readFileSync).mockReturnValue(fileContent);

        consoleLogSpy.mockClear();
        await readFilesFromPaths([filePath], { quiet: true });

        expect(consoleLogSpy).not.toHaveBeenCalled();
      });

      it('should log to console when not in quiet mode', async () => {
        consoleLogSpy.mockRestore();
        const tempConsoleLogSpy = vi.spyOn(console, 'log');

        const filePath = '/path/to/test.png';
        const fileContent = Buffer.from('content');

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(statSync).mockReturnValue({
          isFile: () => true,
          size: fileContent.length
        } as any);
        vi.mocked(readFileSync).mockReturnValue(fileContent);

        await readFilesFromPaths([filePath], { quiet: false });

        expect(tempConsoleLogSpy).toHaveBeenCalled();
        tempConsoleLogSpy.mockRestore();
      });
    });

    describe('edge cases', () => {
      it('should handle files with no extension', async () => {
        const filePath = '/path/to/README';
        const fileContent = Buffer.from('readme content');

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(statSync).mockReturnValue({
          isFile: () => true,
          size: fileContent.length
        } as any);
        vi.mocked(readFileSync).mockReturnValue(fileContent);

        const result = await readFilesFromPaths([filePath]);

        expect(result).toHaveLength(1);
        expect(result[0].fileName).toBe('README');
        expect(result[0].mediaType).toBe('application/octet-stream');
      });

      it('should handle files with multiple dots in name', async () => {
        const filePath = '/path/to/my.backup.tar.gz';
        const fileContent = Buffer.from('tar content');

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(statSync).mockReturnValue({
          isFile: () => true,
          size: fileContent.length
        } as any);
        vi.mocked(readFileSync).mockReturnValue(fileContent);

        const result = await readFilesFromPaths([filePath]);

        expect(result).toHaveLength(1);
        expect(result[0].fileName).toBe('my.backup.tar.gz');
        expect(result[0].mediaType).toBe('application/gzip');
      });

      it('should handle zero-byte files', async () => {
        const filePath = '/path/to/empty.txt';
        const fileContent = Buffer.from('');

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(statSync).mockReturnValue({
          isFile: () => true,
          size: 0
        } as any);
        vi.mocked(readFileSync).mockReturnValue(fileContent);

        const result = await readFilesFromPaths([filePath]);

        expect(result).toHaveLength(1);
        expect(result[0].sizeBytes).toBe(0);
        expect(result[0].data).toBe('');
      });
    });
  });
});
