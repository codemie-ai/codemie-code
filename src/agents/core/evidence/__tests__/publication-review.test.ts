import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let holdAcknowledgement = false;
let acknowledgementEntered: () => void;
let releaseAcknowledgement: () => void;
let acknowledgementRelease: Promise<void>;

vi.mock('../record-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../record-store.js')>();
  return {
    ...actual,
    atomicReplace: async (path: string, content: string): Promise<void> => {
      if (holdAcknowledgement && path.endsWith('.stop-ack.json')) {
        acknowledgementEntered();
        await acknowledgementRelease;
      }
      await actual.atomicReplace(path, content);
    },
  };
});

import { connectFolder, disconnectFolder, resolveConsent } from '../consent-store.js';
import { isStopped, takeNotice, writeNotice, writeStop } from '../stop-marker.js';
import { recordKey, type EvidenceRecord } from '../record-store.js';
import { sendGuard } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/evidence-send.js';

let scratch: string;
let oldHome: string | undefined;
const scope = { owner_hash: 'a'.repeat(64), api_identity: 'https://api.example.com', project: 'work' };

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'publication-review-'));
  oldHome = process.env.CODEMIE_HOME;
  process.env.CODEMIE_HOME = join(scratch, '.codemie');
  holdAcknowledgement = false;
});

afterEach(async () => {
  releaseAcknowledgement?.();
  if (oldHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = oldHome;
  await rm(scratch, { recursive: true, force: true });
});

describe('publication privacy review boundaries', () => {
  it('a reconnect must not authorize an old frozen session before any intervening hook or tick', async () => {
    const folder = join(scratch, 'repo');
    await mkdir(folder);
    await connectFolder(scope, folder);
    const consent = await resolveConsent(scope, folder);
    expect(consent).toBeTruthy();
    const record: EvidenceRecord = {
      ...scope, session_id: 'review-reconnect', schema: 1, launch_mode: 'native',
      routed_via_codemie: false, routing_proof: 'proven', project_source: 'linked_folder',
      funding_route: 'subscription', collection_generation: 0, consent_ref: consent,
      created: Date.now(), last_used: Date.now(),
    };
    const key = recordKey(scope.api_identity, scope.owner_hash, record.session_id);
    expect(await sendGuard(key, record)).toBe(true);
    await disconnectFolder(scope, folder);
    await connectFolder(scope, folder);
    expect(await sendGuard(key, record)).toBe(false);
  });

  it('a stop survives acknowledgement stalled past the lock wait budget', async () => {
    const key = recordKey(scope.api_identity, scope.owner_hash, 'review-lock-timeout');
    await writeNotice(key, 'hold_state_unknown', 'review-lock-timeout');
    const entered = new Promise<void>((resolve) => { acknowledgementEntered = resolve; });
    acknowledgementRelease = new Promise<void>((resolve) => { releaseAcknowledgement = resolve; });
    holdAcknowledgement = true;
    const taking = takeNotice(key);
    await entered;
    try {
      await writeStop(key, 'hold_expired', 'review-lock-timeout');
    } finally {
      releaseAcknowledgement();
      await taking;
    }
    expect(await isStopped(key)).toBe(true);
    expect(await takeNotice(key)).toBe('hold_expired'); // the upgraded marker's reason is shown once, after the stalled ack
    expect(await takeNotice(key)).toBeUndefined();
  }, 10_000);
});
