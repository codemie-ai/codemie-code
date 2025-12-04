import { describe, it, expect } from 'vitest';
import { getDirname } from '../dirname.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

describe('getDirname', () => {
  it('should return the directory path from import.meta.url', () => {
    // Create a mock URL for testing
    const mockUrl = 'file:///Users/test/project/src/utils/module.js';
    
    // Expected result: directory of the mock URL
    const expected = dirname(fileURLToPath(mockUrl));
    
    // Test the function
    const result = getDirname(mockUrl);
    
    // Assert the result matches expected
    expect(result).toBe(expected);
  });

  it('should handle different file paths correctly', () => {
    const mockUrl = 'file:///home/user/app/index.js';
    const expected = dirname(fileURLToPath(mockUrl));
    const result = getDirname(mockUrl);
    
    expect(result).toBe(expected);
  });

  it('should return a string', () => {
    const mockUrl = 'file:///test/path/file.js';
    const result = getDirname(mockUrl);
    
    expect(typeof result).toBe('string');
  });
});
