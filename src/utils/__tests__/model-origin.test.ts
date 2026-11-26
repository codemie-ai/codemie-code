import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeModel,
  isFromDotenv,
  parseModelEnvOrigin,
  recordDotenvValues,
  recordSavedModelPick,
  resetModelOriginRecords,
  resolveModelEnvOrigin,
} from '../model-origin.js';

describe('describeModel', () => {
  it('marks a shell override with the profile model it replaced', () => {
    expect(describeModel('claude-opus-4-8[1m]', 'shell', 'claude-sonnet-5')).toBe(
      'claude-opus-4-8[1m] (CODEMIE_MODEL from shell env overrides profile: claude-sonnet-5)'
    );
  });

  it('marks a .env override', () => {
    expect(describeModel('claude-opus-4-8[1m]', 'dotenv', 'claude-sonnet-5')).toBe(
      'claude-opus-4-8[1m] (CODEMIE_MODEL from .env overrides profile: claude-sonnet-5)'
    );
  });

  it('marks a Copilot saved pick without naming CODEMIE_MODEL', () => {
    expect(describeModel('claude-opus-4-8[1m]', 'saved', 'claude-sonnet-5')).toBe(
      'claude-opus-4-8[1m] (your saved codemie-copilot --model pick, overrides profile: claude-sonnet-5)'
    );
  });

  it('shows N/A for an empty profile model', () => {
    expect(describeModel('gpt-5', 'shell', undefined)).toBe('gpt-5 (CODEMIE_MODEL from shell env overrides profile: N/A)');
    expect(describeModel('gpt-5', 'shell', '')).toBe('gpt-5 (CODEMIE_MODEL from shell env overrides profile: N/A)');
  });

  it('returns the plain model without an origin', () => {
    expect(describeModel('gpt-5', undefined, 'claude-sonnet-5')).toBe('gpt-5');
  });

  it('returns the plain model when it equals the profile model', () => {
    expect(describeModel('gpt-5', 'dotenv', 'gpt-5')).toBe('gpt-5');
  });

  it('strips control characters from the model and the profile model', () => {
    expect(describeModel('gpt\u001b[31m-5\n', 'shell', 'son\u0007net')).toBe(
      'gpt[31m-5 (CODEMIE_MODEL from shell env overrides profile: sonnet)'
    );
    expect(describeModel('gpt\u001b-5', undefined, undefined)).toBe('gpt-5');
  });
});

describe('parseModelEnvOrigin', () => {
  it('accepts the three origins and rejects anything else', () => {
    expect(parseModelEnvOrigin('shell')).toBe('shell');
    expect(parseModelEnvOrigin('dotenv')).toBe('dotenv');
    expect(parseModelEnvOrigin('saved')).toBe('saved');
    expect(parseModelEnvOrigin('')).toBeUndefined();
    expect(parseModelEnvOrigin('env')).toBeUndefined();
    expect(parseModelEnvOrigin(undefined)).toBeUndefined();
  });
});

describe('resolveModelEnvOrigin', () => {
  beforeEach(() => {
    resetModelOriginRecords();
  });

  afterEach(() => {
    resetModelOriginRecords();
  });

  it('is undefined when CODEMIE_MODEL is missing or empty', () => {
    expect(resolveModelEnvOrigin({})).toBeUndefined();
    expect(resolveModelEnvOrigin({ CODEMIE_MODEL: '' })).toBeUndefined();
  });

  it('is shell for an unrecorded value', () => {
    expect(resolveModelEnvOrigin({ CODEMIE_MODEL: 'gpt-5' })).toBe('shell');
  });

  it('is dotenv while CODEMIE_MODEL still holds the value .env added', () => {
    recordDotenvValues({ CODEMIE_MODEL: 'gpt-5' });
    const env: NodeJS.ProcessEnv = { CODEMIE_MODEL: 'gpt-5' };
    expect(isFromDotenv('CODEMIE_MODEL', env)).toBe(true);
    expect(resolveModelEnvOrigin(env)).toBe('dotenv');
  });

  it('is shell once CODEMIE_MODEL was changed after .env was loaded', () => {
    recordDotenvValues({ CODEMIE_MODEL: 'gpt-5' });
    const env: NodeJS.ProcessEnv = { CODEMIE_MODEL: 'gpt-6' };
    expect(isFromDotenv('CODEMIE_MODEL', env)).toBe(false);
    expect(resolveModelEnvOrigin(env)).toBe('shell');
  });

  it('is saved while CODEMIE_MODEL holds the recorded Copilot pick', () => {
    recordSavedModelPick('claude-opus-4-8');
    expect(resolveModelEnvOrigin({ CODEMIE_MODEL: 'claude-opus-4-8' })).toBe('saved');
    expect(resolveModelEnvOrigin({ CODEMIE_MODEL: 'gpt-5' })).toBe('shell');
  });

  it('reads process.env by default', () => {
    const saved = process.env.CODEMIE_MODEL;
    try {
      process.env.CODEMIE_MODEL = 'gpt-5';
      recordDotenvValues({ CODEMIE_MODEL: 'gpt-5' });
      expect(isFromDotenv('CODEMIE_MODEL')).toBe(true);
      expect(resolveModelEnvOrigin()).toBe('dotenv');
    } finally {
      if (saved === undefined) delete process.env.CODEMIE_MODEL;
      else process.env.CODEMIE_MODEL = saved;
    }
  });

  describe('.env key case', () => {
    const originalPlatform = process.platform;
    const setPlatform = (platform: NodeJS.Platform): void => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    };

    afterEach(() => {
      setPlatform(originalPlatform);
    });

    it('matches a lowercase .env key on Windows, where env names are case-insensitive', () => {
      setPlatform('win32');
      recordDotenvValues({ codemie_model: 'gpt-5' });
      const env: NodeJS.ProcessEnv = { CODEMIE_MODEL: 'gpt-5' };

      expect(isFromDotenv('CODEMIE_MODEL', env)).toBe(true);
      expect(resolveModelEnvOrigin(env)).toBe('dotenv');
    });

    it('keeps keys case-sensitive elsewhere', () => {
      setPlatform('linux');
      recordDotenvValues({ codemie_model: 'gpt-5' });

      expect(isFromDotenv('CODEMIE_MODEL', { CODEMIE_MODEL: 'gpt-5' })).toBe(false);
    });
  });

  it('forgets every record on reset', () => {
    recordDotenvValues({ CODEMIE_MODEL: 'gpt-5' });
    recordSavedModelPick('gpt-6');
    resetModelOriginRecords();
    expect(resolveModelEnvOrigin({ CODEMIE_MODEL: 'gpt-5' })).toBe('shell');
    expect(resolveModelEnvOrigin({ CODEMIE_MODEL: 'gpt-6' })).toBe('shell');
  });
});
