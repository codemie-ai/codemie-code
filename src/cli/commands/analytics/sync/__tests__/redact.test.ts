import { describe, expect, it } from 'vitest';

import { errorMessage, redactSecrets } from '../redact.js';
import {
  CodeMieError,
  ExportTooLargeError,
  SyncConfigError,
  SyncDeliveryError,
  SyncIdentityMissingError,
  SyncTargetMissingError
} from '@/utils/errors.js';

describe('redactSecrets', () => {
  it('replaces the sig query value and keeps other query values intact', () => {
    const input = 'https://example.invalid/x?a=1&sig=FAKESIG&b=2';

    const result = redactSecrets(input);

    expect(result).toContain('a=1');
    expect(result).toContain('b=2');
    expect(result).toContain('sig=REDACTED');
    expect(result).not.toContain('FAKESIG');
  });
});

describe('errorMessage', () => {
  it('redacts secrets found anywhere in the cause chain', () => {
    const err = new TypeError('fetch failed', {
      cause: new Error('connect https://example.invalid/?sig=FAKESIG')
    });

    const result = errorMessage(err);

    expect(result).not.toContain('FAKESIG');
  });
});

describe('error classes', () => {
  it('SyncConfigError has the expected name and is a CodeMieError', () => {
    const err = new SyncConfigError('bad config');
    expect(err.name).toBe('SyncConfigError');
    expect(err).toBeInstanceOf(CodeMieError);
  });

  it('SyncTargetMissingError names the install command, not sync config', () => {
    const err = new SyncTargetMissingError();
    expect(err.name).toBe('SyncTargetMissingError');
    expect(err).toBeInstanceOf(CodeMieError);
    expect(err.message).toContain('codemie analytics sync install');
    expect(err.message).not.toContain('sync config');
  });

  it('SyncIdentityMissingError names both the install command and git config, not sync config', () => {
    const err = new SyncIdentityMissingError();
    expect(err.name).toBe('SyncIdentityMissingError');
    expect(err).toBeInstanceOf(CodeMieError);
    expect(err.message).toContain('codemie analytics sync install');
    expect(err.message).toContain('git config --global user.email');
    expect(err.message).not.toContain('sync config');
  });

  it('SyncDeliveryError has the expected name and optional status', () => {
    const err = new SyncDeliveryError('delivery failed', 503);
    expect(err.name).toBe('SyncDeliveryError');
    expect(err).toBeInstanceOf(CodeMieError);
    expect(err.status).toBe(503);
  });

  it('ExportTooLargeError has the expected name and reports bytes/limit', () => {
    const err = new ExportTooLargeError(1000, 500);
    expect(err.name).toBe('ExportTooLargeError');
    expect(err).toBeInstanceOf(CodeMieError);
    expect(err.bytes).toBe(1000);
    expect(err.limit).toBe(500);
  });
});
