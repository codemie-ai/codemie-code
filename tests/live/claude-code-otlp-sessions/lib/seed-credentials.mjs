// Child-process script: stores a FAKE SSO login for the fake backend URL in the isolated CODEMIE_HOME
// (file store; keytar is blocked by the preload), so the real daemon and the real hook process find
// "stored credentials" whose owner e-mail is a JWT claim (no /v1/user lookup needed).
// usage: node --import <no-keytar> seed-credentials.mjs <dist-dir> <backend-url> <email>
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [dist, backendUrl, email] = process.argv.slice(2);
if (!process.env.CODEMIE_HOME || !/otlp-live-/.test(process.env.CODEMIE_HOME)) {
  console.error('refusing to seed: CODEMIE_HOME is not an isolated otlp-live-* temp dir');
  process.exit(2);
}
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(backendUrl)) {
  console.error('refusing to seed: backend URL must be the local fake backend');
  process.exit(2);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ email, sub: 'live-user', exp: Math.floor(Date.now() / 1000) + 86400 })}.live-signature`;

const { CredentialStore } = await import(pathToFileURL(join(dist, 'utils', 'security.js')).href);
await CredentialStore.getInstance().storeSSOCredentials(
  { cookies: { codemie_access_token: fakeJwt }, apiUrl: backendUrl, expiresAt: Date.now() + 24 * 3600_000 },
  backendUrl
);
console.log('seeded');
