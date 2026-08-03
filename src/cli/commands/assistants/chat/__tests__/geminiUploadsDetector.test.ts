import { describe, it, expect } from 'vitest';
import { GeminiUploadsDetector } from '../geminiUploadsDetector.js';
import type { UploadsDetector } from '../types.js';

describe('GeminiUploadsDetector', () => {
  it('returns empty array from detectFromSession', async () => {
    const detector = new GeminiUploadsDetector();
    const result = await detector.detectFromSession('session-abc');
    expect(result).toEqual([]);
  });

  it('returns empty array when quiet option is set', async () => {
    const detector = new GeminiUploadsDetector();
    const result = await detector.detectFromSession('session-abc', { quiet: true });
    expect(result).toEqual([]);
  });

  it('satisfies the UploadsDetector interface', () => {
    const detector: UploadsDetector = new GeminiUploadsDetector();
    expect(typeof detector.detectFromSession).toBe('function');
  });
});
