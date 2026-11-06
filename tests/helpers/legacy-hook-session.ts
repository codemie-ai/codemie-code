import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A recorded pre-contract session: these CLI fixtures test existing hooks while no SSO login is available. */
export function seedLegacyHookSession(home: string, sessionId: string): void {
  const api = 'https://analytics.example.com/code-assistant-api';
  const owner = 'a'.repeat(64);
  const hash = createHash('sha256');
  for (const part of [api, owner, sessionId]) hash.update(`${part.length}:${part}|`);
  const dir = join(home, 'analytics', 'state', 'evidence');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${hash.digest('hex')}.json`), JSON.stringify({
    schema: 1, session_id: sessionId, launch_mode: 'native', routed_via_codemie: false,
    routing_proof: 'unproven', project_source: 'none', api_identity: api, owner_hash: owner,
    created: Date.now(), last_used: Date.now(),
  }));
}
