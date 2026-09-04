import { describe, it, expect } from 'vitest';
import { subscriptionModelsListMessage } from '../models.js';

describe('subscriptionModelsListMessage', () => {
  it('explains models come from the Anthropic subscription and how to switch in-session', () => {
    const msg = subscriptionModelsListMessage();
    expect(msg).toMatch(/Anthropic subscription/i);
    expect(msg).toMatch(/\/model/);
    expect(msg).not.toMatch(/not supported/i);
  });
});
