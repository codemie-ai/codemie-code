/**
 * File Operations Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import { extractFormat, detectLanguage } from '../file-operations.js';

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
});
