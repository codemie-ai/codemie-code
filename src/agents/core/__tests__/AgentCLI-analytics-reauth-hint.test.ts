import { describe, it, expect } from 'vitest';
import { analyticsReauthHintLines } from '../AgentCLI.js';

describe('analyticsReauthHintLines', () => {
  const URL_ = 'https://codemie.example.com';

  it('names the headless login route for the configured URL', () => {
    const lines = analyticsReauthHintLines(URL_);
    expect(lines).toContain(`  No browser on this machine? Run: codemie profile login --no-browser --url ${URL_}`);
  });

  it('keeps the browser re-auth route for the same URL', () => {
    const lines = analyticsReauthHintLines(URL_);
    expect(lines).toContain(`  Re-authenticate later with: codemie profile login --url ${URL_}`);
  });
});
