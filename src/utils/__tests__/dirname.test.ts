import { describe, it, expect } from 'vitest';
import { getDirname } from '../dirname.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { pathToFileURL } from 'url';
import { platform } from 'os';

describe('getDirname', () => {
  it('should return the directory path from import.meta.url', () => {
    // Use a real path that works on the current platform
    const testPath = platform() === 'win32'
      ? 'C:\\Users\\test\\project\\src\\utils\\module.js'
      : '/Users/test/project/src/utils/module.js';
    const mockUrl = pathToFileURL(testPath).href;

    // Expected result: directory of the mock URL
    const expected = dirname(fileURLToPath(mockUrl));

    // Test the function
    const result = getDirname(mockUrl);

    // Assert the result matches expected
    expect(result).toBe(expected);
  });

  it('should handle different file paths correctly', () => {
    const testPath = platform() === 'win32'
      ? 'C:\\home\\user\\app\\index.js'
      : '/home/user/app/index.js';
    const mockUrl = pathToFileURL(testPath).href;
    const expected = dirname(fileURLToPath(mockUrl));
    const result = getDirname(mockUrl);

    expect(result).toBe(expected);
  });

  it('should return a string', () => {
    const testPath = platform() === 'win32'
      ? 'C:\\test\\path\\file.js'
      : '/test/path/file.js';
    const mockUrl = pathToFileURL(testPath).href;
    const result = getDirname(mockUrl);

    expect(typeof result).toBe('string');
  });
});
