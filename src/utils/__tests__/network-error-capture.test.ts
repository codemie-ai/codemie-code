import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { logger } from '@/utils/logger.js';
import {
  installNetworkErrorCapture,
  takeNetworkError,
  clearNetworkError,
} from '@/utils/network-error-capture.js';

const originalAdapter = axios.defaults.adapter;
const cfg = { url: '/x', headers: {} } as unknown as InternalAxiosRequestConfig;

function networkError(code: string): Error {
  return Object.assign(new Error('boom'), { code });
}

beforeEach(() => {
  clearNetworkError();
  vi.mocked(logger.debug).mockClear();
});
afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
});

describe('installNetworkErrorCapture', () => {
  it('resolves the default adapter names to a function', () => {
    expect(typeof axios.getAdapter(axios.defaults.adapter)).toBe('function');
  });

  it('wraps the adapter, records a response-less rejection and rethrows', async () => {
    const real = vi.fn().mockRejectedValue(networkError('ERR_FR_TOO_MANY_REDIRECTS'));
    vi.spyOn(axios, 'getAdapter').mockReturnValue(real as unknown as AxiosAdapter);

    installNetworkErrorCapture();
    const adapter = axios.defaults.adapter as AxiosAdapter;
    expect(typeof adapter).toBe('function');
    expect(adapter).not.toBe(originalAdapter);
    await expect(adapter(cfg)).rejects.toThrow('boom');
    expect(real).toHaveBeenCalledWith(cfg);
    expect(takeNetworkError()?.code).toBe('ERR_FR_TOO_MANY_REDIRECTS');
  });

  it('wraps only once when installed twice', () => {
    const getAdapter = vi.spyOn(axios, 'getAdapter');

    installNetworkErrorCapture();
    const first = axios.defaults.adapter;
    expect(first).not.toBe(originalAdapter);
    expect(getAdapter).toHaveBeenCalledTimes(1);

    installNetworkErrorCapture();
    expect(axios.defaults.adapter).toBe(first);
    expect(getAdapter).toHaveBeenCalledTimes(1);
  });

  it('applies to instances created after install and not before', () => {
    const before = axios.create();
    installNetworkErrorCapture();
    const after = axios.create();
    expect(after.defaults.adapter).toBe(axios.defaults.adapter);
    expect(before.defaults.adapter).not.toBe(axios.defaults.adapter);
  });

  it('resolves the same axios file from the repo and from codemie-sdk', () => {
    const fromRepo = createRequire(import.meta.url).resolve('axios');
    const sdkDir = createRequire(import.meta.url).resolve('codemie-sdk');
    expect(createRequire(sdkDir).resolve('axios')).toBe(fromRepo);
  });

  it('logs at debug level and leaves the adapter untouched when it cannot install', () => {
    vi.spyOn(axios, 'getAdapter').mockImplementation(() => {
      throw new Error('no adapter');
    });
    expect(() => installNetworkErrorCapture()).not.toThrow();
    expect(axios.defaults.adapter).toBe(originalAdapter);
    expect(logger.debug).toHaveBeenCalledWith(
      'Network error capture not installed',
      expect.anything(),
    );
    expect(takeNetworkError()).toBeUndefined();
  });
});

describe('stale capture handling', () => {
  it('clears an unread capture when the next request starts', async () => {
    const real = vi.fn()
      .mockRejectedValueOnce(networkError('ECONNRESET'))
      .mockResolvedValueOnce({ status: 500, data: '' });
    vi.spyOn(axios, 'getAdapter').mockReturnValue(real as unknown as AxiosAdapter);
    installNetworkErrorCapture();
    const adapter = axios.defaults.adapter as AxiosAdapter;

    await expect(adapter(cfg)).rejects.toThrow();
    await adapter(cfg);
    expect(takeNetworkError()).toBeUndefined();
  });

  it('logs the captured error at debug level without the URL', async () => {
    const err = Object.assign(new Error('failed https://host/secret?token=abc'), { code: 'ECONNRESET' });
    vi.spyOn(axios, 'getAdapter').mockReturnValue(vi.fn().mockRejectedValue(err) as unknown as AxiosAdapter);
    installNetworkErrorCapture();
    await expect((axios.defaults.adapter as AxiosAdapter)(cfg)).rejects.toThrow();
    const logged = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toContain('https://host');
    expect(logged).not.toContain('abc');
  });
});
