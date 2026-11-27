import { describe, it, expect } from 'vitest';
import { getMcpAuthTimings } from '../constants.js';
import { useTempCodemieHome } from './helpers/temp-home.js';

const MAX_TIMER_MS = 2 ** 31 - 1;

describe('getMcpAuthTimings', () => {
  useTempCodemieHome();

  it('defaults to 300 s when the env var is unset', () => {
    delete process.env.MCP_PROXY_AUTH_TIMEOUT_SECONDS;
    expect(getMcpAuthTimings()).toEqual({
      callbackTimeoutMs: 300000,
      lockMaxWaitMs: 225000,
      lockStaleMs: 375000,
    });
  });

  it.each([
    ['10', { callbackTimeoutMs: 10000, lockMaxWaitMs: 7500, lockStaleMs: 12500 }],
    ['3600', { callbackTimeoutMs: 3600000, lockMaxWaitMs: 2700000, lockStaleMs: 4500000 }],
    [' 60 ', { callbackTimeoutMs: 60000, lockMaxWaitMs: 45000, lockStaleMs: 75000 }],
  ])('accepts %j', (value, expected) => {
    process.env.MCP_PROXY_AUTH_TIMEOUT_SECONDS = value;
    const timings = getMcpAuthTimings();
    expect(timings).toEqual(expected);
    expect(timings.lockMaxWaitMs).toBeLessThan(timings.callbackTimeoutMs);
    expect(timings.callbackTimeoutMs).toBeLessThan(timings.lockStaleMs);
    expect(timings.lockStaleMs).toBeLessThanOrEqual(MAX_TIMER_MS);
  });

  it.each([
    '0', '9', '3601', '-1', '1.5', 'abc', '', 'Infinity', '99999999999',
    '1e3', '0x20', '+60',
  ])('falls back to 300 s for %j', (value) => {
    process.env.MCP_PROXY_AUTH_TIMEOUT_SECONDS = value;
    expect(getMcpAuthTimings()).toEqual({
      callbackTimeoutMs: 300000,
      lockMaxWaitMs: 225000,
      lockStaleMs: 375000,
    });
  });
});
