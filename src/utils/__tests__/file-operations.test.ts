/**
 * File Operations Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import { extractFormat, detectLanguage, countContentLines } from '../file-operations.js';

describe('file-operations utilities', () => {
  describe('extractFormat', () => {
    it('should extract file extension', () => {
      expect(extractFormat('/path/to/file.ts')).toBe('ts');
      expect(extractFormat('/path/to/file.py')).toBe('py');
      expect(extractFormat('/path/to/file.json')).toBe('json');
      expect(extractFormat('file.js')).toBe('js');
    });

    it('should handle files without extension', () => {
      expect(extractFormat('/path/to/file')).toBeUndefined();
      expect(extractFormat('README')).toBeUndefined();
    });

    it('should handle files ending with dot', () => {
      expect(extractFormat('/path/to/file.')).toBeUndefined();
    });

    it('should handle multiple dots', () => {
      expect(extractFormat('/path/to/file.test.ts')).toBe('ts');
      expect(extractFormat('config.prod.json')).toBe('json');
    });

    it('should handle hidden files', () => {
      expect(extractFormat('/path/.gitignore')).toBe('gitignore');
      expect(extractFormat('.eslintrc')).toBe('eslintrc');
    });
  });

  describe('detectLanguage', () => {
    it('should detect TypeScript', () => {
      expect(detectLanguage('/path/to/file.ts')).toBe('typescript');
      expect(detectLanguage('/path/to/component.tsx')).toBe('typescript');
    });

    it('should detect JavaScript', () => {
      expect(detectLanguage('/path/to/file.js')).toBe('javascript');
      expect(detectLanguage('/path/to/component.jsx')).toBe('javascript');
    });

    it('should detect Python', () => {
      expect(detectLanguage('/path/to/script.py')).toBe('python');
    });

    it('should detect various languages', () => {
      expect(detectLanguage('Main.java')).toBe('java');
      expect(detectLanguage('main.go')).toBe('go');
      expect(detectLanguage('lib.rs')).toBe('rust');
      expect(detectLanguage('app.rb')).toBe('ruby');
      expect(detectLanguage('index.php')).toBe('php');
      expect(detectLanguage('App.swift')).toBe('swift');
      expect(detectLanguage('Main.kt')).toBe('kotlin');
    });

    it('should detect markup and data formats', () => {
      expect(detectLanguage('README.md')).toBe('markdown');
      expect(detectLanguage('config.json')).toBe('json');
      expect(detectLanguage('config.yaml')).toBe('yaml');
      expect(detectLanguage('docker-compose.yml')).toBe('yaml');
    });

    it('should detect C/C++', () => {
      expect(detectLanguage('main.c')).toBe('c');
      expect(detectLanguage('main.cpp')).toBe('cpp');
    });

    it('should handle case insensitivity', () => {
      expect(detectLanguage('FILE.TS')).toBe('typescript');
      expect(detectLanguage('FILE.JS')).toBe('javascript');
    });

    it('should return undefined for unknown extensions', () => {
      expect(detectLanguage('file.xyz')).toBeUndefined();
      expect(detectLanguage('file.unknown')).toBeUndefined();
    });

    it('should return undefined for files without extension', () => {
      expect(detectLanguage('README')).toBeUndefined();
      expect(detectLanguage('/path/to/file')).toBeUndefined();
    });
  });

  describe('countContentLines', () => {
    it('counts lines with no trailing newline', () => {
      expect(countContentLines('a\nb\nc')).toBe(3);
    });

    it('does not count a trailing newline as an extra line', () => {
      expect(countContentLines('a\nb\nc\n')).toBe(3);
    });

    it('returns 0 for empty content', () => {
      expect(countContentLines('')).toBe(0);
    });

    it('counts a single line with no newline as 1', () => {
      expect(countContentLines('a')).toBe(1);
    });

    it('counts content that is only a newline as 1 (one blank line)', () => {
      expect(countContentLines('\n')).toBe(1);
    });

    it('counts a blank line in the middle', () => {
      expect(countContentLines('a\n\nb')).toBe(3);
    });

    it('treats a CRLF-terminated file the same as an LF-terminated one', () => {
      expect(countContentLines('a\r\nb\r\nc\r\n')).toBe(3);
      expect(countContentLines('a\r\nb\r\nc')).toBe(3);
    });
  });
});
