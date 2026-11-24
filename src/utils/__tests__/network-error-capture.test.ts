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

    expect(installNetworkErrorCapture()).toBe(true);
    const adapter = axios.defaults.adapter as AxiosAdapter;
    expect(typeof adapter).toBe('function');
    await expect(adapter(cfg)).rejects.toThrow('boom');
    expect(real).toHaveBeenCalledWith(cfg);
    expect(takeNetworkError()?.code).toBe('ERR_FR_TOO_MANY_REDIRECTS');
  });

  it('wraps only once when installed twice', () => {
    expect(installNetworkErrorCapture()).toBe(true);
    const first = axios.defaults.adapter;
    expect(installNetworkErrorCapture()).toBe(true);
    expect(axios.defaults.adapter).toBe(first);
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

  it('returns false, logs and leaves output unchanged when it cannot install', () => {
    vi.spyOn(axios, 'getAdapter').mockImplementation(() => {
      throw new Error('no adapter');
    });
    expect(installNetworkErrorCapture()).toBe(false);
    expect(logger.debug).toHaveBeenCalled();
    expect(takeNetworkError()).toBeUndefined();
  });
});
