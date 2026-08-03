import { vi, describe, it, expect, beforeEach } from 'vitest';

const { mockLoadSession } = vi.hoisted(() => ({
  mockLoadSession: vi.fn()
}));

vi.mock('@/agents/core/session/SessionStore.js', () => ({
  SessionStore: vi.fn().mockImplementation(function() {
    return { loadSession: mockLoadSession };
  })
}));

import { createUploadsDetector } from '../uploadsDetector.factory.js';
import { ClaudeUploadsDetector } from '../claudeUploadsDetector.js';
import { GeminiUploadsDetector } from '../geminiUploadsDetector.js';

describe('createUploadsDetector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns GeminiUploadsDetector when session agentName is gemini', async () => {
    mockLoadSession.mockResolvedValue({ agentName: 'gemini' });
    const detector = await createUploadsDetector('session-123');
    expect(detector).toBeInstanceOf(GeminiUploadsDetector);
  });

  it('returns ClaudeUploadsDetector when session agentName is claude', async () => {
    mockLoadSession.mockResolvedValue({ agentName: 'claude' });
    const detector = await createUploadsDetector('session-123');
    expect(detector).toBeInstanceOf(ClaudeUploadsDetector);
  });

  it('returns ClaudeUploadsDetector when conversationId is undefined', async () => {
    const detector = await createUploadsDetector(undefined);
    expect(detector).toBeInstanceOf(ClaudeUploadsDetector);
    expect(mockLoadSession).not.toHaveBeenCalled();
  });

  it('returns ClaudeUploadsDetector when loadSession throws', async () => {
    mockLoadSession.mockRejectedValue(new Error('session not found'));
    const detector = await createUploadsDetector('session-404');
    expect(detector).toBeInstanceOf(ClaudeUploadsDetector);
  });

  it('returns ClaudeUploadsDetector when loadSession returns null', async () => {
    mockLoadSession.mockResolvedValue(null);
    const detector = await createUploadsDetector('session-no-file');
    expect(detector).toBeInstanceOf(ClaudeUploadsDetector);
  });
});
