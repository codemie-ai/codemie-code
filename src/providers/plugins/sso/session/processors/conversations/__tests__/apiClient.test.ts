import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createApiClient } from '../apiClient.js';

const fetchMock = vi.fn();

function refused(): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

function failingBodyResponse() {
  return { ok: false, status: 500, statusText: 'Internal Server Error', text: () => Promise.reject(new Error('socket hang up')) };
}

describe('ConversationApiClient request timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('upsertConversation', () => {
    it('leaves no timer pending when every attempt is refused', async () => {
      fetchMock.mockRejectedValue(refused());
      const client = createApiClient({ baseUrl: 'http://127.0.0.1:1' });

      const result = client.upsertConversation('conv-1', []);
      // Two retry back-offs (1 s, 2 s) between the three attempts.
      await vi.advanceTimersByTimeAsync(3_000);

      expect(await result).toEqual({ success: false, message: 'Sync failed: fetch failed' });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no timer pending when the response body read fails', async () => {
      fetchMock.mockResolvedValue(failingBodyResponse());
      const client = createApiClient({ baseUrl: 'http://127.0.0.1:1', retryAttempts: 1 });

      const result = await client.upsertConversation('conv-1', []);

      expect(result).toEqual({ success: false, message: 'Sync failed: socket hang up' });
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('upsertConversation responses', () => {
    it('returns the parsed API error after one attempt on a non-retryable status', async () => {
      const forbidden = {
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: () => Promise.resolve('{"error":{"message":"Project access denied","details":"user is not a member"}}'),
      };
      // A retry would get the ok response below.
      fetchMock
        .mockResolvedValueOnce(forbidden)
        .mockResolvedValue(okResponse({ conversation_id: 'conv-1', new_messages: 1, total_messages: 1, created: true }));
      const client = createApiClient({ baseUrl: 'http://127.0.0.1:1' });

      const result = client.upsertConversation('conv-1', []);
      await vi.advanceTimersByTimeAsync(3_000);

      expect(await result).toEqual({
        success: false,
        message: 'API error: 403 Project access denied (user is not a member)',
      });
    });

    it('maps a successful upsert body to the result', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ conversation_id: 'conv-42', new_messages: 3, total_messages: 7, created: false })
      );
      const client = createApiClient({ baseUrl: 'http://127.0.0.1:1', retryAttempts: 1 });

      const result = await client.upsertConversation('conv-42', []);

      expect(result).toEqual({
        success: true,
        message: 'Conversation synced successfully',
        conversation_id: 'conv-42',
        new_messages: 3,
        total_messages: 7,
        created: false,
      });
    });
  });

  describe('updateConversationMetadata (after a synced history)', () => {
    const synced = { conversation_id: 'conv-1', new_messages: 1, total_messages: 1, created: true };

    it('leaves no timer pending when the metadata request is refused', async () => {
      fetchMock.mockResolvedValueOnce(okResponse(synced)).mockRejectedValueOnce(refused());
      const client = createApiClient({ baseUrl: 'http://127.0.0.1:1', retryAttempts: 1 });

      const result = await client.upsertConversation('conv-1', [], undefined, undefined, 'gpt-x');

      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:1/v1/conversations/conv-1');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no timer pending when the metadata response body read fails', async () => {
      fetchMock.mockResolvedValueOnce(okResponse(synced)).mockResolvedValueOnce(failingBodyResponse());
      const client = createApiClient({ baseUrl: 'http://127.0.0.1:1', retryAttempts: 1 });

      const result = await client.upsertConversation('conv-1', [], undefined, undefined, 'gpt-x');

      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:1/v1/conversations/conv-1');
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
