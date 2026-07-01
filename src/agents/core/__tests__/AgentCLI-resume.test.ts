import { describe, it, expect } from 'vitest';
import { buildResumeEnvOverride } from '../AgentCLI.js';

describe('buildResumeEnvOverride', () => {
  it('returns CODEMIE_CONV_SYNC_DISABLED=1 for an external confirmed resume', () => {
    const env = buildResumeEnvOverride(true);
    expect(env).toEqual({ CODEMIE_CONV_SYNC_DISABLED: '1' });
  });

  it('returns empty object for a CodeMie-owned session', () => {
    const env = buildResumeEnvOverride(false);
    expect(env).toEqual({});
  });
});
