import type { DetectedFile, UploadsDetector } from './types.js';

export class GeminiUploadsDetector implements UploadsDetector {
  async detectFromSession(
    _conversationId: string,
    _options?: { quiet?: boolean }
  ): Promise<DetectedFile[]> {
    // Gemini session files contain plain-string message content with no embedded
    // base64 file blobs. Attachments reach the assistant exclusively via --file.
    return [];
  }
}
